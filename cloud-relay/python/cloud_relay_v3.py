"""
AutoDial Cloud Relay Server v3
================================
JWT-based + PIN-compatible WebSocket + REST API.
Ports: WS=35440, REST=35441 (old relay stays on 35430/35431).
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
from aiohttp import web

from db import db
from auth import (JWT_SECRET, verify_jwt, handle_register, handle_login,
                  handle_refresh, get_client_ip)

# ==================== Config ====================
WS_PORT = int(os.environ.get("AUTODIAL_WS_PORT", "35440"))
HTTP_PORT = int(os.environ.get("AUTODIAL_HTTP_PORT", "35441"))
HEARTBEAT_TIMEOUT = 45

SERVER_START_TIME = time.time()

# ==================== Logging ====================
def setup_logging():
    app_data = os.path.join(
        os.environ.get("APPDATA", os.path.expanduser("~")),
        "autodial-cloud-relay-v3"
    )
    os.makedirs(app_data, exist_ok=True)
    log_file = os.path.join(app_data, "cloud-relay-v3.log")

    logger = logging.getLogger("relay")
    logger.setLevel(logging.DEBUG)
    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(fh)
    return logger

log = setup_logging()

def _now():
    return datetime.now().strftime("%H:%M:%S.") + f"{datetime.now().microsecond // 1000:03d}"

def _log(level, module, uid, msg):
    uid_str = f"[{uid}]" if uid else "[----]"
    line = f"{_now()} [{level}] [{module}] {uid_str} {msg}"
    if level == "E":
        log.error(line)
    elif level == "W":
        log.warning(line)
    else:
        log.info(line)

# ==================== WS State ====================

class PinGroup:
    def __init__(self):
        self.pcs = set()
        self.phones = set()

pin_groups: dict[str, PinGroup] = defaultdict(PinGroup)
ws_meta: dict = {}
ws_connections = set()

# JWT user devices（新）
jwt_devices: dict[int, dict] = {}

PHONE_TO_PC_TYPES = {"phone_hello", "dial_result", "sms_result", "ack"}
PC_TO_PHONE_TYPES = {
    "auth_ok", "auth_fail", "dial", "sms", "hangup", "reconnect_request"
}

# ==================== WS Routing ====================

def get_group(pin):
    return pin_groups[pin]

def remove_from_group(ws):
    meta = ws_meta.get(ws)
    if not meta or not meta.get("pin"):
        return
    pin = meta["pin"]
    group = pin_groups.get(pin)
    if not group:
        return
    group.pcs.discard(ws)
    group.phones.discard(ws)
    if not group.pcs and not group.phones:
        del pin_groups[pin]

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
    group = pin_groups.get(pin)
    if not group:
        return
    data = json.dumps(message, ensure_ascii=False)
    for phone in list(group.phones):
        if phone != exclude_ws:
            try:
                await phone.send(data)
            except Exception:
                group.phones.discard(phone)

# JWT 路由（新）
def register_jwt_device(user_id, device_type, ws):
    if user_id not in jwt_devices:
        jwt_devices[user_id] = {"phones": set(), "pcs": set()}
    jwt_devices[user_id][device_type].add(ws)

def unregister_jwt_device(user_id, device_type, ws):
    if user_id in jwt_devices:
        jwt_devices[user_id][device_type].discard(ws)

async def forward_to_user_phones(user_id, message):
    devices = jwt_devices.get(user_id, {})
    data = json.dumps(message, ensure_ascii=False)
    for phone_ws in list(devices.get("phones", set())):
        try:
            await phone_ws.send(data)
        except Exception:
            devices["phones"].discard(phone_ws)

async def forward_to_user_pcs(user_id, message):
    devices = jwt_devices.get(user_id, {})
    data = json.dumps(message, ensure_ascii=False)
    for pc_ws in list(devices.get("pcs", set())):
        try:
            await pc_ws.send(data)
        except Exception:
            devices["pcs"].discard(pc_ws)

def find_device_ws(device_name):
    for ws, meta in ws_meta.items():
        if meta.get("device_name") == device_name:
            return ws
    return None

# ==================== Heartbeat ====================

async def check_heartbeats():
    while True:
        await asyncio.sleep(30)
        now = datetime.now()
        to_close = []
        for ws, meta in list(ws_meta.items()):
            last_time = meta.get("last_message_time")
            if last_time:
                elapsed = (now - last_time).total_seconds()
                if elapsed > HEARTBEAT_TIMEOUT:
                    to_close.append((ws, meta, elapsed))
        for ws, meta, elapsed in to_close:
            try:
                await ws.close(4000, f"Heartbeat timeout ({HEARTBEAT_TIMEOUT}s)")
                _log("W", "HB", meta.get("pin", meta.get("user_id", "none")),
                     f"{meta.get('role','?')} timeout {elapsed:.0f}s")
            except Exception:
                pass

# ==================== WS Handler ====================

async def handle_connection(ws, path=None):
    client_ip = ws.remote_address[0] if ws.remote_address else "unknown"
    meta = {
        "pin": None, "role": None, "ip": client_ip,
        "device_name": None, "user_id": None,
        "connected_at": datetime.now().isoformat(),
        "last_message_time": datetime.now()
    }
    ws_meta[ws] = meta
    ws_connections.add(ws)

    _log("I", "CONNECT", None, f"{client_ip}")

    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
                msg_type = msg.get("type", "")
            except json.JSONDecodeError:
                continue

            if ws in ws_meta:
                ws_meta[ws]["last_message_time"] = datetime.now()

            meta = ws_meta.get(ws, {})

            # ==================== phone_hello ====================
            if msg_type == "phone_hello":
                auth_method = msg.get("auth_method", "pin")

                if auth_method == "jwt":
                    token = msg.get("token", "")
                    try:
                        payload = verify_jwt(token)
                        user_id = payload["user_id"]
                        meta["user_id"] = user_id
                        meta["role"] = "phone"
                        meta["device_name"] = msg.get("deviceName", f"Phone-{client_ip[-3:]}")
                        await db.upsert_device(user_id, meta["device_name"], "phone")
                        register_jwt_device(user_id, "phones", ws)
                        await ws.send(json.dumps({
                            "type": "auth_ok", "user_id": user_id,
                            "phone": payload.get("phone", "")
                        }))
                        _log("I", "PHONE_HELLO", user_id,
                             f"JWT device={meta['device_name']}")
                    except Exception:
                        await ws.send(json.dumps({
                            "type": "auth_fail", "reason": "Token无效"
                        }))
                    continue

                # ---- 老 PIN 逻辑 ----
                pin = msg.get("pin", "")
                if not pin or len(pin) < 4:
                    await ws.send(json.dumps({"type": "auth_fail", "reason": "配对码无效"}))
                    continue
                remove_from_group(ws)
                meta["pin"] = pin
                meta["role"] = "phone"
                meta["device_name"] = msg.get("deviceName", f"Phone-{client_ip[-3:]}")
                group = get_group(pin)

                old_phones = [
                    p for p in list(group.phones)
                    if p != ws and ws_meta.get(p, {}).get("device_name") == meta["device_name"]
                ]
                for old in old_phones:
                    try: await old.close(4001, "duplicate_reconnect")
                    except: pass
                    group.phones.discard(old)

                group.phones.add(ws)
                has_pc = len(group.pcs) > 0
                await ws.send(json.dumps({
                    "type": "auth_ok", "pin": pin, "pcCount": len(group.pcs),
                    "pc_present": has_pc
                }))

                fwd = dict(msg)
                fwd["deviceId"] = meta["device_name"]
                await forward_to_pcs(pin, fwd, ws)
                _log("I", "PHONE_HELLO", pin, f"device={meta['device_name']}")
                continue

            # ==================== pc_hello ====================
            if msg_type == "pc_hello":
                auth_method = msg.get("auth_method", "pin")

                if auth_method == "jwt":
                    token = msg.get("token", "")
                    try:
                        payload = verify_jwt(token)
                        user_id = payload["user_id"]
                        meta["user_id"] = user_id
                        meta["role"] = "pc"
                        meta["device_name"] = msg.get("hostname", f"ext-{client_ip[-3:]}")
                        await db.upsert_device(user_id, meta["device_name"], "extension")
                        register_jwt_device(user_id, "pcs", ws)
                        await ws.send(json.dumps({
                            "type": "pc_auth_ok", "user_id": user_id,
                            "phone": payload.get("phone", "")
                        }))
                        _log("I", "PC_HELLO", user_id,
                             f"JWT device={meta['device_name']}")
                    except Exception:
                        await ws.send(json.dumps({
                            "type": "pc_auth_fail", "reason": "Token无效"
                        }))
                    continue

                # ---- 老 PIN 逻辑 ----
                pin = msg.get("pin", "")
                if not pin or len(pin) < 4:
                    await ws.send(json.dumps({"type": "pc_auth_fail", "reason": "配对码无效"}))
                    continue
                remove_from_group(ws)
                meta["pin"] = pin
                meta["role"] = "pc"
                meta["device_name"] = msg.get("hostname", f"PC-{client_ip[-3:]}")
                group = get_group(pin)

                old_pcs = [
                    p for p in list(group.pcs)
                    if p != ws and ws_meta.get(p, {}).get("device_name") == meta["device_name"]
                ]
                for old in old_pcs:
                    try: await old.close(4001, "duplicate_reconnect")
                    except: pass
                    group.pcs.discard(old)

                group.pcs.add(ws)
                await ws.send(json.dumps({
                    "type": "pc_auth_ok", "pin": pin, "phoneCount": len(group.phones)
                }))

                if len(group.phones) > 0:
                    await forward_to_phones(pin, {"type": "pc_online", "pin": pin})

                for phone in list(group.phones):
                    ph_meta = ws_meta.get(phone, {})
                    if ph_meta.get("device_name"):
                        await ws.send(json.dumps({
                            "type": "phone_hello", "pin": pin,
                            "deviceName": ph_meta["device_name"],
                            "deviceId": ph_meta["device_name"],
                            "reconnect": True
                        }))

                _log("I", "PC_HELLO", pin, f"hostname={meta['device_name']}")
                continue

            # ==================== 未认证 ====================
            if not meta.get("pin") and not meta.get("user_id"):
                await ws.send(json.dumps({
                    "type": "error", "reason": "请先发送 phone_hello 或 pc_hello"
                }))
                continue

            # ==================== dial_ack → 更新拨号结果 ====================
            if msg_type == "dial_ack":
                req_id = msg.get("req_id", "")
                if req_id in dial_results:
                    old = dial_results[req_id]
                    dial_results[req_id] = {
                        "status": msg.get("status", "ok"),
                        "number": old.get("number", ""),
                        "error": msg.get("error", ""),
                        "user_id": old.get("user_id")
                    }
                    _log("I", "DIAL_ACK", meta.get("user_id", meta.get("pin", "?")),
                         f"req={req_id} status={msg.get('status','ok')}")
                # 同时转发给该用户的 PC 端（JWT 路由）
                user_id = meta.get("user_id")
                if user_id is not None:
                    await forward_to_user_pcs(user_id, msg)
                else:
                    await forward_to_pcs(meta.get("pin", ""), msg, ws)
                continue

            # ==================== ping → pong ====================
            if msg_type == "ping":
                await ws.send(json.dumps({"type": "pong"}))
                continue

            # ==================== Phone → PC ====================
            if msg_type in PHONE_TO_PC_TYPES:
                user_id = meta.get("user_id")
                if user_id is not None:
                    await forward_to_user_pcs(user_id, msg)
                else:
                    await forward_to_pcs(meta.get("pin", ""), msg, ws)
                continue

            # ==================== PC → Phone ====================
            if msg_type in PC_TO_PHONE_TYPES:
                user_id = meta.get("user_id")
                if user_id is not None:
                    await forward_to_user_phones(user_id, msg)
                else:
                    await forward_to_phones(meta.get("pin", ""), msg, ws)
                _log("I", "RELAY", meta.get("user_id", meta.get("pin", "?")), f"{msg_type}")
                continue

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        _log("E", "CONN", None, f"Error: {e}")
    finally:
        meta = ws_meta.pop(ws, {})
        user_id = meta.get("user_id")
        pin = meta.get("pin")
        role = meta.get("role")
        remove_from_group(ws)
        if user_id:
            unregister_jwt_device(user_id, "pcs" if role == "pc" else "phones", ws)
        ws_connections.discard(ws)

        if role == "pc" and pin:
            group = pin_groups.get(pin)
            if not group or len(group.pcs) == 0:
                await forward_to_phones(pin, {"type": "pc_offline", "pin": pin})

        _log("I", "DISCONNECT", user_id or pin or "?", f"role={role}")

# ==================== REST API (35441) ====================

# 拨号结果暂存
from collections import OrderedDict
dial_results = OrderedDict()
MAX_DIAL_RESULTS = 100

REGISTER_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>注册 - AutoDial</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#111318;color:#E8DCC8;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#1A1D24;border-radius:12px;padding:32px 28px;width:360px;box-shadow:0 8px 32px rgba(0,0,0,.4)}
h1{font-size:20px;color:#C9A84C;text-align:center;margin-bottom:24px}
input{width:100%;padding:10px 12px;margin-bottom:12px;background:#111318;border:1px solid #2A2E38;border-radius:8px;color:#E8DCC8;font-size:14px;outline:none}
input:focus{border-color:#C9A84C}
button{width:100%;padding:10px;background:#C9A84C;color:#111318;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#F0C040}
button:disabled{opacity:.5}
.msg{margin-top:12px;text-align:center;font-size:13px;min-height:20px}
.msg.ok{color:#2ECC71}
.msg.err{color:#E74C3C}
</style></head>
<body>
<div class="card">
<h1>AutoDial 注册</h1>
<input id="phone" placeholder="手机号" maxlength="11">
<input id="password" type="password" placeholder="密码（至少6位）">
<button id="btn" onclick="doRegister()">注册</button>
<div class="msg" id="msg"></div>
</div>
<script>
async function doRegister(){
  const phone=document.getElementById('phone').value.trim();
  const password=document.getElementById('password').value;
  if(!phone||phone.length!==11){msg('请输入正确手机号','err');return}
  if(password.length<6){msg('密码至少6位','err');return}
  const btn=document.getElementById('btn');btn.disabled=true;btn.textContent='注册中...';
  try{
    const res=await fetch('/api/v1/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,password})});
    const d=await res.json();
    if(d.ok){msg('注册成功！现在可以去插件登录了','ok')}
    else{msg(d.error||'注册失败','err');btn.disabled=false;btn.textContent='注册'}
  }catch(e){msg('网络错误: '+e.message,'err');btn.disabled=false;btn.textContent='注册'}
}
function msg(t,c){const m=document.getElementById('msg');m.textContent=t;m.className='msg '+c}
</script>
</body></html>"""

async def handle_register_page(request):
    return web.Response(text=REGISTER_PAGE, content_type="text/html; charset=utf-8")


async def handle_health(request):
    uptime = int(time.time() - SERVER_START_TIME)
    return web.json_response({
        "ok": True,
        "data": {
            "service": "AutoDial Cloud Relay v3",
            "uptime_sec": uptime
        }
    })


async def handle_status(request):
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    try:
        payload = verify_jwt(token)
        user_id = payload["user_id"]
    except Exception:
        return web.json_response({"ok": False, "error": "未登录"}, status=401)

    device = await db.get_active_device(user_id)
    return web.json_response({
        "ok": True,
        "data": {
            "phone_online": device is not None,
            "device_name": device["device_name"] if device else None
        }
    })


async def handle_rest_dial(request):
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    try:
        payload = verify_jwt(token)
        user_id = payload["user_id"]
    except Exception:
        return web.json_response({"ok": False, "error": "未登录"}, status=401)

    body = await request.json()
    phone = body.get("phone", "").strip()
    if not phone:
        return web.json_response({"ok": False, "error": "号码不能为空"}, status=400)

    device = await db.get_active_device(user_id)
    if not device:
        return web.json_response({"ok": False, "error": "没有在线的手机"}, status=409)

    phone_ws = find_device_ws(device["device_name"])
    if not phone_ws:
        return web.json_response({"ok": False, "error": "手机已离线"}, status=409)

    import secrets as _s
    req_id = _s.token_hex(8)
    dial_results[req_id] = {"status": "pending", "number": phone, "user_id": user_id}
    while len(dial_results) > MAX_DIAL_RESULTS:
        dial_results.popitem(last=False)

    await phone_ws.send(json.dumps({"type": "dial", "number": phone, "req_id": req_id}))
    await db.log_audit(user_id, "dial", f"number={phone}", get_client_ip(request))

    return web.json_response({
        "ok": True,
        "data": {"req_id": req_id, "status": "pending"}
    }, status=202)


async def handle_dial_result(request):
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    try:
        payload = verify_jwt(token)
        user_id = payload["user_id"]
    except Exception:
        return web.json_response({"ok": False, "error": "未登录"}, status=401)

    req_id = request.query.get("req_id", "")
    result = dial_results.get(req_id)
    if not result:
        return web.json_response({"ok": True, "data": {"status": "unknown"}})
    # 校验归属：只能查自己的拨号结果
    if result.get("user_id") != user_id:
        return web.json_response({"ok": False, "error": "无权访问"}, status=403)
    # 不返回 user_id 给客户端
    safe = {k: v for k, v in result.items() if k != "user_id"}
    return web.json_response({"ok": True, "data": safe})


async def handle_hangup(request):
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    try:
        payload = verify_jwt(token)
        user_id = payload["user_id"]
    except Exception:
        return web.json_response({"ok": False, "error": "未登录"}, status=401)

    device = await db.get_active_device(user_id)
    if not device:
        return web.json_response({"ok": False, "error": "没有在线的手机"}, status=409)

    phone_ws = find_device_ws(device["device_name"])
    if phone_ws:
        await phone_ws.send(json.dumps({"type": "hangup"}))

    return web.json_response({"ok": True, "data": {}}, status=202)


async def handle_sms(request):
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    try:
        payload = verify_jwt(token)
        user_id = payload["user_id"]
    except Exception:
        return web.json_response({"ok": False, "error": "未登录"}, status=401)

    body = await request.json()
    phone = body.get("phone", "").strip()

    device = await db.get_active_device(user_id)
    if not device:
        return web.json_response({"ok": False, "error": "没有在线的手机"}, status=409)

    phone_ws = find_device_ws(device["device_name"])
    if phone_ws:
        await phone_ws.send(json.dumps({"type": "sms", "number": phone}))

    return web.json_response({"ok": True, "data": {}}, status=202)


# ==================== Start ====================

async def start_http_server():
    app = web.Application()
    # 注册页面
    app.router.add_get("/register", handle_register_page)
    # 认证
    app.router.add_post("/api/v1/auth/register", handle_register)
    app.router.add_post("/api/v1/auth/login", handle_login)
    app.router.add_post("/api/v1/auth/refresh", handle_refresh)
    # 业务
    app.router.add_get("/api/v1/status", handle_status)
    app.router.add_post("/api/v1/dial", handle_rest_dial)
    app.router.add_get("/api/v1/dial/result", handle_dial_result)
    app.router.add_post("/api/v1/hangup", handle_hangup)
    app.router.add_post("/api/v1/sms", handle_sms)
    # 健康检查
    app.router.add_get("/health", handle_health)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", HTTP_PORT)
    await site.start()
    _log("I", "HTTP", None, f"REST API on port {HTTP_PORT}")


async def start_ws_server():
    _log("I", "WS", None, f"Starting on port {WS_PORT}...")
    asyncio.create_task(check_heartbeats())

    async with serve(
        handle_connection, "0.0.0.0", WS_PORT,
        ping_interval=30,
        ping_timeout=90,
        close_timeout=10,
        compression="deflate",
    ):
        _log("I", "WS", None, f"Started on port {WS_PORT}")
        await asyncio.Future()


async def main():
    await db.init()
    await db.cleanup_devices_on_startup()
    _log("I", "SERVER", None, f"v3 booting WS={WS_PORT} HTTP={HTTP_PORT}")

    await asyncio.gather(
        start_ws_server(),
        start_http_server(),
    )

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        _log("I", "SERVER", None, "Shutdown")
