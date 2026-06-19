"""
AutoDial v3 认证模块 — JWT + bcrypt + 防爆破限流
"""
import hashlib
import secrets
import time
from datetime import datetime, timezone, timedelta

import bcrypt
import jwt

from db import db

# ==================== JWT 密钥管理 ====================

def load_jwt_secret():
    import os, subprocess

    if os.environ.get("AUTODIAL_JWT_SECRET"):
        return os.environ["AUTODIAL_JWT_SECRET"]

    secret_file = os.path.join(os.path.dirname(__import__("sys").executable), ".jwt_secret")
    if os.path.exists(secret_file):
        with open(secret_file) as f:
            return f.read().strip()

    secret = secrets.token_hex(32)
    with open(secret_file, "w") as f:
        f.write(secret)

    try:
        user = os.environ.get("USERNAME", os.environ.get("USER", ""))
        if user:
            result = subprocess.run(
                ["icacls", secret_file, "/inheritance:r", "/grant:r", f"{user}:(R)"],
                capture_output=True, timeout=5
            )
            if result.returncode != 0:
                print(f"[AUTH] WARN: icacls failed rc={result.returncode} {result.stderr.decode()}")
    except Exception as e:
        print(f"[AUTH] WARN: icacls exec failed: {e}")

    return secret


JWT_SECRET = load_jwt_secret()
JWT_EXPIRE_MINUTES = 15
REFRESH_TOKEN_DAYS = 30

print(f"[AUTH] JWT secret loaded, expire={JWT_EXPIRE_MINUTES}min, refresh={REFRESH_TOKEN_DAYS}d")

# ==================== 工具函数 ====================

def get_client_ip(request):
    return (
        request.headers.get("X-Real-IP")
        or request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
        or request.remote
    )


def make_jwt(user_id, phone=""):
    return jwt.encode({
        "user_id": user_id,
        "phone": phone,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MINUTES)
    }, JWT_SECRET, algorithm="HS256")


def verify_jwt(token):
    return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])


async def make_refresh_token(user_id):
    raw = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    expires_at = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_DAYS)
    await db.create_refresh_token(user_id, token_hash, expires_at)
    return raw

# ==================== 限流器 ====================

_attempts: dict[str, list] = {}
MAX_KEYS = 10000


def check_rate_limit(key, max_attempts=5, window_sec=900):
    now = time.time()
    attempts = [t for t in _attempts.get(key, []) if now - t < window_sec]
    _attempts[key] = attempts

    if len(attempts) >= max_attempts:
        return False

    if len(_attempts) > MAX_KEYS:
        keys = sorted(_attempts.keys(), key=lambda k: max(_attempts[k]) if _attempts[k] else 0)
        for k in keys[:len(keys) // 10]:
            del _attempts[k]
        _attempts[key] = [now]
        return True

    attempts.append(now)
    return True


def reset_rate_limit(key):
    _attempts.pop(key, None)

# ==================== 认证端点（aiohttp handler） ====================

from aiohttp import web


async def handle_register(request):
    body = await request.json()
    phone = body.get("phone", "").strip()
    password = body.get("password", "")

    if not phone or not password:
        return web.json_response({"ok": False, "error": "手机号和密码不能为空"}, status=400)
    if not (phone.startswith("1") and len(phone) == 11 and phone.isdigit()):
        return web.json_response({"ok": False, "error": "手机号格式错误"}, status=400)
    if len(password) < 6:
        return web.json_response({"ok": False, "error": "密码至少6位"}, status=400)

    client_ip = get_client_ip(request)
    if not check_rate_limit(f"reg:{client_ip}"):
        return web.json_response({"ok": False, "error": "请求过于频繁，请稍后再试"}, status=429)

    existing = await db.get_user_by_phone(phone)
    if existing:
        return web.json_response({"ok": False, "error": "该手机号已注册"}, status=409)

    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    user_id = await db.create_user(phone, pw_hash)

    token = make_jwt(user_id, phone)
    refresh_raw = await make_refresh_token(user_id)

    await db.log_audit(user_id, "register", f"phone={phone}", client_ip)

    return web.json_response({
        "ok": True,
        "data": {
            "token": token,
            "refresh_token": refresh_raw,
            "phone": phone
        }
    }, status=201)


async def handle_login(request):
    body = await request.json()
    phone = body.get("phone", "").strip()
    password = body.get("password", "")

    if not phone or not password:
        return web.json_response({"ok": False, "error": "手机号和密码不能为空"}, status=400)

    client_ip = get_client_ip(request)

    if not check_rate_limit(f"ip:{client_ip}"):
        return web.json_response({"ok": False, "error": "请求过于频繁，请15分钟后再试"}, status=429)
    if not check_rate_limit(f"phone:{phone}"):
        return web.json_response({"ok": False, "error": "该账号已被临时锁定，请15分钟后再试"}, status=429)

    user = await db.get_user_by_phone(phone)
    if not user or not bcrypt.checkpw(password.encode(), user["password"].encode()):
        await db.log_audit(None, "login_fail", f"phone={phone}", client_ip)
        return web.json_response({"ok": False, "error": "手机号或密码错误"}, status=401)

    user_id = user["id"]
    token = make_jwt(user_id, phone)
    refresh_raw = await make_refresh_token(user_id)

    reset_rate_limit(f"ip:{client_ip}")
    reset_rate_limit(f"phone:{phone}")

    await db.log_audit(user_id, "login_success", f"phone={phone}", client_ip)

    return web.json_response({
        "ok": True,
        "data": {
            "token": token,
            "refresh_token": refresh_raw,
            "phone": phone
        }
    })


async def handle_refresh(request):
    body = await request.json()
    raw_token = body.get("refresh_token", "")
    if not raw_token:
        return web.json_response({"ok": False, "error": "refresh_token 缺失"}, status=400)

    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    user_id = await db.verify_and_rotate_refresh_token(token_hash)
    if not user_id:
        return web.json_response({"ok": False, "error": "refresh_token 无效或已过期"}, status=401)

    new_token = make_jwt(user_id)
    new_refresh_raw = await make_refresh_token(user_id)

    await db.log_audit(user_id, "refresh", "", "")

    return web.json_response({
        "ok": True,
        "data": {
            "token": new_token,
            "refresh_token": new_refresh_raw
        }
    })
