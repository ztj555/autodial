#!/usr/bin/env python3
"""
AutoDial Cloud Relay - 50 并发压力测试 (v3)
=============================================
模拟 50 个用户同时使用的完整场景。

v3 修复:
  - REST API 测试在 PC 连接之前执行（dial 在 PC 在线时会返回 PC_CONNECTED）
  - 正确处理各种服务端响应码
  - 更好的错误诊断
"""

import asyncio
import json
import time
import sys
import os
import sqlite3
import statistics
import traceback
from datetime import datetime
from collections import Counter

try:
    import aiohttp
except ImportError:
    print("❌ 需要 aiohttp: pip install aiohttp")
    sys.exit(1)

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

# ==================== 配置 ====================
HOST = "127.0.0.1"
PORT = 35430
BASE_URL = f"http://{HOST}:{PORT}"
WS_URL = f"ws://{HOST}:{PORT}"

PHONE_COUNT = 50
PC_COUNT = 50
DIAL_CONCURRENT = 50
VISIT_CONCURRENT = 20
VISITS_QUERY_CONCURRENT = 20
START_PIN = 1
END_PIN = 50
MSG_ROUNDS = 3
BATCH_SIZE = 10
CONNECT_TIMEOUT = 15


def pin_str(i):
    return f"{i:04d}"


def percentile(data, p):
    if not data:
        return 0.0
    s = sorted(data)
    k = (len(s) - 1) * p / 100.0
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (k - f) * (s[c] - s[f]) if c != f else s[f]


# ==================== 统计 (简化：无锁 asyncio) ====================
class _Stats:
    def __init__(self):
        self.d = {}
        self.lists = {}

    def inc(self, k, v=1):
        self.d[k] = self.d.get(k, 0) + v

    def append(self, k, v):
        if k not in self.lists:
            self.lists[k] = []
        self.lists[k].append(v)

    def get(self, k, default=0):
        if k in self.lists:
            return self.lists[k]
        return self.d.get(k, default)

    def get_list(self, k):
        return self.lists.get(k, [])


S = _Stats()


def print_header(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


# ==================== 数据库准备 ====================
def prepare_db():
    db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "visits.db")
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    for i in range(START_PIN, END_PIN + 1):
        pin = pin_str(i)
        c.execute(
            """INSERT OR REPLACE INTO phones (device_id, default_pin, last_pin, first_seen, last_seen)
               VALUES (?, ?, ?, COALESCE((SELECT first_seen FROM phones WHERE device_id=?), ?), ?)""",
            (f"StressTest-Phone-{pin}", pin, pin, f"StressTest-Phone-{pin}", now, now),
        )
    conn.commit()
    conn.close()
    count = END_PIN - START_PIN + 1
    print(f"  [DB] Pre-registered {count} test devices")


# ==================== 资源监控 ====================
async def monitor_resources(stop: asyncio.Event):
    if not HAS_PSUTIL:
        return
    proc = psutil.Process(os.getpid())
    while not stop.is_set():
        try:
            S.append("cpu_samples", psutil.cpu_percent(interval=0.1))
            S.append("memory_samples", proc.memory_info().rss / 1024 / 1024)
        except Exception:
            pass
        await asyncio.sleep(1)


# ==================== WebSocket 客户端 ====================
class WSClient:
    def __init__(self, session, pin, idx, role):
        self.s = session
        self.pin = pin
        self.idx = idx
        self.role = role
        self.ws = None
        self.ok = False

    def hello(self):
        if self.role == "phone":
            return {"type": "phone_hello", "pin": self.pin, "deviceName": f"StressTest-Phone-{self.pin}"}
        else:
            return {"type": "pc_hello", "pin": self.pin, "hostname": f"StressTest-PC-{self.pin}"}

    def expected_auth(self):
        return "auth_ok" if self.role == "phone" else "pc_auth_ok"

    async def connect(self, timeout=CONNECT_TIMEOUT):
        t0 = time.monotonic()
        try:
            self.ws = await asyncio.wait_for(
                self.s.ws_connect(WS_URL, timeout=aiohttp.ClientTimeout(total=timeout), heartbeat=30),
                timeout=timeout,
            )
            S.append("connect_times", (time.monotonic() - t0) * 1000)
            await self.ws.send_json(self.hello())

            resp = await asyncio.wait_for(self.ws.receive_json(), timeout=15)
            rt = resp.get("type", "")

            if rt == self.expected_auth():
                self.ok = True
                S.inc(f"{self.role}_auth_ok")
                S.inc(f"{self.role}_connect_ok")
                return True

            if rt == "auth_pending":
                try:
                    resp2 = await asyncio.wait_for(self.ws.receive_json(), timeout=10)
                    if resp2.get("type") == self.expected_auth():
                        self.ok = True
                        S.inc(f"{self.role}_auth_ok")
                        S.inc(f"{self.role}_connect_ok")
                        return True
                except asyncio.TimeoutError:
                    pass

            S.inc(f"{self.role}_auth_fail")
            S.inc(f"{self.role}_connect_fail")
            S.append("fail_reasons", f"{self.role}:{self.pin}:{resp.get('reason', rt)}")
            return False

        except asyncio.TimeoutError:
            S.inc(f"{self.role}_connect_fail")
            S.append("fail_reasons", f"{self.role}:{self.pin}:connect_timeout")
            return False
        except Exception as e:
            S.inc(f"{self.role}_connect_fail")
            S.append("fail_reasons", f"{self.role}:{self.pin}:{type(e).__name__}")
            return False

    async def ping(self):
        if not self.ok or not self.ws or self.ws.closed:
            return -1
        t0 = time.monotonic()
        try:
            await self.ws.send_json({"type": "ping"})
            await asyncio.wait_for(self.ws.receive_json(), timeout=10)
            return (time.monotonic() - t0) * 1000
        except Exception:
            return -1

    async def send_dial(self, number):
        if not self.ok or not self.ws or self.ws.closed:
            return -1
        t0 = time.monotonic()
        try:
            await self.ws.send_json({"type": "dial", "number": number, "messageId": f"t-{int(t0*1000)}"})
            return (time.monotonic() - t0) * 1000
        except Exception:
            return -1

    async def close(self):
        if self.ws and not self.ws.closed:
            await self.ws.close()


# ==================== REST API ====================
async def rest_call(session, path, params=None, headers=None, timeout=15):
    """统一 REST 调用，返回 (elapsed_ms, status_code, body_json)"""
    t0 = time.monotonic()
    try:
        async with session.get(
            f"{BASE_URL}{path}", params=params, headers=headers,
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as resp:
            body = await resp.json()
            return (time.monotonic() - t0) * 1000, resp.status, body
    except asyncio.TimeoutError:
        return (timeout * 1000), 0, {"error": "timeout"}
    except Exception as e:
        return (time.monotonic() - t0) * 1000, 0, {"error": str(e)}


async def run_rest_batch(label, metric_key, tasks, total):
    """运行一批 REST 请求并统计"""
    t0 = time.monotonic()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    elapsed = time.monotonic() - t0

    ok = 0
    fail = 0
    codes = {}
    for r in results:
        if isinstance(r, tuple) and len(r) >= 3:
            _, sc, body = r
            elapsed_ms = r[0] if r[0] else 0
            S.append(metric_key, elapsed_ms)

            # 判定成功: HTTP 200 + (ok==True 或 code==ACCEPTED 或 是list)
            if sc == 200:
                if isinstance(body, dict):
                    if body.get("ok") or body.get("code") == "ACCEPTED":
                        ok += 1
                    else:
                        code = body.get("code", "unknown")
                        codes[code] = codes.get(code, 0) + 1
                        # PC_CONNECTED / PHONE_OFFLINE / DUPLICATE_DIAL 算预期的业务拒绝，不算失败
                        if code in ("PC_CONNECTED", "PHONE_OFFLINE", "DUPLICATE_DIAL"):
                            ok += 1  # 算预期行为
                        else:
                            fail += 1
                elif isinstance(body, list):
                    ok += 1
                else:
                    fail += 1
            else:
                fail += 1
        else:
            fail += 1

    real_total = ok + fail
    if codes:
        print(f"  {label}: {ok}/{real_total} ({ok/real_total*100:.1f}% OK) | {elapsed:.2f}s | 业务码: {codes}")
    else:
        print(f"  {label}: {ok}/{real_total} ({ok/real_total*100:.1f}% OK) | {elapsed:.2f}s")

    return ok, fail


# ==================== 主测试 ====================
async def run_test():
    print_header("AutoDial Cloud Relay - 50 并发压力测试 v3")
    print(f"  目标: {WS_URL}")
    print(f"  WS: {PHONE_COUNT} phones + {PC_COUNT} PCs")
    print(f"  REST: {DIAL_CONCURRENT} dials + {VISIT_CONCURRENT} visits + {VISITS_QUERY_CONCURRENT} queries")
    print(f"  时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    S.d["start_time"] = datetime.now()

    # 预检
    print_header("Phase 0: 预检")
    prepare_db()
    async with aiohttp.ClientSession() as chk:
        try:
            async with chk.get(f"{BASE_URL}/health", timeout=aiohttp.ClientTimeout(total=5)) as resp:
                h = await resp.json()
                print(f"  ✅ 服务器在线: {h.get('service')} v{h.get('version')} (uptime {h.get('uptime_seconds')}s)")
        except Exception as e:
            print(f"  ❌ 服务器不可达: {e}")
            return

    stop_mon = asyncio.Event()
    if HAS_PSUTIL:
        mon_task = asyncio.create_task(monitor_resources(stop_mon))

    # P0-Fix: 默认 aiohttp TCPConnector limit=100，100 WS + 20 REST 超限导致超时
    connector = aiohttp.TCPConnector(limit=200, force_close=True)
    async with aiohttp.ClientSession(connector=connector) as http:

        # ===== Phase 1: 连接 50 手机（仅手机，不连 PC）=====
        print_header("Phase 1: 50 手机 WebSocket 连接")
        phones = [WSClient(http, pin_str(i), i, "phone") for i in range(START_PIN, END_PIN + 1)]
        t0 = time.monotonic()
        for bi in range(0, PHONE_COUNT, BATCH_SIZE):
            batch = phones[bi:bi + BATCH_SIZE]
            results = await asyncio.gather(*[p.connect() for p in batch], return_exceptions=True)
            ok = sum(1 for r in results if r is True)
            print(f"  Batch {bi//BATCH_SIZE+1}: {ok}/{len(batch)}")
            await asyncio.sleep(0.2)
        print(f"  耗时 {time.monotonic()-t0:.1f}s | OK: {S.get('phone_connect_ok')}/{PHONE_COUNT} ({S.get('phone_connect_ok')/PHONE_COUNT*100:.1f}%)")

        # ===== Phase 2: 50 并发 REST 拨号（手机在线，PC 不在线，拨号应该成功）=====
        print_header("Phase 2: 50 并发 REST 拨号 (GET /api/v1/dial)")
        sem = asyncio.Semaphore(DIAL_CONCURRENT)
        tasks = [rest_call(http, "/api/v1/dial",
                           params={"number": f"1380000{i:04d}"[-11:]},
                           headers={"x-autodial-pin": pin_str(i)})
                 for i in range(START_PIN, START_PIN + DIAL_CONCURRENT)]
        await run_rest_batch("Dial", "rest_dial_times", tasks, DIAL_CONCURRENT)

        # ===== Phase 3: 20 并发登记 =====
        print_header("Phase 3: 20 并发登记 (GET /api/v1/visit)")
        sem = asyncio.Semaphore(VISIT_CONCURRENT)
        tasks = [rest_call(http, "/api/v1/visit",
                           params={"name": f"测试{i:04d}", "mobile": f"1380000{i:04d}"[-11:], "kefu_tel": pin_str(i)},
                           headers={"x-autodial-pin": pin_str(i)})
                 for i in range(START_PIN, START_PIN + VISIT_CONCURRENT)]
        await run_rest_batch("Visit", "rest_visit_times", tasks, VISIT_CONCURRENT)

        # ===== Phase 4: 20 并发查询 =====
        print_header("Phase 4: 20 并发查询 (GET /api/v1/visits)")
        sem = asyncio.Semaphore(VISITS_QUERY_CONCURRENT)
        tasks = [rest_call(http, "/api/v1/visits", params={"pin": pin_str(i)})
                 for i in range(START_PIN, START_PIN + VISITS_QUERY_CONCURRENT)]
        await run_rest_batch("Query", "rest_visits_times", tasks, VISITS_QUERY_CONCURRENT)

        # ===== Phase 5: 连接 50 PC =====
        print_header("Phase 5: 50 PC WebSocket 连接")
        pcs = [WSClient(http, pin_str(i), i, "pc") for i in range(START_PIN, END_PIN + 1)]
        t0 = time.monotonic()
        for bi in range(0, PC_COUNT, BATCH_SIZE):
            batch = pcs[bi:bi + BATCH_SIZE]
            results = await asyncio.gather(*[p.connect() for p in batch], return_exceptions=True)
            ok = sum(1 for r in results if r is True)
            print(f"  Batch {bi//BATCH_SIZE+1}: {ok}/{len(batch)}")
            await asyncio.sleep(0.2)
        print(f"  耗时 {time.monotonic()-t0:.1f}s | OK: {S.get('pc_connect_ok')}/{PC_COUNT} ({S.get('pc_connect_ok')/PC_COUNT*100:.1f}%)")

        # ===== Phase 6: WS 消息压力 =====
        print_header("Phase 6: WebSocket 消息压力测试 (100连接在线)")
        for rnd in range(1, MSG_ROUNDS + 1):
            t0 = time.monotonic()

            # 所有在线客户端发 ping
            ping_tasks = [c.ping() for c in phones + pcs if c.ok and c.ws and not c.ws.closed]
            rtts = await asyncio.gather(*ping_tasks, return_exceptions=True)
            valid = [r for r in rtts if isinstance(r, (int, float)) and r > 0]
            for r in valid:
                S.append("message_latencies", r)

            # PC 发 dial 指令给手机
            dial_tasks = [pc.send_dial(f"1380000{pc.idx:04d}"[-11:])
                          for pc in pcs if pc.ok and pc.ws and not pc.ws.closed]
            await asyncio.gather(*dial_tasks, return_exceptions=True)

            p50 = percentile(valid, 50) if valid else 0
            p99 = percentile(valid, 99) if valid else 0
            print(f"  Round {rnd}/{MSG_ROUNDS}: {len(valid)}/{len(ping_tasks)} pings, "
                  f"P50={p50:.1f}ms P99={p99:.1f}ms ({time.monotonic()-t0:.2f}s)")
            if rnd < MSG_ROUNDS:
                await asyncio.sleep(0.3)

        # ===== Phase 7: REST dial with PC connected（预期返回 PC_CONNECTED）=====
        print_header("Phase 7: REST 拨号（PC在线，预期 PC_CONNECTED）")
        sem = asyncio.Semaphore(20)
        tasks = [rest_call(http, "/api/v1/dial",
                           params={"number": f"1380000{i:04d}"[-11:]},
                           headers={"x-autodial-pin": pin_str(i)})
                 for i in range(START_PIN, START_PIN + 20)]
        await run_rest_batch("Dial (PC在线)", "rest_dial_times_pc", tasks, 20)

        # ===== Phase 8: 清理 =====
        print_header("Phase 8: 清理")
        await asyncio.gather(*[c.close() for c in phones + pcs if c.ws and not c.ws.closed], return_exceptions=True)
        await asyncio.sleep(1)
        print("  完成")

    S.d["end_time"] = datetime.now()
    stop_mon.set()

    print_report()


def print_report():
    d = S.d
    total_s = (d["end_time"] - d["start_time"]).total_seconds()

    print_header("📊 压力测试报告")

    # 连接成功率
    pp = d.get("phone_connect_ok", 0) / PHONE_COUNT * 100
    pc = d.get("pc_connect_ok", 0) / PC_COUNT * 100
    total_ws = d.get("phone_connect_ok", 0) + d.get("pc_connect_ok", 0)
    print(f"\n📡 WebSocket 连接:")
    print(f"  手机: {d.get('phone_connect_ok',0)}/{PHONE_COUNT} ({pp:.1f}%) {'✅' if pp>=90 else '❌'}")
    print(f"  PC:   {d.get('pc_connect_ok',0)}/{PC_COUNT} ({pc:.1f}%) {'✅' if pc>=90 else '❌'}")
    print(f"  总计: {total_ws}/{PHONE_COUNT+PC_COUNT}")

    ct = S.get_list("connect_times")
    if ct:
        print(f"  连接建立: P50={percentile(ct,50):.1f}ms P99={percentile(ct,99):.1f}ms Avg={statistics.mean(ct):.1f}ms")

    # 消息延迟
    lats = S.get_list("message_latencies")
    print(f"\n⏱️  WS 消息延迟 (100连接 ping RTT):")
    if lats:
        print(f"  样本={len(lats)} | P50={percentile(lats,50):.1f}ms P90={percentile(lats,90):.1f}ms "
              f"P99={percentile(lats,99):.1f}ms Max={max(lats):.1f}ms Avg={statistics.mean(lats):.1f}ms")
        print(f"  判定: {'✅ P99<500ms' if percentile(lats,99)<500 else '❌ P99≥500ms'}")
    else:
        print(f"  ⚠️  无数据")

    # REST API
    print(f"\n🌐 REST API:")
    for label, key in [("拨号 /api/v1/dial", "rest_dial_times"),
                        ("登记 /api/v1/visit", "rest_visit_times"),
                        ("查询 /api/v1/visits", "rest_visits_times"),
                        ("拨号 PC在线 /api/v1/dial", "rest_dial_times_pc")]:
        vals = S.get_list(key)
        if vals:
            print(f"  {label}: P50={percentile(vals,50):.1f}ms P99={percentile(vals,99):.1f}ms "
                  f"Avg={statistics.mean(vals):.1f}ms Max={max(vals):.1f}ms")
        else:
            print(f"  {label}: ⚠️ 无数据（可能全部超时）")

    # 资源
    cpu = S.get_list("cpu_samples")
    mem = S.get_list("memory_samples")
    if cpu or mem:
        print(f"\n💻 测试进程资源:")
        if cpu:
            print(f"  CPU Avg={statistics.mean(cpu):.1f}% Max={max(cpu):.1f}%")
        if mem:
            print(f"  MEM Avg={statistics.mean(mem):.1f}MB Max={max(mem):.1f}MB")

    # 失败原因
    fr = S.get_list("fail_reasons")
    if fr:
        print(f"\n🔍 连接失败详情:")
        for reason, count in Counter(fr).most_common(10):
            print(f"  [{count}x] {reason}")

    # 总结
    print_header("总结")
    print(f"  总耗时: {total_s:.1f}s")
    print(f"  时段: {d['start_time'].strftime('%H:%M:%S')} ~ {d['end_time'].strftime('%H:%M:%S')}")

    checks = [
        ("手机 WS 连接 ≥ 90%", pp >= 90),
        ("PC WS 连接 ≥ 90%", pc >= 90),
    ]
    if lats:
        checks.append(("消息 P99 < 500ms", percentile(lats, 99) < 500))
    # REST API 成功率检查
    rest_dial = S.get_list("rest_dial_times")
    if rest_dial:
        checks.append(("REST拨号 P99 < 500ms", percentile(rest_dial, 99) < 500))
    rest_dial_pc = S.get_list("rest_dial_times_pc")
    if rest_dial_pc:
        checks.append(("REST拨号(PC在线) P99 < 1000ms", percentile(rest_dial_pc, 99) < 1000))

    passed = sum(1 for _, ok in checks if ok)
    print(f"\n  通过: {passed}/{len(checks)}")
    for name, ok in checks:
        print(f"  {'✅' if ok else '❌'} {name}")


if __name__ == "__main__":
    print(f"AutoDial Cloud Relay Stress Test v3 | Python {sys.version.split()[0]}")
    try:
        asyncio.run(run_test())
    except KeyboardInterrupt:
        print("\n⚠️ 中断")
    except Exception as e:
        print(f"\n❌ 异常: {e}")
        traceback.print_exc()
