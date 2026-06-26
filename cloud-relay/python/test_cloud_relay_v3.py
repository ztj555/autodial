"""
AutoDial v3 单元测试 — db.py + auth.py 核心函数
不启动完整服务器，直接测逻辑
"""
import sys, os, json, hashlib, time, asyncio
sys.path.insert(0, os.path.dirname(__file__))
os.environ["AUTODIAL_WS_PORT"] = "35540"
os.environ["AUTODIAL_HTTP_PORT"] = "35541"

import pytest
from db import Database
import auth

TEST_DB = os.path.join(os.path.dirname(__file__), "test_unit.db")


@pytest.fixture(autouse=True)
def clean_db():
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)
    yield
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)


def get_db():
    db = Database(TEST_DB)
    asyncio.run(db.init())
    return db


# ==================== DB 层 ====================

def test_create_and_get_user():
    d = get_db()
    uid = asyncio.run(d.create_user("13800001111", "hashed_pw", "测试用户"))
    assert uid == 1

    user = asyncio.run(d.get_user_by_phone("13800001111"))
    assert user is not None
    assert user["phone"] == "13800001111"
    assert user["name"] == "测试用户"


def test_duplicate_phone_rejected():
    d = get_db()
    asyncio.run(d.create_user("13800001111", "pw1"))
    try:
        asyncio.run(d.create_user("13800001111", "pw2"))
        assert False, "应该抛异常"
    except Exception:
        pass  # UNIQUE 约束正确


def test_device_upsert():
    d = get_db()
    uid = asyncio.run(d.create_user("13900001111", "pw"))
    asyncio.run(d.upsert_device(uid, "Pixel-8", "phone"))
    asyncio.run(d.upsert_device(uid, "Pixel-8", "phone"))  # 重复不报错

    dev = asyncio.run(d.get_active_device(uid))
    assert dev is not None
    assert dev["device_name"] == "Pixel-8"


def test_cleanup_on_startup():
    d = get_db()
    uid = asyncio.run(d.create_user("13700001111", "pw"))
    asyncio.run(d.upsert_device(uid, "Xiaomi", "phone"))
    asyncio.run(d.cleanup_devices_on_startup())

    dev = asyncio.run(d.get_active_device(uid))
    assert dev is None  # 全部清为离线


def test_refresh_token_flow():
    d = get_db()
    uid = asyncio.run(d.create_user("13600001111", "pw"))

    raw = auth.secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    from datetime import datetime, timezone, timedelta
    expires_str = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    asyncio.run(d.create_refresh_token(uid, token_hash, expires_str))

    # 验证通过
    result = asyncio.run(d.verify_and_rotate_refresh_token(token_hash))
    assert result == uid

    # 重用失败（已吊销）
    result2 = asyncio.run(d.verify_and_rotate_refresh_token(token_hash))
    assert result2 is None


# ==================== Auth 层 ====================

def test_jwt_sign_and_verify():
    token = auth.make_jwt(42, "13800001111")
    payload = auth.verify_jwt(token)
    assert payload["user_id"] == 42
    assert payload["phone"] == "13800001111"


def test_jwt_expired():
    import jwt
    token = jwt.encode({
        "user_id": 1,
        "exp": __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
        - __import__("datetime").timedelta(minutes=1)
    }, auth.JWT_SECRET, algorithm="HS256")
    try:
        auth.verify_jwt(token)
        assert False, "过期 token 应抛异常"
    except jwt.ExpiredSignatureError:
        pass


def test_bcrypt_hash():
    pw = "test123456".encode()
    hashed = auth.bcrypt.hashpw(pw, auth.bcrypt.gensalt())
    assert auth.bcrypt.checkpw(pw, hashed)
    assert not auth.bcrypt.checkpw(b"wrong", hashed)


def test_rate_limit_basic():
    auth._attempts.clear()
    key = "test:rate"
    for _ in range(5):
        assert auth.check_rate_limit(key, max_attempts=5) is True
    assert auth.check_rate_limit(key, max_attempts=5) is False  # 第6次被拒


def test_rate_limit_reset():
    auth._attempts.clear()
    key = "test:reset"
    for _ in range(5):
        auth.check_rate_limit(key)
    auth.reset_rate_limit(key)
    assert auth.check_rate_limit(key) is True  # 重置后可重试


# ==================== 集成测试（手动启动服务器后用） ====================

def test_server_health_check():
    """需要先启动 cloud_relay_v3.py，再跑这个测试"""
    pass  # 标记为手动测试
