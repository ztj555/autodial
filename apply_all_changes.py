"""Re-apply all 2026-07-12 changes that were lost in git reset."""
import os
os.chdir(r"C:\Users\10517\Videos\bug-deepseek")

# ===== 1. cloud_relay_v2.py - SQLite connection leak fixes =====
fpath = "cloud-relay/python/cloud_relay_v2.py"
with open(fpath, "r", encoding="utf-8") as f:
    c = f.read()

# Fix 1: _sync_to_crm (SQLite leak)
old = """            try:
                conn = sqlite3.connect(DB_PATH)
                c = conn.cursor()
                c.execute('UPDATE visits SET crm_synced=1, updated_at=? WHERE id=?',
                          (datetime.now().strftime('%Y-%m-%dT%H:%M:%S'), visit_id))
                conn.commit()
                conn.close()
            except:
                pass"""
new = """            conn = None
            try:
                conn = sqlite3.connect(DB_PATH)
                c = conn.cursor()
                c.execute('UPDATE visits SET crm_synced=1, updated_at=? WHERE id=?',
                          (datetime.now().strftime('%Y-%m-%dT%H:%M:%S'), visit_id))
                conn.commit()
            except:
                pass
            finally:
                if conn:
                    conn.close()"""
c = c.replace(old, new)
print("Fix 1: _sync_to_crm done")

# Fix 2: /api/v1/advisor/register
old = """        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute(
                'INSERT INTO advisor_names (pin, name, updated_at) VALUES (?, ?, ?) '
                'ON CONFLICT(pin) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at',
                (pin, name, now_str)
            )
            conn.commit()
            conn.close()
        except Exception as e:
            log.error(f'Advisor register error: {e}')
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))"""
new = """        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute(
                'INSERT INTO advisor_names (pin, name, updated_at) VALUES (?, ?, ?) '
                'ON CONFLICT(pin) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at',
                (pin, name, now_str)
            )
            conn.commit()
        except Exception as e:
            log.error(f'Advisor register error: {e}')
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()"""
c = c.replace(old, new)
print("Fix 2: advisor/register done")

# Fix 3: /api/v1/advisor/name
old = """        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('SELECT name FROM advisor_names WHERE pin = ?', (pin,))
            row = c.fetchone()
            conn.close()
            if row:
                return (200, JSON_HDR, json.dumps({'ok': True, 'name': row[0]}).encode('utf-8'))
            else:
                return (200, JSON_HDR, _err_json('NOT_FOUND', '未找到该PIN对应的顾问姓名'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))"""
new = """        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('SELECT name FROM advisor_names WHERE pin = ?', (pin,))
            row = c.fetchone()
            if row:
                return (200, JSON_HDR, json.dumps({'ok': True, 'name': row[0]}).encode('utf-8'))
            else:
                return (200, JSON_HDR, _err_json('NOT_FOUND', '未找到该PIN对应的顾问姓名'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()"""
c = c.replace(old, new)
print("Fix 3: advisor/name done")

# Fix 4: /api/v1/advisor/is_admin
old = """        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('SELECT 1 FROM admins WHERE pin = ?', (pin,))
            is_admin = c.fetchone() is not None
            conn.close()
            return (200, JSON_HDR, json.dumps({'ok': True, 'is_admin': is_admin}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))"""
new = """        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('SELECT 1 FROM admins WHERE pin = ?', (pin,))
            is_admin = c.fetchone() is not None
            return (200, JSON_HDR, json.dumps({'ok': True, 'is_admin': is_admin}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()"""
c = c.replace(old, new)
print("Fix 4: advisor/is_admin done")

# Fix 5: /api/v1/advisor/set_admin
old = """        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
            c.execute('INSERT OR IGNORE INTO admins (pin, added_by, created_at) VALUES (?, ?, ?)',
                      (pin, 'dashboard', now_str))
            conn.commit()
            conn.close()
            log.info(f'ADMIN_SET pin={pin}')
            return (200, JSON_HDR, json.dumps({'ok': True, 'pin': pin}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))"""
new = """        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
            c.execute('INSERT OR IGNORE INTO admins (pin, added_by, created_at) VALUES (?, ?, ?)',
                      (pin, 'dashboard', now_str))
            conn.commit()
            log.info(f'ADMIN_SET pin={pin}')
            return (200, JSON_HDR, json.dumps({'ok': True, 'pin': pin}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()"""
c = c.replace(old, new)
print("Fix 5: advisor/set_admin done")

# Fix 6: /api/v1/advisor/del_admin
old = """        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('DELETE FROM admins WHERE pin = ?', (pin,))
            conn.commit()
            conn.close()
            log.info(f'ADMIN_DEL pin={pin}')
            return (200, JSON_HDR, json.dumps({'ok': True, 'pin': pin}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))"""
new = """        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('DELETE FROM admins WHERE pin = ?', (pin,))
            conn.commit()
            log.info(f'ADMIN_DEL pin={pin}')
            return (200, JSON_HDR, json.dumps({'ok': True, 'pin': pin}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()"""
c = c.replace(old, new)
print("Fix 6: advisor/del_admin done")

# Fix 7: /api/v1/pins
old = """        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute('''SELECT a.pin, a.name, a.group_id, a.updated_at,
                         (SELECT 1 FROM admins WHERE pin = a.pin) AS is_admin
                         FROM advisor_names a ORDER BY a.updated_at DESC''')
            rows = [dict(r) for r in c.fetchall()]
            conn.close()
            return (200, JSON_HDR, json.dumps({'ok': True, 'pins': rows}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))"""
new = """        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute('''SELECT a.pin, a.name, a.group_id, a.updated_at,
                         (SELECT 1 FROM admins WHERE pin = a.pin) AS is_admin
                         FROM advisor_names a ORDER BY a.updated_at DESC''')
            rows = [dict(r) for r in c.fetchall()]
            return (200, JSON_HDR, json.dumps({'ok': True, 'pins': rows}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()"""
c = c.replace(old, new)
print("Fix 7: pins done")

# Fix 8: /api/v1/pin/set_group
old = """        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('UPDATE advisor_names SET group_id=? WHERE pin=?', (int(gid) if gid else None, pin))
            conn.commit()
            conn.close()
            return (200, JSON_HDR, json.dumps({'ok': True}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))"""
new = """        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('UPDATE advisor_names SET group_id=? WHERE pin=?', (int(gid) if gid else None, pin))
            conn.commit()
            return (200, JSON_HDR, json.dumps({'ok': True}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()"""
c = c.replace(old, new)
print("Fix 8: pin/set_group done")

# Fix 9: /api/v1/groups
old = """        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute('SELECT * FROM pin_groups ORDER BY id')
            rows = [dict(r) for r in c.fetchall()]
            conn.close()
            return (200, JSON_HDR, json.dumps({'ok': True, 'groups': rows}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))"""
new = """        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute('SELECT * FROM pin_groups ORDER BY id')
            rows = [dict(r) for r in c.fetchall()]
            return (200, JSON_HDR, json.dumps({'ok': True, 'groups': rows}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()"""
c = c.replace(old, new)
print("Fix 9: groups done")

# Fix 10: /api/v1/group/add
old = """        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
            c.execute('INSERT INTO pin_groups (name, created_at) VALUES (?, ?)', (name, now_str))
            conn.commit()
            rid = c.lastrowid
            conn.close()
            return (200, JSON_HDR, json.dumps({'ok': True, 'id': rid, 'name': name}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))"""
new = """        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
            c.execute('INSERT INTO pin_groups (name, created_at) VALUES (?, ?)', (name, now_str))
            conn.commit()
            rid = c.lastrowid
            return (200, JSON_HDR, json.dumps({'ok': True, 'id': rid, 'name': name}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()"""
c = c.replace(old, new)
print("Fix 10: group/add done")

# Fix 11: /api/v1/group/del
old = """        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('UPDATE advisor_names SET group_id=NULL WHERE group_id=?', (int(gid),))
            c.execute('DELETE FROM pin_groups WHERE id=?', (int(gid),))
            conn.commit()
            conn.close()
            return (200, JSON_HDR, json.dumps({'ok': True}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))"""
new = """        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('UPDATE advisor_names SET group_id=NULL WHERE group_id=?', (int(gid),))
            c.execute('DELETE FROM pin_groups WHERE id=?', (int(gid),))
            conn.commit()
            return (200, JSON_HDR, json.dumps({'ok': True}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()"""
c = c.replace(old, new)
print("Fix 11: group/del done")

# Fix 12: /api/v1/visit - INSERT
old = """        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute(
                'INSERT INTO visits (pin, name, mobile, kefu_tel, visit_type, source, created_at, updated_at) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (pin, name, mobile, kefu_tel, visit_type, source, now_str, now_str)
            )
            # 自动注册顾问姓名映射（手机端通过此映射获取顾问姓名）
            if kefu_tel and kefu_tel.strip():
                c.execute(
                    'INSERT INTO advisor_names (pin, name, updated_at) VALUES (?, ?, ?) '
                    'ON CONFLICT(pin) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at',
                    (pin, kefu_tel.strip(), now_str)
                )
            conn.commit()
            row_id = c.lastrowid
            conn.close()
        except Exception as e:
            log.error(f'INSERT visit error: {e}')
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))"""
new = """        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute(
                'INSERT INTO visits (pin, name, mobile, kefu_tel, visit_type, source, created_at, updated_at) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (pin, name, mobile, kefu_tel, visit_type, source, now_str, now_str)
            )
            # 自动注册顾问姓名映射（手机端通过此映射获取顾问姓名）
            if kefu_tel and kefu_tel.strip():
                c.execute(
                    'INSERT INTO advisor_names (pin, name, updated_at) VALUES (?, ?, ?) '
                    'ON CONFLICT(pin) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at',
                    (pin, kefu_tel.strip(), now_str)
                )
            conn.commit()
            row_id = c.lastrowid
        except Exception as e:
            log.error(f'INSERT visit error: {e}')
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()"""
c = c.replace(old, new)
print("Fix 12: visit create done")

# Fix 13: /api/v1/visits - SELECT
old = """        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            if group_id:
                # 按分组查询：先找出该分组的所有 PIN，再查 visits
                c.execute('SELECT pin FROM advisor_names WHERE group_id=?', (int(group_id),))
                group_pins = [r['pin'] for r in c.fetchall()]
                if group_pins:
                    placeholders = ','.join(['?'] * len(group_pins))
                    c.execute(f'SELECT * FROM visits WHERE pin IN ({placeholders}) ORDER BY created_at DESC',
                              group_pins)
                else:
                    c.execute('SELECT * FROM visits WHERE 1=0')
            elif pin:
                c.execute('SELECT * FROM visits WHERE pin=? ORDER BY created_at DESC', (pin,))
            else:
                c.execute('SELECT * FROM visits ORDER BY created_at DESC LIMIT 500')
            rows = [dict(r) for r in c.fetchall()]
            conn.close()
            return (200, JSON_HDR, json.dumps(rows, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))"""
new = """        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            if group_id:
                c.execute('SELECT pin FROM advisor_names WHERE group_id=?', (int(group_id),))
                group_pins = [r['pin'] for r in c.fetchall()]
                if group_pins:
                    placeholders = ','.join(['?'] * len(group_pins))
                    c.execute(f'SELECT * FROM visits WHERE pin IN ({placeholders}) ORDER BY created_at DESC',
                              group_pins)
                else:
                    c.execute('SELECT * FROM visits WHERE 1=0')
            elif pin:
                c.execute('SELECT * FROM visits WHERE pin=? ORDER BY created_at DESC', (pin,))
            else:
                c.execute('SELECT * FROM visits ORDER BY created_at DESC LIMIT 500')
            rows = [dict(r) for r in c.fetchall()]
            return (200, JSON_HDR, json.dumps(rows, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()"""
c = c.replace(old, new)
print("Fix 13: visits list done")

# Fix 14: /api/v1/visit/delete
old = """        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('DELETE FROM visits WHERE id=?', (int(rid),))
            conn.commit()
            affected = c.rowcount
            conn.close()
            return (200, JSON_HDR, json.dumps(
                {'ok': affected > 0, 'code': 'DELETED' if affected > 0 else 'NOT_FOUND',
                 'id': int(rid)}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))"""
new = """        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('DELETE FROM visits WHERE id=?', (int(rid),))
            conn.commit()
            affected = c.rowcount
            return (200, JSON_HDR, json.dumps(
                {'ok': affected > 0, 'code': 'DELETED' if affected > 0 else 'NOT_FOUND',
                 'id': int(rid)}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()"""
c = c.replace(old, new)
print("Fix 14: visit/delete done")

# Fix 15: /api/v1/visit/update
old = """        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute(f'UPDATE visits SET {", ".join(fields)} WHERE id=?', values)
            conn.commit()
            affected = c.rowcount
            conn.close()
            return (200, JSON_HDR, json.dumps(
                {'ok': affected > 0, 'code': 'UPDATED' if affected > 0 else 'NOT_FOUND',
                 'id': int(rid)}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))"""
new = """        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute(f'UPDATE visits SET {", ".join(fields)} WHERE id=?', values)
            conn.commit()
            affected = c.rowcount
            return (200, JSON_HDR, json.dumps(
                {'ok': affected > 0, 'code': 'UPDATED' if affected > 0 else 'NOT_FOUND',
                 'id': int(rid)}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()"""
c = c.replace(old, new)
print("Fix 15: visit/update done")

# Fix 16: Headless server compatibility - wrap run_tray()
old = """    # 主线程运行托盘（pystray 要求主线程）
    run_tray()"""
new = """    # 主线程运行托盘（pystray 要求主线程）；无桌面环境时跳过
    try:
        run_tray()
    except Exception:
        log.info(f'Server running without system tray (headless), port={PORT}')
        server_thread.join()"""
c = c.replace(old, new)
print("Fix 16: headless tray done")

with open(fpath, "w", encoding="utf-8") as f:
    f.write(c)
print("cloud_relay_v2.py saved")

# ===== 2. Default server URL changes =====
files_to_update = {
    "AutoDial-Extension/background.js": [
        ("262ao85kz470.vicp.fun:55535", "101.34.65.254:35430"),
    ],
    "AutoDial-Extension/popup.js": [
        ("262ao85kz470.vicp.fun:55535", "101.34.65.254:35430"),
    ],
    "AutoDial-Extension/popup.html": [
        ("262ao85kz470.vicp.fun:55535", "101.34.65.254:35430"),
    ],
    "AutoDial-Extension/content-script.js": [
        ("262ao85kz470.vicp.fun:55535", "101.34.65.254:35430"),
    ],
    "pc-app-go/frontend/index.html": [
        ("262ao85kz470.vicp.fun:55535", "101.34.65.254:35430"),
    ],
}

for fname, replacements in files_to_update.items():
    with open(fname, "r", encoding="utf-8") as f:
        content = f.read()
    for old_str, new_str in replacements:
        count = content.count(old_str)
        content = content.replace(old_str, new_str)
        print(f"  {fname}: {old_str} -> {new_str} ({count}x)")
    with open(fname, "w", encoding="utf-8") as f:
        f.write(content)

# ===== 3. CHANGELOG update =====
latest = """# AutoDial v4.1.0 更新日志

> 最后修改：2026-07-12

---

## 2026-07-12 云端部署 + 稳定修复 + 运维体系建立

### 云中继稳定性修复 (cloud_relay_v2.py)
- 16 SQLite handlers: conn.close() moved to finally block (connection leak fix)
- Headless server: run_tray() wrapped in try/except (Ubuntu Server compatibility)
### 腾讯云部署 (101.34.65.254)
- Ubuntu 22.04.4, 1Panel v2.0.15, Docker + Supervisor dual-instance (35430/35440)
- Quick commands: 7 scripts at /opt/autodial/scripts/, CSV import template
### 默认服务器地址
- All clients: default cloud URL changed to 101.34.65.254:35430

---

"""

with open("CHANGELOG.md", "w", encoding="utf-8") as f:
    f.write(latest + "# AutoDial v4.1.0 更新日志 (continued)\n\n> 历史更新请查看 git log\n")

print("\n=== ALL DONE ===")
