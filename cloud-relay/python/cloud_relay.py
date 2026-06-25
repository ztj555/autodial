"""
AutoDial Cloud Relay Server v2 — Python Edition
=================================================
PIN-based WebSocket message forwarding relay with system tray icon.
Aligned with Android v7 ConnectionManager architecture.

Improvements over v1:
  - Enhanced /health endpoint with per-PIN group stats
  - reconnect_request forwarding for cloud-wake
  - per-message-deflate compression
  - Unified log format matching Android/PC
  - Relay hub tray icon (not just a dot)
  - No console window on launch
  - targetDevice routing for precise phone delivery
  - Duplicate connection cleanup (same deviceName)
  - 45s heartbeat timeout (aligned with Android/PC)

Dependencies: websockets, pystray, Pillow
"""

import asyncio
import json
import logging
import os
import signal
import sys
import threading
import time
from collections import defaultdict
from datetime import datetime

import websockets
from websockets.legacy.server import serve

# ==================== Configuration ====================
DEFAULT_PORT = 35430
PORT = DEFAULT_PORT
HEARTBEAT_TIMEOUT = 45  # aligned with Android ConnectionManager/PC PhoneConnectionManager

for i, arg in enumerate(sys.argv[1:]):
    if arg in ('--port', '-p') and i + 1 < len(sys.argv):
        try:
            PORT = int(sys.argv[i + 1])
        except ValueError:
            pass

SERVER_START_TIME = time.time()

# ==================== Unified Logging ====================
# Format: [HH:MM:SS.mmm] [LEVEL] [MODULE] [PIN] message
log_file_path = None

def setup_logging():
    global log_file_path
    app_data = os.path.join(
        os.environ.get('APPDATA', os.path.expanduser('~')),
        'autodial-cloud-relay'
    )
    os.makedirs(app_data, exist_ok=True)
    log_file_path = os.path.join(app_data, 'cloud-relay.log')

    logger = logging.getLogger('relay')
    logger.setLevel(logging.DEBUG)

    # File handler only — no console output (keep it quiet)
    fh = logging.FileHandler(log_file_path, encoding='utf-8')
    fh.setFormatter(logging.Formatter(
        '%(message)s'  # we format timestamps manually for consistency with Android/PC
    ))
    logger.addHandler(fh)
    return logger

log = setup_logging()

def _now_ts():
    """Timestamp for log lines: HH:MM:SS.mmm"""
    now = datetime.now()
    return f"{now.hour:02d}:{now.minute:02d}:{now.second:02d}.{now.microsecond // 1000:03d}"

def log_info(module, pin, msg):
    pin_str = f"[{pin}]" if pin else "[----]"
    log.info(f"{_now_ts()} [I] [{module}] {pin_str} {msg}")

def log_warn(module, pin, msg):
    pin_str = f"[{pin}]" if pin else "[----]"
    log.warning(f"{_now_ts()} [W] [{module}] {pin_str} {msg}")

def log_error(module, pin, msg):
    pin_str = f"[{pin}]" if pin else "[----]"
    log.error(f"{_now_ts()} [E] [{module}] {pin_str} {msg}")

# ==================== PIN Group Management ====================
class PinGroup:
    def __init__(self):
        self.pcs = set()
        self.phones = set()

pin_groups: dict[str, PinGroup] = defaultdict(PinGroup)
ws_meta: dict = {}  # ws -> {pin, role, ip, device_name, connected_at, last_message_time}
ws_connections = set()

def get_group(pin):
    return pin_groups[pin]

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

# ==================== Heartbeat ====================
async def check_heartbeats():
    while True:
        await asyncio.sleep(30)
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
                await ws.close(4000, f'Heartbeat timeout ({HEARTBEAT_TIMEOUT}s)')
                log_warn('HEARTBEAT', meta.get('pin', 'none'),
                         f"{meta.get('role','?')} timeout {elapsed:.0f}s")
            except Exception:
                pass

# ==================== Message Forwarding ====================
# v2: Added reconnect_request for cloud-wake
PHONE_TO_PC_TYPES = {'phone_hello', 'dial_result', 'sms_result', 'ack'}
PC_TO_PHONE_TYPES = {'auth_ok', 'auth_fail', 'dial', 'sms', 'hangup', 'reconnect_request'}

async def forward_to_pcs(pin, message, exclude_ws=None):
    group = pin_groups.get(pin)
    if not group:
        return
    data = json.dumps(message, ensure_ascii=False)
    for pc in list(group.pcs):
        if pc != exclude_ws:
            try:
                await pc.send(data)
            except Exception:
                group.pcs.discard(pc)

async def forward_to_phones(pin, message, exclude_ws=None):
    """Forward to phones with targetDevice routing support"""
    group = pin_groups.get(pin)
    if not group:
        return
    msg_obj = message if isinstance(message, dict) else message
    target_device = msg_obj.get('targetDevice')
    data = json.dumps(msg_obj, ensure_ascii=False)
    sent = 0
    for phone in list(group.phones):
        if phone != exclude_ws:
            if target_device:
                meta = ws_meta.get(phone, {})
                if meta.get('device_name') != target_device:
                    continue
            try:
                await phone.send(data)
                sent += 1
            except Exception:
                group.phones.discard(phone)
    if target_device and sent == 0:
        log_warn('RELAY', pin, f"No phone matched targetDevice={target_device}")

# ==================== WebSocket Handler ====================
server_instance = None

async def handle_connection(ws, path=None):
    client_ip = ws.remote_address[0] if ws.remote_address else 'unknown'
    ws_meta[ws] = {
        'pin': None,
        'role': None,
        'ip': client_ip,
        'device_name': None,
        'connected_at': datetime.now().isoformat(),
        'last_message_time': datetime.now()
    }
    ws_connections.add(ws)

    log_info('CONNECT', None, f"{client_ip}")

    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
                msg_type = msg.get('type', '')
            except json.JSONDecodeError:
                continue

            if ws in ws_meta:
                ws_meta[ws]['last_message_time'] = datetime.now()

            meta = ws_meta.get(ws, {})

            # ===== Phone hello =====
            if msg_type == 'phone_hello':
                pin = msg.get('pin', '')
                if not pin or len(pin) < 4:
                    await ws.send(json.dumps({'type': 'auth_fail', 'reason': '配对码无效'}))
                    continue
                remove_from_group(ws)
                meta['pin'] = pin
                meta['role'] = 'phone'
                meta['device_name'] = msg.get('deviceName', f'Phone-{client_ip[-3:]}')
                group = get_group(pin)

                # Clean duplicate connections (same deviceName)
                old_phones = [
                    p for p in list(group.phones)
                    if p != ws and ws_meta.get(p, {}).get('device_name') == meta['device_name']
                ]
                for old in old_phones:
                    try:
                        await old.close(4001, 'duplicate_reconnect')
                    except Exception:
                        pass
                    group.phones.discard(old)
                    log_info('CLEANUP', pin, f"Closed old phone: {meta['device_name']}")

                group.phones.add(ws)
                # Include pc_present field so phone knows if PC is online
                has_pc = len(group.pcs) > 0
                await ws.send(json.dumps({
                    'type': 'auth_ok', 'pin': pin, 'pcCount': len(group.pcs),
                    'pc_present': has_pc
                }))

                # Forward phone_hello to all PCs in same PIN group
                fwd_msg = dict(msg)
                fwd_msg['deviceId'] = meta['device_name']
                await forward_to_pcs(pin, fwd_msg, ws)

                log_info('PHONE_HELLO', pin,
                         f"device={meta['device_name']} ip={client_ip} pcs={len(group.pcs)}")

                # Forward existing phone_hello to newly connected phone (Bug9 fix for phones)
                # This is mainly for PC-side, but kept for symmetry
                continue

            # ===== PC hello =====
            if msg_type == 'pc_hello':
                pin = msg.get('pin', '')
                if not pin or len(pin) < 4:
                    await ws.send(json.dumps({'type': 'pc_auth_fail', 'reason': '配对码无效'}))
                    continue
                remove_from_group(ws)
                meta['pin'] = pin
                meta['role'] = 'pc'
                meta['device_name'] = msg.get('hostname', f'PC-{client_ip[-3:]}')
                group = get_group(pin)

                # Clean duplicate PC connections
                old_pcs = [
                    p for p in list(group.pcs)
                    if p != ws and ws_meta.get(p, {}).get('device_name') == meta['device_name']
                ]
                for old in old_pcs:
                    try:
                        await old.close(4001, 'duplicate_reconnect')
                    except Exception:
                        pass
                    group.pcs.discard(old)
                    log_info('CLEANUP', pin, f"Closed old PC: {meta['device_name']}")

                group.pcs.add(ws)
                await ws.send(json.dumps({
                    'type': 'pc_auth_ok', 'pin': pin, 'phoneCount': len(group.phones)
                }))

                # Notify all phones that PC is now online
                if len(group.phones) > 0:
                    await forward_to_phones(pin, {'type': 'pc_online', 'pin': pin})

                # Bug9 fix: forward existing phone_hello to newly connected PC
                for phone in list(group.phones):
                    ph_meta = ws_meta.get(phone, {})
                    if ph_meta.get('device_name'):
                        await ws.send(json.dumps({
                            'type': 'phone_hello',
                            'pin': pin,
                            'deviceName': ph_meta['device_name'],
                            'deviceId': ph_meta['device_name'],
                            'reconnect': True
                        }))

                log_info('PC_HELLO', pin,
                         f"hostname={meta['device_name']} ip={client_ip} phones={len(group.phones)}")
                continue

            # ===== Reject unauthenticated =====
            if not meta.get('pin'):
                await ws.send(json.dumps({'type': 'error', 'reason': '请先发送 phone_hello 或 pc_hello'}))
                continue

            pin = meta['pin']

            # ===== Phone → PC forwarding =====
            if msg_type in PHONE_TO_PC_TYPES:
                await forward_to_pcs(pin, msg, ws)
                if msg_type == 'ping':
                    await ws.send(json.dumps({'type': 'pong'}))
                else:
                    log_info('RELAY', pin, f"{msg_type} phone→pc")
                continue

            # ===== PC → Phone forwarding =====
            if msg_type in PC_TO_PHONE_TYPES:
                await forward_to_phones(pin, msg, ws)
                log_info('RELAY', pin, f"{msg_type} pc→phone")
                continue

            log_info('UNKNOWN', pin, f"type={msg_type}")

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        log_error('CONN', None, f"Error: {e}")
    finally:
        meta = ws_meta.pop(ws, {})
        pin = meta.get('pin', 'none')
        role = meta.get('role', '?')
        remove_from_group(ws)
        ws_connections.discard(ws)

        # If PC disconnects and no other PC in group, notify all phones
        if role == 'pc' and pin != 'none':
            group = pin_groups.get(pin)
            if not group or len(group.pcs) == 0:
                log_info('PC_OFFLINE', pin, f"{meta.get('device_name','?')} disconnected, notifying phones")
                await forward_to_phones(pin, {'type': 'pc_offline', 'pin': pin})

        log_info('DISCONNECT', pin,
                 f"{meta.get('role','?')} ip={meta.get('ip','?')}")

# ==================== HTTP Health Check (same port) ====================
async def health_check_handler(path, request_headers):
    """Enhanced health check with per-PIN group stats"""
    if path == '/health' or path == '/':
        uptime_sec = int(time.time() - SERVER_START_TIME)

        # Per-PIN group stats
        groups_detail = {}
        for pin, group in pin_groups.items():
            pc_names = [ws_meta.get(p, {}).get('device_name', '?') for p in group.pcs]
            phone_names = [ws_meta.get(p, {}).get('device_name', '?') for p in group.phones]
            groups_detail[pin] = {
                'pcCount': len(group.pcs),
                'phoneCount': len(group.phones),
                'pcs': pc_names,
                'phones': phone_names,
            }

        body = json.dumps({
            'service': 'AutoDial Cloud Relay',
            'version': '2.0.0',
            'port': PORT,
            'uptime': uptime_sec,
            'uptimeFormatted': f"{uptime_sec // 3600}h {(uptime_sec % 3600) // 60}m {uptime_sec % 60}s",
            'totalGroups': len(pin_groups),
            'totalConnections': len(ws_connections),
            'groups': groups_detail,
        }, ensure_ascii=False).encode('utf-8')
        return (200, [('Content-Type', 'application/json; charset=utf-8'),
                       ('Access-Control-Allow-Origin', '*')], body)
    return None

# ==================== Server Lifecycle ====================
async def run_server():
    global server_instance
    log_info('SERVER', None, f"Starting on port {PORT}...")

    asyncio.create_task(check_heartbeats())
    log_info('SERVER', None, f"Heartbeat checker started (timeout={HEARTBEAT_TIMEOUT}s)")

    async with serve(
        handle_connection, '0.0.0.0', PORT,
        process_request=health_check_handler,
        ping_interval=30,
        ping_timeout=90,
        close_timeout=10,
        compression="deflate",  # v2: per-message-deflate
    ) as server:
        server_instance = server
        log_info('SERVER', None, f"Started on port {PORT}, PID={os.getpid()}")
        update_tray_status(True)
        await asyncio.Future()

async def stop_server():
    global server_instance
    if server_instance:
        log_info('SERVER', None, "Stopping...")
        for ws in list(ws_connections):
            try:
                await ws.close(1001, 'server shutting down')
            except Exception:
                pass
        server_instance.close()
        await server_instance.wait_closed()
        server_instance = None
        log_info('SERVER', None, "Stopped")
        update_tray_status(False)

# ==================== System Tray ====================
tray_icon = None
server_running = False
loop = None

def create_tray_icon():
    """Draw a relay/hub icon — two concentric rings with connecting spokes"""
    from PIL import Image, ImageDraw

    img = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Outer ring
    draw.ellipse([3, 3, 29, 29], outline=(76, 175, 80, 255), width=2)
    # Inner hub
    draw.ellipse([12, 12, 20, 20], fill=(76, 175, 80, 255))

    # Spokes connecting hub to ring (4 directions)
    spokes = [(16, 4, 16, 11), (16, 21, 16, 28), (4, 16, 11, 16), (21, 16, 28, 16)]
    for x1, y1, x2, y2 in spokes:
        draw.line([x1, y1, x2, y2], fill=(76, 175, 80, 255), width=2)

    return img

def create_tray_icon_stopped():
    """Gray relay icon for stopped state"""
    from PIL import Image, ImageDraw

    img = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw.ellipse([3, 3, 29, 29], outline=(140, 140, 140, 255), width=2)
    draw.ellipse([12, 12, 20, 20], fill=(140, 140, 140, 255))

    spokes = [(16, 4, 16, 11), (16, 21, 16, 28), (4, 16, 11, 16), (21, 16, 28, 16)]
    for x1, y1, x2, y2 in spokes:
        draw.line([x1, y1, x2, y2], fill=(140, 140, 140, 255), width=2)

    return img

def update_tray_status(running):
    global server_running, tray_icon
    server_running = running
    if tray_icon:
        try:
            if running:
                tray_icon.icon = create_tray_icon()
                tray_icon.title = f'AutoDial Cloud Relay\nRunning | Port {PORT}'
            else:
                tray_icon.icon = create_tray_icon_stopped()
                tray_icon.title = f'AutoDial Cloud Relay\nStopped | Port {PORT}'
            tray_icon.menu = create_menu()
        except Exception as e:
            log_error('TRAY', None, f"Update error: {e}")

def create_menu():
    import pystray
    pc_count = sum(1 for g in pin_groups.values() for _ in g.pcs)
    phone_count = sum(1 for g in pin_groups.values() for _ in g.phones)
    status_icon = '\u25cf' if server_running else '\u25cb'
    status_text = f"Running ({phone_count}P + {pc_count}PC)" if server_running else "Stopped"

    return pystray.Menu(
        pystray.MenuItem(f'AutoDial Cloud Relay v2', None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(f'{status_icon} {status_text}', None, enabled=False),
        pystray.MenuItem(f'Port: {PORT}  |  Groups: {len(pin_groups)}', None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            'Stop Server' if server_running else 'Start Server',
            toggle_server, default=True
        ),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('Open Log File', open_log),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('Exit', quit_app),
    )

def toggle_server():
    global loop
    if server_running:
        if loop and loop.is_running():
            asyncio.run_coroutine_threadsafe(stop_server(), loop)
    else:
        if loop and loop.is_running():
            asyncio.run_coroutine_threadsafe(start_server_task(), loop)

async def start_server_task():
    asyncio.create_task(run_server())

def open_log():
    if log_file_path and os.path.exists(log_file_path):
        os.startfile(log_file_path)

def quit_app():
    global loop
    if loop and loop.is_running():
        asyncio.run_coroutine_threadsafe(shutdown(), loop)
    else:
        if tray_icon:
            tray_icon.stop()
        sys.exit(0)

async def shutdown():
    await stop_server()
    if tray_icon:
        tray_icon.stop()
    log_info('SERVER', None, "Shutdown complete")
    sys.exit(0)

def run_tray():
    global tray_icon
    import pystray

    tray_icon = pystray.Icon(
        'AutoDial Cloud Relay',
        icon=create_tray_icon_stopped(),
        title=f'AutoDial Cloud Relay\nStopped | Port {PORT}',
        menu=create_menu()
    )
    tray_icon.run()

def run_server_thread():
    global loop
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(run_server())
    except Exception as e:
        log_error('SERVER', None, f"Fatal: {e}")
        update_tray_status(False)

# ==================== Entry Point ====================
def main():
    # No print() — stay silent to avoid console window flash
    log_info('SERVER', None, f"AutoDial Cloud Relay v2 booting, port={PORT} PID={os.getpid()}")

    server_thread = threading.Thread(target=run_server_thread, daemon=True)
    server_thread.start()

    # Tray runs on main thread (pystray requirement)
    run_tray()

if __name__ == '__main__':
    main()
