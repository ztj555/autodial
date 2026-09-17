"""
AutoDial 云中转服务器 - Python 版（带 Web 管理界面 v4.10）
功能：WebSocket 中转 + 系统托盘图标 + Web 可视化界面，打包为单个 EXE
依赖：websockets, pystray, Pillow
"""

import asyncio
import json
import logging
import sys
import os
import signal
import threading
import subprocess
import time
import sqlite3
import uuid
import hashlib
import secrets
import contextvars
from collections import defaultdict
from datetime import datetime, timedelta
from urllib.parse import urlparse, parse_qs, urlencode
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

# P0-Fix: 专用线程池，避免 DB 查询占用 websockets process_request 的默认线程池
_db_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix='db')
# v4.23 (Y-4): 来访去重是"SELECT 判重→INSERT"两步，_db_executor 8 线程可并发进入，
# 存在 check-then-insert 竞态（双拨同号并发登记可各插一条）。用进程内锁把判重+写入
# 原子化——双实例(35430/35440)各自独立 DB，跨进程竞态不存在，进程内锁足够；
# 员工登记频率极低，串行化无感知。（crm_id 路径另有唯一索引兜底）
_visit_insert_lock = threading.Lock()

import websockets
from websockets.legacy.server import serve
from websockets.legacy import http as ws_http
from websockets.exceptions import InvalidMessage

# ==================== 配置 ====================
DEFAULT_PORT = 35430
PORT = DEFAULT_PORT
# v4.23 (M-8): 服务版本单一来源——/health、/api/status 与面板"系统信息"统一显示，
# 此前面板展示"设计系统 6.0"、接口硬编码 '4.10'，排查问题时易误判线上版本
APP_VERSION = '4.33'
# Fix D4: Web 管理界面和 WebSocket 共用 PORT, WEB_PORT 已废弃

# v4.26: 固定人员名册（唯一权威源）。
# 来源 = 插件端「一键登记」弹出框所用的同一份 CRM 顾问列表，接口无需登录即可读取：
#   curl -s -X POST https://guwen.zhudaicms.com/bserve/search \
#        -H 'Content-Type: application/x-www-form-urlencoded' -d 'keyword=&brand=1833'
# 这批人**就是全部人员，不会有其他人**。v4.33 起本表降级为「出厂种子 / 离线兜底」：
# 权威源优先取 DB 表 advisor_roster（由面板「人员管理 → 刷新名单」从上面的 CRM 接口同步而来），
# 只有 DB 为空（全新实例、或清库后尚未刷新过）才回退到这批内置数据。
# 「人员管理」以此名册为准逐条展示：姓名匹配上已注册记录 ⇒ 显示其 PIN/分组/更新时间；
# 匹配不上 ⇒ 显示「未绑定」（该人员尚未用插件登记过）。名册变更时更新本表并同步 CHANGELOG。
ADVISOR_ROSTER = [
    {'id': '179408', 'name': '补录上门账号'},
    {'id': '170745', 'name': '韩俊'},
    {'id': '181839', 'name': '洪钰梅'},
    {'id': '161125', 'name': '金晟'},
    {'id': '176705', 'name': '刘静'},
    {'id': '180084', 'name': '牛敬龙'},
    {'id': '160947', 'name': '融鑫汇总账号'},
    {'id': '172949', 'name': '叶浩'},
    {'id': '163921', 'name': '虞洳愚'},
    {'id': '170746', 'name': '张召'},
    {'id': '161879', 'name': '左廷军'},
]

# v4.33: 名册「从源头刷新」所用的 CRM 接口（面板「人员管理 → 刷新名单」按钮）。
# 实测行为：无需登录，POST 表单，返回 {code:1, data:[{id, name}]}，数组顺序即 CRM 中的展示顺序。
# 环境变量可覆盖，便于换域名、或测试时指向桩服务：
#   AUTODIAL_CRM_ROSTER_URL / AUTODIAL_CRM_BRAND / AUTODIAL_CRM_TIMEOUT
CRM_ROSTER_URL = os.environ.get('AUTODIAL_CRM_ROSTER_URL') or 'https://guwen.zhudaicms.com/bserve/search'
CRM_ROSTER_BRAND = os.environ.get('AUTODIAL_CRM_BRAND') or '1833'
CRM_ROSTER_TIMEOUT = float(os.environ.get('AUTODIAL_CRM_TIMEOUT') or 8)

# v4.16.1: 设备自动注册（内部部署便捷模式）。
# 开启时，未在云端注册的设备首次 phone_hello 自动绑定到其当前使用的 PIN，
# 不再报"未在云端注册"拒绝，免去管理员逐台预设默认 PIN。
# 同 PIN 直连 auth_ok 不受影响；绑定后改用其他 PIN 仍走浏览器插件授权（防误输 PIN 顶号）。
# 关闭方式：环境变量 AUTODIAL_AUTO_REGISTER=0（恢复"未注册即拒绝"严格模式）
AUTO_REGISTER_DEVICE = os.environ.get('AUTODIAL_AUTO_REGISTER', '1') == '1'

# 解析命令行参数 (Fix D4: simplified CLI parsing)
args = sys.argv[1:]
for i, arg in enumerate(args):
    if arg in ('--port', '-p') and i + 1 < len(args):
        try:
            PORT = int(args[i + 1])
        except ValueError:
            pass

# ==================== 管理鉴权 ====================
# 管理账号存储在 admin_accounts 表中，首次启动自动创建默认账号
# 鉴权始终启用，所有管理接口需要登录后才能访问

# ==================== 日志 ====================
log_file_path = None

def _data_dir():
    """数据目录：优先 AUTODIAL_DATA_DIR 环境变量。
    Y-11修复(v4.23)：此前日志与 stats.json 固定写 APPDATA or ~，Docker 容器里
    两者都指向容器内部路径，容器重建即丢。Docker 部署时应设置
    AUTODIAL_DATA_DIR 指向挂载卷（见 docker-compose.yml）。"""
    env_dir = os.environ.get('AUTODIAL_DATA_DIR')
    if env_dir:
        return env_dir
    return os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')),
                        'autodial-cloud-relay')

def setup_logging():
    global log_file_path
    app_data = _data_dir()
    os.makedirs(app_data, exist_ok=True)
    log_file_path = os.path.join(app_data, 'cloud-relay.log')

    logger = logging.getLogger('relay')
    logger.setLevel(logging.INFO)

    # 文件日志（轮转：10MB × 5个备份文件）
    from logging.handlers import RotatingFileHandler
    fh = RotatingFileHandler(log_file_path, maxBytes=10*1024*1024, backupCount=5, encoding='utf-8')
    fh.setFormatter(logging.Formatter('[%(asctime)s] [%(levelname)s] %(message)s',
                                       datefmt='%Y-%m-%dT%H:%M:%S'))
    logger.addHandler(fh)

    # 控制台日志
    ch = logging.StreamHandler()
    ch.setFormatter(logging.Formatter('[%(asctime)s] [%(levelname)s] %(message)s',
                                       datefmt='%H:%M:%S'))
    logger.addHandler(ch)
    return logger

log = setup_logging()

# ==================== SQLite 访问登记数据库 ====================
# DB 路径：优先环境变量 AUTODIAL_DB_PATH（Docker 场景映射到挂载卷，容器重建不丢数据），
# 否则与脚本同目录（Windows 桌面部署）
DB_PATH = os.environ.get('AUTODIAL_DB_PATH') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'visits.db')

# 内存降级库：`:memory:` 每次 connect 都会新建一个独立空库，44 处 _connect_db()
# 彼此看不到对方建的表 → 降级不是"重启丢数据"而是"整个后端直接不可用"。
# 改用 shared-cache 内存库 + 常驻 anchor 连接（anchor 一关库即被回收，故永不关闭），
# 让所有连接共享同一个内存库，降级才真正可用。
_MEM_DB_URI = 'file:autodial_memdb?mode=memory&cache=shared'
_mem_anchor = None

def _connect_db():
    """创建 SQLite 连接并统一设置连接级参数。

    F5修复: busy_timeout 是连接级 PRAGMA，此前只在 init_db 的首个连接上设置，
    其余 39 处 _connect_db() 在 Python 3.8-3.10 下默认立即报
    'database is locked'。统一入口后每个连接都带 5s 锁等待。
    """
    if DB_PATH == ':memory:':
        conn = sqlite3.connect(_MEM_DB_URI, uri=True, timeout=5.0)
    else:
        conn = sqlite3.connect(DB_PATH, timeout=5.0)
    try:
        conn.execute('PRAGMA busy_timeout=5000')
    except Exception:
        pass  # 内存库/极端环境忽略
    return conn

def init_db():
    """初始化 visits 表及索引，失败时降级到共享内存数据库"""
    global DB_PATH, _mem_anchor
    create_visits = '''CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pin TEXT NOT NULL,
        name TEXT NOT NULL,
        mobile TEXT NOT NULL,
        kefu_tel TEXT NOT NULL,
        visit_type TEXT DEFAULT '贷款咨询',
        source TEXT DEFAULT 'plugin',
        crm_synced INTEGER DEFAULT 0,
        visit_time TEXT DEFAULT '',
        crm_id TEXT DEFAULT NULL,
        visit_extra TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )'''
    create_advisor = '''CREATE TABLE IF NOT EXISTS advisor_names (
        pin TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )'''
    # v4.33: 人员名册（面板「刷新名单」从 CRM 同步而来）。DB 有数据即以 DB 为准，
    # 空表才回退内置 ADVISOR_ROSTER —— 于是「刷新过」与「没刷新过」语义清晰可分。
    create_roster = '''CREATE TABLE IF NOT EXISTS advisor_roster (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
    )'''
    create_admin_accounts = '''CREATE TABLE IF NOT EXISTS admin_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TEXT NOT NULL
    )'''
    create_groups = '''CREATE TABLE IF NOT EXISTS pin_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL
    )'''
    create_phones = '''CREATE TABLE IF NOT EXISTS phones (
        device_id TEXT PRIMARY KEY,
        label TEXT DEFAULT '',
        last_pin TEXT DEFAULT '',
        default_pin TEXT DEFAULT '',
        device_model TEXT DEFAULT '',
        app_version TEXT DEFAULT '',
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
    )'''
    create_call_records = '''CREATE TABLE IF NOT EXISTS call_records_raw (
        device_id TEXT NOT NULL,
        local_id INTEGER NOT NULL,
        number TEXT NOT NULL,
        dial_time INTEGER NOT NULL,
        duration INTEGER DEFAULT 0,
        call_type INTEGER DEFAULT 0,
        sim_slot INTEGER DEFAULT 0,
        server_time TEXT NOT NULL,
        PRIMARY KEY (device_id, local_id)
    )'''
    create_phone_events = '''CREATE TABLE IF NOT EXISTS phone_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_time TEXT NOT NULL,
        pin TEXT DEFAULT '',
        detail TEXT DEFAULT '',
        server_time TEXT NOT NULL
    )'''
    create_phone_daily = '''CREATE TABLE IF NOT EXISTS phone_daily_stats (
        device_id TEXT NOT NULL,
        date TEXT NOT NULL,
        server_dial INTEGER DEFAULT 0,
        server_conn INTEGER DEFAULT 0,
        server_dur INTEGER DEFAULT 0,
        phone_dial INTEGER DEFAULT 0,
        phone_conn INTEGER DEFAULT 0,
        phone_dur INTEGER DEFAULT 0,
        match_status TEXT DEFAULT 'OK',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (device_id, date)
    )'''
    # v4.15: 离线登记补推队列持久化（此前存内存，服务器重启即丢）
    create_pending_visits = '''CREATE TABLE IF NOT EXISTS pending_visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pin TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
    )'''
    try:
        conn = _connect_db()
        c = conn.cursor()
        # Fix P0-1: WAL mode to prevent DB write locks from blocking reads
        c.execute('PRAGMA journal_mode=WAL')
        c.execute('PRAGMA synchronous=NORMAL')
        c.execute('PRAGMA busy_timeout=5000')
        c.execute(create_visits)
        c.execute('CREATE INDEX IF NOT EXISTS idx_visits_pin ON visits(pin)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at)')
        # v4.17: 去重查询走索引，数据量大后去重不再全表扫
        c.execute('CREATE INDEX IF NOT EXISTS idx_visits_mobile ON visits(mobile)')
        c.execute(create_advisor)
        c.execute('CREATE INDEX IF NOT EXISTS idx_advisor_updated ON advisor_names(updated_at)')
        c.execute(create_groups)
        c.execute(create_admin_accounts)
        c.execute(create_phones)
        c.execute(create_call_records)
        # v4.21: 索引必须建在 create_call_records 之后——v4.17 曾把该索引放在建表前，
        # 全新 DB 首次初始化必抛 "no such table: main.call_records_raw"，
        # 走进 :memory: 降级分支（分支里同样先建索引再失败，最终所有数据落内存库，
        # 进程重启全部丢失）。线上库是旧库带表才一直没炸，属"潜伏雷"。
        c.execute('CREATE INDEX IF NOT EXISTS idx_call_records_dial ON call_records_raw(dial_time)')
        c.execute(create_phone_events)
        c.execute(create_phone_daily)
        c.execute(create_pending_visits)
        c.execute('CREATE INDEX IF NOT EXISTS idx_pending_visits_pin ON pending_visits(pin)')
        c.execute(create_roster)
        conn.commit()
        # 兼容旧版 DB：添加新列
        try: c.execute('ALTER TABLE visits ADD COLUMN crm_synced INTEGER DEFAULT 0'); conn.commit()
        except: pass  # column already exists
        try: c.execute('ALTER TABLE visits ADD COLUMN visit_time TEXT DEFAULT \'\''); conn.commit()
        except: pass  # column already exists
        try: c.execute('ALTER TABLE advisor_names ADD COLUMN group_id INTEGER DEFAULT NULL'); conn.commit()
        except: pass  # column already exists
        try: c.execute('ALTER TABLE visits ADD COLUMN crm_id TEXT DEFAULT NULL'); conn.commit()
        except: pass  # column already exists
        try: c.execute('ALTER TABLE visits ADD COLUMN visit_extra TEXT DEFAULT \'{}\''); conn.commit()
        except: pass  # column already exists
        try: c.execute('ALTER TABLE phones ADD COLUMN default_pin TEXT DEFAULT \'\''); conn.commit()
        except: pass  # column already exists
        # 为 crm_id 建唯一索引（SQLite ALTER TABLE 不支持 UNIQUE 列约束，需单独建索引）
        try: c.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_crm_id ON visits(crm_id)'); conn.commit()
        except: pass
        conn.close()
        log.info(f'Visits DB initialized at {DB_PATH}')
    except Exception as e:
        log.error(f'Database initialization failed: {e}. Using in-memory fallback.')
        DB_PATH = ':memory:'
        # anchor 连接常驻不关闭：shared-cache 内存库在最后一个连接关闭时会被销毁，
        # 关掉它等于降级库凭空消失（其余连接又各自看到独立空库）。
        # 注意：本分支的建表语句必须与上方 try 分支保持同步（改一处要改两处）。
        _mem_anchor = _connect_db()
        conn = _mem_anchor
        c = conn.cursor()
        c.execute(create_visits)
        c.execute('CREATE INDEX IF NOT EXISTS idx_visits_pin ON visits(pin)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at)')
        # v4.17: 去重查询走索引，数据量大后去重不再全表扫
        c.execute('CREATE INDEX IF NOT EXISTS idx_visits_mobile ON visits(mobile)')
        c.execute(create_advisor)
        c.execute('CREATE INDEX IF NOT EXISTS idx_advisor_updated ON advisor_names(updated_at)')
        c.execute(create_groups)
        c.execute(create_admin_accounts)
        c.execute(create_phones)
        c.execute(create_call_records)
        c.execute('CREATE INDEX IF NOT EXISTS idx_call_records_dial ON call_records_raw(dial_time)')
        c.execute(create_phone_events)
        c.execute(create_phone_daily)
        c.execute(create_pending_visits)
        c.execute('CREATE INDEX IF NOT EXISTS idx_pending_visits_pin ON pending_visits(pin)')
        c.execute(create_roster)
        conn.commit()
        try: c.execute('ALTER TABLE visits ADD COLUMN crm_synced INTEGER DEFAULT 0'); conn.commit()
        except: pass  # column already exists
        try: c.execute('ALTER TABLE visits ADD COLUMN visit_time TEXT DEFAULT \'\''); conn.commit()
        except: pass  # column already exists
        try: c.execute('ALTER TABLE advisor_names ADD COLUMN group_id INTEGER DEFAULT NULL'); conn.commit()
        except: pass  # column already exists
        try: c.execute('ALTER TABLE visits ADD COLUMN crm_id TEXT DEFAULT NULL'); conn.commit()
        except: pass  # column already exists
        try: c.execute('ALTER TABLE visits ADD COLUMN visit_extra TEXT DEFAULT \'{}\''); conn.commit()
        except: pass  # column already exists
        try: c.execute('ALTER TABLE phones ADD COLUMN default_pin TEXT DEFAULT \'\''); conn.commit()
        except: pass  # column already exists
        # 为 crm_id 建唯一索引（SQLite ALTER TABLE 不支持 UNIQUE 列约束，需单独建索引）
        try: c.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_crm_id ON visits(crm_id)'); conn.commit()
        except: pass
        # 不 close：见上方 anchor 注释。_mem_anchor 常驻，保证共享内存库不被回收。
        log.warning(f'DEGRADED: 已降级到共享内存库，数据不落盘、进程重启即丢，请检查 DB 文件与磁盘权限: {e}')

init_db()

# S6修复: 管理员密码哈希（不再明文存储）与登录失败限频
_ADMIN_SALT = 'autodial#v4'

def _hash_pwd(pwd):
    return hashlib.sha256((_ADMIN_SALT + pwd).encode('utf-8')).hexdigest()

# 登录失败时间戳（60 秒窗口内每 (username, client_ip) 最多 5 次失败，防爆破）
# S5修复: 由全局列表改为按 (username, client_ip) 维度计数，防止任何人失败 5 次
# 即锁死管理员登录（管理端 DoS）。仅单线程事件循环内访问，无需加锁。
_login_failures = {}  # (username, client_ip) -> [失败时间戳]

# 是否信任反向代理转发的来源 IP 头。
# X-Forwarded-For / X-Real-IP 由客户端可任意伪造，默认不采信——否则登录限频形同
# 虚设（每次换一个假 IP 就能无限试密码）。只有确认前面有可信反代时才开启。
_TRUST_PROXY_HEADERS = (os.environ.get('AUTODIAL_TRUST_PROXY') or '').strip().lower() in ('1', 'true', 'yes')

def _login_client_ip(hdrs):
    """提取客户端 IP。

    默认取 TCP 对端地址（_peer_ip，由协议层写入，不可伪造）；
    仅当显式设置 AUTODIAL_TRUST_PROXY=1 时才采信 X-Forwarded-For。
    """
    if _TRUST_PROXY_HEADERS:
        for h in ('x-forwarded-for', 'x-real-ip'):
            v = (hdrs.get(h) or '').strip()
            if v:
                return v.split(',')[0].strip()
    peer = _peer_ip.get()
    return peer or 'unknown'

def _prune_login_failures(now_ts):
    """移除全部过期条目（防 dict 无界增长）"""
    expired = [k for k, lst in _login_failures.items() if not lst or now_ts - lst[-1] > 60]
    for k in expired:
        del _login_failures[k]
    if len(_login_failures) > 2000:
        for k, lst in list(_login_failures.items()):
            _login_failures[k] = [t for t in lst if now_ts - t <= 60]
            if not _login_failures[k]:
                del _login_failures[k]

# 首次启动：创建默认管理员账号（如果没有任何账号）
def _seed_default_admin():
    conn = None
    try:
        conn = _connect_db()
        c = conn.cursor()
        c.execute('SELECT COUNT(*) FROM admin_accounts')
        if c.fetchone()[0] == 0:
            now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
            # 安全修复：初始账号/密码从环境变量读取；未设置时生成随机密码并打印到日志，
            # 不再在源码中硬编码已知弱口令（18335162275/123456）。
            seed_user = (os.environ.get('AUTODIAL_ADMIN_USER') or '').strip() or '18335162275'
            seed_pass = (os.environ.get('AUTODIAL_ADMIN_PASS') or '').strip()
            if not seed_pass:
                seed_pass = secrets.token_hex(4)
                log.warning('ADMIN_SEED: 未设置 AUTODIAL_ADMIN_PASS，已生成随机初始密码，请立即登录并修改。账号=%s 密码=%s',
                            seed_user, seed_pass)
            c.execute('INSERT INTO admin_accounts (username, password, created_at) VALUES (?, ?, ?)',
                      (seed_user, _hash_pwd(seed_pass), now_str))
            conn.commit()
            log.info('ADMIN_SEED: 已创建默认管理员账号 (%s)', seed_user)
    except Exception as e:
        log.error(f'ADMIN_SEED failed: {e}')
    finally:
        if conn:
            conn.close()
_seed_default_admin()

# ==================== 统计数据结构 ====================
start_time = datetime.now()
total_messages = 0
total_bytes_sent = 0
total_bytes_received = 0
message_count_by_pin = defaultdict(int)  # pin -> 消息数
message_count_by_type = defaultdict(int)  # 消息类型 -> 计数
daily_stats = defaultdict(lambda: {'messages': 0, 'bytes': 0})  # YYYY-MM-DD -> stats

# ==================== 连接数历史（供仪表盘趋势图） ====================
connection_history = []  # [{time: str, count: int}, ...]
MAX_HISTORY_POINTS = 2880  # 24小时 × 每30秒一次

def snapshot_connection_history():
    """记录当前连接数快照"""
    connection_history.append({
        'time': datetime.now().strftime('%Y-%m-%dT%H:%M:%S'),
        'count': len(ws_connections),
        'groups': len(pin_groups),
        'pcs': sum(1 for m in ws_meta.values() if m.get('role') == 'pc'),
        'phones': sum(1 for m in ws_meta.values() if m.get('role') == 'phone'),
    })
    if len(connection_history) > MAX_HISTORY_POINTS:
        connection_history.pop(0)

def cleanup_memory():
    """定期清理无界增长的数据结构，防止内存泄露"""
    # 1. message_count_by_pin: 保留 Top 200，其余删除
    if len(message_count_by_pin) > 200:
        top = sorted(message_count_by_pin.items(), key=lambda x: x[1], reverse=True)[:200]
        message_count_by_pin.clear()
        message_count_by_pin.update(top)
        log.info(f'MEM_CLEANUP: trimmed message_count_by_pin to top 200')

    # 2. last_ext_activity: 清理超过 1 小时未活跃的 PIN
    now = datetime.now()
    stale_pins = [p for p, t in list(last_ext_activity.items())
                  if (now - t).total_seconds() > 3600]
    for p in stale_pins:
        del last_ext_activity[p]
        last_ext_ip.pop(p, None)
    if stale_pins:
        log.info(f'MEM_CLEANUP: removed {len(stale_pins)} stale ext_activity entries')

    # 3. _pin_attempts / _rest_attempts: 清理超过 1 分钟未尝试的 IP
    for ip in list(_pin_attempts.keys()):
        _pin_attempts[ip] = [t for t in _pin_attempts[ip] if now - t < timedelta(minutes=1)]
        if not _pin_attempts[ip]:
            del _pin_attempts[ip]
    for ip in list(_rest_attempts.keys()):
        _rest_attempts[ip] = [t for t in _rest_attempts[ip] if now - t < timedelta(minutes=1)]
        if not _rest_attempts[ip]:
            del _rest_attempts[ip]

    # 4. pending_visits（v4.15 起持久化在 SQLite）: 清理 7 天前仍未补推成功的记录
    try:
        conn = _connect_db()
        c = conn.cursor()
        cutoff = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%S')
        c.execute('DELETE FROM pending_visits WHERE created_at < ?', (cutoff,))
        conn.commit()
        conn.close()
    except Exception:
        pass

    # 5. PinGroup.last_dial: 清理超过 10 分钟的拨号记录
    for pin, group in pin_groups.items():
        cutoff = time.time() - 600
        stale_numbers = [n for n, t in list(group.last_dial.items()) if t < cutoff]
        for n in stale_numbers:
            del group.last_dial[n]

    # 6. daily_stats: 保留最近 90 天
    sorted_dates = sorted(daily_stats.keys())
    if len(sorted_dates) > 90:
        for old_date in sorted_dates[:-90]:
            del daily_stats[old_date]

    # 7. pending_auths: 清除超时 120 秒的授权请求
    now_ts = time.time()
    expired_ids = [rid for rid, req in list(_pending_auths.items()) if now_ts - req['created_at'] > 120]
    for rid in expired_ids:
        req = _pending_auths.pop(rid, None)
        if req:
            async def _timeout_reject(ws=req['ws'], dn=req['device_name'], p=req['pin']):
                try:
                    await ws.send(json.dumps({
                        'type': 'auth_fail',
                        'reason': '授权超时：对方未在 CRM 界面确认。请对方打开 CRM 页面后，重新点击「连接」'
                    }))
                    await ws.close(4003, 'auth_timeout')
                except Exception:
                    pass
            _schedule_async(_timeout_reject())
            log.info(f'AUTH_TIMEOUT id={rid} device={dn} pin={p}')

    # 8. _admin_sessions: 清理已过期会话
    # 此前只在 _check_admin 命中同一个 token 时才惰性删除，无人访问的旧 token
    # 会永久留在 dict 里（只增不减）。
    expired_tokens = [t for t, exp in list(_admin_sessions.items()) if exp <= now_ts]
    for t in expired_tokens:
        _admin_sessions.pop(t, None)
    if expired_tokens:
        log.info(f'MEM_CLEANUP: removed {len(expired_tokens)} expired admin sessions')

def record_message(pin, msg_type, bytes_count):
    """记录消息统计"""
    global total_messages, total_bytes_sent, total_bytes_received
    total_messages += 1
    if msg_type in ('dial', 'sms', 'hangup', 'rest_dial', 'rest_hangup'):
        total_bytes_sent += bytes_count
    else:
        total_bytes_received += bytes_count
    message_count_by_pin[pin] += 1
    message_count_by_type[msg_type] += 1
    today = datetime.now().strftime('%Y-%m-%d')
    daily_stats[today]['messages'] += 1
    daily_stats[today]['bytes'] += bytes_count

# Fix ⏳4: persist daily stats to JSON file for survival across restarts
STATS_FILE = None

def save_stats():
    """Persist daily_stats to a JSON file"""
    global STATS_FILE
    if STATS_FILE is None:
        app_data = _data_dir()
        os.makedirs(app_data, exist_ok=True)
        STATS_FILE = os.path.join(app_data, 'stats.json')
    try:
        data = {
            'daily_stats': {k: dict(v) for k, v in daily_stats.items()},
            'total_messages': total_messages,
            'total_bytes_sent': total_bytes_sent,
            'total_bytes_received': total_bytes_received,
        }
        with open(STATS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception as e:
        log.warning(f'Failed to save stats: {e}')

def load_stats():
    """Restore persisted stats from JSON file"""
    global STATS_FILE, total_messages, total_bytes_sent, total_bytes_received
    if STATS_FILE is None:
        app_data = _data_dir()
        STATS_FILE = os.path.join(app_data, 'stats.json')
    if not os.path.exists(STATS_FILE):
        return
    try:
        with open(STATS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        ds = data.get('daily_stats', {})
        for k, v in ds.items():
            daily_stats[k]['messages'] = v.get('messages', 0)
            daily_stats[k]['bytes'] = v.get('bytes', 0)
        total_messages = data.get('total_messages', 0)
        total_bytes_sent = data.get('total_bytes_sent', 0)
        total_bytes_received = data.get('total_bytes_received', 0)
        log.info(f'Stats restored: {total_messages} messages across {len(daily_stats)} days')
    except Exception as e:
        log.warning(f'Failed to load stats (starting fresh): {e}')

# ==================== PIN 分组管理 ====================
class PinGroup:
    def __init__(self):
        self.pcs = set()      # websocket connections
        self.phones = set()   # websocket connections
        self.last_dial = {}   # {number: timestamp}  REST 端点并发保护
        self.pending_visits = []  # 手机离线时堆积的 visit_record

# pin -> PinGroup
pin_groups: dict[str, PinGroup] = defaultdict(PinGroup)

# websocket -> metadata
ws_meta: dict = {}  # ws -> {pin, role, ip, device_name, connected_at, last_message_time}

def get_group(pin):
    if pin not in pin_groups:
        pin_groups[pin] = PinGroup()
    return pin_groups[pin]

def validate_pin(pin):
    """PIN 校验：仅接受 4 位或 11 位纯数字（兼容老版 4 位 PC 端 + 新版 11 位手机号）"""
    return pin and pin.isdigit() and (len(pin) == 4 or len(pin) == 11)

def today_start_ms():
    from datetime import datetime as dt
    today = dt.now().replace(hour=0, minute=0, second=0, microsecond=0)
    return int(today.timestamp() * 1000)

def today_end_ms():
    from datetime import datetime as dt
    tomorrow = dt.now().replace(hour=0, minute=0, second=0, microsecond=0)
    from datetime import timedelta
    tomorrow += timedelta(days=1)
    return int(tomorrow.timestamp() * 1000)

def remove_from_group(ws):
    meta = ws_meta.get(ws)
    if not meta or not meta.get('pin'):
        return
    pin = meta['pin']
    group = pin_groups.get(pin)
    if not group:
        return
    was_member = (ws in group.pcs) or (ws in group.phones)
    group.pcs.discard(ws)
    group.phones.discard(ws)
    # v4.15: 只有当该连接此前确实还在组内时才允许清空整组。
    # 否则会踩中"先踢后删"竞态：新手机刚被加入组、旧连接的 finally 才执行到这里，
    # 把带着新手机的组从字典里删掉 → 新手机假在线，收不到任何 dial/visit_record。
    if was_member and not group.pcs and not group.phones:
        del pin_groups[pin]

# ==================== 心跳超时检测 ====================
HEARTBEAT_TIMEOUT = 90  # 90秒没收到消息就断开
MAX_TOTAL_CONNECTIONS = 500  # 全局连接上限（腾讯云中等配置安全值）

# ==================== PIN 尝试频率限制 ====================
MAX_PIN_ATTEMPTS_PER_MINUTE = 5
_pin_attempts: dict[str, list] = defaultdict(list)

def check_rate_limit(client_ip: str, pin: str = '') -> bool:
    """检查是否超频，返回 True 表示应该拒绝。
    v4.15: 限频维度从"仅 IP"改为"IP+PIN"——同一办公室 NAT 出口下的多台设备
    互不挤占配额，避免早上全员开机时只有前 5 台能连上、其余被"请求过于频繁"拒绝。"""
    # P1: localhost 请求不限频（健康检查、管理界面自身调用）
    if client_ip in ('127.0.0.1', '::1', 'localhost'):
        return False
    now = datetime.now()
    # 清理过期条目
    key = f'{client_ip}|{pin}' if pin else client_ip
    _pin_attempts[key] = [
        t for t in _pin_attempts[key] if now - t < timedelta(minutes=1)
    ]
    if len(_pin_attempts[key]) >= MAX_PIN_ATTEMPTS_PER_MINUTE:
        return True
    _pin_attempts[key].append(now)
    return False

# ==================== v4.18: REST 全局限频 ====================
# legacy process_request 回调拿不到对端地址，改用协议子类在握手时捕获并放入 ContextVar
_peer_ip: contextvars.ContextVar = contextvars.ContextVar('peer_ip', default='')

# v4.21: POST body 同理经 ContextVar 传递（process_request 在 read_http_request 之后
# 运行，请求体留在协议实例的 StreamReader 中，由 _PeerProtocol 统一读取）
_request_body: contextvars.ContextVar = contextvars.ContextVar('request_body', default='')

# v4.21: 限流按端点分级。原"所有 /api/v1/ 共享 60/min/IP"会把同一办公室（共用出口 IP）
# 的业务请求一起拦掉（线上已发生 /api/v1/visit 被 429）。
# 分级原则：
#   - 认证/管理类：严格（防爆破），维持 60/min/IP
#   - 高频轮询类（扩展授权轮询）：单独配额且阈值高（正常心跳流量，不算滥用）
#   - 业务类（拨号/登记/上报/查询）：放宽到 600/min/IP，仍能兜底防滥用
MAX_REST_AUTH_PER_MINUTE = 60
MAX_REST_POLL_PER_MINUTE = 240
MAX_REST_BIZ_PER_MINUTE = 600

# 轮询类端点（扩展后台例行查询，非用户操作）
_REST_POLL_PATHS = {'/api/v1/auth/pending'}

# 认证/管理类端点：失败即封爆破面，按严格阈值
_REST_AUTH_PATHS = {
    '/api/v1/login', '/api/v1/admin/add', '/api/v1/admin/del',
    '/api/v1/admin/chpwd', '/api/v1/admin/accounts', '/api/v1/auth/respond',
}

# v4.29: 通话记录「认人」口径 —— 用手机主人 default_pin，不用 last_pin。
#   业务背景（用户 2026-09-17 确认真实场景）：手机不换人，但**上午用本人 PIN、下午 15-16 点
#   改用同事 PIN** 打同事的客户。last_pin 是三处上报（events/log、stats/report、
#   set_default_pin）**覆盖式**写入的"最后一次登录 PIN" ⇒ 下午一换，该机**上午的记录会整体
#   漂移到同事名下**，「某人今天打了多少通」直接答错。
#   default_pin 才是这台手机的主人（首次握手自动绑定、后台可手动改、借人授权时明确"不改"），
#   语义与手机管理页已有的「默认PIN」列一致。
#   边界：从未握手注册、只走过上报的设备 default_pin 为空 ⇒ 回退 last_pin，避免出现空归属。
#   ⚠️ 两个 SQL 片段必须同时使用，勿只改一处。
_OWNER_PIN_SQL = "COALESCE(NULLIF(p.default_pin, ''), p.last_pin)"

_rest_attempts: dict[str, list] = defaultdict(list)

def _rest_limit_for(path: str) -> int:
    if path in _REST_POLL_PATHS:
        return MAX_REST_POLL_PER_MINUTE
    if path in _REST_AUTH_PATHS:
        return MAX_REST_AUTH_PER_MINUTE
    return MAX_REST_BIZ_PER_MINUTE

def check_rest_rate_limit(client_ip: str, path: str = '') -> bool:
    """REST 端点限频，返回 True 表示应拒绝（429）。堵 PIN 枚举/管理口令爆破/接口滥用。
    v4.21: 按"端点分级"计配额——认证类严格、轮询类独立、业务类放宽。"""
    if not client_ip or client_ip in ('127.0.0.1', '::1', 'localhost'):
        return False
    now = datetime.now()
    key = f'{client_ip}|{_rest_limit_for(path)}'
    _rest_attempts[key] = [t for t in _rest_attempts[key] if now - t < timedelta(minutes=1)]
    limit = _rest_limit_for(path)
    if len(_rest_attempts[key]) >= limit:
        return True
    _rest_attempts[key].append(now)
    return False

class _PeerProtocol(websockets.legacy.server.WebSocketServerProtocol):
    """捕获对端 IP 后再走常规 HTTP 处理（health_check_handler）。

    注意：process_request 以实例属性方式设置，避免被 serve(process_request=...) kwarg
    覆盖；create_protocol 工厂不传 process_request。
    """
    def __init__(self, *args, **kwargs):
        kwargs.pop('process_request', None)
        super().__init__(*args, **kwargs)
        self.process_request = self._process_request_with_peer
        self.http_method = 'GET'

    async def read_http_request(self):
        """v4.21: 放行 POST 方法（REST 大负载走请求体）。

        websockets 原版 read_http_request 调 read_request()，其中硬编码
        method != b"GET" 即抛 ValueError("unsupported HTTP method")，POST 请求
        在解析请求行时就被拒（网页端会收到 400）。这里复刻原版读取逻辑但不限
        method；WS 握手请求 method 必为 GET，行为不变。"""
        try:
            request_line = await self.reader.readline()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise InvalidMessage('did not receive a valid HTTP request') from exc
        if len(request_line) > ws_http.MAX_LINE_LENGTH + 2:
            raise InvalidMessage('HTTP request line too long')
        if not request_line.endswith(b'\r\n'):
            raise InvalidMessage('HTTP request line without CRLF')
        request_line = request_line[:-2]
        try:
            method, raw_path, version = request_line.split(b' ', 2)
        except ValueError:
            raise InvalidMessage('invalid HTTP request line') from None
        if version != b'HTTP/1.1':
            raise InvalidMessage('unsupported HTTP version')
        try:
            headers = await ws_http.read_headers(self.reader)
        except Exception as exc:
            raise InvalidMessage('invalid HTTP headers') from exc
        self.http_method = method.decode('ascii', 'replace').upper()
        self.path = raw_path.decode('ascii', 'surrogateescape')
        self.request_headers = headers
        return self.path, headers

    async def _process_request_with_peer(self, path, request_headers):
        try:
            ra = self.remote_address
            _peer_ip.set(ra[0] if isinstance(ra, tuple) else str(ra))
        except Exception:
            pass
        # v4.21: 读取 POST body（websockets 不解析请求体，只留原始字节在 self.reader）。
        # batch 等大负载端点改走 POST body，绕开 GET URL 8KB 硬上限。
        hdrs = dict(request_headers)
        try:
            content_length = int(hdrs.get('content-length', '0') or '0')
        except ValueError:
            content_length = 0
        if self.http_method == 'POST' and content_length > 0:
            try:
                body = await self.reader.readexactly(content_length)
                _request_body.set(body.decode('utf-8', errors='replace'))
            except (asyncio.IncompleteReadError, ValueError) as e:
                log.warning(f'POST_BODY_READ_FAIL: {e}')
                _request_body.set('')
        else:
            _request_body.set('')
        return await health_check_handler(path, request_headers)

# ==================== 消息转发 ====================
PHONE_TO_PC_TYPES = {
    'phone_hello', 'dial_result', 'sms_result', 'ping', 'ack',
    # 上传协议（无状态透传）
    'file_upload_start', 'file_chunk', 'file_upload_complete', 'file_upload_error'
}
PC_TO_PHONE_TYPES = {
    'auth_ok', 'auth_fail', 'dial', 'sms', 'hangup', 'ack',
    # 上传协议（无状态透传）
    'file_chunk_ack', 'file_upload_error',
    # 访问登记推送
    'visit_record',
    # F3修复: PC 端云端唤醒指令此前不在白名单，到达云中继即被丢弃，导致离线手机无法被唤醒
    'reconnect_request'
}

async def forward_to_pcs(pin, message, exclude_ws=None):
    group = pin_groups.get(pin)
    if not group:
        return
    data = json.dumps(message, ensure_ascii=False)
    for pc in list(group.pcs):
        if pc != exclude_ws:
            try:
                await pc.send(data)
            except Exception as e:
                log.warning(f'forward_to_pcs failed pin={pin}: {e}')  # C3修复: 记录转发失败日志
                group.pcs.discard(pc)

async def forward_to_phones(pin, message, exclude_ws=None):
    group = pin_groups.get(pin)
    if not group:
        return 0
    data = json.dumps(message, ensure_ascii=False)
    target_device = message.get('targetDevice')
    sent_count = 0
    # P0-4: 创建快照避免迭代过程中集合被其他协程修改
    phones_snapshot = [(p, ws_meta.get(p, {})) for p in list(group.phones)]
    for phone, phone_meta in phones_snapshot:
        if phone != exclude_ws:
            # 如果指定了 targetDevice，只转发给匹配的设备
            if target_device:
                phone_name = phone_meta.get('device_name', '')
                phone_pin = phone_meta.get('pin', '') or ''
                # F3修复: 各端历史上 targetDevice 时而传设备名、时而传 PIN，这里两者都兼容
                if phone_name != target_device and phone_pin != target_device:
                    continue
            try:
                await phone.send(data)
                sent_count += 1
            except Exception:
                group.phones.discard(phone)
    if target_device:
        log.info(f'ROUTED to {sent_count} phone(s) matching targetDevice={target_device} pin={pin}')
    if sent_count == 0 and target_device:
        log.warning(f'NO phone matched targetDevice={target_device} pin={pin} (available: {[ws_meta.get(p, {}).get("device_name", "?") for p in group.phones]})')
    # 返回实际送达数。调用方必须据此判断"是否真的发出去了"：连接已死但还留在
    # group.phones 里的"僵尸手机"会让 send 抛异常 → 既没送达也没落 pending，
    # 这条登记就无痕丢失了。
    return sent_count

# ==================== WebSocket 处理 ====================
server_instance = None
ws_connections = set()
EXT_ACTIVITY_TIMEOUT = 300  # 5分钟内收到过扩展REST请求视为在线
last_ext_activity = {}  # pin -> datetime 记录扩展最后活跃时间
last_ext_ip = {}        # pin -> 发起轮询的对端 IP（授权响应归属校验用，见 auth/respond）

def track_ext_activity(pin):
    """记录扩展活跃时间与来源 IP（每次REST请求调用）"""
    if not pin:
        return
    last_ext_activity[pin] = datetime.now()
    last_ext_ip[pin] = _peer_ip.get() or ''

def is_ext_online(pin):
    """扩展是否在线（5分钟内有REST请求）"""
    last = last_ext_activity.get(pin)
    if not last:
        return False
    return (datetime.now() - last).total_seconds() < EXT_ACTIVITY_TIMEOUT

async def handle_connection(ws, path=None):
    client_ip = ws.remote_address[0] if ws.remote_address else 'unknown'
    
    # 连接数上限保护
    if len(ws_connections) >= MAX_TOTAL_CONNECTIONS:
        log.warning(f'REJECTED max_connections={MAX_TOTAL_CONNECTIONS} ip={client_ip}')
        await ws.close(1013, '服务器连接数已达上限')
        return
    
    ws_meta[ws] = {
        'pin': None,
        'role': None,
        'ip': client_ip,
        'device_name': None,
        'connected_at': datetime.now().isoformat(),
        'last_message_time': datetime.now()  # 添加最后消息时间用于心跳超时检测
    }
    ws_connections.add(ws)

    log.info(f'CONNECT {client_ip} (path={path})')
    
    # v6诊断: 记录详细信息便于排查连接问题
    log.info(f'CONNECT_DETAIL ip={client_ip} remote_address={ws.remote_address} local_address={ws.local_address}')

    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
                msg_type = msg.get('type', '')
            except json.JSONDecodeError:
                continue

            # 更新最后消息时间（用于应用层心跳检测）
            if ws in ws_meta:
                ws_meta[ws]['last_message_time'] = datetime.now()

            meta = ws_meta.get(ws, {})

            # ===== 手机端握手 =====
            if msg_type == 'phone_hello':
                pin = msg.get('pin', '')
                # v4.15: 频率限制改为 IP+PIN 维度
                rl_key = f'{client_ip}|{pin}' if pin else client_ip
                if check_rate_limit(client_ip, pin):
                    await ws.send(json.dumps({'type': 'auth_fail', 'reason': '请求过于频繁，请稍后再试'}))
                    log.warning(f'RATE_LIMITED phone_hello ip={client_ip} pin={pin}')
                    # v6诊断: 记录当前速率限制状态
                    recent_attempts = len([t for t in _pin_attempts.get(rl_key, []) if datetime.now() - t < timedelta(minutes=1)])
                    log.warning(f'RATE_LIMIT_STATE key={rl_key} attempts_in_last_minute={recent_attempts}/{MAX_PIN_ATTEMPTS_PER_MINUTE}')
                    continue
                if not validate_pin(pin):
                    await ws.send(json.dumps({'type': 'auth_fail', 'reason': '配对码须为4位或11位数字'}))
                    continue
                remove_from_group(ws)
                meta['pin'] = pin
                meta['role'] = 'phone'
                meta['device_name'] = msg.get('deviceName', f'Phone-{client_ip[-3:]}')
                # v4.16 修复B: 设备唯一键改用手机端 deviceId（现有 device_uuid），向后兼容旧 APK 回退 deviceName
                meta['device_id'] = msg.get('deviceId') or meta['device_name']
                # S2修复: 每次重新握手先清除授权标记，防止旧会话授权状态被带到新 PIN
                meta['authorized'] = False
                group = get_group(pin)
                # C-4 修复（v4.21.2，管理员拍板"配对成功再踢下线"）：同 PIN 只允许一台手机在线，
                # 但踢旧机从"授权判定之前"推迟到"授权判定成功之后"。
                # 此前无条件先踢：待授权设备（默认 PIN 不匹配、等待浏览器插件授权，甚至授权被拒）
                # 也会先顶掉该 PIN 正在线的手机 → 员工"莫名其妙掉线"。
                # 幽灵分组竞态防备保留：先从组内移出再 close（旧连接 finally 不会误删整组）。
                async def _kick_old_phones():
                    for old_phone in list(group.phones):
                        if old_phone != ws:
                            group.phones.discard(old_phone)
                            try:
                                await old_phone.close(4001, 'duplicate_reconnect')
                            except Exception:
                                pass
                # is_first_device 语义不变：组内无 PC 且无"将被踢掉的"其他手机
                is_first_device = len(group.pcs) == 0 and not any(p != ws for p in group.phones)

                # ===== 设备-PIN 绑定授权检查 =====
                # v4.16 修复B: 绑定/查询/去重一律用 device_id；面向用户的消息继续传 device_name
                device_id = meta['device_id']
                device_name = meta['device_name']
                default_pin = _get_device_default_pin(device_id)
                needs_auth = False

                if default_pin is None:
                    if AUTO_REGISTER_DEVICE:
                        # v4.16.1: 自动注册 —— 未知设备绑定到当前使用的 PIN，直接放行
                        _set_device_default_pin(device_id, pin)
                        default_pin = pin
                        log.info(f'AUTO_REGISTER device={device_id} name={device_name} pin={pin} ip={client_ip}')
                    else:
                        # 严格模式：设备未在云端注册 → 拒绝
                        await ws.send(json.dumps({
                            'type': 'auth_fail',
                            'reason': f'设备 {device_name} 未在云端注册，请联系管理员预设默认 PIN'
                        }))
                        log.warning(f'AUTH_DENIED_NO_DEFAULT device={device_id} name={device_name} pin={pin}')
                        continue
                elif default_pin != pin:
                    # PIN 不匹配：需扩展端授权（仅当目标 PIN 的扩展已激活且 CRM 页面打开）
                    needs_auth = True
                    ext_online = is_ext_online(pin)
                    if not ext_online:
                        # v4.16.1: 直接拒绝并给出可操作提示——对方打开 CRM 后重连即可重新检测
                        await ws.send(json.dumps({
                            'type': 'auth_fail',
                            'reason': f'需对方授权：请对方（PIN {pin}）在电脑上打开 CRM 界面后，重新点击「连接」'
                        }))
                        log.warning(f'AUTH_DENIED_EXT_OFFLINE device={device_id} name={device_name} pin={pin} default_pin={default_pin}')
                        continue
                    # 创建授权请求
                    req_id = uuid.uuid4().hex[:12]
                    _pending_auths[req_id] = {
                        'ws': ws,
                        'pin': pin,
                        'device_id': device_id,
                        'device_name': device_name,
                        'default_pin': default_pin,
                        'created_at': time.time()
                    }
                    # 通知新 PIN 组内已连接的 PC（可选，扩展轮询为主要途径）
                    auth_msg = json.dumps({
                        'type': 'auth_request',
                        'request_id': req_id,
                        'device_name': device_name,
                        'pin': pin,
                        'default_pin': default_pin,
                        'note': f'设备 {device_name} 请求使用 PIN {pin}（默认PIN: {default_pin}）'
                    }, ensure_ascii=False)
                    for pc_ws in list(group.pcs):
                        try:
                            await pc_ws.send(auth_msg)
                        except Exception:
                            pass
                    # Round3: 卸载同步 DB 查询到线程池，避免阻塞事件循环
                    owner_name = ''
                    try:
                        loop_ref = asyncio.get_running_loop()
                        def _query_owner_name():
                            conn = _connect_db()
                            try:
                                c = conn.cursor()
                                c.execute('SELECT name FROM advisor_names WHERE pin=?', (default_pin,))
                                row = c.fetchone()
                                return row[0] if row else ''
                            finally:
                                conn.close()
                        owner_name = await loop_ref.run_in_executor(_db_executor, _query_owner_name)
                    except Exception:
                        pass
                    # 通知手机等待授权
                    await ws.send(json.dumps({
                        'type': 'auth_pending',
                        'request_id': req_id,
                        'pin': pin,
                        'default_pin': default_pin,     # 手机主人的PIN
                        'default_name': owner_name,      # 手机主人的姓名
                        'message': f'等待 PIN {pin} 的浏览器插件授权中（需 CRM 页面打开）...'
                    }))
                    log.info(f'AUTH_REQUEST id={req_id} device={device_id} name={device_name} pin={pin} default_pin={default_pin} ext_online=1')

                if needs_auth:
                    continue  # 跳过后续处理，等待 PC 授权

                # S2修复: 授权通过（default_pin 匹配），标记连接为已授权，此后消息才允许转发给 PC
                # C-4: 配对成功此刻才踢旧机。注意：踢旧机会把同 PIN 的其他手机移出
                # group.phones，导致下面"通知已有手机"分支永远遍历到空集合（通知形同虚设）。
                # 所以先快照，通知时用快照。
                _pre_join_phones = [p for p in list(group.phones) if p is not ws]
                await _kick_old_phones()  # C-4: 配对成功此刻才踢旧机
                meta['authorized'] = True
                group.phones.add(ws)
                pc_online = len(group.pcs) > 0
                # Round3: 卸载同步 DB 查询到线程池，避免阻塞事件循环
                owner_name = ''
                try:
                    loop_ref = asyncio.get_running_loop()
                    def _query_owner_name2():
                        conn = _connect_db()
                        try:
                            c = conn.cursor()
                            c.execute('SELECT name FROM advisor_names WHERE pin=?', (default_pin,))
                            row = c.fetchone()
                            return row[0] if row else ''
                        finally:
                            conn.close()
                    owner_name = await loop_ref.run_in_executor(_db_executor, _query_owner_name2)
                except Exception:
                    pass
                await ws.send(json.dumps({
                    'type': 'auth_ok',
                    'pin': pin,
                    'default_pin': default_pin,       # 手机主人的PIN
                    'default_name': owner_name,       # 手机主人的姓名
                    'pcCount': len(group.pcs),
                    'pc_present': pc_online,
                    'ext_online': is_ext_online(pin),
                    'newDevice': not is_first_device
                }))
                # Fix ⏳5: 如果非首设备加入已有组，广播通知给已有成员
                if not is_first_device:
                    existing_devices = []
                    for w in list(group.pcs | group.phones):
                        if w != ws:
                            wm = ws_meta.get(w, {})
                            existing_devices.append(wm.get('device_name', '?'))
                    # 通知已有手机（用加入前的快照——踢旧机已经把 group.phones 清空了，
                    # 直接遍历 group.phones 这个分支永远进不来）
                    for phone_ws in _pre_join_phones:
                        if phone_ws is ws:
                            continue
                        try:
                            await phone_ws.send(json.dumps({
                                'type': 'new_device_join',
                                'deviceName': meta['device_name'],
                                'role': 'phone',
                                'pin': pin
                            }))
                        except Exception:
                            pass
                    # 通知已有 PC
                    for pc_ws in list(group.pcs):
                        try:
                            await pc_ws.send(json.dumps({
                                'type': 'new_device_join',
                                'deviceName': meta['device_name'],
                                'role': 'phone',
                                'pin': pin
                            }))
                        except Exception:
                            pass
                    log.info(f'NEW_DEVICE_JOIN pin={pin} device={meta["device_name"]} existing={existing_devices}')
                # 转发 phone_hello 给同 PIN 的所有 PC
                # Bug6修复 + v4.16: 附加 deviceId（现用 device_id 唯一键），使 PC 端能正确识别云端设备
                msg['deviceId'] = meta.get('device_id') or meta['device_name']
                await forward_to_pcs(pin, msg, ws)
                record_message(pin, msg_type, len(raw))
                log.info(f'PHONE_HELLO pin={pin} device={meta["device_id"]} name={meta["device_name"]} ip={client_ip} pcs={len(group.pcs)}')
                # 补推离线堆积的 visit_record（v4.15: 从 SQLite 读取，重启不丢）
                pending_rows = _db_get_pending_visits(pin)
                if pending_rows:
                    pushed = 0
                    for vid, visit in pending_rows:
                        try:
                            sent = await forward_to_phones(pin, {
                                'type': 'visit_record',
                                'data': visit
                            })
                        except Exception:
                            continue  # 发送异常，保留 pending 下次重试
                        if not sent:
                            # 未真正送达就不要删 pending——此前删库与"送达"脱钩，
                            # 补推失败也照样删，登记从此消失。
                            continue
                        _db_delete_pending_visit(vid)
                        pushed += 1
                    log.info(f'phone_hello pin={pin}: pushed {pushed}/{len(pending_rows)} pending visits')
                continue

            # ===== PC 端握手 =====
            if msg_type == 'pc_hello':
                pin = msg.get('pin', '')
                # v4.15: 频率限制改为 IP+PIN 维度（与 phone_hello 对齐）
                rl_key = f'{client_ip}|{pin}' if pin else client_ip
                if check_rate_limit(client_ip, pin):
                    await ws.send(json.dumps({'type': 'pc_auth_fail', 'reason': '请求过于频繁，请稍后再试'}))
                    log.warning(f'RATE_LIMITED pc_hello ip={client_ip} pin={pin}')
                    recent_attempts = len([t for t in _pin_attempts.get(rl_key, []) if datetime.now() - t < timedelta(minutes=1)])
                    log.warning(f'RATE_LIMIT_STATE key={rl_key} attempts_in_last_minute={recent_attempts}/{MAX_PIN_ATTEMPTS_PER_MINUTE}')
                    continue
                if not validate_pin(pin):
                    await ws.send(json.dumps({'type': 'pc_auth_fail', 'reason': '配对码须为4位或11位数字'}))
                    continue
                remove_from_group(ws)
                meta['pin'] = pin
                meta['role'] = 'pc'
                meta['device_name'] = msg.get('hostname', f'PC-{client_ip[-3:]}')
                group = get_group(pin)
                group.pcs.add(ws)
                await ws.send(json.dumps({
                    'type': 'pc_auth_ok',
                    'pin': pin,
                    'phoneCount': len(group.phones)
                }))
                # Bug9修复: 把已在线手机的 phone_hello 补发给新连接的 PC
                for phone_ws in list(group.phones):
                    phone_meta = ws_meta.get(phone_ws, {})
                    phone_device_name = phone_meta.get('device_name', '')
                    if phone_device_name:
                        try:
                            await ws.send(json.dumps({
                                'type': 'phone_hello',
                                'pin': pin,
                                'deviceName': phone_device_name,
                                # v4.16: 用 device_id 唯一键（旧 meta 无此字段时回退 device_name）
                                'deviceId': phone_meta.get('device_id') or phone_device_name,
                                'reconnect': True
                            }))
                            log.info(f'RESEND phone_hello to new PC: device={phone_device_name} pin={pin}')
                        except Exception as e:
                            log.warning(f'Failed to resend phone_hello: {e}')
                record_message(pin, msg_type, len(raw))
                log.info(f'PC_HELLO pin={pin} hostname={meta["device_name"]} ip={client_ip} phones={len(group.phones)}')
                # v8: PC 上线后通知同 PIN 所有手机
                if len(group.phones) > 0:
                    await forward_to_phones(pin, {
                        'type': 'pc_online',
                        'pin': pin,
                        'pcCount': len(group.pcs),
                        'hostname': meta['device_name']
                    })
                continue

            # ===== 未握手则拒绝 =====
            if not meta.get('pin'):
                await ws.send(json.dumps({'type': 'error', 'reason': '请先发送 phone_hello 或 pc_hello'}))
                continue

            # ===== PC 端响应设备授权 =====
            if msg_type == 'auth_response':
                # 安全修复: 仅允许 PC 端响应授权，防止等待授权的手机自批（此前 meta.pin 已设置即可通过）
                if meta.get('role') != 'pc':
                    await ws.send(json.dumps({'type': 'auth_response_ack', 'ok': False, 'reason': '仅 PC 端可响应授权'}))
                    continue
                req_id = msg.get('request_id', '')
                allow = msg.get('allow', False)
                auth_req = _pending_auths.pop(req_id, None)
                if not auth_req:
                    await ws.send(json.dumps({'type': 'auth_response_ack', 'ok': False, 'reason': '授权请求已过期或不存在'}))
                    continue
                phone_ws = auth_req['ws']
                device_name = auth_req['device_name']
                auth_pin = auth_req['pin']
                default_pin = auth_req['default_pin']
                if allow:
                    # 授权通过：加入分组发送 auth_ok（不改变 default_pin，仅本次会话有效）
                    group = get_group(auth_pin)
                    # 踢掉相同 PIN 的旧手机
                    # v4.15: 先移出组再 close，防止 close 等待期间旧连接 finally 误删整组
                    for old_phone in list(group.phones):
                        group.phones.discard(old_phone)
                        try:
                            await old_phone.close(4001, 'duplicate_reconnect')
                        except Exception:
                            pass
                    group.phones.add(phone_ws)
                    # S2修复: 授权通过后标记手机连接为已授权，此后其消息才允许转发给 PC
                    phone_meta = ws_meta.get(phone_ws)
                    if phone_meta is not None:
                        phone_meta['authorized'] = True
                    pc_online = len(group.pcs) > 0
                    try:
                        await phone_ws.send(json.dumps({
                            'type': 'auth_ok',
                            'pin': auth_pin,
                            'pcCount': len(group.pcs),
                            'pc_present': pc_online,
                            'ext_online': is_ext_online(auth_pin),
                            'newDevice': len(group.pcs) > 0
                        }))
                        # 转发 phone_hello 给同 PIN 的 PC
                        await forward_to_pcs(auth_pin, {
                            'type': 'phone_hello',
                            'pin': auth_pin,
                            'deviceName': device_name,
                            # v4.16: device_id 唯一键
                            'deviceId': auth_req.get('device_id') or device_name
                        }, phone_ws)
                    except Exception:
                        pass
                    await ws.send(json.dumps({'type': 'auth_response_ack', 'ok': True}))
                    log.info(f'AUTH_APPROVED id={req_id} device={auth_req.get("device_id") or device_name} name={device_name} pin={auth_pin} approved_by_pc={meta.get("device_name","?")}')
                else:
                    # 授权拒绝
                    try:
                        await phone_ws.send(json.dumps({
                            'type': 'auth_fail',
                            'reason': f'浏览器插件拒绝了设备 {device_name} 使用 PIN {auth_pin}'
                        }))
                        await phone_ws.close(4003, 'auth_denied')
                    except Exception:
                        pass
                    await ws.send(json.dumps({'type': 'auth_response_ack', 'ok': True}))
                    log.info(f'AUTH_DENIED id={req_id} device={auth_req.get("device_id") or device_name} name={device_name} pin={auth_pin} denied_by_pc={meta.get("device_name","?")}')
                continue

            pin = meta['pin']

            # ===== 手机→PC 转发 =====
            if msg_type in PHONE_TO_PC_TYPES:
                # ping 消息附加设备名称，便于 PC 端识别心跳来源
                if msg_type == 'ping':
                    msg['deviceName'] = meta.get('device_name', '')
                # S2修复: 未授权手机（等待授权中/被拒绝但仍保持连接）的消息不得转发给 PC；
                # 仅保留心跳 pong，避免被拒连接继续向 PC 注入 dial_result/file_chunk 等白名单消息。
                if meta.get('role') == 'phone' and not meta.get('authorized'):
                    if msg_type == 'ping':
                        await ws.send(json.dumps({'type': 'pong'}))
                        record_message(pin, msg_type, len(raw))
                    continue
                # ack 消息记录路由信息
                if msg_type == 'ack':
                    log.info(f'RELAY ack phone→pc pin={pin} messageId={msg.get("messageId","?")} originalType={msg.get("originalType","?")} deviceName={msg.get("deviceName","?")}')
                await forward_to_pcs(pin, msg, ws)
                record_message(pin, msg_type, len(raw))
                if msg_type == 'ping':
                    await ws.send(json.dumps({'type': 'pong'}))
                    # ping 不记日志，避免刷屏
                elif msg_type != 'ack':
                    log.info(f'RELAY {msg_type} phone→pc pin={pin}')
                continue

            # ===== PC→手机 转发 =====
            if msg_type in PC_TO_PHONE_TYPES:
                target = msg.get('targetDevice', '')
                log.info(f'RELAY {msg_type} pc→phone pin={pin} targetDevice={target}')
                await forward_to_phones(pin, msg, ws)
                record_message(pin, msg_type, len(raw))
                continue

            # ===== 通用 ping/pong（任何角色发 ping 都回复 pong）=====
            if msg_type == 'ping':
                await ws.send(json.dumps({'type': 'pong'}))
                record_message(pin, 'ping', len(raw))
                continue

            log.info(f'UNKNOWN type={msg_type} pin={pin}')

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        import traceback
        log.error(f'Connection error: {e}\nTraceback:\n{traceback.format_exc()}')
    finally:
        remove_from_group(ws)
        meta = ws_meta.pop(ws, {})
        ws_connections.discard(ws)
        role = meta.get('role', 'unknown')
        pin = meta.get('pin', 'none')
        ip = meta.get('ip', '?')
        log.info(f'DISCONNECT {role} pin={pin} ip={ip}')
        # 清理该连接关联的待授权请求
        stale = [rid for rid, req in list(_pending_auths.items()) if req['ws'] is ws]
        for rid in stale:
            _pending_auths.pop(rid, None)
            log.info(f'AUTH_CLEANUP id={rid}: phone disconnected while waiting')
        # v8: 如果断线的是 PC，通知同 PIN 所有手机 PC 已离线
        if role == 'pc' and pin != 'none':
            group = pin_groups.get(pin)
            if group and len(group.phones) > 0:
                try:
                    await forward_to_phones(pin, {
                        'type': 'pc_offline',
                        'pin': pin,
                        'pcCount': len(group.pcs)
                    })
                except Exception:
                    pass
        # Fix B7: 如果断线的是手机，通知同 PIN 所有 PC 手机已离线
        if role == 'phone' and pin != 'none':
            group = pin_groups.get(pin)
            if group and len(group.pcs) > 0:
                try:
                    await forward_to_pcs(pin, {
                        'type': 'phone_offline',
                        'pin': pin,
                        'deviceName': meta.get('device_name', ''),
                        'phoneCount': len(group.phones)
                    })
                except Exception:
                    pass

# ==================== 防火墙配置 ====================
def configure_firewall():
    """自动配置 Windows 防火墙规则（需要管理员权限）"""
    import subprocess

    # Y-14修复(v4.23): netsh 是 Windows 独有命令。此前无平台判断，
    # Linux/Docker 每次启动都白跑两趟 netsh 并刷两条 error 日志（噪音+困惑）。
    if not sys.platform.startswith('win'):
        log.info('非 Windows 平台，跳过防火墙自动配置')
        return

    rules = [
        (f'AutoDial Cloud Relay (WebSocket {PORT})', PORT),
    ]
    
    for rule_name, port in rules:
        # 先尝试删除已存在的规则（避免重复）
        try:
            subprocess.run([
                'netsh', 'advfirewall', 'firewall', 'delete', 'rule',
                f'name={rule_name}'
            ], capture_output=True, encoding='gbk', errors='ignore', timeout=5)
        except Exception:
            pass
        
        # 添加入站规则
        try:
            result = subprocess.run([
                'netsh', 'advfirewall', 'firewall', 'add', 'rule',
                f'name={rule_name}',
                'dir=in',
                'action=allow',
                'protocol=TCP',
                f'localport={port}'
            ], capture_output=True, encoding='gbk', errors='ignore', timeout=5)
            
            if result.returncode == 0:
                log.info(f'防火墙规则已添加: {rule_name} (端口 {port})')
            else:
                log.warning(f'添加防火墙规则失败: {rule_name} - {result.stderr}')
        except subprocess.TimeoutExpired:
            log.error(f'添加防火墙规则超时: {rule_name}')
        except Exception as e:
            log.error(f'添加防火墙规则错误: {rule_name} - {e}')
    
    log.info('防火墙配置完成（如果失败，请以管理员身份运行程序）')

# ==================== HTTP 健康检查 + Web 管理界面 ====================
def load_dashboard_html():
    """从外部文件读取 dashboard.html（启动时读取一次，不热更新）"""
    # PyInstaller 打包后资源在 sys._MEIPASS 中；开发模式下在脚本同目录
    if getattr(sys, 'frozen', False):
        script_dir = sys._MEIPASS
    else:
        script_dir = os.path.dirname(os.path.abspath(__file__))
    html_path = os.path.join(script_dir, 'dashboard.html')
    try:
        with open(html_path, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        log.error(f'Failed to load dashboard.html: {e}')
        return '<html><body><h1>Dashboard not found</h1></body></html>'

HTML_CONTENT = load_dashboard_html()

def get_clients_list():
    """获取所有客户端列表（C1修复: 快照 ws_meta 避免跨线程竞态）"""
    clients = []
    try:
        snapshot = list(ws_meta.items())  # 快照，避免 HTTP 线程迭代时 asyncio 线程修改
    except Exception:
        return clients
    for ws, meta in snapshot:
        if meta.get('pin'):
            clients.append({
                'device_name': meta.get('device_name', 'Unknown'),
                'role': meta.get('role', 'unknown'),
                'pin': meta.get('pin', ''),
                'ip': meta.get('ip', 'unknown'),
                'connected_at': meta.get('connected_at', '')
            })
    return clients

def get_uptime_seconds():
    """获取运行时间（秒）"""
    return int((datetime.now() - start_time).total_seconds())

def get_daily_stats():
    """获取按天统计数据"""
    result = []
    for date in sorted(daily_stats.keys(), reverse=True)[:7]:
        stats = daily_stats[date]
        result.append({
            'date': date,
            'messages': stats['messages'],
            'bytes': stats['bytes']
        })
    return result

def get_logs(n=100):
    """读取最近 n 条日志（从文件尾部倒读，避免全量读入大日志文件）"""
    if not log_file_path or not os.path.exists(log_file_path):
        return []
    try:
        lines = []
        block_size = 8192
        with open(log_file_path, 'rb') as f:
            f.seek(0, os.SEEK_END)
            file_size = f.tell()
            pos = file_size
            tail = b''
            while pos > 0 and len(lines) < n:
                read_size = min(block_size, pos)
                pos -= read_size
                f.seek(pos)
                chunk = f.read(read_size)
                data = chunk + tail
                # 按 '\n' 切分；'\n' 不会出现在多字节 UTF-8 字符内部，块边界安全。
                # 若当前块是文件末尾且以 '\n' 结尾，split 会多出一个空段（对应 readlines 不产生的空行），丢弃。
                parts = data.split(b'\n')
                if pos + read_size == file_size and data.endswith(b'\n'):
                    parts = parts[:-1]
                tail = parts[0]  # 行首残段，与更早的块拼接
                for p in reversed(parts[1:]):
                    if len(lines) >= n:
                        break
                    lines.append(p)
            if tail and len(lines) < n:
                lines.append(tail)
        # lines 目前为倒序（文件尾部在前），反转回文件顺序并取最后 n 条
        lines.reverse()
        return [line.decode('utf-8', errors='replace').strip() for line in lines[-n:]]
    except Exception:
        return []

# ==================== HTTP 请求处理 ====================
JSON_HDR = [('Content-Type', 'application/json'), ('Access-Control-Allow-Origin', '*')]
HEALTH_CORS = [('Access-Control-Allow-Origin', '*')]

def _err_json(code, message):
    """构造错误 JSON 响应体"""
    return json.dumps({'ok': False, 'code': code, 'message': message}, ensure_ascii=False).encode('utf-8')

_AUTH_ERR = (401, JSON_HDR, _err_json('UNAUTHORIZED', '需要管理权限'))

def _safe_int(value, default=0):
    """安全地把字符串转成 int；非法输入（如 'abc'）返回默认值，避免整型解析异常导致 500。"""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default

def _safe_limit(value, default, maximum):
    """安全的分页 limit：夹到 [1, maximum]。

    只做上限检查是不够的——SQLite 里 `LIMIT -1` 表示"不设上限"，传 limit=-1
    会把整张表一次返回（/api/v1/calls、/api/v1/events 曾如此，等于给别人一个
    "一键拖走全部通话记录/事件"的开关，同时把事件循环和内存打满）。
    """
    n = _safe_int(value, default)
    if n < 1:
        return default
    return min(n, maximum)

def _safe_offset(value):
    """安全的分页 offset：负数一律归零（SQLite OFFSET -1 等价于 0，但语义模糊）。"""
    n = _safe_int(value, 0)
    return n if n > 0 else 0

def _schedule_async(coro):
    """调度 async 任务：事件循环内用 create_task，跨线程用 run_coroutine_threadsafe"""
    global loop
    try:
        running_loop = asyncio.get_running_loop()
        if running_loop is loop:
            asyncio.create_task(coro)
            return
    except RuntimeError:
        pass  # 不在事件循环中，走跨线程路径
    if loop and loop.is_running():
        asyncio.run_coroutine_threadsafe(coro, loop)
    else:
        log.warning('Cannot schedule async task: event loop not running')


async def _run_db(fn):
    """v4.21.2 (C-1): 把 REST 端点里同步的 DB 查询/CSV 拼接段丢进共享线程池执行，
    事件循环不被 20 万行 fetchall+内存拼 CSV 卡住（导出期间拨号/心跳停摆的根因）。
    用法：把原来 try 块里的同步段包成无参闭包，返回 ('json', status, body)
    / ('csv', filename, bytes) / ('err', status, body) 标记，调用方 await _run_db(...) 后展开。"""
    loop_ = asyncio.get_running_loop()
    return await loop_.run_in_executor(_db_executor, fn)

# ==================== 人员名册（v4.33） ====================
# 名册 = 面板「人员管理」的权威人员集合，来源是 CRM 顾问列表（见文件头 ADVISOR_ROSTER 注释）。
# 刷新入口：GET /api/v1/roster/refresh（管理员鉴权）。
# 第一原则：**刷新失败必须无损**。拉取/解析/写库任何一步出错，都保持现有名册原样并明确报错；
# 否则一次网络抖动就会把名册清空，连带「人员管理」整页变空白，且用户看不出为什么。

def _crm_request_origin():
    """从 CRM URL 推导 Origin/Referer（URL 被环境变量覆盖时提示头也要跟着走）"""
    parsed = urlparse(CRM_ROSTER_URL)
    return f'{parsed.scheme}://{parsed.netloc}'

def _fetch_crm_roster_sync():
    """从 CRM 拉取顾问名单（同步阻塞）。返回 (成员列表, 错误信息)，二者必有其一为 None。

    ⚠️ 只能在 _run_db 的线程池里调用：本函数是阻塞网络请求，直接在事件循环里跑会
    冻结整个服务（拨号、WS 心跳、其他 REST 请求全部停摆数秒）。
    """
    origin = _crm_request_origin()
    body = urlencode({'keyword': '', 'brand': CRM_ROSTER_BRAND}).encode('utf-8')
    req = urllib.request.Request(
        CRM_ROSTER_URL, data=body, method='POST',
        headers={
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': origin,
            'Referer': origin + '/bserve/saoma.html?brand=' + CRM_ROSTER_BRAND,
            'User-Agent': 'AutoDial-Relay/' + APP_VERSION,
        })
    try:
        with urllib.request.urlopen(req, timeout=CRM_ROSTER_TIMEOUT) as resp:
            raw = resp.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return None, f'CRM 返回 HTTP {e.code}（{CRM_ROSTER_URL}）'
    except Exception as e:
        return None, f'无法连接 CRM：{e}'
    try:
        payload = json.loads(raw)
    except Exception:
        return None, 'CRM 返回的不是合法 JSON（可能被登录页/网关拦截）'
    if not isinstance(payload, dict) or payload.get('code') != 1:
        hint = ''
        if isinstance(payload, dict):
            hint = str(payload.get('msg') or payload.get('message') or '')[:120]
        return None, 'CRM 返回业务错误：' + (hint or 'code != 1')
    data = payload.get('data')
    if not isinstance(data, list) or not data:
        return None, 'CRM 返回的名单为空，已保留原有名册'
    members, seen = [], set()
    for item in data:
        if not isinstance(item, dict):
            continue
        mid = str(item.get('id') or '').strip()
        nm = str(item.get('name') or '').strip()
        if not mid or not nm or mid in seen:
            continue    # id/姓名缺失或 id 重复的行一律跳过，不让脏数据进名册
        seen.add(mid)
        members.append((mid, nm))
    if not members:
        return None, 'CRM 返回的名单里没有有效成员，已保留原有名册'
    return members, None

def _builtin_roster():
    return [{'id': m['id'], 'name': m['name']} for m in ADVISOR_ROSTER]

def _read_roster_rows(c):
    """读当前有效名册：DB 有数据即以此为准，空表才回退内置种子表。"""
    c.execute('SELECT id, name FROM advisor_roster ORDER BY sort_order, id')
    rows = [{'id': r[0], 'name': r[1]} for r in c.fetchall()]
    return rows or _builtin_roster()

def _load_roster_sync():
    """给 /api/v1/pins 用的名册读取（DB 异常也不能让人员管理整页挂掉 → 回退内置）"""
    conn = None
    try:
        conn = _connect_db()
        return _read_roster_rows(conn.cursor())
    except Exception as e:
        log.warning(f'ROSTER load failed, fallback to builtin: {e}')
        return _builtin_roster()
    finally:
        if conn:
            conn.close()

def _refresh_roster_sync():
    """拉 CRM → 覆盖写 DB → 返回变化摘要。返回 (结果 dict, HTTP 状态码)。

    拉取失败时**不碰 DB**（先取后写，不先删）。写库若中途失败，事务未 commit、
    连接关闭即回滚 ⇒ 名册仍是刷新前那份。
    """
    members, err = _fetch_crm_roster_sync()
    if err:
        return {'ok': False, 'code': 'CRM_FAILED', 'message': err}, 200
    conn = None
    try:
        conn = _connect_db()
        c = conn.cursor()
        old_rows = _read_roster_rows(c)
        old_by_id = {m['id']: m['name'] for m in old_rows}
        new_by_id = {mid: nm for mid, nm in members}
        now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        c.execute('DELETE FROM advisor_roster')
        c.executemany('INSERT INTO advisor_roster (id, name, sort_order, updated_at) VALUES (?,?,?,?)',
                      [(mid, nm, idx, now_str) for idx, (mid, nm) in enumerate(members)])
        conn.commit()
        added = [{'id': i, 'name': n} for i, n in new_by_id.items() if i not in old_by_id]
        removed = [{'id': i, 'name': n} for i, n in old_by_id.items() if i not in new_by_id]
        # 同名不同 id（CRM 重建工号）也算一次变化，否则用户会看到"没变化"却对不上人
        renamed = [{'id': i, 'old': old_by_id[i], 'name': n} for i, n in new_by_id.items()
                   if i in old_by_id and old_by_id[i] != n]
        return {'ok': True, 'total': len(members), 'added': added, 'removed': removed,
                'renamed': renamed, 'synced_at': now_str}, 200
    except Exception as e:
        return {'ok': False, 'code': 'DB_ERROR', 'message': '写入名册失败：' + str(e)}, 500
    finally:
        if conn:
            conn.close()

# 会话令牌管理（简单实现，重启全部失效）
_admin_sessions = {}  # token -> expiry_timestamp

def _check_admin(hdrs, parsed_query_string=''):
    """验证管理员登录状态。鉴权始终启用。"""
    # Authorization: Bearer <session_token>
    auth = hdrs.get('authorization', '')
    if auth.startswith('Bearer ') and auth[7:] in _admin_sessions:
        if time.time() < _admin_sessions[auth[7:]]:
            return True
        else:
            _admin_sessions.pop(auth[7:], None)  # 过期了，清理掉
            return False
    # 兼容 ?token=<session_token>（供浏览器使用）
    if parsed_query_string:
        qs = parse_qs(parsed_query_string)
        token = qs.get('token', [''])[0]
        if token in _admin_sessions:
            if time.time() < _admin_sessions[token]:
                return True
            else:
                _admin_sessions.pop(token, None)
                return False
    return False

# ==================== 设备授权暂存 ====================
# 当设备使用不同于 default_pin 的 PIN 登录时，暂挂连接等待 PC 侧授权
# request_id -> {pin, device_name, default_pin, ws, created_at}
_pending_auths = {}  # request_id -> auth_info

def _get_device_default_pin(device_name):
    """查询设备的默认 PIN"""
    conn = None
    try:
        conn = _connect_db()
        c = conn.cursor()
        c.execute('SELECT default_pin FROM phones WHERE device_id = ?', (device_name,))
        row = c.fetchone()
        return row[0] if row and row[0] else None
    except Exception:
        return None
    finally:
        if conn:
            conn.close()


def _device_registered(device_id):
    """Y-1 修复（v4.23）：判断 device_id 是否为"曾通过 WS 握手注册过"的真实设备。

    背景：手机端上报接口（calls/batch、events/log）原先完全无鉴权，服务又在公网
    0.0.0.0 监听，任何人都能凭空伪造 device_id 批量灌入假通话记录、假设备，
    污染统计报表。

    为什么用"是否已注册"而不是要求管理员 token：手机端没有管理凭据，不能要求它
    带 token。但设备上报**必然发生在 WS 已连接之后**（DialService 的上报受
    isConnected 门控），而这之前 phone_hello 已把该 device_id 写入 phones 表。
    而 device_id 是 App 生成的随机 UUID，外部无从猜起 → 足以挡住凭空伪造，
    且不会误伤正常流程。

    注意：云端以共享内存库降级运行时不落盘，重启后设备需重新握手——这与降级模式
    自身的语义一致（降级本就意味着重启即丢）。
    """
    if not device_id:
        return False
    conn = None
    try:
        conn = _connect_db()
        c = conn.cursor()
        c.execute('SELECT 1 FROM phones WHERE device_id = ? LIMIT 1', (device_id,))
        return c.fetchone() is not None
    except Exception as e:
        log.warning(f'DEVICE_REGISTERED check failed device={device_id}: {e}')
        return False
    finally:
        if conn:
            conn.close()


def _set_device_default_pin(device_name, pin):
    """设置/更新设备的默认 PIN"""
    conn = None
    try:
        conn = _connect_db()
        c = conn.cursor()
        now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        c.execute('''INSERT INTO phones (device_id, default_pin, last_pin, first_seen, last_seen)
                     VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT(device_id) DO UPDATE SET default_pin=excluded.default_pin, last_pin=excluded.last_pin, last_seen=excluded.last_seen''',
                  (device_name, pin, pin, now_str, now_str))
        conn.commit()
        return True
    except Exception as e:
        log.error(f'SET_DEFAULT_PIN error device={device_name}: {e}')
        return False
    finally:
        if conn:
            conn.close()

# ==================== 访问登记辅助函数 ====================

# v4.15: 离线补推队列持久化到 SQLite（此前存 PinGroup.pending_visits 内存列表，
# 服务器重启/组被删除时全部丢失）

def _db_add_pending_visit(pin, visit_record):
    try:
        conn = _connect_db()
        c = conn.cursor()
        c.execute('INSERT INTO pending_visits (pin, payload, created_at) VALUES (?, ?, ?)',
                  (pin, json.dumps(visit_record, ensure_ascii=False),
                   datetime.now().strftime('%Y-%m-%dT%H:%M:%S')))
        conn.commit()
        conn.close()
        return True
    except Exception as e:
        log.error(f'PENDING_VISIT_DB_ADD failed pin={pin}: {e}')
        return False

def _db_get_pending_visits(pin):
    try:
        conn = _connect_db()
        c = conn.cursor()
        c.execute('SELECT id, payload FROM pending_visits WHERE pin=? ORDER BY id', (pin,))
        rows = c.fetchall()
        conn.close()
        return [(r[0], json.loads(r[1])) for r in rows]
    except Exception as e:
        log.error(f'PENDING_VISIT_DB_GET failed pin={pin}: {e}')
        return []

def _db_delete_pending_visit(vid):
    try:
        conn = _connect_db()
        c = conn.cursor()
        c.execute('DELETE FROM pending_visits WHERE id=?', (vid,))
        conn.commit()
        conn.close()
    except Exception as e:
        log.error(f'PENDING_VISIT_DB_DEL failed id={vid}: {e}')

def _push_visit_to_phone(pin, visit_record):
    """推送 visit_record 给对应 pin 的手机，离线或发送失败则落库待补推"""
    group = pin_groups.get(pin)
    if group and group.phones:
        async def _push():
            try:
                sent = await forward_to_phones(pin, {'type': 'visit_record', 'data': visit_record})
            except Exception as e:
                log.warning(f'VISIT push failed pin={pin}: {e}')
                _db_add_pending_visit(pin, visit_record)
                return
            if not sent:
                # 组里有手机，但一条都没发出去（连接已死、集合尚未清理）。
                # 之前这里"异常被吞 + 不落 pending"，登记就直接丢了。
                _db_add_pending_visit(pin, visit_record)
                log.warning(f'VISIT push reached 0 phone, queued for resend pin={pin}')
        _schedule_async(_push())
    else:
        _db_add_pending_visit(pin, visit_record)
        log.info(f'VISIT queued (offline) pin={pin}')

async def health_check_handler(path, request_headers):
    """处理 HTTP 请求（健康检查 + API + Web 界面）

    这是 async 函数，运行在 asyncio 事件循环上。HTTP 响应直接通过
    websockets 库发送，无需经过 run_in_executor → Future 等待环节。
    同步 DB 查询通过 _db_executor 线程池卸载。异步转发使用 create_task。
    """
    # 如果是 WebSocket 握手请求，不拦截，让 websockets 库处理
    # v8修复: dict() 归一化 headers 键为全小写，兼容 Node.js ws (Upgrade) 和 OkHttp (upgrade)
    try:
        hdrs = dict(request_headers)
        upgrade = hdrs.get('upgrade', '')
        if upgrade == 'websocket':
            log.info(f'WS_UPGRADE path={path} upgrade={upgrade} → allow')
            return None
    except Exception as e:
        log.warning(f'WS_CHECK_FAIL: {e}')
        hdrs = {}  # 防御：确保 hdrs 已定义，后续 REST 端点使用 .get() 安全
        # fallback: 直接检查 headers 中是否有 upgrade 相关字段
        try:
            for key in request_headers:
                if key.lower() == 'upgrade' and request_headers[key].lower() == 'websocket':
                    log.info(f'WS_UPGRADE(fallback) path={path} → allow')
                    return None
        except Exception:
            pass
    
    parsed = urlparse(path)

    # v4.18: REST 端点限频（localhost 豁免）。v4.21 起按端点分级：
    # 认证类 60/min/IP、轮询类 240/min/IP、业务类 600/min/IP。WS 握手路径不受影响。
    if parsed.path.startswith('/api/v1/') and check_rest_rate_limit(_peer_ip.get(), parsed.path):
        log.warning(f'REST_RATE_LIMITED ip={_peer_ip.get() or "?"} path={parsed.path}')
        return (429, JSON_HDR, _err_json('RATE_LIMITED', '请求过于频繁，请稍后再试'))
    path = parsed.path
    
    # 健康检查（兼容旧版本，加 CORS 供 popup 测试连接）
    if path == '/health':
        body = json.dumps({
            'service': 'AutoDial Cloud Relay',
            'version': APP_VERSION,
            'port': PORT,
            'uptime_seconds': get_uptime_seconds(),
            'total_connections': len(ws_connections),
            'total_groups': len(pin_groups)
        }, ensure_ascii=False).encode('utf-8')
        return (200, JSON_HDR, body)
    
    # API: 状态
    if path == '/api/status':
        # S3修复: 敏感信息端点需管理员鉴权（此前裸奔泄露在线状态）
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        # 最近活跃人员（从在线连接中提取，取最近3个不同PIN）——纯内存操作，先取快照
        seen_pins = set()
        active_list = []
        try:
            snapshot = list(ws_meta.items())
        except Exception:
            snapshot = []
        for _ws, _meta in snapshot:
            _pin = _meta.get('pin', '')
            if _pin and _pin not in seen_pins:
                seen_pins.add(_pin)
                active_list.append({
                    'pin': _pin,
                    'name': _meta.get('device_name', '') if _meta.get('role') == 'pc' else '',
                    'role': _meta.get('role', ''),
                    'connected_at': _meta.get('connected_at', '')
                })
        # v4.23 (Y-12): DB 查询原先直接跑在事件循环协程里，DB 卡顿时会拖住全部连接。
        # 合并为一个同步函数丢进 _db_executor 卸载（与 visits 上报同等待遇）。
        def _status_db_sync():
            today_dials = 0
            today_visits = 0
            advisor_names_map = {}
            try:
                conn = _connect_db()
                c = conn.cursor()
                today_str = datetime.now().strftime('%Y-%m-%d')
                # v4.32（口径修复）：改用"拨打时间"区间，与手机管理页「每日对账」/通话列表
                # 一致（面板通话列显示的也是 dial_time）。此前用 date(server_time)=入库时间
                # ⇒ 手机离线几天后补传时，那几天的量会全部算进"今天"
                # （实测：首页 14307 vs 对账 1970，差 7 倍）。
                # 区间写法还能用上 idx_call_records_dial —— 函数包列用不上索引，
                # 而本端点是 15 秒轮询的首页接口。
                c.execute("SELECT COUNT(*) FROM call_records_raw WHERE dial_time>=? AND dial_time<?",
                          (today_start_ms(), today_end_ms()))
                row = c.fetchone()
                if row:
                    today_dials = row[0]
                # v4.32：与上门列表的日期筛选口径对齐（列表用 COALESCE(visit_time,created_at)）。
                # 插件端在线登记不传 visit_time（今天行为完全不变）；但批量导入的 Excel
                # 带「上门时间」列时会落进 visit_time ⇒ 原先首页按 created_at 统计会与
                # 列表页对不上，故统一到同一口径。
                c.execute("SELECT COUNT(*) FROM visits WHERE date(COALESCE(NULLIF(visit_time,''), created_at))=?",
                          (today_str,))
                row = c.fetchone()
                if row:
                    today_visits = row[0]
                # 尝试从 advisor_names 补全姓名
                for _p in seen_pins:
                    c.execute("SELECT name FROM advisor_names WHERE pin=?", (_p,))
                    row = c.fetchone()
                    if row:
                        advisor_names_map[_p] = row[0]
                conn.close()
            except Exception:
                pass
            return today_dials, today_visits, advisor_names_map

        today_dials, today_visits, advisor_names_map = await _run_db(_status_db_sync)
        for a in active_list:
            _n = advisor_names_map.get(a['pin'])
            if _n:
                a['name'] = _n
        active_list.sort(key=lambda x: x.get('connected_at', ''), reverse=True)
        recent_active = active_list[:3]

        body = json.dumps({
            'service': 'AutoDial Cloud Relay',
            'version': APP_VERSION,
            'port': PORT,
            'uptime_seconds': get_uptime_seconds(),
            'total_connections': len(ws_connections),
            'total_groups': len(pin_groups),
            'total_messages': total_messages,
            'total_bytes_sent': total_bytes_sent,
            'total_bytes_received': total_bytes_received,
            'today_dials': today_dials,
            'today_visits': today_visits,
            'recent_active': recent_active
        }, ensure_ascii=False).encode('utf-8')
        return (200, JSON_HDR, body)
    
    # API: 客户端列表
    if path == '/api/clients':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        body = json.dumps({
            'clients': get_clients_list()
        }, ensure_ascii=False).encode('utf-8')
        return (200, JSON_HDR, body)
    
    # API: 统计数据
    if path == '/api/stats':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        body = json.dumps({
            'total_messages': total_messages,
            'total_bytes_sent': total_bytes_sent,
            'total_bytes_received': total_bytes_received,
            'daily': get_daily_stats(),
            'by_type': dict(message_count_by_type),
            'by_pin': dict(message_count_by_pin)
        }, ensure_ascii=False).encode('utf-8')
        return (200, JSON_HDR, body)
    
    # API: 日志（支持 ?n=500&q=关键词）
    if path == '/api/logs':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        n = _safe_limit(qs.get('n', ['100'])[0], 100, 1000)
        q = qs.get('q', [''])[0]
        logs = get_logs(n)
        if q:
            logs = [l for l in logs if q.lower() in l.lower()]
        body = json.dumps({
            'logs': logs,
            'total': len(logs)
        }, ensure_ascii=False).encode('utf-8')
        return (200, JSON_HDR, body)

    # ===== 新增: REST 拨号端点 (GET + Header PIN) =====
    if path == '/api/v1/dial':
        pin = hdrs.get('x-autodial-pin', '')
        number = parse_qs(parsed.query).get('number', [''])[0]

        # PIN 格式校验（4位或11位纯数字）
        if not validate_pin(pin):
            return (200, JSON_HDR, _err_json('INVALID_PIN', 'PIN 格式错误，须为4位或11位数字'))
        track_ext_activity(pin)  # 记录扩展活跃时间
        # 号码校验：允许 3-20 位的数字/*/#/+，兼容 10086/固话/400/*100# 等
        if not number:
            return (200, JSON_HDR, _err_json('INVALID_NUMBER', '号码不能为空'))
        cleaned = number.replace('+', '').replace('*', '').replace('#', '').replace('-', '').replace(' ', '')
        if len(cleaned) < 3 or len(cleaned) > 20:
            return (200, JSON_HDR, _err_json('INVALID_NUMBER', '号码不合法'))

        group = pin_groups.get(pin)
        # v4.15: 移除 PC_CONNECTED 拒绝逻辑。此前只要同 PIN 任意 PC 在线，扩展走云端
        # 拨号就被拒——但"PC 在线"指的是别的电脑（扩展只会用本机 127.0.0.1），导致
        # 在另一台电脑上插件的云端拨号被永久锁死。现在云端照常转发，PC 端仅作旁路监听。
        # 手机离线
        if not group or not group.phones:
            return (200, JSON_HDR, _err_json('PHONE_OFFLINE', '手机未连接'))

        # DUPLICATE_DIAL 并发保护：5秒内同号码去重
        now = time.time()
        last = group.last_dial.get(number, 0)
        if now - last < 5:
            return (200, JSON_HDR, _err_json('DUPLICATE_DIAL', '相同号码正在拨号中'))
        group.last_dial[number] = now

        # 同步返回 ACCEPTED，异步转发到手机
        async def _dial_forward():
            try:
                await forward_to_phones(pin, {
                    'type': 'dial',
                    'number': number,
                    'messageId': f'rest-{int(now*1000)}'
                })
            except Exception as e:
                log.error(f'REST_DIAL failed pin={pin}: {e}')
        _schedule_async(_dial_forward())
        record_message(pin, 'rest_dial', 64)
        log.info(f'REST_DIAL pin={pin} number={number}')
        return (200, JSON_HDR, json.dumps({'ok': True, 'code': 'ACCEPTED'}).encode('utf-8'))

    if path == '/api/v1/hangup':
        pin = hdrs.get('x-autodial-pin', '')
        if not validate_pin(pin):
            return (200, JSON_HDR, _err_json('INVALID_PIN', 'PIN 格式错误，须为4位或11位数字'))
        track_ext_activity(pin)

        group = pin_groups.get(pin)
        # v4.15: 与 /dial 对齐，移除 PC_CONNECTED 拒绝（同 PIN 别的电脑在线不应锁死挂断）
        if not group or not group.phones:
            return (200, JSON_HDR, _err_json('PHONE_OFFLINE', '手机未连接'))

        async def _hangup_forward():
            try:
                await forward_to_phones(pin, {
                    'type': 'hangup',
                    'messageId': f'rest-hangup-{int(time.time()*1000)}'
                })
            except Exception as e:
                log.error(f'REST_HANGUP failed pin={pin}: {e}')
        _schedule_async(_hangup_forward())
        record_message(pin, 'rest_hangup', 32)
        log.info(f'REST_HANGUP pin={pin}')
        return (200, JSON_HDR, json.dumps({'ok': True, 'code': 'ACCEPTED'}).encode('utf-8'))

    if path == '/api/v1/status':
        pin = hdrs.get('x-autodial-pin', '')
        if not validate_pin(pin):
            return (200, JSON_HDR, _err_json('INVALID_PIN', 'PIN 格式错误，须为4位或11位数字'))

        group = pin_groups.get(pin)
        body = json.dumps({
            'ok': True,
            'pin': pin,
            'pcConnected': len(group.pcs) > 0 if group else False,
            'phoneConnected': len(group.phones) > 0 if group else False,
            'phoneCount': len(group.phones) if group else 0,
            'extOnline': is_ext_online(pin)
        }, ensure_ascii=False).encode('utf-8')
        return (200, JSON_HDR, body)
    
    # ===== 顾问姓名映射 =====

    # 注册/更新顾问姓名: GET /api/v1/advisor/register?pin=xxx&name=xxx
    # Chrome 扩展检测到 CRM 姓名后调用此接口上传
    if path == '/api/v1/advisor/register':
        qs = parse_qs(parsed.query)
        pin = qs.get('pin', [''])[0].strip()
        name = qs.get('name', [''])[0].strip()
        if not pin or not name:
            return (200, JSON_HDR, _err_json('MISSING', 'pin 和 name 不能为空'))
        # v4.17: 输入校验——该端点免鉴权且数据会渲染进管理面板，拒收超长/HTML 特殊字符
        if not validate_pin(pin):
            return (200, JSON_HDR, _err_json('INVALID_PIN', 'PIN 格式错误'))
        if len(name) > 32 or any(ch in name for ch in '<>"\'`\\'):
            return (200, JSON_HDR, _err_json('INVALID_NAME', '姓名超长或含非法字符'))
        
        now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        conn = None
        try:
            conn = _connect_db()
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
                conn.close()
        
        log.info(f'ADVISOR_REGISTER pin={pin} name={name}')
        return (200, JSON_HDR, json.dumps({'ok': True, 'pin': pin, 'name': name}).encode('utf-8'))

    # 查询顾问姓名: GET /api/v1/advisor/name?pin=xxx
    # Android/Chrome 根据 PIN 查询对应姓名
    if path == '/api/v1/advisor/name':
        qs = parse_qs(parsed.query)
        pin = qs.get('pin', [''])[0].strip()
        if not pin:
            return (200, JSON_HDR, _err_json('MISSING_PIN', 'pin 不能为空'))
        conn = None
        try:
            conn = _connect_db()
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
                conn.close()

    # API: 更新顾问姓名 GET /api/v1/advisor/update?pin=xxx&name=xxx
    if path == '/api/v1/advisor/update':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        pin = qs.get('pin', [''])[0].strip()
        name = qs.get('name', [''])[0].strip()
        if not pin:
            return (200, JSON_HDR, _err_json('MISSING_PARAM', 'pin 不能为空'))
        conn = None
        try:
            conn = _connect_db()
            c = conn.cursor()
            now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
            c.execute('''INSERT INTO advisor_names (pin, name, updated_at) VALUES (?, ?, ?)
                         ON CONFLICT(pin) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at''',
                      (pin, name, now_str))
            conn.commit()
            log.info(f'ADVISOR_UPDATE pin={pin} name={name}')
            return (200, JSON_HDR, json.dumps({'ok': True, 'pin': pin, 'name': name}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # ===== 管理员标记 =====

    # 管理员登录（仅接受 POST body：{"user":..., "pass":...}）
    # Y-7修复(v4.23): 关闭 GET query 通道。原 `?user=&pass=` 会把口令写进浏览器历史、
    #   服务器访问日志与 Referer；而本服务在公网明文 HTTP 上监听，风险不可接受。
    #   旧 GET 调用返回明确提示（不采信其值，也不把口令写进日志）。
    if path == '/api/v1/login':
        # S6修复 + S5加固: 登录失败限频（60 秒窗口内每 (username, client_ip) 最多 5 次），
        # 防口令爆破且不再因他人失败而锁死管理员登录
        now_ts = time.time()
        user = ''
        pwd = ''
        body_raw = _request_body.get()
        if body_raw:
            try:
                _body_obj = json.loads(body_raw)
                if isinstance(_body_obj, dict):
                    user = str(_body_obj.get('user', '')).strip()
                    pwd = str(_body_obj.get('pass', '')).strip()
            except json.JSONDecodeError:
                pass
        if not user or not pwd:
            # 兼容诊断：若仍用 GET 传凭据，明确告知改用 POST（绝不采信、绝不记录口令本身）
            qs_probe = parse_qs(parsed.query)
            if qs_probe.get('user') or qs_probe.get('pass'):
                log.warning(f'LOGIN_VIA_GET_REJECTED ip={_login_client_ip(hdrs)} —— 请改用 POST body 提交凭据')
                return (401, JSON_HDR, _err_json(
                    'LOGIN_FAILED', '登录方式已更新：请使用 POST 提交账号密码（不再支持网址传参）'))
            return (401, JSON_HDR, _err_json('LOGIN_FAILED', '请输入账号和密码'))
        client_ip = _login_client_ip(hdrs)
        fail_key = (user, client_ip)
        if len(_login_failures) > 2000:
            _prune_login_failures(now_ts)
        cur_failures = [t for t in _login_failures.get(fail_key, []) if now_ts - t <= 60]
        if len(cur_failures) >= 5:
            _login_failures[fail_key] = cur_failures
            return (429, JSON_HDR, _err_json('RATE_LIMITED', '尝试过于频繁，请60秒后再试'))
        conn = None
        try:
            conn = _connect_db()
            c = conn.cursor()
            # S6修复: 密码哈希比对 + 兼容旧明文记录并自动迁移
            c.execute('SELECT id, username, password FROM admin_accounts WHERE username = ?', (user,))
            row = c.fetchone()
            if row and (row[2] == _hash_pwd(pwd) or row[2] == pwd):
                if row[2] != _hash_pwd(pwd):
                    try:
                        c.execute('UPDATE admin_accounts SET password=? WHERE id=?', (_hash_pwd(pwd), row[0]))
                        conn.commit()
                    except Exception:
                        pass
                # Q2修复: 登录成功后清空该 (user, client_ip) 的失败计数，防止 60s 窗口内失败次数跨成功保留
                _login_failures.pop(fail_key, None)
                token = uuid.uuid4().hex
                _admin_sessions[token] = time.time() + 86400  # 24小时有效
                log.info(f'ADMIN_LOGIN user={user}')
                return (200, JSON_HDR, json.dumps({'ok': True, 'token': token, 'username': user}).encode('utf-8'))
            cur_failures.append(now_ts)
            _login_failures[fail_key] = cur_failures
            return (401, JSON_HDR, _err_json('LOGIN_FAILED', '账号或密码错误'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # 登出: GET /api/v1/logout?token=xxx
    if path == '/api/v1/logout':
        # Y-7修复(v4.23): 优先从 Authorization 头取 token（面板已改为请求头方式），
        # query 通道保留仅为兼容旧客户端——token 用后即失效，风险远低于口令。
        token = ''
        auth = hdrs.get('authorization', '')
        if auth.startswith('Bearer '):
            token = auth[7:]
        if not token:
            qs = parse_qs(parsed.query)
            token = qs.get('token', [''])[0]
        _admin_sessions.pop(token, None)
        return (200, JSON_HDR, json.dumps({'ok': True}).encode('utf-8'))

    # ===== 管理员账号管理 =====

    # 列出所有管理账号: GET /api/v1/admin/accounts
    if path == '/api/v1/admin/accounts':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        conn = None
        try:
            conn = _connect_db()
            c = conn.cursor()
            c.execute('SELECT id, username, created_at FROM admin_accounts ORDER BY id')
            rows = c.fetchall()
            accounts = [{'id': r[0], 'username': r[1], 'created_at': r[2]} for r in rows]
            return (200, JSON_HDR, json.dumps({'ok': True, 'accounts': accounts}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # 添加管理账号: GET /api/v1/admin/add?user=xxx&pass=xxx
    # v4.21.2 (D-8): 兼容 POST body（{"user":..., "pass":...}）——凭据不进网址
    if path == '/api/v1/admin/add':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        username = qs.get('user', [''])[0].strip()
        password = qs.get('pass', [''])[0].strip()
        body_raw = _request_body.get()
        if body_raw:
            try:
                _body_obj = json.loads(body_raw)
                if isinstance(_body_obj, dict):
                    username = str(_body_obj.get('user', username)).strip()
                    password = str(_body_obj.get('pass', password)).strip()
            except json.JSONDecodeError:
                pass
        if not username or not password:
            return (200, JSON_HDR, _err_json('MISSING_PARAM', '账号和密码不能为空'))
        if len(username) < 4:
            return (200, JSON_HDR, _err_json('INVALID_PARAM', '账号至少4位'))
        if len(password) < 4:
            return (200, JSON_HDR, _err_json('INVALID_PARAM', '密码至少4位'))
        conn = None
        try:
            conn = _connect_db()
            c = conn.cursor()
            now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
            c.execute('INSERT INTO admin_accounts (username, password, created_at) VALUES (?, ?, ?)',
                      (username, _hash_pwd(password), now_str))
            conn.commit()
            log.info(f'ADMIN_ADD user={username}')
            return (200, JSON_HDR, json.dumps({'ok': True, 'username': username}).encode('utf-8'))
        except sqlite3.IntegrityError:
            return (200, JSON_HDR, _err_json('DUPLICATE', '账号已存在'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # 删除管理账号: GET /api/v1/admin/del?id=xxx
    if path == '/api/v1/admin/del':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        aid = qs.get('id', [''])[0].strip()
        if not aid:
            return (200, JSON_HDR, _err_json('MISSING_PARAM', 'id 不能为空'))
        conn = None
        try:
            conn = _connect_db()
            c = conn.cursor()
            # 检查是否只剩一个账号，不允许删除最后一个
            c.execute('SELECT COUNT(*) FROM admin_accounts')
            total = c.fetchone()[0]
            if total <= 1:
                return (200, JSON_HDR, _err_json('LAST_ACCOUNT', '不能删除最后一个管理账号'))
            c.execute('DELETE FROM admin_accounts WHERE id = ?', (aid,))
            conn.commit()
            log.info(f'ADMIN_DEL id={aid}')
            return (200, JSON_HDR, json.dumps({'ok': True, 'id': aid}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # 修改密码: GET /api/v1/admin/chpwd?id=xxx&newpass=xxx
    if path == '/api/v1/admin/chpwd':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        aid = qs.get('id', [''])[0].strip()
        newpass = qs.get('newpass', [''])[0].strip()
        body_raw = _request_body.get()
        if body_raw:
            try:
                _body_obj = json.loads(body_raw)
                if isinstance(_body_obj, dict):
                    aid = str(_body_obj.get('id', aid)).strip()
                    newpass = str(_body_obj.get('newpass', newpass)).strip()
            except json.JSONDecodeError:
                pass
        if not aid or not newpass:
            return (200, JSON_HDR, _err_json('MISSING_PARAM', 'id 和新密码不能为空'))
        if len(newpass) < 4:
            return (200, JSON_HDR, _err_json('INVALID_PARAM', '密码至少4位'))
        conn = None
        try:
            conn = _connect_db()
            c = conn.cursor()
            c.execute('UPDATE admin_accounts SET password = ? WHERE id = ?', (_hash_pwd(newpass), aid))
            conn.commit()
            log.info(f'ADMIN_CHPWD id={aid}')
            return (200, JSON_HDR, json.dumps({'ok': True, 'id': aid}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()


    # ===== 设备授权（扩展端轮询） =====

    # 查询挂起的授权请求: GET /api/v1/auth/pending?pin=xxx
    if path == '/api/v1/auth/pending':
        qs = parse_qs(parsed.query)
        pin = qs.get('pin', [''])[0].strip()
        track_ext_activity(pin)  # 轮询本身证明扩展在线
        now = time.time()
        result = []
        for req_id, req in list(_pending_auths.items()):
            # 只返回匹配 PIN 且在 120 秒内的请求
            if req['pin'] == pin and now - req['created_at'] < 120:
                result.append({
                    'request_id': req_id,
                    'device_id': req.get('device_id', ''),
                    'device_name': req['device_name'],
                    'default_pin': req['default_pin'],
                    'pin': req['pin']
                })
        return (200, JSON_HDR, json.dumps({'ok': True, 'pending': result}).encode('utf-8'))

    # 响应授权请求: GET /api/v1/auth/respond?request_id=xxx&allow=1|0&pin=xxx
    if path == '/api/v1/auth/respond':
        qs = parse_qs(parsed.query)
        req_id = qs.get('request_id', [''])[0].strip()
        allow = qs.get('allow', ['0'])[0] == '1'
        caller_pin = qs.get('pin', [''])[0].strip()
        auth_req = _pending_auths.get(req_id)
        if not auth_req:
            return (200, JSON_HDR, _err_json('EXPIRED', '授权请求已过期或不存在'))
        # 安全修复: 响应者必须携带与请求一致的 PIN，防止等待授权的手机自批/他人越权
        if caller_pin != auth_req['pin']:
            return (200, JSON_HDR, _err_json('UNAUTHORIZED', 'PIN 不匹配，无法响应此授权请求'))
        # 安全修复增强: 光校验 PIN 不够——等待授权的手机自己知道这个 PIN，
        # 它先调一次 /api/v1/auth/pending（同样会登记扩展活跃）再调 auth/respond
        # 就能给自己放行，整个授权流程形同虚设。要求响应方来自"刚刚轮询过
        # auth/pending 的那个 IP"，把响应权绑回真正持有插件的机器。
        if not is_ext_online(caller_pin):
            log.warning(f'AUTH_RESPOND_REJECT(no ext) id={req_id} pin={caller_pin}')
            return (200, JSON_HDR, _err_json('UNAUTHORIZED', '该 PIN 的授权插件不在线，无法响应此授权请求'))
        caller_ip = _peer_ip.get() or ''
        ext_ip = last_ext_ip.get(caller_pin) or ''
        if ext_ip and caller_ip and ext_ip != caller_ip:
            log.warning(f'AUTH_RESPOND_REJECT(ip) id={req_id} pin={caller_pin} ext_ip={ext_ip} caller_ip={caller_ip}')
            return (200, JSON_HDR, _err_json('UNAUTHORIZED', '响应方 IP 与该 PIN 的授权插件不一致'))
        _pending_auths.pop(req_id, None)
        phone_ws = auth_req['ws']
        device_name = auth_req['device_name']
        auth_pin = auth_req['pin']
        # F1修复: REST 分支此前遗漏 default_pin 赋值，导致 NameError 使授权永远无法完成
        default_pin = auth_req['default_pin']
        if allow:
            # 授权通过：加入分组发送 auth_ok（不改变 default_pin，仅本次会话有效）
            group = get_group(auth_pin)
            # 踢掉相同 PIN 的旧手机（通过 phone_ws 同组清除）
            # v4.15: 先移出组再 close，防止 close 等待期间旧连接 finally 误删整组
            for old_phone in list(group.phones):
                group.phones.discard(old_phone)
                try:
                    await old_phone.close(1001, 'duplicate_reconnect')
                except Exception:
                    pass
            group.phones.add(phone_ws)
            # S2修复: REST 授权通过后同样标记手机连接为已授权（与 WS 版 auth_response 对齐）
            phone_meta = ws_meta.get(phone_ws)
            if phone_meta is not None:
                phone_meta['authorized'] = True
            pc_online = len(group.pcs) > 0
            # 查询手机主人姓名（v4.21.2: 移线程池 + 修 conn3 未定义的 finally 隐患）
            owner_name = ''
            try:
                def _query_owner_rest():
                    conn3 = _connect_db()
                    try:
                        c3 = conn3.cursor()
                        c3.execute('SELECT name FROM advisor_names WHERE pin=?', (default_pin,))
                        row3 = c3.fetchone()
                        return row3[0] if row3 else ''
                    finally:
                        conn3.close()
                owner_name = await asyncio.get_running_loop().run_in_executor(_db_executor, _query_owner_rest)
            except Exception:
                pass
            # 通过 _schedule_async 调度异步任务（自动检测事件循环上下文）
            async def _send_auth_ok():
                try:
                    await phone_ws.send(json.dumps({
                        'type': 'auth_ok',
                        'pin': auth_pin,
                        'default_pin': default_pin,     # 手机主人的PIN
                        'default_name': owner_name,      # 手机主人的姓名
                        'pcCount': len(group.pcs),
                        'pc_present': pc_online,
                        'ext_online': is_ext_online(auth_pin),
                        'newDevice': True
                    }))
                    await forward_to_pcs(auth_pin, {
                        'type': 'phone_hello',
                        'pin': auth_pin,
                        'deviceName': device_name,
                        'deviceId': device_name
                    }, phone_ws)
                except Exception as e:
                    log.error(f'AUTH send auth_ok failed: {e}')
            _schedule_async(_send_auth_ok())
            log.info(f'AUTH_APPROVED_REST id={req_id} device={device_name} pin={auth_pin}')
        else:
            async def _send_auth_fail():
                try:
                    await phone_ws.send(json.dumps({
                        'type': 'auth_fail',
                        'reason': f'浏览器插件拒绝了设备 {device_name} 使用 PIN {auth_pin}'
                    }))
                    await phone_ws.close(4003, 'auth_denied')
                except Exception:
                    pass
            _schedule_async(_send_auth_fail())
            log.info(f'AUTH_DENIED_REST id={req_id} device={device_name} pin={auth_pin}')
        return (200, JSON_HDR, json.dumps({'ok': True}).encode('utf-8'))

    # ===== PIN 列表 + 分组管理 =====

    # 所有已注册 PIN（含姓名、分组）
    if path == '/api/v1/pins':
        # S3修复: PIN 即顾问手机号，敏感，需管理员鉴权
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        conn = None
        try:
            conn = _connect_db()
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute('''SELECT a.pin, a.name, a.group_id, a.updated_at
                         FROM advisor_names a ORDER BY a.updated_at DESC''')
            rows = [dict(r) for r in c.fetchall()]
            # v4.26: 与固定人员名册合并（按姓名匹配）。名册 = 全部人员的权威集合，
            # 未匹配上的行是「还没用插件登记过」的人，前端显示为「未绑定」。
            # v4.33: 名册改从 DB 读（面板「刷新名单」可从 CRM 同步覆盖），空表才回退内置种子表
            roster = _read_roster_rows(c)
            # 上次从 CRM 同步的时间；NULL/空 = 从没同步过，当前显示的是内置种子表
            c.execute('SELECT MAX(updated_at) FROM advisor_roster')
            _rrow = c.fetchone()
            roster_synced_at = _rrow[0] if _rrow and _rrow[0] else None
            by_name = {}
            for r in rows:
                nm = (r.get('name') or '').strip()
                if nm and nm not in by_name:
                    by_name[nm] = r   # 同名取 updated_at 最新的一条（已按时间倒序）
            merged = []
            used_pins = set()
            for m in roster:
                hit = by_name.get(m['name'])
                if hit:
                    used_pins.add(hit.get('pin'))
                merged.append({
                    'pin': (hit or {}).get('pin') or '',
                    'name': m['name'],
                    'group_id': (hit or {}).get('group_id'),
                    'updated_at': (hit or {}).get('updated_at'),
                    'roster_id': m['id'],       # CRM 内部工号
                    'roster': True,
                    'bound': bool(hit),
                })
            # 名册之外确实注册过的人（如改名、试岗、姓名兜底成手机号）仍保留，避免数据凭空消失
            for r in rows:
                if r.get('pin') in used_pins:
                    continue
                nm = (r.get('name') or '').strip()
                merged.append({
                    'pin': r.get('pin') or '',
                    'name': nm or (r.get('pin') or ''),
                    'group_id': r.get('group_id'),
                    'updated_at': r.get('updated_at'),
                    'roster_id': None,
                    'roster': False,
                    'bound': True,
                })
            return (200, JSON_HDR, json.dumps({
                'ok': True, 'pins': merged,
                'roster_size': len(roster),
                'roster_synced_at': roster_synced_at,
                'bound_count': sum(1 for x in merged if x['bound']),
            }).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # 刷新人员名册（源头 = CRM 顾问列表）: GET /api/v1/roster/refresh
    if path == '/api/v1/roster/refresh':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        # 走线程池：CRM 是外网请求，直接 await 会卡住事件循环（拨号/心跳一起停摆）
        result, status = await _run_db(_refresh_roster_sync)
        if result.get('ok'):
            log.info(f"ROSTER_REFRESH total={result['total']} added={len(result['added'])} "
                     f"removed={len(result['removed'])} renamed={len(result['renamed'])}")
        else:
            log.warning(f"ROSTER_REFRESH failed: {result.get('message')}")
        return (status, JSON_HDR, json.dumps(result, ensure_ascii=False).encode('utf-8'))

    # 设置 PIN 分组: GET /api/v1/pin/set_group?pin=xxx&group_id=N
    if path == '/api/v1/pin/set_group':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        pin = qs.get('pin', [''])[0].strip()
        gid = qs.get('group_id', [''])[0].strip()
        if not pin:
            return (200, JSON_HDR, _err_json('MISSING', 'pin 不能为空'))
        conn = None
        try:
            conn = _connect_db()
            c = conn.cursor()
            c.execute('UPDATE advisor_names SET group_id=? WHERE pin=?', (int(gid) if gid else None, pin))
            conn.commit()
            return (200, JSON_HDR, json.dumps({'ok': True}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # 分组列表: GET /api/v1/groups
    if path == '/api/v1/groups':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        conn = None
        try:
            conn = _connect_db()
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute('SELECT * FROM pin_groups ORDER BY id')
            rows = [dict(r) for r in c.fetchall()]
            return (200, JSON_HDR, json.dumps({'ok': True, 'groups': rows}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # 添加分组: GET /api/v1/group/add?name=xxx
    if path == '/api/v1/group/add':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        name = qs.get('name', [''])[0].strip()
        if not name:
            return (200, JSON_HDR, _err_json('MISSING', '分组名不能为空'))
        conn = None
        try:
            conn = _connect_db()
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
                conn.close()

    # 删除分组: GET /api/v1/group/del?id=N
    if path == '/api/v1/group/del':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        gid = qs.get('id', [''])[0]
        if not gid:
            return (200, JSON_HDR, _err_json('MISSING', 'id 不能为空'))
        conn = None
        try:
            conn = _connect_db()
            c = conn.cursor()
            c.execute('UPDATE advisor_names SET group_id=NULL WHERE group_id=?', (int(gid),))
            c.execute('DELETE FROM pin_groups WHERE id=?', (int(gid),))
            conn.commit()
            return (200, JSON_HDR, json.dumps({'ok': True}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # 根据分组查询 visits: GET /api/v1/visits?group=N
    # 修改现有 visits 查询，支持 group_id 参数

    # ===== 一键登记 API（GET + query params，与 dial 风格一致） =====

    # ===== 手机端数据上报 API =====

    # 批量上传通话记录
    #   v4.21: 兼容 POST body（{"device_id":..,"pin":..,"data":[...]}）——大 JSON 不进 GET URL / 访问日志
    #   GET  /api/v1/calls/batch?device_id=xxx&pin=xxx&data=<json>（旧版 App 兼容保留）
    #   Y-1修复(v4.23): 增加设备注册校验，杜绝公网凭空伪造上报
    if path == '/api/v1/calls/batch':
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0].strip()
        pin = qs.get('pin', [''])[0].strip()
        data_str = qs.get('data', [''])[0]
        records = data_str  # 默认取 GET 的 JSON 字符串，下面统一解析
        body_raw = _request_body.get()
        if body_raw:
            try:
                body_obj = json.loads(body_raw)
            except json.JSONDecodeError as e:
                return (400, JSON_HDR, _err_json('INVALID_JSON', f'请求体 JSON格式错误: {e}'))
            if not isinstance(body_obj, dict):
                return (400, JSON_HDR, _err_json('INVALID_JSON', '请求体须为 JSON 对象'))
            device_id = str(body_obj.get('device_id', device_id) or '').strip()
            pin = str(body_obj.get('pin', pin) or '').strip()
            records = body_obj.get('data', None)
        if not device_id or records is None or records == '':
            return (200, JSON_HDR, _err_json('MISSING_FIELDS', 'device_id和data不能为空'))
        if not _device_registered(device_id):
            log.warning(f'CALLS_BATCH rejected: unregistered device={device_id}')
            return (403, JSON_HDR, _err_json(
                'DEVICE_NOT_REGISTERED', '设备未在云端注册，请先在 App 内重新连接后再同步'))
        now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        inserted, skipped = 0, 0
        conn = None
        try:
            if isinstance(records, str):
                records = json.loads(records)
            if not isinstance(records, list):
                return (400, JSON_HDR, _err_json('INVALID_JSON', 'data 必须为 JSON 数组'))
            conn = _connect_db()
            c = conn.cursor()
            c.execute('''INSERT OR IGNORE INTO phones (device_id, last_pin, first_seen, last_seen)
                         VALUES (?, ?, ?, ?)''', (device_id, pin, now_str, now_str))
            for r in records:
                try:
                    c.execute('''INSERT OR IGNORE INTO call_records_raw
                                 (device_id, local_id, number, dial_time, duration, call_type, sim_slot, server_time)
                                 VALUES (?,?,?,?,?,?,?,?)''',
                              (device_id, r['local_id'], r.get('number',''), r.get('dial_time',0),
                               r.get('duration',0), r.get('call_type',0), r.get('sim_slot',0), now_str))
                    if c.rowcount > 0: inserted += 1
                    else: skipped += 1
                except Exception:
                    skipped += 1
            c.execute('UPDATE phones SET last_seen=? WHERE device_id=?', (now_str, device_id))
            conn.commit()
            log.info(f'CALLS_BATCH device={device_id} pin={pin} inserted={inserted} skipped={skipped}')
            return (200, JSON_HDR, json.dumps({'ok': True, 'inserted': inserted, 'skipped': skipped}).encode('utf-8'))
        except json.JSONDecodeError as e:
            log.error(f'CALLS_BATCH JSON parse error device={device_id}: {e}')
            return (400, JSON_HDR, _err_json('INVALID_JSON', 'data格式错误'))
        except Exception as e:
            log.error(f'CALLS_BATCH error device={device_id}: {e}')
            return (500, JSON_HDR, _err_json('SERVER_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # 上报行为事件: GET /api/v1/events/log?device_id=xxx&event_type=login&pin=xxx&detail=xxx
    # Y-1修复(v4.23): 增加设备注册校验（原先无任何鉴权，公网可伪造灌入假设备/假事件）
    if path == '/api/v1/events/log':
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0].strip()
        event_type = qs.get('event_type', [''])[0].strip()
        event_pin = qs.get('pin', [''])[0].strip()
        detail = qs.get('detail', [''])[0].strip()
        if not device_id or not event_type:
            return (200, JSON_HDR, _err_json('MISSING_FIELDS', 'device_id和event_type不能为空'))
        if not _device_registered(device_id):
            log.warning(f'EVENTS_LOG rejected: unregistered device={device_id}')
            return (403, JSON_HDR, _err_json(
                'DEVICE_NOT_REGISTERED', '设备未在云端注册，请先在 App 内重新连接'))
        now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        conn = None
        try:
            conn = _connect_db()
            c = conn.cursor()
            c.execute('INSERT INTO phone_events (device_id, event_type, event_time, pin, detail, server_time) VALUES (?,?,?,?,?,?)',
                      (device_id, event_type, now_str, event_pin, detail, now_str))
            # F4修复: 原 INSERT OR REPLACE 会把 default_pin/label 重置为空，破坏设备绑定；改为仅更新上报字段
            c.execute('''INSERT INTO phones (device_id, last_pin, first_seen, last_seen)
                         VALUES (?, ?, COALESCE((SELECT first_seen FROM phones WHERE device_id=?), ?), ?)
                         ON CONFLICT(device_id) DO UPDATE SET last_pin=excluded.last_pin, last_seen=excluded.last_seen''',
                      (device_id, event_pin, device_id, now_str, now_str))
            conn.commit()
            return (200, JSON_HDR, json.dumps({'ok': True}).encode('utf-8'))
        except Exception as e:
            log.error(f'EVENTS_LOG error device={device_id}: {e}')
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # 上报每日统计快照: GET /api/v1/stats/report?device_id=xxx&pin=xxx&model=xxx&version=xxx&count=12&duration=180&connected=8
    if path == '/api/v1/stats/report':
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0].strip()
        pin = qs.get('pin', [''])[0].strip()
        model = qs.get('model', [''])[0].strip()
        version = qs.get('version', [''])[0].strip()
        phone_dial = _safe_int(qs.get('count', ['0'])[0], 0)
        phone_dur = _safe_int(qs.get('duration', ['0'])[0], 0)
        phone_conn = _safe_int(qs.get('connected', ['0'])[0], 0)
        if not device_id:
            return (200, JSON_HDR, _err_json('MISSING_FIELDS', 'device_id不能为空'))
        # v4.32（P0 修复）：本端点原先无任何门禁，却会 INSERT INTO phones ⇒
        # 任何人凭空调一次就能把任意 device_id 变成"已注册设备"，从而绕过
        # calls/batch、events/log 上 v4.23 加的 _device_registered 校验
        # （实测：未见过的设备先调本端点变 200，再调 calls/batch 即 inserted=1）。
        # 补齐同一道门禁：手机端本端点的上报受 isConnected 门控（连上 WS 才跑），
        # 而 phone_hello 在那之前已把 device_id 写入 phones ⇒ 正常流程不受影响。
        # 注意不能改成要求管理员 token —— 手机端没有管理凭据。
        if not _device_registered(device_id):
            log.warning(f'STATS_REPORT rejected: unregistered device={device_id}')
            return (403, JSON_HDR, _err_json(
                'DEVICE_NOT_REGISTERED', '设备未在云端注册，请先在 App 内重新连接后再同步'))
        now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        today_str = datetime.now().strftime('%Y-%m-%d')
        conn = None
        try:
            conn = _connect_db()
            c = conn.cursor()
            c.execute('''INSERT INTO phones (device_id, last_pin, device_model, app_version, first_seen, last_seen)
                     VALUES (?, ?, ?, ?, COALESCE((SELECT first_seen FROM phones WHERE device_id=?), ?), ?)
                     ON CONFLICT(device_id) DO UPDATE SET last_pin=excluded.last_pin, device_model=excluded.device_model, app_version=excluded.app_version, last_seen=excluded.last_seen''',
                      (device_id, pin, model, version, device_id, now_str, now_str))
            # 从原始记录重算服务器端值
            c.execute('SELECT COUNT(*), SUM(duration), COUNT(CASE WHEN duration>0 THEN 1 END) FROM call_records_raw WHERE device_id=? AND dial_time>=? AND dial_time<?',
                      (device_id, today_start_ms(), today_end_ms()))
            row = c.fetchone()
            server_dial = row[0] or 0
            server_dur = row[1] or 0
            server_conn = row[2] or 0
            match = 'OK' if (server_dial == phone_dial and server_conn == phone_conn) else 'MISMATCH'
            c.execute('''INSERT OR REPLACE INTO phone_daily_stats
                         (device_id, date, server_dial, server_conn, server_dur, phone_dial, phone_conn, phone_dur, match_status, updated_at)
                         VALUES (?,?,?,?,?,?,?,?,?,?)''',
                      (device_id, today_str, server_dial, server_conn, server_dur, phone_dial, phone_conn, phone_dur, match, now_str))
            conn.commit()
            return (200, JSON_HDR, json.dumps({'ok': True, 'match': match}).encode('utf-8'))
        except Exception as e:
            log.error(f'STATS_REPORT error device={device_id}: {e}')
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # 批量导入: GET /api/v1/visits/batch?data=<JSON数组>&token=<admin_token>
    # v4.21: 新增 POST body 方式（请求体 JSON：{"data": [...]}），绕开 GET URL
    # 8KB 硬上限（websockets MAX_LINE_LENGTH）；GET 兼容保留（小批量仍可用）。
    if path == '/api/v1/visits/batch':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        body_raw = _request_body.get()
        if body_raw:
            try:
                body_obj = json.loads(body_raw)
            except json.JSONDecodeError as e:
                return (400, JSON_HDR, _err_json('INVALID_JSON', f'请求体 JSON格式错误: {e}'))
            if not isinstance(body_obj, dict) or 'data' not in body_obj:
                return (400, JSON_HDR, _err_json('INVALID_JSON', '请求体须为 {"data": [...]}'))
            records = body_obj['data']
            if not isinstance(records, list):
                return (400, JSON_HDR, _err_json('INVALID_JSON', 'data 必须为 JSON 数组'))
            data_str = None
        else:
            qs = parse_qs(parsed.query)
            data_str = qs.get('data', [''])[0]
            if not data_str:
                return (200, JSON_HDR, _err_json('MISSING_DATA', '缺少 data 参数'))
            try:
                records = json.loads(data_str)
            except json.JSONDecodeError as e:
                return (400, JSON_HDR, _err_json('INVALID_JSON', f'data JSON格式错误: {e}'))
        if not isinstance(records, list):
            return (400, JSON_HDR, _err_json('INVALID_JSON', 'data 必须为 JSON 数组'))

        conn = None
        try:
            conn = _connect_db()
            c = conn.cursor()
            now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
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
                    pin = (rec.get('pin') or '').strip()
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
                        VALUES (?, ?, ?, ?, ?, ?, 'crm_import', ?, 1, ?, ?, ?)''',
                        (crm_id if crm_id else None, pin, name, mobile, kefu_tel,
                         visit_type, visit_time, visit_extra, now_str, now_str)
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
            log.info(f'VISITS_BATCH inserted={inserted} skipped={skipped} errors={len(errors)}')
            return (200, JSON_HDR, json.dumps({
                'ok': True, 'inserted': inserted, 'skipped': skipped, 'errors': errors
            }, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            log.error(f'VISITS_BATCH error: {e}')
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # 创建登记: GET /api/v1/visit?name=...&mobile=...&...
    if path == '/api/v1/visit':
        pin = hdrs.get('x-autodial-pin', '')
        if not validate_pin(pin):
            return (200, JSON_HDR, _err_json('INVALID_PIN', 'PIN 格式错误，须为4位或11位数字'))
        track_ext_activity(pin)

        qs = parse_qs(parsed.query)
        name = qs.get('name', [''])[0].strip()
        mobile = qs.get('mobile', [''])[0].strip()
        kefu_tel = qs.get('kefu_tel', [''])[0].strip()
        visit_type = qs.get('visit_type', ['贷款咨询'])[0].strip()
        source = qs.get('source', ['plugin'])[0].strip()
        visit_time = qs.get('visit_time', [''])[0].strip()
        # v4.17: 客户端唯一 id——重发/补推场景下同一物理来访只入库一次（库侧唯一索引兜底）
        crm_id = qs.get('crm_id', [''])[0].strip()[:64]

        if not name or not mobile or not kefu_tel:
            return (200, JSON_HDR, _err_json('MISSING_FIELDS', '缺少必填字段: name, mobile, kefu_tel'))
        # 输入长度上限（防滥用/防存储异常膨胀）
        if len(name) > 64 or len(mobile) > 32 or len(kefu_tel) > 64 or len(visit_type) > 64 or len(visit_time) > 64:
            return (200, JSON_HDR, _err_json('INVALID_FIELDS', '字段超长'))

        now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')

        # v4.21.2 (C-1): DB 段移入线程池——员工登记是最高频 REST 写操作
        def _visit_insert_sync():
            # v4.23 (Y-4): 判重与写入必须原子——否则 8 线程池里两个并发请求
            # 可能同时通过 SELECT 判重、各插一条（同号 2 小时窗口路径尤甚）
            with _visit_insert_lock:
                conn = None
                try:
                    conn = _connect_db()
                    c = conn.cursor()
                    # v4.17: 去重三级——① crm_id 唯一索引（重发/补推精确去重）
                    # ② 有 visit_time：mobile+visit_time 精确匹配
                    # ③ 回退：同号 2 小时内（原"当日去重"会静默吞掉同客户当天第二次真实上门）
                    if crm_id:
                        c.execute('SELECT id FROM visits WHERE crm_id = ? LIMIT 1', (crm_id,))
                    elif visit_time:
                        c.execute(
                            'SELECT id FROM visits WHERE mobile = ? AND visit_time = ? LIMIT 1',
                            (mobile, visit_time)
                        )
                    else:
                        cutoff_2h = (datetime.now() - timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%S')
                        c.execute(
                            'SELECT id FROM visits WHERE mobile = ? AND created_at >= ? LIMIT 1',
                            (mobile, cutoff_2h)
                        )
                    if c.fetchone():
                        return ('json', 200, json.dumps({'ok': True, 'skipped': True, 'reason': 'duplicate'}).encode('utf-8'))
                    # v4.29: 归属改为「接待顾问」而非登记人 —— 用户 2026-09-17 确认真实业务：
                    #   「顾问是谁，上门就是谁的」（代登记场景：A 在自己电脑上帮 B 登记，这条归 B）。
                    #   kefu_tel 存的是**顾问姓名**（插件端登记弹窗下拉的 value 就是姓名，
                    #   见 cs-40-dialogs.js），故按姓名反查 advisor_names 拿顾问 PIN 再落库。
                    #   查不到 ⇒ 该顾问还没用插件登记过（人员管理页显示"未绑定"），
                    #   此时回退登记人 PIN，保证记录不丢、且仍可按"谁登记的"追溯。
                    owner_pin = pin
                    if kefu_tel:
                        c.execute('SELECT pin FROM advisor_names WHERE name = ? '
                                  'ORDER BY updated_at DESC LIMIT 1', (kefu_tel,))
                        _adv = c.fetchone()
                        if _adv and _adv[0]:
                            owner_pin = _adv[0]
                    c.execute(
                        'INSERT INTO visits (pin, name, mobile, kefu_tel, visit_type, source, visit_time, crm_id, created_at, updated_at) '
                        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        (owner_pin, name, mobile, kefu_tel, visit_type, source, visit_time, crm_id or None, now_str, now_str)
                    )
                    # v4.29: 删除此处对 advisor_names 的"兜底写入"。原逻辑写的是
                    #   advisor_names[登记人 PIN] = 接待顾问姓名 —— 只在"登记人 = 顾问"时才对，
                    #   代登记场景（A 帮 B 登记）会把 B 的姓名挂到 A 的手机号上，且是 DO NOTHING，
                    #   一旦写错就永久固化，人员管理页按姓名匹配名册随即错位。
                    #   权威来源始终是插件端刷新 CRM 时调的 /api/v1/advisor/register
                    #   （pin/name 都取自同一个 CRM 页面，天然同源），无需这里再猜。
                    conn.commit()
                    return ('rowid', c.lastrowid)
                except Exception as e:
                    log.error(f'INSERT visit error: {e}')
                    return ('err', 500, _err_json('DB_ERROR', str(e)))
                finally:
                    if conn:
                        conn.close()

        res = await _run_db(_visit_insert_sync)
        if res[0] == 'err':
            return (res[1], JSON_HDR, res[2])
        if res[0] == 'json':
            return (res[1], JSON_HDR, res[2])
        row_id = res[1]

        # 客户端已直接提交 CRM，云端只做记录 + WS 推送，不再重复提交 CRM
        visit_record = {'id': row_id, 'pin': pin, 'name': name, 'mobile': mobile,
                        'kefu_tel': kefu_tel, 'visit_type': visit_type, 'source': source,
                        'visit_time': visit_time, 'crm_id': crm_id,
                        'created_at': now_str, 'updated_at': now_str}
        _push_visit_to_phone(pin, visit_record)

        log.info(f'VISIT_CREATE pin={pin} name={name} id={row_id}')
        return (200, JSON_HDR, json.dumps({'ok': True, 'code': 'ACCEPTED', 'id': row_id}).encode('utf-8'))

    # 查询列表: GET /api/v1/visits?pin=xxx[&group=N]
    # v4.18: 管理面板分页——带 page 参数返回 {ok,total,page,page_size,rows}；
    # 不带 page 保持原样返回数组（手机端同步兼容，勿改返回结构）。
    # 额外过滤参数：days=N（最近 N 天）、source=plugin|crm_sync|phone|unsynced、
    # d_from/d_to（日期，按 COALESCE(visit_time,created_at) 比较）
    if path == '/api/v1/visits':
        qs = parse_qs(parsed.query)
        pin = qs.get('pin', [''])[0]
        group_id = qs.get('group', [''])[0]
        page_param = qs.get('page', [''])[0]
        days_param = qs.get('days', [''])[0]
        source_f = qs.get('source', [''])[0]
        d_from = qs.get('d_from', [''])[0].strip()[:10]
        d_to = qs.get('d_to', [''])[0].strip()[:10]
        # S3修复: 仅明确携带单 PIN（手机端同步）可不鉴权；无筛选/按分组均涉及客户数据，必须管理员
        # Y-2修复(v4.23): group 分支在下方 where 构造中优先级高于 pin 分支，而原判定只检查
        #   "pin 是否为空" → 构造 "?pin=任意非空值&group=N" 即可绕过鉴权，无需管理员身份
        #   就能读出整组客服名下的客户数据。改为：只要带 group（必然涉及他人数据）就必须管理员。
        if group_id:
            if not _check_admin(hdrs, parsed.query):
                return _AUTH_ERR
        elif not pin:
            if not _check_admin(hdrs, parsed.query):
                return _AUTH_ERR
        try:
            page_no = max(1, int(page_param)) if page_param else 0
        except (TypeError, ValueError):
            page_no = 0
        try:
            page_size = min(max(int(qs.get('page_size', ['50'])[0] or 50), 1), 200)
        except (TypeError, ValueError):
            page_size = 50

        # v4.21.2 (C-1): DB 段移入线程池——面板 15s 轮询 + 手机同步的高频读
        def _visits_list_sync():
            conn = None
            try:
                conn = _connect_db()
                conn.row_factory = sqlite3.Row
                c = conn.cursor()
                where = []
                args = []
                if group_id:
                    try:
                        gid = int(group_id)
                    except (TypeError, ValueError):
                        return ('err', 400, _err_json('INVALID_GROUP', '分组 ID 无效'))
                    c.execute('SELECT pin FROM advisor_names WHERE group_id=?', (gid,))
                    group_pins = [r['pin'] for r in c.fetchall()]
                    if group_pins:
                        where.append('pin IN (%s)' % ','.join(['?'] * len(group_pins)))
                        args += group_pins
                    else:
                        where.append('1=0')
                elif pin:
                    where.append('pin=?')
                    args.append(pin)
                if days_param:
                    try:
                        days_n = int(days_param)
                    except (TypeError, ValueError):
                        days_n = 0
                    if days_n > 0:
                        cutoff = (datetime.now() - timedelta(days=days_n)).strftime('%Y-%m-%dT%H:%M:%S')
                        where.append('created_at >= ?')
                        args.append(cutoff)
                if source_f == 'unsynced':
                    where.append('IFNULL(crm_synced,0) = 0')
                elif source_f:
                    where.append('source = ?')
                    args.append(source_f)
                if d_from:
                    where.append("(CASE WHEN IFNULL(visit_time,'') != '' THEN visit_time ELSE created_at END) >= ?")
                    args.append(d_from)
                if d_to:
                    where.append("(CASE WHEN IFNULL(visit_time,'') != '' THEN visit_time ELSE created_at END) <= ?")
                    args.append(d_to + 'T23:59:59')
                wsql = ('WHERE ' + ' AND '.join(where)) if where else ''

                total = 0
                if page_no:
                    c.execute(f'SELECT COUNT(*) FROM visits {wsql}', args)
                    total = c.fetchone()[0]
                    c.execute(f'SELECT * FROM visits {wsql} ORDER BY created_at DESC LIMIT ? OFFSET ?',
                              args + [page_size, (page_no - 1) * page_size])
                elif where:
                    # 原有行为：pin / group 筛选返回全量（手机端同步依赖）
                    c.execute(f'SELECT * FROM visits {wsql} ORDER BY created_at DESC', args)
                else:
                    c.execute('SELECT * FROM visits ORDER BY created_at DESC LIMIT 500')
                rows = [dict(r) for r in c.fetchall()]
                # v4.29: kefu_tel 实际存的是**顾问姓名**（插件端登记弹窗下拉的 value 就是姓名），
                #   原实现按 `WHERE pin IN (姓名…)` 查 ⇒ 永远匹配不上，「顾问姓名」列恒为空。
                #   改为按 name 查，并把顾问的 PIN 一并回填（kefu_pin），便于核对归属。
                try:
                    kefu_names = list(set(r.get('kefu_tel','') for r in rows if r.get('kefu_tel','')))
                    if kefu_names:
                        ph = ','.join(['?'] * len(kefu_names))
                        c.execute(f'SELECT pin, name FROM advisor_names WHERE name IN ({ph})', kefu_names)
                        pin_map = {}
                        for r2 in c.fetchall():
                            pin_map.setdefault(r2['name'], r2['pin'])
                        for r in rows:
                            nm = r.get('kefu_tel','')
                            r['kefu_name'] = nm
                            if nm and nm in pin_map:
                                r['kefu_pin'] = pin_map[nm]
                except Exception: pass
                if page_no:
                    return ('json', 200, json.dumps(
                        {'ok': True, 'total': total, 'page': page_no, 'page_size': page_size, 'rows': rows},
                        ensure_ascii=False).encode('utf-8'))
                return ('json', 200, json.dumps(rows, ensure_ascii=False).encode('utf-8'))
            except Exception as e:
                return ('err', 500, _err_json('DB_ERROR', str(e)))
            finally:
                if conn:
                    conn.close()

        res = await _run_db(_visits_list_sync)
        if res[0] == 'err':
            return (res[1], JSON_HDR, res[2])
        return (res[1], JSON_HDR, res[2])

    # v4.18: 服务端 CSV 导出（完整数据，不再只导屏幕上已渲染的行）
    # GET /api/v1/visits/export?token=xxx[&pin=][&group=][&days=][&source=][&d_from=][&d_to=]
    if path == '/api/v1/visits/export':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        pin = qs.get('pin', [''])[0]
        group_id = qs.get('group', [''])[0]
        days_param = qs.get('days', [''])[0]
        source_f = qs.get('source', [''])[0]
        d_from = qs.get('d_from', [''])[0].strip()[:10]
        d_to = qs.get('d_to', [''])[0].strip()[:10]

        # v4.21.2 (C-1): 查询 + ≤20 万行 fetchall + 内存拼 CSV 全段移入线程池，
        # 导出期间事件循环继续跑 WS 拨号/心跳（此前整段同步，全员卡顿根因）
        def _export_visits_sync():
            conn = None
            try:
                conn = _connect_db()
                conn.row_factory = sqlite3.Row
                c = conn.cursor()
                where = []
                args = []
                if group_id:
                    try:
                        gid = int(group_id)
                    except (TypeError, ValueError):
                        return ('err', 400, _err_json('INVALID_GROUP', '分组 ID 无效'))
                    c.execute('SELECT pin FROM advisor_names WHERE group_id=?', (gid,))
                    group_pins = [r['pin'] for r in c.fetchall()]
                    if group_pins:
                        where.append('pin IN (%s)' % ','.join(['?'] * len(group_pins)))
                        args += group_pins
                    else:
                        where.append('1=0')
                elif pin:
                    where.append('pin=?')
                    args.append(pin)
                if days_param:
                    try:
                        days_n = int(days_param)
                    except (TypeError, ValueError):
                        days_n = 0
                    if days_n > 0:
                        cutoff = (datetime.now() - timedelta(days=days_n)).strftime('%Y-%m-%dT%H:%M:%S')
                        where.append('created_at >= ?')
                        args.append(cutoff)
                if source_f == 'unsynced':
                    where.append('IFNULL(crm_synced,0) = 0')
                elif source_f:
                    where.append('source = ?')
                    args.append(source_f)
                if d_from:
                    where.append("(CASE WHEN IFNULL(visit_time,'') != '' THEN visit_time ELSE created_at END) >= ?")
                    args.append(d_from)
                if d_to:
                    where.append("(CASE WHEN IFNULL(visit_time,'') != '' THEN visit_time ELSE created_at END) <= ?")
                    args.append(d_to + 'T23:59:59')
                wsql = ('WHERE ' + ' AND '.join(where)) if where else ''
                c.execute(f'SELECT * FROM visits {wsql} ORDER BY created_at DESC LIMIT 200000', args)
                rows = [dict(r) for r in c.fetchall()]
                # v4.29: kefu_tel 存的就是**顾问姓名**（插件端登记弹窗下拉的 value 即姓名），
                #   原实现按 `WHERE pin IN (姓名…)` 关联 advisor_names ⇒ 永远匹配不上，
                #   导出的「顾问姓名」整列空白。直接回填，无需再查库。
                for r in rows:
                    r['kefu_name'] = str(r.get('kefu_tel') or '').strip()
            except Exception as e:
                return ('err', 500, _err_json('DB_ERROR', str(e)))
            finally:
                if conn:
                    conn.close()

            import csv as _csv
            import io as _io
            buf = _io.StringIO()
            buf.write('\ufeff')  # BOM：Excel 直接打开中文不乱码
            w = _csv.writer(buf)
            # v4.29: 原「顾问电话」列存的其实是**顾问姓名**（插件端传的是姓名），
            #   且「顾问姓名」列因按 pin 误查而整列空白。现改为「接待顾问」（= 归属人姓名）
            #   + 「归属顾问PIN」（= visits.pin，即落库时的归属键）。
            w.writerow(['ID', '客户姓名', '手机号', '接待顾问', '归属顾问PIN', '事由', '来源', 'CRM同步', '登记时间', '来访时间'])
            for r in rows:
                cells = [
                    r.get('id', ''),
                    r.get('name', ''), r.get('mobile', ''), r.get('kefu_tel', ''),
                    r.get('pin', ''), r.get('visit_type', ''),
                    {'phone': '手机', 'crm_sync': 'CRM同步'}.get(r.get('source', ''), '插件'),
                    '已同步' if r.get('crm_synced') else '未同步',
                    r.get('created_at', ''), r.get('visit_time', ''),
                ]
                # 防 CSV 公式注入：以 =+-@ 开头的单元格前置单引号
                safe_cells = []
                for v in cells:
                    s = str(v if v is not None else '')
                    if s[:1] in ('=', '+', '-', '@'):
                        s = "'" + s
                    safe_cells.append(s)
                w.writerow(safe_cells)
            filename = 'visits_' + datetime.now().strftime('%Y%m%d_%H%M%S') + '.csv'
            return ('csv', filename, buf.getvalue().encode('utf-8'))

        kind, a, b = await _run_db(_export_visits_sync)
        if kind == 'err':
            return (a, JSON_HDR, b)
        return (200, [
            ('Content-Type', 'text/csv; charset=utf-8'),
            ('Content-Disposition', f'attachment; filename={a}'),
            ('Access-Control-Allow-Origin', '*'),
        ], b)

    # 删除: GET /api/v1/visit/delete?id=N
    if path == '/api/v1/visit/delete':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        rid = qs.get('id', [''])[0]
        if not rid:
            return (200, JSON_HDR, _err_json('MISSING_ID', '缺少记录 id'))
        conn = None
        try:
            conn = _connect_db()
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
                conn.close()

    # 更新: GET /api/v1/visit/update?id=N&name=...&mobile=...&visit_type=...
    if path == '/api/v1/visit/update':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        rid = qs.get('id', [''])[0]
        if not rid:
            return (200, JSON_HDR, _err_json('MISSING_ID', '缺少记录 id'))
        fields = []
        values = []
        for key in ('name', 'mobile', 'kefu_tel', 'visit_type'):
            val = qs.get(key, [''])[0].strip()
            if val:
                fields.append(f'{key}=?')
                values.append(val)
        if not fields:
            return (200, JSON_HDR, _err_json('NO_FIELDS', '没有要更新的字段'))
        now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        fields.append('updated_at=?')
        values.append(now_str)
        values.append(int(rid))
        conn = None
        try:
            conn = _connect_db()
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
                conn.close()

    # ===== 新增: Dashboard 管理 API =====

    # API: 设备清单 GET /api/v1/devices
    if path == '/api/v1/devices':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR

        # v4.21.2 (C-1): DB 段移入线程池（面板手机管理页轮询端点）
        def _devices_list_sync():
            conn = None
            try:
                conn = _connect_db()
                conn.row_factory = sqlite3.Row
                c = conn.cursor()
                c.execute('SELECT * FROM phones ORDER BY last_seen DESC')
                rows = [dict(r) for r in c.fetchall()]
                # 标注在线状态 + IP + 当前PIN
                # v4.16 修复B: 在线状态按 device_id 匹配（旧 meta 无 device_id 时回退 device_name）
                online_map = {}      # device_id -> {ip, pin}
                try:
                    snapshot = list(ws_meta.items())
                except Exception:
                    snapshot = []
                for _ws, _meta in snapshot:
                    if _meta.get('role') == 'phone' and _meta.get('device_name'):
                        _did = _meta.get('device_id') or _meta['device_name']
                        online_map[_did] = {
                            'ip': _meta.get('ip', ''),
                            'pin': _meta.get('pin', '')
                        }
                # 收集所有 PIN 用于查询姓名
                all_pins = set()
                for row in rows:
                    did = row.get('device_id', '')
                    row['is_online'] = did in online_map
                    row['current_ip'] = online_map.get(did, {}).get('ip', '')
                    pin_ = online_map.get(did, {}).get('pin', '') or row.get('last_pin', '')
                    row['current_pin'] = pin_
                    row['current_name'] = ''
                    if pin_:
                        all_pins.add(pin_)
                # 批量查询姓名
                if all_pins:
                    placeholders = ','.join(['?'] * len(all_pins))
                    c.execute(f"SELECT pin, name FROM advisor_names WHERE pin IN ({placeholders})", list(all_pins))
                    pin_name_map = {r['pin']: r['name'] for r in c.fetchall()}
                    for row in rows:
                        if row.get('current_pin') and row['current_pin'] in pin_name_map:
                            row['current_name'] = pin_name_map[row['current_pin']]
                return ('json', 200, json.dumps({'ok': True, 'devices': rows}, ensure_ascii=False).encode('utf-8'))
            except Exception as e:
                return ('err', 500, _err_json('DB_ERROR', str(e)))
            finally:
                if conn:
                    conn.close()

        res = await _run_db(_devices_list_sync)
        return (res[1], JSON_HDR, res[2])

    # API: 设备PIN历史 GET /api/v1/device-history?device_id=xxx
    if path == '/api/v1/device-history':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0].strip()
        if not device_id:
            return (200, JSON_HDR, _err_json('MISSING', 'device_id 不能为空'))
        conn = None
        try:
            conn = _connect_db()
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute(
                "SELECT pin, event_time FROM phone_events WHERE device_id=? AND event_type='login' AND pin!='' ORDER BY event_time DESC LIMIT 50",
                (device_id,)
            )
            events = [dict(r) for r in c.fetchall()]
            # 补全姓名
            pins = list(set(e['pin'] for e in events))
            if pins:
                placeholders = ','.join(['?'] * len(pins))
                c.execute(f"SELECT pin, name FROM advisor_names WHERE pin IN ({placeholders})", pins)
                pin_name_map = {r['pin']: r['name'] for r in c.fetchall()}
                for e in events:
                    e['name'] = pin_name_map.get(e['pin'], '')
            return (200, JSON_HDR, json.dumps({'ok': True, 'history': events}, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # API: 设置设备默认PIN GET /api/v1/device-set-default-pin?device_id=xxx&default_pin=xxx
    if path == '/api/v1/device-set-default-pin':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0].strip()
        dpin = qs.get('default_pin', [''])[0].strip()
        if not device_id:
            return (200, JSON_HDR, _err_json('MISSING_PARAM', 'device_id 不能为空'))
        if dpin and not validate_pin(dpin) and dpin != '-':
            return (200, JSON_HDR, _err_json('INVALID_PIN', '默认PIN须为4位或11位数字'))
        conn = None
        try:
            conn = _connect_db()
            c = conn.cursor()
            now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
            if dpin == '-':
                c.execute('UPDATE phones SET default_pin = NULL WHERE device_id = ?', (device_id,))
            else:
                c.execute('''INSERT INTO phones (device_id, default_pin, last_pin, first_seen, last_seen)
                             VALUES (?, ?, ?, ?, ?)
                             ON CONFLICT(device_id) DO UPDATE SET default_pin=excluded.default_pin, last_seen=excluded.last_seen''',
                          (device_id, dpin, dpin, now_str, now_str))
            conn.commit()
            log.info(f'DEVICE_DEFAULT_PIN device={device_id} default_pin={dpin}')
            return (200, JSON_HDR, json.dumps({'ok': True, 'device_id': device_id, 'default_pin': dpin}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # API: 设置设备别名 GET /api/v1/device/update?device_id=xxx&label=xxx
    if path == '/api/v1/device/update':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0].strip()
        label = qs.get('label', [''])[0].strip()
        if not device_id:
            return (200, JSON_HDR, _err_json('MISSING_PARAM', 'device_id 不能为空'))
        conn = None
        try:
            conn = _connect_db()
            c = conn.cursor()
            now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
            c.execute('''INSERT INTO phones (device_id, label, last_seen, first_seen)
                         VALUES (?, ?, ?, ?)
                         ON CONFLICT(device_id) DO UPDATE SET label=excluded.label, last_seen=excluded.last_seen''',
                      (device_id, label, now_str, now_str))
            conn.commit()
            log.info(f'DEVICE_LABEL device={device_id} label={label}')
            return (200, JSON_HDR, json.dumps({'ok': True, 'device_id': device_id, 'label': label}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # API: 通话记录查询 GET /api/v1/calls?device_id=&pin=&date_from=&date_to=&number=&limit=&offset=
    if path == '/api/v1/calls':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0]
        pin = qs.get('pin', [''])[0]
        date_from = qs.get('date_from', [''])[0]
        date_to = qs.get('date_to', [''])[0]
        number = qs.get('number', [''])[0]
        limit = _safe_limit(qs.get('limit', ['200'])[0], 200, 1000)
        offset = _safe_offset(qs.get('offset', ['0'])[0])

        # v4.21.2 (C-1): DB 段移入线程池（面板通话记录页轮询端点）
        def _calls_list_sync():
            conn = None
            try:
                conn = _connect_db()
                conn.row_factory = sqlite3.Row
                c = conn.cursor()
                where = []
                params = []
                if device_id:
                    where.append('cr.device_id = ?'); params.append(device_id)
                if pin:
                    # v4.29: 按「手机主人」筛，与下面的认人口径一致
                    where.append(f'{_OWNER_PIN_SQL} = ?'); params.append(pin)
                if number:
                    where.append('cr.number LIKE ?'); params.append(f'%{number}%')
                if date_from:
                    try:
                        d = datetime.strptime(date_from, '%Y-%m-%d')
                        where.append('cr.dial_time >= ?'); params.append(int(d.timestamp() * 1000))
                    except Exception: pass  # invalid date format, skip filter
                if date_to:
                    try:
                        d = datetime.strptime(date_to + 'T23:59:59', '%Y-%m-%dT%H:%M:%S')
                        where.append('cr.dial_time <= ?'); params.append(int(d.timestamp() * 1000))
                    except Exception: pass  # invalid date format, skip filter
                w = ' AND '.join(where) if where else '1=1'
                # v4.29: pin 列改出「手机主人」（原 p.last_pin 会被下午换 PIN 覆盖，
                # 导致该机上午的记录被判给同事），并顺带带出顾问姓名供面板显示。
                c.execute(f'''SELECT cr.*, {_OWNER_PIN_SQL} as pin, p.device_model, p.app_version,
                                    a.name as advisor_name
                             FROM call_records_raw cr
                             LEFT JOIN phones p ON cr.device_id = p.device_id
                             LEFT JOIN advisor_names a ON a.pin = {_OWNER_PIN_SQL}
                             WHERE {w} ORDER BY cr.dial_time DESC LIMIT ? OFFSET ?''',
                          params + [limit, offset])
                rows = [dict(r) for r in c.fetchall()]
                c.execute(f'SELECT COUNT(*) FROM call_records_raw cr LEFT JOIN phones p ON cr.device_id=p.device_id WHERE {w}', params)
                total = c.fetchone()[0]
                return ('json', 200, json.dumps({
                    'ok': True, 'calls': rows, 'total': total, 'limit': limit, 'offset': offset
                }, ensure_ascii=False).encode('utf-8'))
            except Exception as e:
                return ('err', 500, _err_json('DB_ERROR', str(e)))
            finally:
                if conn:
                    conn.close()

        res = await _run_db(_calls_list_sync)
        return (res[1], JSON_HDR, res[2])

    # v4.19: 通话记录 CSV 导出（导出当前筛选条件下的完整结果集，不再只导当前页 50 行）
    # GET /api/v1/calls/export?token=xxx[&device_id=][&pin=][&date_from=][&date_to=][&number=]
    if path == '/api/v1/calls/export':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        e_device_id = qs.get('device_id', [''])[0]
        e_pin = qs.get('pin', [''])[0]
        e_date_from = qs.get('date_from', [''])[0]
        e_date_to = qs.get('date_to', [''])[0]
        e_number = qs.get('number', [''])[0]

        # v4.21.2 (C-1): 查询 + ≤20 万行 fetchall + CSV 拼接全段移入线程池
        def _export_calls_sync():
            conn = None
            try:
                conn = _connect_db()
                conn.row_factory = sqlite3.Row
                c = conn.cursor()
                where = []
                params = []
                if e_device_id:
                    where.append('cr.device_id = ?'); params.append(e_device_id)
                if e_pin:
                    # v4.29: 与 /api/v1/calls 同口径（手机主人）
                    where.append(f'{_OWNER_PIN_SQL} = ?'); params.append(e_pin)
                if e_number:
                    where.append('cr.number LIKE ?'); params.append(f'%{e_number}%')
                if e_date_from:
                    try:
                        d = datetime.strptime(e_date_from, '%Y-%m-%d')
                        where.append('cr.dial_time >= ?'); params.append(int(d.timestamp() * 1000))
                    except Exception:
                        pass
                if e_date_to:
                    try:
                        d = datetime.strptime(e_date_to + 'T23:59:59', '%Y-%m-%dT%H:%M:%S')
                        where.append('cr.dial_time <= ?'); params.append(int(d.timestamp() * 1000))
                    except Exception:
                        pass
                wsql = ('WHERE ' + ' AND '.join(where)) if where else ''
                # v4.29: 导出与列表同口径 —— 归属 = 手机主人，并带出顾问姓名
                c.execute(f'''SELECT cr.*, {_OWNER_PIN_SQL} as pin, p.device_model, p.app_version,
                                    a.name as advisor_name
                             FROM call_records_raw cr
                             LEFT JOIN phones p ON cr.device_id = p.device_id
                             LEFT JOIN advisor_names a ON a.pin = {_OWNER_PIN_SQL}
                             {wsql} ORDER BY cr.dial_time DESC LIMIT 200000''', params)
                rows = [dict(r) for r in c.fetchall()]
            except Exception as e:
                return ('err', 500, _err_json('DB_ERROR', str(e)))
            finally:
                if conn:
                    conn.close()

            import csv as _csv
            import io as _io
            _CALL_TYPES = {0: '未知', 1: '呼入', 2: '呼出', 3: '未接'}
            buf = _io.StringIO()
            buf.write('\ufeff')  # BOM：Excel 直接打开中文不乱码
            _cw = _csv.writer(buf)
            _cw.writerow(['设备ID', '顾问', '号码', '通话时间', '时长(秒)', '类型', 'SIM卡', '机型', '版本'])
            for r in rows:
                ts = r.get('dial_time')
                try:
                    tstr = datetime.fromtimestamp(int(ts) / 1000).strftime('%Y-%m-%d %H:%M:%S') if ts else ''
                except (TypeError, ValueError, OSError):
                    tstr = str(ts if ts is not None else '')
                try:
                    ct = int(r.get('call_type'))
                except (TypeError, ValueError):
                    ct = -1
                cells = [
                    r.get('device_id', ''),
                    r.get('advisor_name', ''),
                    r.get('number', ''),
                    tstr,
                    r.get('duration', 0),
                    _CALL_TYPES.get(ct, '未知'),
                    'SIM' + str((r.get('sim_slot') or 0) + 1),
                    r.get('device_model', ''),
                    r.get('app_version', ''),
                ]
                # 防 CSV 公式注入：以 =+-@ 开头的单元格前置单引号
                safe_cells = []
                for v in cells:
                    s = str(v if v is not None else '')
                    if s[:1] in ('=', '+', '-', '@'):
                        s = "'" + s
                    safe_cells.append(s)
                _cw.writerow(safe_cells)
            filename = 'calls_' + datetime.now().strftime('%Y%m%d_%H%M%S') + '.csv'
            return ('csv', filename, buf.getvalue().encode('utf-8'))

        kind, a, b = await _run_db(_export_calls_sync)
        if kind == 'err':
            return (a, JSON_HDR, b)
        return (200, [
            ('Content-Type', 'text/csv; charset=utf-8'),
            ('Content-Disposition', f'attachment; filename={a}'),
            ('Access-Control-Allow-Origin', '*'),
        ], b)

    # API: 踢出客户端 GET /api/v1/kick?pin=&role=
    if path == '/api/v1/kick':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        pin = qs.get('pin', [''])[0]
        role = qs.get('role', [''])[0]
        if not pin:
            return (200, JSON_HDR, _err_json('MISSING', 'pin不能为空'))
        kicked = 0
        for _ws, _meta in list(ws_meta.items()):
            if _meta.get('pin') == pin and (not role or _meta.get('role') == role):
                kicked += 1
                async def _kick_ws(ws=_ws):
                    try:
                        await ws.close(4000, 'kicked by admin')
                    except Exception:
                        pass
                _schedule_async(_kick_ws())
        log.info(f'KICK pin={pin} role={role or "any"} count={kicked}')
        return (200, JSON_HDR, json.dumps({'ok': True, 'kicked': kicked}).encode('utf-8'))

    # API: 每日对账 GET /api/v1/phone-stats?device_id=
    if path == '/api/v1/phone-stats':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0]
        conn = None
        try:
            conn = _connect_db()
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            if device_id:
                c.execute('SELECT * FROM phone_daily_stats WHERE device_id=? ORDER BY date DESC LIMIT 30', (device_id,))
            else:
                c.execute('SELECT * FROM phone_daily_stats ORDER BY date DESC, device_id LIMIT 200')
            rows = [dict(r) for r in c.fetchall()]
            return (200, JSON_HDR, json.dumps({'ok': True, 'stats': rows}, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # API: 手机事件日志 GET /api/v1/events?device_id=&event_type=&limit=
    if path == '/api/v1/events':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0]
        event_type = qs.get('event_type', [''])[0]
        limit = _safe_limit(qs.get('limit', ['100'])[0], 100, 500)
        conn = None
        try:
            conn = _connect_db()
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            where = []; params = []
            if device_id:
                where.append('device_id=?'); params.append(device_id)
            if event_type:
                where.append('event_type=?'); params.append(event_type)
            w = ' AND '.join(where) if where else '1=1'
            c.execute(f'SELECT * FROM phone_events WHERE {w} ORDER BY event_time DESC LIMIT ?', params + [limit])
            rows = [dict(r) for r in c.fetchall()]
            return (200, JSON_HDR, json.dumps({'ok': True, 'events': rows}, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # API: 连接数历史 GET /api/history
    if path == '/api/history':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        data = list(connection_history[-288:])  # 最近4小时（288×30s）
        return (200, JSON_HDR, json.dumps({'ok': True, 'history': data}, ensure_ascii=False).encode('utf-8'))

    # Web 管理界面
    if path == '/' or path == '/index.html':
        return (200, [('Content-Type', 'text/html; charset=utf-8')], HTML_CONTENT.encode('utf-8'))
    
    # 404
    return (404, [('Content-Type', 'text/plain')], b'Not Found')

# ==================== 服务器启停 ====================
_heartbeat_task = None  # C4修复: 保存心跳任务引用，防止重启时累积多个
# C4修复扩展: 记录全部周期任务，重启前统一取消，否则每次拉起一遍服务器都会
# 多叠一层 periodic_save / periodic_snapshot / periodic_cleanup。
_periodic_tasks = []

async def run_server():
    global server_instance, _heartbeat_task, loop
    log.info(f'Starting server on port {PORT}...')

    # P0-Fix: 必须把事件循环登记到全局 loop。
    # headless 路径（Docker entrypoint）只走 asyncio.run(run_server())，从不经过
    # run_server_thread()；此前这里用局部变量接收 get_running_loop()，全局 loop 恒为
    # None，于是所有 _schedule_async（REST 拨号 / 挂断 / 登记推送 / 踢人 / 授权回调）
    # 都落到 else 分支被静默丢弃 —— Docker 实例核心链路"看着在跑，实际什么都没做"。
    loop = asyncio.get_running_loop()
    # 自动配置防火墙规则（放到 executor 中避免阻塞事件循环）
    # P0-Fix: 扩大默认线程池，防止 sync process_request 因线程池饱和而排队超时
    loop.set_default_executor(ThreadPoolExecutor(max_workers=32, thread_name_prefix='ws-http'))
    await loop.run_in_executor(None, configure_firewall)

    # C4修复: 取消旧心跳任务再创建新的
    # 注意：已禁用应用层心跳检测，改用WebSocket内置的ping/pong机制
    # 避免因只有WebSocket心跳而没有应用层消息导致误判超时
    log.info('Using WebSocket built-in ping/pong mechanism (application-layer heartbeat disabled)')

    async with serve(handle_connection, '0.0.0.0', PORT,
                     process_request=None,
                     create_protocol=_PeerProtocol,
                     ping_interval=30,
                     ping_timeout=90,  # 增加 ping 超时到 90 秒
                     close_timeout=10,
                     max_queue=128) as server:  # P0-Fix: 增大连接队列防止高并发丢连接
        server_instance = server
        log.info(f'Server started on port {PORT}, PID={os.getpid()}')
        log.info(f'Web 管理界面: http://0.0.0.0:{PORT} (与 WebSocket 同端口)')

        # 通知托盘状态更新
        update_tray_status(True)

        # C4修复: 取消旧周期任务再创建新的，防止服务器重启时任务叠加（内存/DB 双写）
        for _old in list(_periodic_tasks):
            _old.cancel()
        _periodic_tasks.clear()

        # Fix ⏳4: periodically persist stats every 5 minutes
        async def periodic_save():
            while True:
                await asyncio.sleep(300)
                save_stats()
        _periodic_tasks.append(asyncio.create_task(periodic_save()))

        # 连接数历史快照（每30秒记录一次，供仪表盘趋势图）
        async def periodic_snapshot():
            while True:
                await asyncio.sleep(30)
                snapshot_connection_history()
        _periodic_tasks.append(asyncio.create_task(periodic_snapshot()))

        # 内存清理（每10分钟清理一次无界数据结构）
        async def periodic_cleanup():
            while True:
                await asyncio.sleep(600)
                cleanup_memory()
        _periodic_tasks.append(asyncio.create_task(periodic_cleanup()))

        # 保持运行
        await asyncio.Future()  # 永不完成

async def stop_server():
    global server_instance
    if server_instance:
        log.info('Stopping server...')
        # 关闭所有连接
        for ws in list(ws_connections):
            try:
                await ws.close(1001, 'server shutting down')
            except Exception:
                pass
        server_instance.close()
        await server_instance.wait_closed()
        server_instance = None
        log.info('Server stopped')
        update_tray_status(False)

# ==================== 系统托盘 ====================
tray_icon = None
server_running = False
loop = None  # asyncio event loop

def create_tray_icon():
    """创建托盘图标（绿色圆点）"""
    from PIL import Image, ImageDraw

    # 32x32 绿色圆点图标
    img = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse([4, 4, 28, 28], fill=(76, 175, 80, 255))  # 绿色
    return img

def create_tray_icon_stopped():
    """创建停止状态图标（灰色圆点）"""
    from PIL import Image, ImageDraw

    img = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse([4, 4, 28, 28], fill=(158, 158, 158, 255))  # 灰色
    return img

def update_tray_status(running):
    """更新托盘图标和菜单"""
    global server_running, tray_icon
    server_running = running
    if tray_icon:
        try:
            if running:
                tray_icon.icon = create_tray_icon()
                tray_icon.title = f'AutoDial 云中转\n运行中 | 端口 {PORT}'
            else:
                tray_icon.icon = create_tray_icon_stopped()
                tray_icon.title = f'AutoDial 云中转\n已停止 | 端口 {PORT}'
            tray_icon.menu = create_menu()
        except Exception as e:
            log.error(f'Update tray error: {e}')

def create_menu():
    """创建托盘菜单"""
    import pystray
    status_text = '● 运行中' if server_running else '○ 已停止'
    return pystray.Menu(
        pystray.MenuItem(f'AutoDial 云中转 - {status_text}', None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(f'端口: {PORT}', None, enabled=False),
        pystray.MenuItem(f'Web: http://127.0.0.1:{PORT}', None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('停止服务器' if server_running else '启动服务器',
                         toggle_server, default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('打开 Web 管理界面', open_web),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('打开日志', open_log),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('退出', quit_app),
    )

def toggle_server():
    """切换服务器启停"""
    global loop
    if server_running:
        if loop and loop.is_running():
            asyncio.run_coroutine_threadsafe(stop_server(), loop)
    else:
        if loop and loop.is_running():
            asyncio.run_coroutine_threadsafe(start_server_task(), loop)

async def start_server_task():
    """启动服务器任务（D9修复: 先等旧服务器停止再启动，防止端口冲突）"""
    if server_instance is not None:
        await stop_server()
    asyncio.create_task(run_server())

def open_web():
    """打开 Web 管理界面（注意：Web管理界面在WebSocket端口上通过HTTP路由处理）"""
    import webbrowser
    webbrowser.open(f'http://127.0.0.1:{PORT}')

def open_log():
    """打开日志文件"""
    if log_file_path and os.path.exists(log_file_path):
        os.startfile(log_file_path)

def quit_app():
    """退出应用"""
    global loop
    if loop and loop.is_running():
        asyncio.run_coroutine_threadsafe(shutdown(), loop)
    else:
        sys.exit(0)

async def shutdown():
    """优雅关闭"""
    save_stats()  # Fix ⏳4: persist stats before shutdown
    await stop_server()
    if tray_icon:
        tray_icon.stop()
    # Y-10修复(v4.23): 协程里的 sys.exit 抛 SystemExit 只会终止运行事件循环的线程
    # （托盘路径下 loop 在子线程），主线程的托盘图标残留成"僵尸进程"。
    # 走到这里说明落盘与停服已完成，直接结束整个进程即为用户点「退出」的预期。
    os._exit(0)

def run_tray():
    """在主线程运行托盘图标"""
    global tray_icon
    import pystray

    tray_icon = pystray.Icon(
        'AutoDial Cloud Relay',
        icon=create_tray_icon_stopped(),
        title=f'AutoDial 云中转\n已停止 | 端口 {PORT}',
        menu=create_menu()
    )
    tray_icon.run()

def run_server_thread():
    """在线程中运行 asyncio 服务器"""
    global loop
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(run_server())
    except Exception as e:
        import traceback
        log.error(f'Server error: {e}')
        log.error(f'Traceback: {traceback.format_exc()}')
        update_tray_status(False)

def run_headless():
    """headless 启动入口（Docker / 无桌面环境）。

    与 run_server_thread 的区别与存在理由：
    1) 显式登记全局 loop（run_server 内部也会登记，这里是双保险）；
    2) 接管 SIGTERM/SIGINT：`docker stop` 默认发 SIGTERM。此前 import signal 从未
       使用过，容器重启一律硬杀 —— 统计来不及落盘、WS 连接不打招呼就断、周期任务
       残留到下次启动叠加。现在改为触发 落盘 + 关闭全部连接 + 停止服务器。
    """
    global loop
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def _on_signal(signum, _frame):
        log.info(f'Received signal {signum}, shutting down gracefully...')
        try:
            asyncio.run_coroutine_threadsafe(shutdown_gracefully(), loop)
        except Exception as e:
            log.error(f'graceful shutdown failed: {e}')

    # Windows 下 SIGTERM 语义受限，注册失败直接忽略
    for _sig_name in ('SIGTERM', 'SIGINT'):
        _sig = getattr(signal, _sig_name, None)
        if _sig is None:
            continue
        try:
            signal.signal(_sig, _on_signal)
        except (ValueError, OSError, AttributeError):
            pass

    try:
        loop.run_until_complete(run_server())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        import traceback
        log.error(f'Server error: {e}')
        log.error(f'Traceback: {traceback.format_exc()}')
        sys.exit(1)

async def shutdown_gracefully():
    """优雅关闭：落盘统计 → 取消周期任务 → 关闭连接并停服 → 停事件循环。"""
    try:
        save_stats()
    except Exception as e:
        log.error(f'save_stats on shutdown failed: {e}')
    for t in list(_periodic_tasks):
        t.cancel()
    _periodic_tasks.clear()
    try:
        await stop_server()
    except Exception as e:
        log.error(f'stop_server on shutdown failed: {e}')
    log.info('Graceful shutdown complete')
    asyncio.get_running_loop().stop()

# ==================== 主入口 ====================
def main():
    # Fix Q4: check if another instance is already running
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(('127.0.0.1', PORT))
    except OSError:
        print(f'')
        print(f'  ⚠ AutoDial Cloud Relay 已在运行中（端口 {PORT} 被占用）')
        print(f'  请先关闭正在运行的实例再启动。')
        print(f'')
        if sys.platform == 'win32':
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, f'AutoDial Cloud Relay 已在运行中\n端口 {PORT} 被占用，请先关闭已有实例。', 'AutoDial', 0x30)
        sys.exit(1)
    finally:
        sock.close()

    print('')
    print('========================================')
    print('  AutoDial Cloud Relay Server')
    print('  版本: v1')
    print('========================================')
    print(f'  Port:     {PORT}')
    print(f'  PID:      {os.getpid()}')
    print('========================================')
    print('')
    print(f'  Web 管理界面: http://127.0.0.1:{PORT} (与 WebSocket 同端口)')
    print('')

    # Fix ⏳4: restore persisted stats from previous runs
    load_stats()

    # 无桌面环境（Docker / Windows 服务化）直接走 headless：不创建托盘、接管 SIGTERM
    if (os.environ.get('AUTODIAL_HEADLESS') or '').strip().lower() in ('1', 'true', 'yes'):
        run_headless()
        return

    # 启动服务器线程
    server_thread = threading.Thread(target=run_server_thread, daemon=True)
    server_thread.start()

    # 主线程运行托盘（pystray 要求主线程）；无桌面环境时跳过
    try:
        run_tray()
    except Exception:
        log.info(f'Server running without system tray (headless), port={PORT}')
        server_thread.join()

if __name__ == '__main__':
    main()
