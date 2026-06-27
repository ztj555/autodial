"""
AutoDial 云中转服务器 - Python 版（带 Web 管理界面）
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
    create_sql = '''CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pin TEXT NOT NULL,
        name TEXT NOT NULL,
        mobile TEXT NOT NULL,
        kefu_tel TEXT NOT NULL,
        visit_type TEXT DEFAULT '贷款咨询',
        source TEXT DEFAULT 'plugin',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )'''
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute(create_sql)
        c.execute('CREATE INDEX IF NOT EXISTS idx_visits_pin ON visits(pin)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at)')
        conn.commit()
        conn.close()
        log.info(f'Visits DB initialized at {DB_PATH}')
    except Exception as e:
        log.error(f'Database initialization failed: {e}. Using in-memory fallback.')
        DB_PATH = ':memory:'
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute(create_sql)
        c.execute('CREATE INDEX IF NOT EXISTS idx_visits_pin ON visits(pin)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at)')
        conn.commit()
        conn.close()

init_db()

# ==================== 统计数据结构 ====================
start_time = datetime.now()
total_messages = 0
total_bytes_sent = 0
total_bytes_received = 0
message_count_by_pin = defaultdict(int)  # pin -> 消息数
message_count_by_type = defaultdict(int)  # 消息类型 -> 计数
daily_stats = defaultdict(lambda: {'messages': 0, 'bytes': 0})  # YYYY-MM-DD -> stats

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
    except Exception:
        pass

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
    except Exception:
        pass

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
                group.phones.add(ws)
                pc_online = len(group.pcs) > 0
                await ws.send(json.dumps({
                    'type': 'auth_ok',
                    'pin': pin,
                    'pcCount': len(group.pcs),
                    'pc_present': pc_online,  # v8: 手机端据此判断 PC 是否可达
                    'newDevice': not is_first_device  # Fix ⏳5: 通知新设备它是否是后续加入的
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
JSON_HDR = [('Content-Type', 'application/json')]
HEALTH_CORS = [('Access-Control-Allow-Origin', '*')]

def _err_json(code, message):
    """构造错误 JSON 响应体"""
    return json.dumps({'ok': False, 'code': code, 'message': message}, ensure_ascii=False).encode('utf-8')

# ==================== 访问登记辅助函数 ====================

def _sync_to_crm(name, mobile, kefu_tel, visit_type):
    """后台同步到 CRM 系统（在 executor 线程中运行）"""
    try:
        import urllib.request
        crm_data = urlencode({
            'brand': '1833', 'name': name, 'mobile': mobile,
            'kefu_tel': kefu_tel, 'visit_type': visit_type
        }).encode('utf-8')
        req = urllib.request.Request(
            'https://guwen.zhudaicms.com/bserve/saoma_indb.html',
            data=crm_data,
            headers={'Content-Type': 'application/x-www-form-urlencoded'}
        )
        urllib.request.urlopen(req, timeout=10)
        log.info(f'CRM sync OK name={name}')
    except Exception as e:
        log.warning(f'CRM sync failed: {e}')

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
            'version': '4.00',
            'port': PORT,
            'uptime_seconds': get_uptime_seconds(),
            'total_connections': len(ws_connections),
            'total_groups': len(pin_groups)
        }, ensure_ascii=False).encode('utf-8')
        return (200, JSON_HDR + HEALTH_CORS, body)
    
    # API: 状态
    if path == '/api/status':
        body = json.dumps({
            'service': 'AutoDial Cloud Relay',
            'version': '4.00',
            'port': PORT,
            'uptime_seconds': get_uptime_seconds(),
            'total_connections': len(ws_connections),
            'total_groups': len(pin_groups),
            'total_messages': total_messages,
            'total_bytes_sent': total_bytes_sent,
            'total_bytes_received': total_bytes_received
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
            'daily': get_daily_stats()
        }, ensure_ascii=False).encode('utf-8')
        return (200, JSON_HDR, body)
    
    # API: 日志
    if path == '/api/logs':
        body = json.dumps({
            'logs': get_logs(100)
        }, ensure_ascii=False).encode('utf-8')
        return (200, JSON_HDR, body)

    # ===== 新增: REST 拨号端点 (GET + Header PIN) =====
    if path == '/api/v1/dial':
        pin = hdrs.get('x-autodial-pin', '')
        number = parse_qs(parsed.query).get('number', [''])[0]

        # PIN 格式校验（4位或11位纯数字）
        if not validate_pin(pin):
            return (200, JSON_HDR, _err_json('INVALID_PIN', 'PIN 格式错误，须为4位或11位数字'))
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
            'phoneCount': len(group.phones) if group else 0
        }, ensure_ascii=False).encode('utf-8')
        return (200, JSON_HDR, body)
    
    # ===== 一键登记 API（GET + query params，与 dial 风格一致） =====

    # 创建登记: GET /api/v1/visit?name=...&mobile=...&...
    if path == '/api/v1/visit':
        pin = hdrs.get('x-autodial-pin', '')
        if not validate_pin(pin):
            return (200, JSON_HDR, _err_json('INVALID_PIN', 'PIN 格式错误，须为4位或11位数字'))

        qs = parse_qs(parsed.query)
        name = qs.get('name', [''])[0].strip()
        mobile = qs.get('mobile', [''])[0].strip()
        kefu_tel = qs.get('kefu_tel', [''])[0].strip()
        visit_type = qs.get('visit_type', ['贷款咨询'])[0].strip()
        source = qs.get('source', ['plugin'])[0].strip()

        if not name or not mobile or not kefu_tel:
            return (200, JSON_HDR, _err_json('MISSING_FIELDS', '缺少必填字段: name, mobile, kefu_tel'))

        now_str = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute(
                'INSERT INTO visits (pin, name, mobile, kefu_tel, visit_type, source, created_at, updated_at) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (pin, name, mobile, kefu_tel, visit_type, source, now_str, now_str)
            )
            conn.commit()
            row_id = c.lastrowid
            conn.close()
        except Exception as e:
            log.error(f'INSERT visit error: {e}')
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))

        # 后台同步 CRM + WS 推送
        visit_record = {'id': row_id, 'pin': pin, 'name': name, 'mobile': mobile,
                        'kefu_tel': kefu_tel, 'visit_type': visit_type, 'source': source,
                        'created_at': now_str, 'updated_at': now_str}
        asyncio.get_running_loop().run_in_executor(None, _sync_to_crm, name, mobile, kefu_tel, visit_type)
        _push_visit_to_phone(pin, visit_record)

        log.info(f'VISIT_CREATE pin={pin} name={name} id={row_id}')
        return (200, JSON_HDR, json.dumps({'ok': True, 'code': 'ACCEPTED', 'id': row_id}).encode('utf-8'))

    # 查询列表: GET /api/v1/visits?pin=xxx
    if path == '/api/v1/visits':
        qs = parse_qs(parsed.query)
        pin = qs.get('pin', [''])[0]
        if not pin:
            return (200, JSON_HDR, _err_json('MISSING_PIN', '缺少 PIN 参数'))
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute('SELECT * FROM visits WHERE pin=? ORDER BY created_at DESC', (pin,))
            rows = [dict(r) for r in c.fetchall()]
            conn.close()
            return (200, JSON_HDR, json.dumps(rows, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))

    # 删除: GET /api/v1/visit/delete?id=N
    if path == '/api/v1/visit/delete':
        qs = parse_qs(parsed.query)
        rid = qs.get('id', [''])[0]
        if not rid:
            return (200, JSON_HDR, _err_json('MISSING_ID', '缺少记录 id'))
        try:
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
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))

    # 更新: GET /api/v1/visit/update?id=N&name=...&mobile=...&visit_type=...
    if path == '/api/v1/visit/update':
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
        try:
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
            return (500, JSON_HDR, _err_json('DB_ERROR', str(e)))

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
    print('  版本: 4.00 (带 Web 管理界面)')
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

    # 主线程运行托盘（pystray 要求主线程）
    run_tray()

if __name__ == '__main__':
    main()
