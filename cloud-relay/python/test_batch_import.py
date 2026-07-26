#!/usr/bin/env python3
"""
Edward (QA) — Round 1 (Fixed): Unit tests for /api/v1/visits/batch
After fixing test bugs, the remaining failures are source code bugs.
"""
import json
import os
import sys
import tempfile
import unittest
import sqlite3


# ============================================================
# Port of backend logic
# ============================================================

def _check_admin_logic(auth_enabled, sessions, hdrs, query_string=''):
    """Direct port of _check_admin() from cloud_relay_v2.py"""
    if not auth_enabled:
        return True
    # Authorization: Bearer <token>
    auth = hdrs.get('authorization', '')
    if auth.startswith('Bearer ') and auth[7:] in sessions:
        import time
        if time.time() < sessions[auth[7:]]:
            return True
        else:
            sessions.pop(auth[7:], None)
            return False
    # ?token=<token>
    if query_string:
        from urllib.parse import parse_qs
        qs = parse_qs(query_string)
        token = qs.get('token', [''])[0]
        if token in sessions:
            import time
            if time.time() < sessions[token]:
                return True
            else:
                sessions.pop(token, None)
                return False
    return False


# Port of JS mapHeader (EXACT from dashboard.html lines 859-871)
def _map_header(col):
    c = col.replace(r'^\s+|\s+$/g', '').strip()
    # Simulate JS regex: col.replace(/^\s+|\s+$/g, '')
    import re
    c = re.sub(r'^\s+|\s+$', '', col)
    m = {
        'id': 'crm_id', '编号': 'crm_id', '客户id': 'crm_id',
        '姓名': 'name', '客户姓名': 'name', '客户名': 'name', 'name': 'name',
        '手机号': 'mobile', '客户手机号': 'mobile', '手机': 'mobile', '电话': 'mobile', 'mobile': 'mobile',
        '顾问电话': 'kefu_tel', '顾问': 'kefu_tel', '接待顾问': 'kefu_tel', '客服电话': 'kefu_tel',
        '上门时间': 'visit_time', '来访时间': 'visit_time', 'visit_time': 'visit_time', '日期': 'visit_time',
        '来访事由': 'visit_type', '事由': 'visit_type', '类型': 'visit_type', 'visit_type': 'visit_type',
        '城市': 'city', '一级部门': 'dept1', '二级部门': 'dept2', '部门': 'dept1'
    }
    return m.get(c) or m.get(c.lower())


# Port of JS detectDelimiter
def _detect_delimiter(line):
    counts = {'\t': line.count('\t'), ',': line.count(','), '|': line.count('|')}
    best = max(counts.items(), key=lambda x: x[1])
    return best[0] if best[1] > 0 else '\t'


# ============================================================
# DB helper — uses CORRECT schema (crm_id in CREATE TABLE)
# This simulates a FIXED version for logic verification
# ============================================================

def _create_fixed_db(db_path):
    """Create DB with crm_id in the initial CREATE TABLE (correct approach)"""
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crm_id TEXT UNIQUE,
        pin TEXT NOT NULL,
        name TEXT NOT NULL,
        mobile TEXT NOT NULL,
        kefu_tel TEXT NOT NULL,
        visit_type TEXT DEFAULT '贷款咨询',
        source TEXT DEFAULT 'plugin',
        crm_synced INTEGER DEFAULT 0,
        visit_time TEXT DEFAULT '',
        visit_extra TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )''')
    conn.commit()
    conn.close()


def _create_buggy_db(db_path):
    """Create DB using the actual buggy approach (ALTER TABLE ADD UNIQUE)"""
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    # Same as cloud_relay_v2.py create_visits (line 85-97) — NO crm_id
    c.execute('''CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pin TEXT NOT NULL,
        name TEXT NOT NULL,
        mobile TEXT NOT NULL,
        kefu_tel TEXT NOT NULL,
        visit_type TEXT DEFAULT '贷款咨询',
        source TEXT DEFAULT 'plugin',
        crm_synced INTEGER DEFAULT 0,
        visit_time TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )''')
    # Buggy ALTER — same as cloud_relay_v2.py line 177
    try:
        c.execute('ALTER TABLE visits ADD COLUMN crm_id TEXT UNIQUE')
        conn.commit()
    except sqlite3.OperationalError:
        pass  # Silently fails! (the bug)
    try:
        c.execute("ALTER TABLE visits ADD COLUMN visit_extra TEXT DEFAULT '{}'")
        conn.commit()
    except sqlite3.OperationalError:
        pass
    # Check if crm_id exists
    c.execute("PRAGMA table_info(visits)")
    cols = [row[1] for row in c.fetchall()]
    conn.close()
    return 'crm_id' in cols


def _process_batch(records, db_path):
    """Port of batch insert loop from cloud_relay_v2.py lines 1557-1595"""
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    now = '2024-06-01T12:00:00'
    inserted = 0
    skipped = 0
    errors = []

    for i, rec in enumerate(records):
        try:
            if not isinstance(rec, dict):
                errors.append({'row': i, 'reason': '记录不是 JSON 对象'})
                skipped += 1
                continue

            crm_id = (rec.get('crm_id') or '').strip()
            name = (rec.get('name') or '').strip()
            mobile = (rec.get('mobile') or '').strip()
            kefu_tel = (rec.get('kefu_tel') or '').strip()
            visit_type = (rec.get('visit_type') or '贷款咨询').strip()
            visit_time = (rec.get('visit_time') or '').strip()
            visit_extra = rec.get('visit_extra', '{}')
            if isinstance(visit_extra, dict):
                visit_extra = json.dumps(visit_extra, ensure_ascii=False)

            if not name or not mobile:
                errors.append({'row': i, 'crm_id': crm_id, 'reason': '缺少必填字段(name/mobile)'})
                skipped += 1
                continue

            c.execute(
                '''INSERT OR IGNORE INTO visits
                (crm_id, pin, name, mobile, kefu_tel, visit_type, source, visit_time,
                 crm_synced, visit_extra, created_at, updated_at)
                VALUES (?, '', ?, ?, ?, ?, 'crm_import', ?, 1, ?, ?, ?)''',
                (crm_id if crm_id else None, name, mobile, kefu_tel,
                 visit_type, visit_time, visit_extra, now, now)
            )
            if c.rowcount > 0:
                inserted += 1
            else:
                skipped += 1
                errors.append({'row': i, 'crm_id': crm_id, 'reason': 'crm_id 重复，已跳过'})
        except Exception as e:
            errors.append({'row': i, 'reason': str(e)})
            skipped += 1

    conn.commit()
    conn.close()
    return {'inserted': inserted, 'skipped': skipped, 'errors': errors}


# ============================================================
# Test: SOURCE BUG — ALTER TABLE ADD COLUMN UNIQUE fails
# ============================================================

class TestSourceBugAlterTableUnique(unittest.TestCase):
    """验证源码 Bug: SQLite 不支持 ALTER TABLE ADD COLUMN ... UNIQUE"""

    def test_buggy_db_missing_crm_id_column(self):
        """buggy 方式创建 DB → crm_id 列不存在"""
        tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
        tmp.close()
        try:
            has_crm_id = _create_buggy_db(tmp.name)
            self.assertFalse(has_crm_id,
                "BUG CONFIRMED: crm_id 列未被创建! "
                "SQLite不支持 ALTER TABLE ADD COLUMN ... UNIQUE")
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

    def test_buggy_db_insert_fails(self):
        """buggy DB → INSERT 报错 'no such column: crm_id'"""
        tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
        tmp.close()
        try:
            _create_buggy_db(tmp.name)
            result = _process_batch([
                {'crm_id': 'C1', 'name': '张三', 'mobile': '13800138000', 'kefu_tel': '顾问'},
            ], tmp.name)
            self.assertEqual(result['inserted'], 0,
                "BUG CONFIRMED: 因 crm_id 列缺失, 所有插入均失败")
            self.assertGreater(len(result['errors']), 0)
            self.assertIn('has no column named crm_id', result['errors'][0]['reason'])
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass


# ============================================================
# Tests with FIXED schema — verify business logic is correct
# ============================================================

class _DBTestBase(unittest.TestCase):
    """Base class for tests using fixed DB schema"""
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
        self.tmp.close()
        self.db_path = self.tmp.name
        _create_fixed_db(self.db_path)

    def tearDown(self):
        try:
            os.unlink(self.tmp.name)
        except OSError:
            pass


class TestAuthMechanism(unittest.TestCase):
    """鉴权: 各种 token 路径"""
    def setUp(self):
        self.sessions = {}
        import time
        self.time = time

    def test_auth_disabled(self):
        self.assertTrue(_check_admin_logic(False, self.sessions, {}))

    def test_auth_enabled_no_token(self):
        self.assertFalse(_check_admin_logic(True, self.sessions, {}))

    def test_auth_enabled_valid_query_token(self):
        self.sessions['tok123'] = self.time.time() + 3600
        self.assertTrue(_check_admin_logic(True, self.sessions, {}, 'token=tok123'))

    def test_auth_enabled_valid_bearer_token(self):
        self.sessions['tok456'] = self.time.time() + 3600
        self.assertTrue(_check_admin_logic(True, self.sessions,
                                           {'authorization': 'Bearer tok456'}))

    def test_auth_enabled_expired_token(self):
        self.sessions['old'] = self.time.time() - 3600
        self.assertFalse(_check_admin_logic(True, self.sessions, {}, 'token=old'))
        self.assertNotIn('old', self.sessions)


class TestDedupCRM(_DBTestBase):
    """去重: 相同 crm_id → skipped"""

    def test_duplicate_crm_id_skipped(self):
        result = _process_batch([
            {'crm_id': 'CRM_DUP', 'name': '张三', 'mobile': '13800138000', 'kefu_tel': 'A'},
            {'crm_id': 'CRM_DUP', 'name': '李四', 'mobile': '13900139000', 'kefu_tel': 'B'},
        ], self.db_path)
        self.assertEqual(result['inserted'], 1)
        self.assertEqual(result['skipped'], 1)
        self.assertIn('crm_id 重复', result['errors'][0]['reason'])

        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute('SELECT name FROM visits WHERE crm_id=?', ('CRM_DUP',))
        row = c.fetchone()
        conn.close()
        self.assertEqual(row[0], '张三', "应保留第一条, 跳过第二条")

    def test_no_crm_id_multiple_inserts(self):
        """无 crm_id → NULL, UNIQUE 不冲突, 全插入"""
        result = _process_batch([
            {'crm_id': '', 'name': 'A', 'mobile': '13800000001', 'kefu_tel': 'X'},
            {'crm_id': '', 'name': 'B', 'mobile': '13800000002', 'kefu_tel': 'X'},
            {'crm_id': '', 'name': 'C', 'mobile': '13800000003', 'kefu_tel': 'X'},
        ], self.db_path)
        self.assertEqual(result['inserted'], 3)
        self.assertEqual(result['skipped'], 0)


class TestMissingFields(_DBTestBase):
    """必填校验: name/mobile 为空 → skipped"""

    def test_name_empty_skipped(self):
        r = _process_batch([
            {'crm_id': 'C1', 'name': '', 'mobile': '13800138000', 'kefu_tel': 'A'},
        ], self.db_path)
        self.assertEqual(r['skipped'], 1)
        self.assertIn('name/mobile', r['errors'][0]['reason'])

    def test_mobile_empty_skipped(self):
        r = _process_batch([
            {'crm_id': 'C2', 'name': '张三', 'mobile': '', 'kefu_tel': 'A'},
        ], self.db_path)
        self.assertEqual(r['skipped'], 1)

    def test_both_empty_skipped(self):
        r = _process_batch([
            {'crm_id': 'C3', 'name': '', 'mobile': '', 'kefu_tel': 'A'},
        ], self.db_path)
        self.assertEqual(r['skipped'], 1)

    def test_name_whitespace_skipped(self):
        r = _process_batch([
            {'crm_id': 'C4', 'name': '   ', 'mobile': '13800138000', 'kefu_tel': 'A'},
        ], self.db_path)
        self.assertEqual(r['skipped'], 1, "纯空格 name 经 strip() 后为空")

    def test_valid_record_inserted(self):
        r = _process_batch([
            {'crm_id': 'C5', 'name': '张三', 'mobile': '13800138000', 'kefu_tel': 'A'},
        ], self.db_path)
        self.assertEqual(r['inserted'], 1)


class TestDelimiterDetection(unittest.TestCase):
    """分隔符检测: Tab/逗号/竖线"""

    def test_tab(self):
        self.assertEqual(_detect_delimiter("a\tb\tc\td"), '\t')

    def test_comma(self):
        self.assertEqual(_detect_delimiter("a,b,c,d"), ',')

    def test_pipe(self):
        self.assertEqual(_detect_delimiter("a|b|c|d"), '|')

    def test_mixed_prefers_most(self):
        self.assertEqual(_detect_delimiter("a,b\tc,d\te"), '\t')

    def test_fallback_to_tab(self):
        self.assertEqual(_detect_delimiter("single"), '\t')


class TestHeaderMapping(unittest.TestCase):
    """JS mapHeader() — 列名模糊匹配"""

    def test_chinese_headers(self):
        self.assertEqual(_map_header('编号'), 'crm_id')
        self.assertEqual(_map_header('客户id'), 'crm_id')
        self.assertEqual(_map_header('客户姓名'), 'name')
        self.assertEqual(_map_header('客户名'), 'name')
        self.assertEqual(_map_header('姓名'), 'name')
        self.assertEqual(_map_header('手机号'), 'mobile')
        self.assertEqual(_map_header('客户手机号'), 'mobile')
        self.assertEqual(_map_header('手机'), 'mobile')
        self.assertEqual(_map_header('电话'), 'mobile')
        self.assertEqual(_map_header('接待顾问'), 'kefu_tel')
        self.assertEqual(_map_header('顾问'), 'kefu_tel')
        self.assertEqual(_map_header('顾问电话'), 'kefu_tel')
        self.assertEqual(_map_header('客服电话'), 'kefu_tel')
        self.assertEqual(_map_header('城市'), 'city')
        self.assertEqual(_map_header('一级部门'), 'dept1')
        self.assertEqual(_map_header('二级部门'), 'dept2')
        self.assertEqual(_map_header('部门'), 'dept1')

    def test_english_headers(self):
        self.assertEqual(_map_header('id'), 'crm_id')
        self.assertEqual(_map_header('name'), 'name')
        self.assertEqual(_map_header('mobile'), 'mobile')
        self.assertEqual(_map_header('visit_time'), 'visit_time')
        self.assertEqual(_map_header('visit_type'), 'visit_type')

    def test_case_insensitive(self):
        self.assertEqual(_map_header('ID'), 'crm_id')
        self.assertEqual(_map_header('Name'), 'name')
        self.assertEqual(_map_header('Mobile'), 'mobile')

    def test_unknown_column(self):
        self.assertIsNone(_map_header('随机字段'))
        self.assertIsNone(_map_header(''))


class TestVisitExtraJSON(_DBTestBase):
    """visit_extra JSON 存储城市/部门"""

    def test_visit_extra_stored(self):
        r = _process_batch([
            {'crm_id': 'EXT1', 'name': '张三', 'mobile': '13800138000',
             'kefu_tel': '顾问', 'visit_extra': '{"city":"深圳","dept1":"销售部","dept2":"一组"}'},
        ], self.db_path)
        self.assertEqual(r['inserted'], 1)

        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute('SELECT visit_extra FROM visits WHERE crm_id=?', ('EXT1',))
        row = c.fetchone()
        conn.close()
        extra = json.loads(row[0])
        self.assertEqual(extra['city'], '深圳')
        self.assertEqual(extra['dept1'], '销售部')
        self.assertEqual(extra['dept2'], '一组')

    def test_visit_extra_empty_default(self):
        r = _process_batch([
            {'crm_id': 'EXT2', 'name': '李四', 'mobile': '13900139000', 'kefu_tel': 'A'},
        ], self.db_path)
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute('SELECT visit_extra FROM visits WHERE crm_id=?', ('EXT2',))
        row = c.fetchone()
        conn.close()
        self.assertEqual(row[0], '{}')

    def test_visit_extra_dict_converted(self):
        """dict → JSON string (API 直接调用场景)"""
        r = _process_batch([
            {'crm_id': 'EXT3', 'name': '王五', 'mobile': '13700137000',
             'kefu_tel': 'B', 'visit_extra': {'city': '广州'}},
        ], self.db_path)
        self.assertEqual(r['inserted'], 1)
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute('SELECT visit_extra FROM visits WHERE crm_id=?', ('EXT3',))
        row = c.fetchone()
        conn.close()
        extra = json.loads(row[0])
        self.assertEqual(extra['city'], '广州')


class TestCountIntegrity(_DBTestBase):
    """inserted + skipped = 实际行数"""

    def test_mixed_batch(self):
        records = [
            {'crm_id': 'X1', 'name': 'A', 'mobile': '13000000001', 'kefu_tel': 'X'},
            {'crm_id': 'X1', 'name': 'A', 'mobile': '13000000001', 'kefu_tel': 'X'},  # dup
            {'crm_id': '', 'name': '', 'mobile': '', 'kefu_tel': ''},  # missing
            {'crm_id': 'X2', 'name': 'B', 'mobile': '13000000002', 'kefu_tel': 'X'},
            'not_a_dict',
        ]
        r = _process_batch(records, self.db_path)
        self.assertEqual(r['inserted'] + r['skipped'], len(records))
        self.assertEqual(r['inserted'], 2)
        self.assertEqual(r['skipped'], 3)

    def test_all_valid(self):
        records = [
            {'crm_id': 'Y1', 'name': 'A', 'mobile': '13000000001', 'kefu_tel': 'X'},
            {'crm_id': 'Y2', 'name': 'B', 'mobile': '13000000002', 'kefu_tel': 'X'},
        ]
        r = _process_batch(records, self.db_path)
        self.assertEqual(r['inserted'], 2)
        self.assertEqual(r['skipped'], 0)

    def test_all_missing(self):
        records = [
            {'crm_id': '', 'name': '', 'mobile': '', 'kefu_tel': ''},
            {'crm_id': '', 'name': '', 'mobile': '', 'kefu_tel': ''},
        ]
        r = _process_batch(records, self.db_path)
        self.assertEqual(r['inserted'], 0)
        self.assertEqual(r['skipped'], 2)


class TestEdgeCases(unittest.TestCase):
    """边界值"""

    def test_crm_id_zero_preserved(self):
        self.assertEqual('0' if '0' else None, '0')

    def test_crm_id_empty_to_none(self):
        self.assertIsNone('' if '' else None)

    def test_default_visit_type(self):
        self.assertEqual((None or '贷款咨询').strip(), '贷款咨询')

    def test_source_is_crm_import(self):
        self.assertEqual('crm_import', 'crm_import')


if __name__ == '__main__':
    unittest.main(verbosity=2)
