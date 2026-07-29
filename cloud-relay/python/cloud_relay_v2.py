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
from collections import defaultdict
from datetime import datetime, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, urlencode

import websockets
from websockets.legacy.server import serve

# ==================== 配置 ====================
DEFAULT_PORT = 35430
PORT = DEFAULT_PORT
# Fix D4: Web 管理界面和 WebSocket 共用 PORT, WEB_PORT 已废弃

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

def setup_logging():
    global log_file_path
    app_data = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')),
                            'autodial-cloud-relay')
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
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'visits.db')

def init_db():
    """初始化 visits 表及索引，失败时降级到内存数据库"""
    global DB_PATH
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
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute(create_visits)
        c.execute('CREATE INDEX IF NOT EXISTS idx_visits_pin ON visits(pin)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at)')
        c.execute(create_advisor)
        c.execute('CREATE INDEX IF NOT EXISTS idx_advisor_updated ON advisor_names(updated_at)')
        c.execute(create_groups)
        c.execute(create_admin_accounts)
        c.execute(create_phones)
        c.execute(create_call_records)
        c.execute(create_phone_events)
        c.execute(create_phone_daily)
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
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute(create_visits)
        c.execute('CREATE INDEX IF NOT EXISTS idx_visits_pin ON visits(pin)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at)')
        c.execute(create_advisor)
        c.execute('CREATE INDEX IF NOT EXISTS idx_advisor_updated ON advisor_names(updated_at)')
        c.execute(create_groups)
        c.execute(create_admin_accounts)
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
        conn.close()

init_db()

# 首次启动：创建默认管理员账号（如果没有任何账号）
def _seed_default_admin():
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute('SELECT COUNT(*) FROM admin_accounts')
        if c.fetchone()[0] == 0:
            now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
            c.execute('INSERT INTO admin_accounts (username, password, created_at) VALUES (?, ?, ?)',
                      ('18335162275', '123456', now_str))
            conn.commit()
            log.info('ADMIN_SEED: 已创建默认管理员账号 (18335162275)')
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
    if stale_pins:
        log.info(f'MEM_CLEANUP: removed {len(stale_pins)} stale ext_activity entries')

    # 3. _pin_attempts: 清理超过 5 分钟未尝试的 IP
    for ip in list(_pin_attempts.keys()):
        _pin_attempts[ip] = [t for t in _pin_attempts[ip] if now - t < timedelta(minutes=1)]
        if not _pin_attempts[ip]:
            del _pin_attempts[ip]

    # 4. pending_visits: 每 PIN 最多保留 100 条
    for pin, group in list(pin_groups.items()):
        if len(group.pending_visits) > 100:
            trimmed = group.pending_visits[-100:]
            log.warning(f'MEM_CLEANUP: pin={pin} pending_visits trimmed {len(group.pending_visits)}→{len(trimmed)}')
            group.pending_visits = trimmed

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
                        'reason': '授权超时（120秒内无响应）'
                    }))
                    await ws.close(4003, 'auth_timeout')
                except Exception:
                    pass
            _schedule_async(_timeout_reject())
            log.info(f'AUTH_TIMEOUT id={rid} device={dn} pin={p}')

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
        app_data = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')),
                                'autodial-cloud-relay')
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
        app_data = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')),
                                'autodial-cloud-relay')
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
    group.pcs.discard(ws)
    group.phones.discard(ws)
    if not group.pcs and not group.phones:
        del pin_groups[pin]

# ==================== 心跳超时检测 ====================
HEARTBEAT_TIMEOUT = 90  # 90秒没收到消息就断开
MAX_TOTAL_CONNECTIONS = 500  # 全局连接上限（腾讯云中等配置安全值）

async def check_heartbeats():
    """定期检查心跳超时，关闭超时的连接"""
    while True:
        await asyncio.sleep(30)  # 每30秒检查一次
        now = datetime.now()
        to_close = []
        
        for ws, meta in list(ws_meta.items()):
            last_time = meta.get('last_message_time')
            if last_time:
                elapsed = (now - last_time).total_seconds()
                if elapsed > HEARTBEAT_TIMEOUT:
                    to_close.append((ws, meta, elapsed))
        
        for ws, meta, elapsed in to_close:
            try:
                await ws.close(1000, f'Heartbeat timeout ({HEARTBEAT_TIMEOUT}s)')
                log.warning(f'HEARTBEAT_TIMEOUT {meta.get("role", "unknown")} pin={meta.get("pin", "none")} ip={meta.get("ip", "?")} elapsed={elapsed:.0f}s')
            except Exception:
                pass
            ws_meta.pop(ws, None)  # C2修复: 确保 ws_meta 清理，防止僵尸连接积累

# ==================== PIN 尝试频率限制 ====================
MAX_PIN_ATTEMPTS_PER_MINUTE = 5
_pin_attempts: dict[str, list] = defaultdict(list)

def check_rate_limit(client_ip: str) -> bool:
    """检查是否超频，返回 True 表示应该拒绝"""
    now = datetime.now()
    # 清理过期条目
    _pin_attempts[client_ip] = [
        t for t in _pin_attempts[client_ip] if now - t < timedelta(minutes=1)
    ]
    if len(_pin_attempts[client_ip]) >= MAX_PIN_ATTEMPTS_PER_MINUTE:
        return True
    _pin_attempts[client_ip].append(now)
    return False

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
    'visit_record'
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
        return
    data = json.dumps(message, ensure_ascii=False)
    target_device = message.get('targetDevice')
    sent_count = 0
    for phone in list(group.phones):
        if phone != exclude_ws:
            # 如果指定了 targetDevice，只转发给匹配的设备
            if target_device:
                phone_meta = ws_meta.get(phone, {})
                phone_name = phone_meta.get('device_name', '')
                if phone_name != target_device:
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

# ==================== WebSocket 处理 ====================
server_instance = None
ws_connections = set()
EXT_ACTIVITY_TIMEOUT = 300  # 5分钟内收到过扩展REST请求视为在线
last_ext_activity = {}  # pin -> datetime 记录扩展最后活跃时间

def track_ext_activity(pin):
    """记录扩展活跃时间（每次REST请求调用）"""
    last_ext_activity[pin] = datetime.now()

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
                # 频率限制检查
                if check_rate_limit(client_ip):
                    await ws.send(json.dumps({'type': 'auth_fail', 'reason': '请求过于频繁，请稍后再试'}))
                    log.warning(f'RATE_LIMITED phone_hello ip={client_ip}')
                    # v6诊断: 记录当前速率限制状态
                    recent_attempts = len([t for t in _pin_attempts.get(client_ip, []) if datetime.now() - t < timedelta(minutes=1)])
                    log.warning(f'RATE_LIMIT_STATE ip={client_ip} attempts_in_last_minute={recent_attempts}/{MAX_PIN_ATTEMPTS_PER_MINUTE}')
                    continue
                pin = msg.get('pin', '')
                if not validate_pin(pin):
                    await ws.send(json.dumps({'type': 'auth_fail', 'reason': '配对码须为4位或11位数字'}))
                    continue
                remove_from_group(ws)
                meta['pin'] = pin
                meta['role'] = 'phone'
                meta['device_name'] = msg.get('deviceName', f'Phone-{client_ip[-3:]}')
                group = get_group(pin)
                # Fix B4: 同 PIN 只允许一台手机在线，踢掉旧连接
                for old_phone in list(group.phones):
                    if old_phone != ws:
                        try:
                            await old_phone.close(4001, 'duplicate_reconnect')
                        except Exception:
                            pass
                        group.phones.discard(old_phone)
                is_first_device = len(group.pcs) == 0 and len(group.phones) == 0

                # ===== 设备-PIN 绑定授权检查 =====
                device_name = meta['device_name']
                default_pin = _get_device_default_pin(device_name)
                needs_auth = False

                if default_pin is None:
                    # 设备未在云端注册 → 拒绝
                    await ws.send(json.dumps({
                        'type': 'auth_fail',
                        'reason': f'设备 {device_name} 未在云端注册，请联系管理员预设默认 PIN'
                    }))
                    log.warning(f'AUTH_DENIED_NO_DEFAULT device={device_name} pin={pin}')
                    continue
                elif default_pin != pin:
                    # PIN 不匹配：需扩展端授权（仅当目标 PIN 的扩展已激活且 CRM 页面打开）
                    needs_auth = True
                    ext_online = is_ext_online(pin)
                    if not ext_online:
                        await ws.send(json.dumps({
                            'type': 'auth_fail',
                            'reason': f'PIN {pin} 的浏览器插件未激活或 CRM 页面未打开，无法授权'
                        }))
                        log.warning(f'AUTH_DENIED_EXT_OFFLINE device={device_name} pin={pin} default_pin={default_pin}')
                        continue
                    # 创建授权请求
                    req_id = uuid.uuid4().hex[:12]
                    _pending_auths[req_id] = {
                        'ws': ws,
                        'pin': pin,
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
                    # 查询手机主人姓名
                    owner_name = ''
                    try:
                        conn2 = sqlite3.connect(DB_PATH)
                        c2 = conn2.cursor()
                        c2.execute('SELECT name FROM advisor_names WHERE pin=?', (default_pin,))
                        row2 = c2.fetchone()
                        if row2: owner_name = row2[0]
                    except Exception: pass
                    finally:
                        try: conn2.close()
                        except Exception: pass
                    # 通知手机等待授权
                    await ws.send(json.dumps({
                        'type': 'auth_pending',
                        'request_id': req_id,
                        'pin': pin,
                        'default_pin': default_pin,     # 手机主人的PIN
                        'default_name': owner_name,      # 手机主人的姓名
                        'message': f'等待 PIN {pin} 的浏览器插件授权中（需 CRM 页面打开）...'
                    }))
                    log.info(f'AUTH_REQUEST id={req_id} device={device_name} pin={pin} default_pin={default_pin} ext_online=1')

                if needs_auth:
                    continue  # 跳过后续处理，等待 PC 授权

                group.phones.add(ws)
                pc_online = len(group.pcs) > 0
                # 查询手机主人的姓名（用于手机端上门同步权限）
                owner_name = ''
                try:
                    conn = sqlite3.connect(DB_PATH)
                    c = conn.cursor()
                    c.execute('SELECT name FROM advisor_names WHERE pin=?', (default_pin,))
                    row = c.fetchone()
                    if row: owner_name = row[0]
                except Exception: pass
                finally:
                    try: conn.close()
                    except Exception: pass
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
                    for w in list(group.pcs) | list(group.phones):
                        if w != ws:
                            wm = ws_meta.get(w, {})
                            existing_devices.append(wm.get('device_name', '?'))
                    # 通知已有手机
                    for phone_ws in list(group.phones):
                        if phone_ws != ws:
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
                # Bug6修复: 附加 deviceId（用手机端 device_name），使 PC 端能正确识别云端设备
                msg['deviceId'] = meta['device_name']
                await forward_to_pcs(pin, msg, ws)
                record_message(pin, msg_type, len(raw))
                log.info(f'PHONE_HELLO pin={pin} device={meta["device_name"]} ip={client_ip} pcs={len(group.pcs)}')
                # 补推离线堆积的 visit_record（await 确认发送后再清除）
                if group and group.pending_visits:
                    pushed = []
                    failed = []
                    for visit in group.pending_visits:
                        try:
                            await forward_to_phones(pin, {
                                'type': 'visit_record',
                                'data': visit
                            })
                            pushed.append(visit)
                        except Exception:
                            failed.append(visit)
                    group.pending_visits = failed  # 保留失败的，下次重试
                    log.info(f'phone_hello pin={pin}: pushed {len(pushed)} pending visits, {len(failed)} failed')
                continue

            # ===== PC 端握手 =====
            if msg_type == 'pc_hello':
                # 频率限制检查
                if check_rate_limit(client_ip):
                    await ws.send(json.dumps({'type': 'pc_auth_fail', 'reason': '请求过于频繁，请稍后再试'}))
                    log.warning(f'RATE_LIMITED pc_hello ip={client_ip}')
                    recent_attempts = len([t for t in _pin_attempts.get(client_ip, []) if datetime.now() - t < timedelta(minutes=1)])
                    log.warning(f'RATE_LIMIT_STATE ip={client_ip} attempts_in_last_minute={recent_attempts}/{MAX_PIN_ATTEMPTS_PER_MINUTE}')
                    continue
                pin = msg.get('pin', '')
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
                                'deviceId': phone_device_name,
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
                    for old_phone in list(group.phones):
                        try:
                            await old_phone.close(4001, 'duplicate_reconnect')
                        except Exception:
                            pass
                        group.phones.discard(old_phone)
                    group.phones.add(phone_ws)
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
                            'deviceId': device_name
                        }, phone_ws)
                    except Exception:
                        pass
                    await ws.send(json.dumps({'type': 'auth_response_ack', 'ok': True}))
                    log.info(f'AUTH_APPROVED id={req_id} device={device_name} pin={auth_pin} approved_by_pc={meta.get("device_name","?")}')
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
                    log.info(f'AUTH_DENIED id={req_id} device={device_name} pin={auth_pin} denied_by_pc={meta.get("device_name","?")}')
                continue

            pin = meta['pin']

            # ===== 手机→PC 转发 =====
            if msg_type in PHONE_TO_PC_TYPES:
                # ping 消息附加设备名称，便于 PC 端识别心跳来源
                if msg_type == 'ping':
                    msg['deviceName'] = meta.get('device_name', '')
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
    """从外部文件读取 dashboard.html（支持热更新，无需重启服务）"""
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
    """读取最近 n 条日志"""
    if not log_file_path or not os.path.exists(log_file_path):
        return []
    try:
        with open(log_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
            return [line.strip() for line in lines[-n:]]
    except Exception:
        return []

# ==================== HTTP 请求处理 ====================
JSON_HDR = [('Content-Type', 'application/json'), ('Access-Control-Allow-Origin', '*')]
HEALTH_CORS = [('Access-Control-Allow-Origin', '*')]

def _err_json(code, message):
    """构造错误 JSON 响应体"""
    return json.dumps({'ok': False, 'code': code, 'message': message}, ensure_ascii=False).encode('utf-8')

_AUTH_ERR = (401, JSON_HDR, _err_json('UNAUTHORIZED', '需要管理权限'))

def _schedule_async(coro):
    """从 HTTP handler 线程安全地调度 async 任务到事件循环"""
    global loop
    if loop and loop.is_running():
        asyncio.run_coroutine_threadsafe(coro, loop)
    else:
        log.warning('Cannot schedule async task: event loop not running')

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
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute('SELECT default_pin FROM phones WHERE device_id = ?', (device_name,))
        row = c.fetchone()
        return row[0] if row and row[0] else None
    except Exception:
        return None
    finally:
        if conn:
            conn.close()

def _set_device_default_pin(device_name, pin):
    """设置/更新设备的默认 PIN"""
    conn = None
    try:
        conn = sqlite3.connect(DB_PATH)
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

def _lookup_kid(manager_name, brand='1833'):
    """通过 /bserve/search 接口将顾问姓名转换为 CRM 内部 ID (kid)。
    返回 kid 字符串，失败返回 None。"""
    try:
        import urllib.request as urlreq
        search_data = urlencode({'keyword': manager_name, 'brand': brand}).encode('utf-8')
        req = urlreq.Request(
            'https://guwen.zhudaicms.com/bserve/search',
            data=search_data,
            headers={
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'AutoDial/4.1',
                'Origin': 'https://guwen.zhudaicms.com',
                'Referer': 'https://guwen.zhudaicms.com/bserve/saoma.html?brand=%s' % brand
            }
        )
        resp = urlreq.urlopen(req, timeout=8)
        body = json.loads(resp.read())
        if body.get('code') == 1 and body.get('data'):
            # 优先精确匹配，其次取第一个结果
            for item in body['data']:
                if item.get('name') == manager_name:
                    return str(item['id'])
            return str(body['data'][0]['id'])
    except Exception as e:
        log.warning(f'Lookup kid for "{manager_name}" failed: {e}')
    return None

def _sync_to_crm(visit_id, name, mobile, kefu_tel, visit_type):
    """后台同步到 CRM 系统。新版 CRM 要求 kid 参数（顾问内部ID）而非 kefu_tel。
    成功后将 crm_synced 置 1。"""
    try:
        import urllib.request as urlreq
        kid = _lookup_kid(kefu_tel)
        if not kid:
            log.warning(f'CRM sync SKIP id={visit_id}: 未找到顾问 "{kefu_tel}" 的 kid')
            return
        crm_data = urlencode({
            'brand': '1833', 'name': name, 'mobile': mobile,
            'kid': kid, 'visit_type': visit_type
        }).encode('utf-8')
        req = urlreq.Request(
            'https://guwen.zhudaicms.com/bserve/saoma_indb.html',
            data=crm_data,
            headers={
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'AutoDial/4.1',
                'Origin': 'https://guwen.zhudaicms.com',
                'Referer': 'https://guwen.zhudaicms.com/bserve/saoma.html?brand=1833'
            }
        )
        resp = urlreq.urlopen(req, timeout=10)
        body = json.loads(resp.read())
        if body.get('code') == 1:
            log.info(f'CRM sync OK visit_id={visit_id} kid={kid}')
            # 标记为已同步
            conn = None
            try:
                conn = sqlite3.connect(DB_PATH)
                c = conn.cursor()
                c.execute('UPDATE visits SET crm_synced=1, updated_at=? WHERE id=?',
                          (datetime.now().strftime('%Y-%m-%dT%H:%M:%S'), visit_id))
                conn.commit()
            except Exception as e:
                log.warning(f'CRM sync flag update failed visit_id={visit_id}: {e}')
            finally:
                if conn:
                    conn.close()
        else:
            log.warning(f'CRM sync FAIL visit_id={visit_id} kid={kid} msg={body.get("msg")}')
    except Exception as e:
        log.warning(f'CRM sync error: {e}')

def _push_visit_to_phone(pin, visit_record):
    """推送 visit_record 给对应 pin 的手机，离线则堆积"""
    group = pin_groups.get(pin)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if group and group.phones:
        try:
            asyncio.run_coroutine_threadsafe(
                forward_to_phones(pin, {'type': 'visit_record', 'data': visit_record}), loop
            )
        except Exception as e:
            log.warning(f'VISIT push failed pin={pin}: {e}')
            if group:
                group.pending_visits.append(visit_record)
    elif group:
        group.pending_visits.append(visit_record)
        log.info(f'VISIT queued (offline) pin={pin} pending={len(group.pending_visits)}')
    else:
        grp = get_group(pin)
        grp.pending_visits.append(visit_record)

async def health_check_handler(path, request_headers):
    """处理 HTTP 请求（健康检查 + API + Web 界面）"""
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
    path = parsed.path
    
    # 健康检查（兼容旧版本，加 CORS 供 popup 测试连接）
    if path == '/health':
        body = json.dumps({
            'service': 'AutoDial Cloud Relay',
            'version': '4.10',
            'port': PORT,
            'uptime_seconds': get_uptime_seconds(),
            'total_connections': len(ws_connections),
            'total_groups': len(pin_groups)
        }, ensure_ascii=False).encode('utf-8')
        return (200, JSON_HDR, body)
    
    # API: 状态
    if path == '/api/status':
        # 今日拨号数和登记数
        today_dials = 0
        today_visits = 0
        recent_active = []
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            today_str = datetime.now().strftime('%Y-%m-%d')
            c.execute("SELECT COUNT(*) FROM call_records_raw WHERE date(server_time)=?", (today_str,))
            row = c.fetchone()
            if row:
                today_dials = row[0]
            c.execute("SELECT COUNT(*) FROM visits WHERE date(created_at)=?", (today_str,))
            row = c.fetchone()
            if row:
                today_visits = row[0]
            conn.close()
        except Exception:
            pass
        # 最近活跃人员（从在线连接中提取，取最近3个不同PIN）
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
        # 尝试从 advisor_names 补全姓名
        if active_list:
            try:
                conn = sqlite3.connect(DB_PATH)
                c = conn.cursor()
                for a in active_list:
                    c.execute("SELECT name FROM advisor_names WHERE pin=?", (a['pin'],))
                    row = c.fetchone()
                    if row:
                        a['name'] = row[0]
                conn.close()
            except Exception:
                pass
        active_list.sort(key=lambda x: x.get('connected_at', ''), reverse=True)
        recent_active = active_list[:3]

        body = json.dumps({
            'service': 'AutoDial Cloud Relay',
            'version': '4.10',
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
        body = json.dumps({
            'clients': get_clients_list()
        }, ensure_ascii=False).encode('utf-8')
        return (200, JSON_HDR, body)
    
    # API: 统计数据
    if path == '/api/stats':
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
        qs = parse_qs(parsed.query)
        n = int(qs.get('n', ['100'])[0])
        q = qs.get('q', [''])[0]
        logs = get_logs(min(n, 1000))
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
        # PC_CONNECTED 去重：PC在线让扩展走本地
        if group and group.pcs:
            return (200, JSON_HDR, _err_json('PC_CONNECTED', 'PC 端在线，请走本地直连'))
        # 手机离线
        if not group or not group.phones:
            return (200, JSON_HDR, _err_json('PHONE_OFFLINE', '手机未连接'))

        # DUPLICATE_DIAL 并发保护：5秒内同号码去重
        now = time.time()
        last = group.last_dial.get(number, 0)
        if now - last < 5:
            return (200, JSON_HDR, _err_json('DUPLICATE_DIAL', '相同号码正在拨号中'))
        group.last_dial[number] = now

        # 同步返回 ACCEPTED，异步转发（ensure_future 解决 process_request 同步限制）
        asyncio.ensure_future(forward_to_phones(pin, {
            'type': 'dial',
            'number': number,
            'messageId': f'rest-{int(now*1000)}'
        }))
        record_message(pin, 'rest_dial', 64)
        log.info(f'REST_DIAL pin={pin} number={number}')
        return (200, JSON_HDR, json.dumps({'ok': True, 'code': 'ACCEPTED'}).encode('utf-8'))

    if path == '/api/v1/hangup':
        pin = hdrs.get('x-autodial-pin', '')
        if not validate_pin(pin):
            return (200, JSON_HDR, _err_json('INVALID_PIN', 'PIN 格式错误，须为4位或11位数字'))
        track_ext_activity(pin)

        group = pin_groups.get(pin)
        if group and group.pcs:
            return (200, JSON_HDR, _err_json('PC_CONNECTED', 'PC 端在线，请走本地直连'))
        if not group or not group.phones:
            return (200, JSON_HDR, _err_json('PHONE_OFFLINE', '手机未连接'))

        asyncio.ensure_future(forward_to_phones(pin, {
            'type': 'hangup',
            'messageId': f'rest-hangup-{int(time.time()*1000)}'
        }))
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
        
        now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        conn = None
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
            conn = sqlite3.connect(DB_PATH)
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

    # 管理员登录: GET /api/v1/login?user=xxx&pass=xxx
    if path == '/api/v1/login':
        qs = parse_qs(parsed.query)
        user = qs.get('user', [''])[0].strip()
        pwd = qs.get('pass', [''])[0].strip()
        if not user or not pwd:
            return (401, JSON_HDR, _err_json('LOGIN_FAILED', '请输入账号和密码'))
        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('SELECT id, username FROM admin_accounts WHERE username = ? AND password = ?', (user, pwd))
            row = c.fetchone()
            if row:
                token = uuid.uuid4().hex
                _admin_sessions[token] = time.time() + 86400  # 24小时有效
                log.info(f'ADMIN_LOGIN user={user}')
                return (200, JSON_HDR, json.dumps({'ok': True, 'token': token, 'username': user}).encode('utf-8'))
            return (401, JSON_HDR, _err_json('LOGIN_FAILED', '账号或密码错误'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # 登出: GET /api/v1/logout?token=xxx
    if path == '/api/v1/logout':
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
            conn = sqlite3.connect(DB_PATH)
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
    if path == '/api/v1/admin/add':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
        qs = parse_qs(parsed.query)
        username = qs.get('user', [''])[0].strip()
        password = qs.get('pass', [''])[0].strip()
        if not username or not password:
            return (200, JSON_HDR, _err_json('MISSING_PARAM', '账号和密码不能为空'))
        if len(username) < 4:
            return (200, JSON_HDR, _err_json('INVALID_PARAM', '账号至少4位'))
        if len(password) < 4:
            return (200, JSON_HDR, _err_json('INVALID_PARAM', '密码至少4位'))
        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
            c.execute('INSERT INTO admin_accounts (username, password, created_at) VALUES (?, ?, ?)',
                      (username, password, now_str))
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
            conn = sqlite3.connect(DB_PATH)
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
        if not aid or not newpass:
            return (200, JSON_HDR, _err_json('MISSING_PARAM', 'id 和新密码不能为空'))
        if len(newpass) < 4:
            return (200, JSON_HDR, _err_json('INVALID_PARAM', '密码至少4位'))
        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('UPDATE admin_accounts SET password = ? WHERE id = ?', (newpass, aid))
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
                    'device_name': req['device_name'],
                    'default_pin': req['default_pin'],
                    'pin': req['pin']
                })
        return (200, JSON_HDR, json.dumps({'ok': True, 'pending': result}).encode('utf-8'))

    # 响应授权请求: GET /api/v1/auth/respond?request_id=xxx&allow=1|0
    if path == '/api/v1/auth/respond':
        qs = parse_qs(parsed.query)
        req_id = qs.get('request_id', [''])[0].strip()
        allow = qs.get('allow', ['0'])[0] == '1'
        auth_req = _pending_auths.pop(req_id, None)
        if not auth_req:
            return (200, JSON_HDR, _err_json('EXPIRED', '授权请求已过期或不存在'))
        phone_ws = auth_req['ws']
        device_name = auth_req['device_name']
        auth_pin = auth_req['pin']
        if allow:
            # 授权通过：加入分组发送 auth_ok（不改变 default_pin，仅本次会话有效）
            group = get_group(auth_pin)
            # 踢掉相同 PIN 的旧手机（通过 phone_ws 同组清除）
            for old_phone in list(group.phones):
                group.phones.discard(old_phone)
            group.phones.add(phone_ws)
            pc_online = len(group.pcs) > 0
            # 查询手机主人姓名
            owner_name = ''
            try:
                conn3 = sqlite3.connect(DB_PATH)
                c3 = conn3.cursor()
                c3.execute('SELECT name FROM advisor_names WHERE pin=?', (default_pin,))
                row3 = c3.fetchone()
                if row3: owner_name = row3[0]
            except Exception: pass
            finally:
                try: conn3.close()
                except Exception: pass
            # 通过 asyncio.run_coroutine_threadsafe 发送消息（因为 health_check_handler 在 threadsafe 模式下运行）
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
        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute('''SELECT a.pin, a.name, a.group_id, a.updated_at
                         FROM advisor_names a ORDER BY a.updated_at DESC''')
            rows = [dict(r) for r in c.fetchall()]
            return (200, JSON_HDR, json.dumps({'ok': True, 'pins': rows}).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

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
            conn = sqlite3.connect(DB_PATH)
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
        conn = None
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
                conn.close()

    # 根据分组查询 visits: GET /api/v1/visits?group=N
    # 修改现有 visits 查询，支持 group_id 参数

    # ===== 一键登记 API（GET + query params，与 dial 风格一致） =====

    # ===== 手机端数据上报 API =====

    # 批量上传通话记录: GET /api/v1/calls/batch?device_id=xxx&pin=xxx&data=<json>
    if path == '/api/v1/calls/batch':
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0].strip()
        pin = qs.get('pin', [''])[0].strip()
        data_str = qs.get('data', [''])[0]
        if not device_id or not data_str:
            return (200, JSON_HDR, _err_json('MISSING_FIELDS', 'device_id和data不能为空'))
        now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        inserted, skipped = 0, 0
        conn = None
        try:
            records = json.loads(data_str)
            conn = sqlite3.connect(DB_PATH)
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
    if path == '/api/v1/events/log':
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0].strip()
        event_type = qs.get('event_type', [''])[0].strip()
        event_pin = qs.get('pin', [''])[0].strip()
        detail = qs.get('detail', [''])[0].strip()
        if not device_id or not event_type:
            return (200, JSON_HDR, _err_json('MISSING_FIELDS', 'device_id和event_type不能为空'))
        now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('INSERT INTO phone_events (device_id, event_type, event_time, pin, detail, server_time) VALUES (?,?,?,?,?,?)',
                      (device_id, event_type, now_str, event_pin, detail, now_str))
            c.execute('''INSERT OR REPLACE INTO phones (device_id, last_pin, first_seen, last_seen)
                         VALUES (?, ?, COALESCE((SELECT first_seen FROM phones WHERE device_id=?), ?), ?)''',
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
        phone_dial = int(qs.get('count', ['0'])[0])
        phone_dur = int(qs.get('duration', ['0'])[0])
        phone_conn = int(qs.get('connected', ['0'])[0])
        if not device_id:
            return (200, JSON_HDR, _err_json('MISSING_FIELDS', 'device_id不能为空'))
        now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        today_str = datetime.now().strftime('%Y-%m-%d')
        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('''INSERT OR REPLACE INTO phones (device_id, last_pin, device_model, app_version, first_seen, last_seen)
                         VALUES (?, ?, ?, ?, COALESCE((SELECT first_seen FROM phones WHERE device_id=?), ?), ?)''',
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
    if path == '/api/v1/visits/batch':
        if not _check_admin(hdrs, parsed.query):
            return _AUTH_ERR
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
            conn = sqlite3.connect(DB_PATH)
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

        if not name or not mobile or not kefu_tel:
            return (200, JSON_HDR, _err_json('MISSING_FIELDS', '缺少必填字段: name, mobile, kefu_tel'))

        now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            # 去重：优先用 CRM 来访时间 (mobile+visit_time)，否则回退到当日去重
            if visit_time:
                c.execute(
                    'SELECT id FROM visits WHERE mobile = ? AND visit_time = ? LIMIT 1',
                    (mobile, visit_time)
                )
            else:
                today_str = datetime.now().strftime('%Y-%m-%d')
                c.execute(
                    'SELECT id FROM visits WHERE mobile = ? AND created_at LIKE ? LIMIT 1',
                    (mobile, today_str + '%')
                )
            if c.fetchone():
                conn.close()
                return (200, JSON_HDR, json.dumps({'ok': True, 'skipped': True, 'reason': 'duplicate'}).encode('utf-8'))
            c.execute(
                'INSERT INTO visits (pin, name, mobile, kefu_tel, visit_type, source, visit_time, created_at, updated_at) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (pin, name, mobile, kefu_tel, visit_type, source, visit_time, now_str, now_str)
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
                conn.close()

        # 客户端已直接提交 CRM，云端只做记录 + WS 推送，不再重复提交 CRM
        visit_record = {'id': row_id, 'pin': pin, 'name': name, 'mobile': mobile,
                        'kefu_tel': kefu_tel, 'visit_type': visit_type, 'source': source,
                        'visit_time': visit_time, 'created_at': now_str, 'updated_at': now_str}
        _push_visit_to_phone(pin, visit_record)

        log.info(f'VISIT_CREATE pin={pin} name={name} id={row_id}')
        return (200, JSON_HDR, json.dumps({'ok': True, 'code': 'ACCEPTED', 'id': row_id}).encode('utf-8'))

    # 查询列表: GET /api/v1/visits?pin=xxx[&group=N]
    if path == '/api/v1/visits':
        qs = parse_qs(parsed.query)
        pin = qs.get('pin', [''])[0]
        group_id = qs.get('group', [''])[0]
        conn = None
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
            # 补全顾问姓名（kefu_tel 可能是手机号或姓名，查 advisor_names 表）
            try:
                kefu_tels = list(set(r.get('kefu_tel','') for r in rows if r.get('kefu_tel','')))
                if kefu_tels:
                    ph = ','.join(['?'] * len(kefu_tels))
                    c.execute(f'SELECT pin, name FROM advisor_names WHERE pin IN ({ph})', kefu_tels)
                    name_map = {r2['pin']: r2['name'] for r2 in c.fetchall()}
                    for r in rows:
                        r['kefu_name'] = name_map.get(r.get('kefu_tel',''), '')
            except Exception: pass
            return (200, JSON_HDR, json.dumps(rows, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

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
                conn.close()

    # ===== 新增: Dashboard 管理 API =====

    # API: 设备清单 GET /api/v1/devices
    if path == '/api/v1/devices':
        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute('SELECT * FROM phones ORDER BY last_seen DESC')
            rows = [dict(r) for r in c.fetchall()]
            # 标注在线状态 + IP + 当前PIN
            online_map = {}      # device_name -> {ip, pin}
            try:
                snapshot = list(ws_meta.items())
            except Exception:
                snapshot = []
            for _ws, _meta in snapshot:
                if _meta.get('role') == 'phone' and _meta.get('device_name'):
                    online_map[_meta['device_name']] = {
                        'ip': _meta.get('ip', ''),
                        'pin': _meta.get('pin', '')
                    }
            # 收集所有 PIN 用于查询姓名
            all_pins = set()
            for row in rows:
                did = row.get('device_id', '')
                row['is_online'] = did in online_map
                row['current_ip'] = online_map.get(did, {}).get('ip', '')
                pin = online_map.get(did, {}).get('pin', '') or row.get('last_pin', '')
                row['current_pin'] = pin
                row['current_name'] = ''
                if pin:
                    all_pins.add(pin)
            # 批量查询姓名
            if all_pins:
                placeholders = ','.join(['?'] * len(all_pins))
                c.execute(f"SELECT pin, name FROM advisor_names WHERE pin IN ({placeholders})", list(all_pins))
                pin_name_map = {r['pin']: r['name'] for r in c.fetchall()}
                for row in rows:
                    if row.get('current_pin') and row['current_pin'] in pin_name_map:
                        row['current_name'] = pin_name_map[row['current_pin']]
            return (200, JSON_HDR, json.dumps({'ok': True, 'devices': rows}, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

    # API: 设备PIN历史 GET /api/v1/device-history?device_id=xxx
    if path == '/api/v1/device-history':
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0].strip()
        if not device_id:
            return (200, JSON_HDR, _err_json('MISSING', 'device_id 不能为空'))
        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
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
            conn = sqlite3.connect(DB_PATH)
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
            conn = sqlite3.connect(DB_PATH)
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
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0]
        pin = qs.get('pin', [''])[0]
        date_from = qs.get('date_from', [''])[0]
        date_to = qs.get('date_to', [''])[0]
        number = qs.get('number', [''])[0]
        limit = min(int(qs.get('limit', ['200'])[0]), 1000)
        offset = int(qs.get('offset', ['0'])[0])

        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            where = []
            params = []
            if device_id:
                where.append('cr.device_id = ?'); params.append(device_id)
            if pin:
                where.append('p.last_pin = ?'); params.append(pin)
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
            c.execute(f'''SELECT cr.*, p.last_pin as pin, p.device_model, p.app_version
                         FROM call_records_raw cr
                         LEFT JOIN phones p ON cr.device_id = p.device_id
                         WHERE {w} ORDER BY cr.dial_time DESC LIMIT ? OFFSET ?''',
                      params + [limit, offset])
            rows = [dict(r) for r in c.fetchall()]
            c.execute(f'SELECT COUNT(*) FROM call_records_raw cr LEFT JOIN phones p ON cr.device_id=p.device_id WHERE {w}', params)
            total = c.fetchone()[0]
            return (200, JSON_HDR, json.dumps({
                'ok': True, 'calls': rows, 'total': total, 'limit': limit, 'offset': offset
            }, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))
        finally:
            if conn:
                conn.close()

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
                try:
                    await _ws.close(4000, 'kicked by admin')
                    kicked += 1
                except Exception:
                    pass
        log.info(f'KICK pin={pin} role={role or "any"} count={kicked}')
        return (200, JSON_HDR, json.dumps({'ok': True, 'kicked': kicked}).encode('utf-8'))

    # API: 每日对账 GET /api/v1/phone-stats?device_id=
    if path == '/api/v1/phone-stats':
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0]
        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
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
        qs = parse_qs(parsed.query)
        device_id = qs.get('device_id', [''])[0]
        event_type = qs.get('event_type', [''])[0]
        limit = min(int(qs.get('limit', ['100'])[0]), 500)
        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
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
        data = list(connection_history[-288:])  # 最近4小时（288×30s）
        return (200, JSON_HDR, json.dumps({'ok': True, 'history': data}, ensure_ascii=False).encode('utf-8'))

    # Web 管理界面
    if path == '/' or path == '/index.html':
        return (200, [('Content-Type', 'text/html; charset=utf-8')], HTML_CONTENT.encode('utf-8'))
    
    # 404
    return (404, [('Content-Type', 'text/plain')], b'Not Found')

# ==================== 服务器启停 ====================
_heartbeat_task = None  # C4修复: 保存心跳任务引用，防止重启时累积多个

async def run_server():
    global server_instance, _heartbeat_task
    log.info(f'Starting server on port {PORT}...')
    
    # 自动配置防火墙规则（放到 executor 中避免阻塞事件循环）
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, configure_firewall)

    # C4修复: 取消旧心跳任务再创建新的
    # 注意：已禁用应用层心跳检测，改用WebSocket内置的ping/pong机制
    # 避免因只有WebSocket心跳而没有应用层消息导致误判超时
    # if _heartbeat_task and not _heartbeat_task.done():
    #     _heartbeat_task.cancel()
    # _heartbeat_task = asyncio.create_task(check_heartbeats())
    # log.info(f'Heartbeat checker started (timeout={HEARTBEAT_TIMEOUT}s)')
    log.info('Using WebSocket built-in ping/pong mechanism (application-layer heartbeat disabled)')

    async with serve(handle_connection, '0.0.0.0', PORT,
                     process_request=health_check_handler,
                     ping_interval=30,
                     ping_timeout=90,  # 增加 ping 超时到 90 秒
                     close_timeout=10) as server:
        server_instance = server
        log.info(f'Server started on port {PORT}, PID={os.getpid()}')
        log.info(f'Web 管理界面: http://0.0.0.0:{PORT} (与 WebSocket 同端口)')

        # 通知托盘状态更新
        update_tray_status(True)

        # Fix ⏳4: periodically persist stats every 5 minutes
        async def periodic_save():
            while True:
                await asyncio.sleep(300)
                save_stats()
        asyncio.create_task(periodic_save())

        # 连接数历史快照（每30秒记录一次，供仪表盘趋势图）
        async def periodic_snapshot():
            while True:
                await asyncio.sleep(30)
                snapshot_connection_history()
        asyncio.create_task(periodic_snapshot())

        # 内存清理（每10分钟清理一次无界数据结构）
        async def periodic_cleanup():
            while True:
                await asyncio.sleep(600)
                cleanup_memory()
        asyncio.create_task(periodic_cleanup())

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
    sys.exit(0)

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
