"""P0 修复回归测试。

覆盖三处"文档声称已修、实际未生效"的坑：
1. run_server() 未把事件循环登记到全局 loop —— Docker/headless 路径下所有
   _schedule_async（拨号/挂断/登记推送/踢人/授权回调）被静默丢弃；
2. limit 只钳上限不钳下限 —— limit=-1 时 SQLite `LIMIT -1` 表示不限量，整表泄漏；
3. :memory: 降级分支不可用 —— 每次 connect 新建独立空库，后续连接看不到表。

不依赖真实网络、托盘与防火墙（相关调用已打桩）。
运行：python -m pytest test_p0_fixes.py -q
"""
import asyncio
import os
import tempfile

os.environ.setdefault('AUTODIAL_DB_PATH', os.path.join(tempfile.gettempdir(), 'autodial_p0_test.db'))

import cloud_relay_v2 as cr


class _FakeServe:
    """替代 websockets.serve 的异步上下文管理器。"""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def test_safe_limit_clamps_lower_bound():
    assert cr._safe_limit('-1', 200, 1000) == 200
    assert cr._safe_limit('-99999', 200, 1000) == 200
    assert cr._safe_limit('0', 200, 1000) == 200


def test_safe_limit_clamps_upper_bound():
    assert cr._safe_limit('50', 200, 1000) == 50
    assert cr._safe_limit('99999', 200, 1000) == 1000


def test_safe_limit_falls_back_on_garbage():
    assert cr._safe_limit('abc', 200, 1000) == 200
    assert cr._safe_limit(None, 200, 1000) == 200


def test_safe_offset_never_negative():
    assert cr._safe_offset('-5') == 0
    assert cr._safe_offset('0') == 0
    assert cr._safe_offset('10') == 10


def test_memory_fallback_shares_one_database():
    """降级到 :memory: 后，第二个连接必须能看到第一个连接建的表和数据。"""
    original = cr.DB_PATH
    try:
        cr.DB_PATH = ':memory:'
        anchor = cr._connect_db()
        anchor.execute('CREATE TABLE t_probe (x INTEGER)')
        anchor.commit()

        other = cr._connect_db()
        other.execute('INSERT INTO t_probe (x) VALUES (1)')
        other.commit()
        assert other.execute('SELECT COUNT(*) FROM t_probe').fetchone()[0] == 1
        other.close()
        anchor.close()
    finally:
        cr.DB_PATH = original


def test_run_server_registers_global_loop(monkeypatch=None):
    """run_server() 必须走 global loop：headless 入口只调用它，不经过 run_server_thread()。"""
    cr.loop = None
    cr.serve = lambda *a, **k: _FakeServe()
    cr.configure_firewall = lambda: None

    async def _probe():
        task = asyncio.create_task(cr.run_server())
        await asyncio.sleep(0.2)
        task.cancel()
        try:
            await task
        except BaseException:
            pass

    asyncio.run(_probe())
    assert cr.loop is not None, '全局 loop 未被登记，_schedule_async 会静默丢弃任务'
    assert cr.loop.is_running() is False  # 事件循环已随 asyncio.run 结束
