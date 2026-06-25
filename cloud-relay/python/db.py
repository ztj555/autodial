"""
AutoDial v3 数据库层 — aiosqlite 封装
"""
import aiosqlite
import os, sys

DB_PATH = os.path.join(os.path.dirname(sys.executable), "autodial.db")


class Database:
    def __init__(self, path=None):
        self.path = path or DB_PATH

    async def init(self):
        """首次运行时建表 + migration"""
        async with aiosqlite.connect(self.path) as db:
            await db.execute("PRAGMA foreign_keys = ON")
            await db.execute("PRAGMA journal_mode = WAL")

            cursor = await db.execute("PRAGMA user_version")
            version = (await cursor.fetchone())[0]

            if version < 1:
                await self._create_tables_v1(db)
                await db.execute("PRAGMA user_version = 1")
                print("[DB] 数据库初始化完成 (v1)")
            else:
                print(f"[DB] 数据库已存在 (v{version})")

    async def _create_tables_v1(self, db):
        await db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                phone      TEXT UNIQUE NOT NULL,
                password   TEXT NOT NULL,
                name       TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS refresh_tokens (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL,
                token_hash TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                revoked    INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens(user_id);
            CREATE INDEX IF NOT EXISTS idx_rt_hash ON refresh_tokens(token_hash);
            CREATE TABLE IF NOT EXISTS devices (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id        INTEGER NOT NULL,
                device_name    TEXT NOT NULL,
                device_type    TEXT DEFAULT 'phone',
                last_heartbeat TEXT,
                is_active      INTEGER DEFAULT 1,
                UNIQUE(user_id, device_name),
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE INDEX IF NOT EXISTS idx_dev_user ON devices(user_id);
            CREATE TABLE IF NOT EXISTS audit_log (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER,
                action     TEXT NOT NULL,
                detail     TEXT DEFAULT '',
                ip         TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now'))
            );
        """)

    # ==================== 用户操作 ====================

    async def get_user_by_phone(self, phone):
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute("SELECT * FROM users WHERE phone = ?", (phone,))
            return await cursor.fetchone()

    async def create_user(self, phone, password_hash, name=""):
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute(
                "INSERT INTO users (phone, password, name) VALUES (?, ?, ?)",
                (phone, password_hash, name)
            )
            user_id = cursor.lastrowid  # commit 前取，更稳
            await db.commit()
            return user_id

    # ==================== refresh_token ====================

    async def create_refresh_token(self, user_id, token_hash, expires_at):
        expires = expires_at.isoformat() if hasattr(expires_at, "isoformat") else str(expires_at)
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
                (user_id, token_hash, expires)
            )
            await db.commit()

    async def verify_and_rotate_refresh_token(self, token_hash):
        """验证 refresh_token，成功则吊销旧并返回 user_id"""
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute("""
                SELECT * FROM refresh_tokens
                WHERE token_hash = ? AND revoked = 0 AND expires_at > datetime('now')
            """, (token_hash,))
            row = await cursor.fetchone()
            if not row:
                return None

            user_id = row['user_id']
            await db.execute("UPDATE refresh_tokens SET revoked = 1 WHERE id = ?", (row['id'],))
            await db.commit()

        return user_id

    async def revoke_all_user_tokens(self, user_id):
        async with aiosqlite.connect(self.path) as db:
            await db.execute("UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?", (user_id,))
            await db.commit()

    # ==================== 设备 ====================

    async def get_active_device(self, user_id):
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute("""
                SELECT * FROM devices
                WHERE user_id = ? AND is_active = 1
                ORDER BY last_heartbeat DESC LIMIT 1
            """, (user_id,))
            return await cursor.fetchone()

    async def upsert_device(self, user_id, device_name, device_type):
        async with aiosqlite.connect(self.path) as db:
            await db.execute("""
                INSERT INTO devices (user_id, device_name, device_type, last_heartbeat, is_active)
                VALUES (?, ?, ?, datetime('now'), 1)
                ON CONFLICT(user_id, device_name) DO UPDATE SET
                    last_heartbeat = datetime('now'),
                    is_active = 1
            """, (user_id, device_name, device_type))
            await db.commit()

    async def cleanup_devices_on_startup(self):
        """重启后清空所有活跃标记"""
        async with aiosqlite.connect(self.path) as db:
            await db.execute("UPDATE devices SET is_active = 0")
            await db.commit()

    # ==================== 审计日志 ====================

    async def log_audit(self, user_id, action, detail="", ip=""):
        try:
            async with aiosqlite.connect(self.path) as db:
                await db.execute(
                    "INSERT INTO audit_log (user_id, action, detail, ip) VALUES (?, ?, ?, ?)",
                    (user_id, action, detail, ip)
                )
                await db.commit()
        except Exception:
            pass


# 单例
db = Database()
