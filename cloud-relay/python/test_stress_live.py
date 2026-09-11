#!/usr/bin/env python3
"""
AutoDial 云中转 - 线上真机压测 (live)
=========================================
目标：真实部署的云端服务器，从真实外网 IP 发起。

与原 test_stress_50_users.py 的关键区别：
  * 原脚本连 127.0.0.1，而服务端对 localhost **豁免限流** → 永远测不到 429。
  * 本脚本连真实公网地址，所有请求共享同一个 NAT 出口 IP
    → 精确复现「整间办公室共用一个出口 IP」的生产场景。

分阶段执行，控制影响面：
  preflight   预检 / 基线延迟
  ws-ramp     WebSocket 连接承载力阶梯（20→50→100→200）
  ws-latency  在线连接的心跳 RTT 分布
  rest-burst  REST 突发，验证 60/min/IP 限流拐点（核心）
  morning     模拟「20 人早上同时开机」：握手 + 上报突发
  block       检测同步 SQLite 阻塞事件循环（REST 突发期间观测 WS 心跳 RTT）
  cleanup    关闭所有连接

用法：
  python test_stress_live.py preflight
  python test_stress_live.py ws-ramp --levels 20,50,100
  ...
"""

import argparse
import asyncio
import json
import statistics
import sys
import time
from collections import Counter
from datetime import datetime

try:
    import aiohttp
except ImportError:
    print("需要 aiohttp: pip install aiohttp")
    sys.exit(1)

# ==================== 目标 ====================
HOST = "101.34.65.254"
PORT = 35430
BASE = f"http://{HOST}:{PORT}"
WS_URL = f"ws://{HOST}:{PORT}"

# 测试用 PIN：11 位、199 开头，明显为合成号，避免与真实员工手机号撞号
PIN_PREFIX = "19900000"


def tpin(i):
    """第 i 个测试 PIN（i 从 1 开始）→ 19900000001 ..."""
    return f"{PIN_PREFIX}{i:03d}"


def devname(i):
    return f"ZZLOADTEST-P{i:03d}"


def percentile(data, p):
    if not data:
        return 0.0
    s = sorted(data)
    k = (len(s) - 1) * p / 100.0
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (k - f) * (s[c] - s[f]) if c != f else s[f]


def fmt_stats(vals, unit="ms"):
    if not vals:
        return "无数据"
    return (f"P50={percentile(vals,50):.1f}{unit} P90={percentile(vals,90):.1f}{unit} "
            f"P99={percentile(vals,99):.1f}{unit} Max={max(vals):.1f}{unit} "
            f"Avg={statistics.mean(vals):.1f}{unit}")


def header(t):
    print(f"\n{'='*66}\n  {t}\n{'='*66}")


# ==================== WS 客户端 ====================
class Phone:
    def __init__(self, session, idx):
        self.s = session
        self.idx = idx
        self.pin = tpin(idx)
        self.name = devname(idx)
        self.ws = None
        self.ok = False
        self.conn_ms = 0.0
        self.last_reason = ""

    async def connect(self, timeout=20):
        t0 = time.monotonic()
        try:
            self.ws = await self.s.ws_connect(
                WS_URL, timeout=aiohttp.ClientTimeout(total=timeout),
                heartbeat=None, max_msg_size=0,
            )
            await self.ws.send_json({
                "type": "phone_hello", "pin": self.pin,
                "deviceName": self.name, "deviceId": self.name,
            })
            rt, reason = await self._await_auth(timeout=15)
            self.conn_ms = (time.monotonic() - t0) * 1000
            if rt == "auth_ok":
                self.ok = True
                return True
            self.last_reason = f"{rt}:{reason}"
            return False
        except asyncio.TimeoutError:
            self.conn_ms = (time.monotonic() - t0) * 1000
            self.last_reason = "connect_timeout"
            return False
        except Exception as e:
            self.conn_ms = (time.monotonic() - t0) * 1000
            self.last_reason = f"{type(e).__name__}:{e}"
            return False

    async def _await_auth(self, timeout=15):
        """握手可能直接 auth_ok，也可能先 auth_pending（需扩展授权）"""
        try:
            while True:
                msg = await asyncio.wait_for(self.ws.receive_json(), timeout=timeout)
                t = msg.get("type", "")
                if t == "auth_ok":
                    return "auth_ok", ""
                if t in ("auth_fail",):
                    return "auth_fail", msg.get("reason", "")
                if t == "auth_pending":
                    # 合成设备通常不应触发；若触发则等待最终结果
                    return "auth_pending", msg.get("reason", "需扩展授权")
                # ping 等其他消息忽略
        except asyncio.TimeoutError:
            return "timeout", ""

    async def ping(self, timeout=15):
        if not self.ok or not self.ws or self.ws.closed:
            return -1.0
        t0 = time.monotonic()
        try:
            await self.ws.send_json({"type": "ping"})
            while True:
                msg = await asyncio.wait_for(self.ws.receive_json(), timeout=timeout)
                if msg.get("type") in ("pong", "ping"):
                    return (time.monotonic() - t0) * 1000
        except Exception:
            return -1.0

    async def close(self):
        if self.ws and not self.ws.closed:
            try:
                await self.ws.close()
            except Exception:
                pass


# ==================== REST ====================
async def rest(session, path, params=None, headers=None, timeout=20):
    t0 = time.monotonic()
    try:
        async with session.get(f"{BASE}{path}", params=params, headers=headers,
                               timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
            raw = await resp.text()
            try:
                body = json.loads(raw)
            except Exception:
                body = {"_raw": raw[:200]}
            return (time.monotonic() - t0) * 1000, resp.status, body
    except asyncio.TimeoutError:
        return timeout * 1000, 0, {"error": "timeout"}
    except Exception as e:
        return (time.monotonic() - t0) * 1000, 0, {"error": f"{type(e).__name__}"}


def classify(status, body):
    """归一化一次 REST 调用的结果"""
    if status == 429:
        return "RATE_LIMITED"
    if status == 0:
        return "NETWORK_ERR"
    if status != 200:
        return f"HTTP_{status}"
    if isinstance(body, dict):
        if body.get("ok") is True:
            return "OK"
        return body.get("code", "UNKNOWN")
    return "OK"


# ==================== 阶段实现 ====================
async def preflight():
    header("Phase 0 · 预检与基线延迟")
    async with aiohttp.ClientSession() as s:
        try:
            async with s.get(f"{BASE}/health", timeout=aiohttp.ClientTimeout(total=8)) as r:
                h = await r.json()
                print(f"  服务: {h.get('service')}  version={h.get('version')}  "
                      f"uptime={h.get('uptime_seconds')}s")
                print(f"  当前在线连接={h.get('total_connections')}  活跃分组={h.get('total_groups')}")
        except Exception as e:
            print(f"  ❌ 服务不可达: {e}")
            return
        lats = []
        for _ in range(20):
            t0 = time.monotonic()
            try:
                async with s.get(f"{BASE}/health", timeout=aiohttp.ClientTimeout(total=8)) as r:
                    await r.read()
                lats.append((time.monotonic() - t0) * 1000)
            except Exception:
                pass
            await asyncio.sleep(0.05)
        print(f"  /health RTT x{len(lats)}: {fmt_stats(lats)}")


async def ws_ramp(levels):
    header(f"Phase 1 · WebSocket 连接承载力阶梯 {levels}")
    connector = aiohttp.TCPConnector(limit=0, force_close=False)
    async with aiohttp.ClientSession(connector=connector) as s:
        phones = []
        for lvl in levels:
            # 本轮只新建尚未创建的连接
            newbies = []
            while len(phones) < lvl:
                p = Phone(s, len(phones) + 1)
                phones.append(p)
                newbies.append(p)
            t0 = time.monotonic()
            results = await asyncio.gather(*[p.connect() for p in newbies], return_exceptions=True)
            el = time.monotonic() - t0
            oks = sum(1 for p in newbies if p.ok)
            conn_ms = [p.conn_ms for p in newbies if p.ok]
            total_ok = sum(1 for p in phones if p.ok)
            print(f"  并发 {lvl:>4} 连接: 本轮 {oks}/{len(newbies)} 成功  "
                  f"累计在线 {total_ok}/{lvl}  ({el:.2f}s)")
            if conn_ms:
                print(f"            建连耗时 {fmt_stats(conn_ms)}")
            fails = Counter(p.last_reason for p in newbies if not p.ok)
            if fails:
                print(f"            失败原因: {dict(fails)}")
            await asyncio.sleep(1.0)

        # 保持在线，测心跳
        online = [p for p in phones if p.ok]
        print(f"\n  保持 {len(online)} 条连接在线 3s，测心跳 RTT ...")
        await asyncio.sleep(2)
        rtts = await asyncio.gather(*[p.ping() for p in online], return_exceptions=True)
        valid = [r for r in rtts if isinstance(r, (int, float)) and r > 0]
        print(f"  心跳 RTT: {len(valid)}/{len(online)} 响应正常")
        if valid:
            print(f"            {fmt_stats(valid)}")

        print("\n  关闭全部连接 ...")
        await asyncio.gather(*[p.close() for p in phones], return_exceptions=True)
        await asyncio.sleep(1)
        print("  完成")


async def rest_burst(count, label="REST 突发"):
    """核心：单个出口 IP 快速发 count 个 REST，观察限流拐点"""
    header(f"Phase 2 · {label}（{count} 个请求，单一出口 IP）")
    print(f"  说明：服务端限流 = 60 次/分钟/IP。本机所有请求共享同一出口 IP，")
    print(f"       与「20 台手机在同一 WiFi 后面」完全等价。\n")
    connector = aiohttp.TCPConnector(limit=0)
    async with aiohttp.ClientSession(connector=connector) as s:
        tasks = []
        for i in range(1, count + 1):
            p = tpin(i)
            # 三类真实业务请求交替打
            m = i % 3
            if m == 0:
                tasks.append(rest(s, "/api/v1/dial",
                                  params={"number": "13800000000"},
                                  headers={"x-autodial-pin": p}))
            elif m == 1:
                tasks.append(rest(s, "/api/v1/visits", params={"pin": p, "page_size": "10"}))
            else:
                tasks.append(rest(s, "/api/v1/calls/batch",
                                  params={"device_id": devname(i), "pin": p,
                                          "data": json.dumps([{
                                              "number": "13800000000", "name": "压测勿用",
                                              "duration": 1, "type": 1,
                                              "time": datetime.now().strftime("%Y-%m-%dT%H:%M:%S")}])}))
        t0 = time.monotonic()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        el = time.monotonic() - t0

        codes = Counter()
        lats = []
        first_429_at = None
        for idx, r in enumerate(results, start=1):
            if not isinstance(r, tuple):
                codes["EXC"] += 1
                continue
            ms, status, body = r
            lats.append(ms)
            c = classify(status, body)
            codes[c] += 1
            if c == "RATE_LIMITED" and first_429_at is None:
                first_429_at = idx

        total = len(results)
        print(f"  总耗时 {el:.2f}s   吞吐 {total/el:.1f} req/s")
        print(f"  延迟: {fmt_stats(lats)}")
        print(f"\n  结果分布:")
        for c, n in codes.most_common():
            mark = "  ← 被限流拒绝" if c == "RATE_LIMITED" else ""
            print(f"    {c:<16} {n:>4}{mark}")
        ok = codes.get("OK", 0)
        rl = codes.get("RATE_LIMITED", 0)
        print(f"\n  成功率 {ok}/{total} = {ok/total*100:.1f}%")
        if rl:
            print(f"  ⚠️  限流拐点：约第 {first_429_at} 个请求开始返回 429，共 {rl} 个被拒")
        else:
            print(f"  ✅ 未触发限流")
        return codes


async def morning_storm(n=20):
    """模拟 20 人早上同时开机：握手 + 每人 3 个上报，全部并发"""
    header(f"Phase 3 · 「{n} 人早上同时开机」风暴模拟")
    print("  场景：全员 9:00 到岗，手机同时联网重连 + 上报离线堆积通话记录\n")
    connector = aiohttp.TCPConnector(limit=0)
    async with aiohttp.ClientSession(connector=connector) as s:
        # 1) 同时握手
        phones = [Phone(s, i) for i in range(1, n + 1)]
        t0 = time.monotonic()
        await asyncio.gather(*[p.connect() for p in phones], return_exceptions=True)
        ws_el = time.monotonic() - t0
        ws_ok = sum(1 for p in phones if p.ok)
        print(f"  ① WS 握手: {ws_ok}/{n} 成功，耗时 {ws_el:.2f}s")
        fails = Counter(p.last_reason for p in phones if not p.ok)
        if fails:
            print(f"     失败: {dict(fails)}")

        # 2) 每人同时打 3 个 REST（对应 Android 端 5 分钟一轮的上报）
        await asyncio.sleep(0.3)
        tasks = []
        for i in range(1, n + 1):
            p = tpin(i)
            tasks.append(rest(s, "/api/v1/calls/batch",
                              params={"device_id": devname(i), "pin": p,
                                      "data": json.dumps([{"number": "13800000000", "name": "压测勿用",
                                                           "duration": 1, "type": 1,
                                                           "time": datetime.now().strftime("%Y-%m-%dT%H:%M:%S")}])}))
            tasks.append(rest(s, "/api/v1/stats/report",
                              params={"device_id": devname(i), "pin": p, "model": "LoadTest",
                                      "version": "test", "count": "1", "duration": "5", "connected": "1"}))
            tasks.append(rest(s, "/api/v1/events/log",
                              params={"device_id": devname(i), "event_type": "loadtest",
                                      "pin": p, "detail": "stress"}))
        t0 = time.monotonic()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        el = time.monotonic() - t0
        codes = Counter()
        first_429 = None
        for idx, r in enumerate(results, start=1):
            if not isinstance(r, tuple):
                codes["EXC"] += 1
                continue
            ms, status, body = r
            c = classify(status, body)
            codes[c] += 1
            if c == "RATE_LIMITED" and first_429 is None:
                first_429 = idx
        n_req = len(results)
        print(f"  ② REST 上报: {n_req} 个请求，耗时 {el:.2f}s，吞吐 {n_req/el:.1f} req/s")
        for c, cnt in codes.most_common():
            print(f"       {c:<16} {cnt}")
        if codes.get("RATE_LIMITED"):
            print(f"  ⚠️  第 {first_429} 个请求起被限流，{codes['RATE_LIMITED']}/{n_req} 失败")
            print(f"      → 员工表现：部分手机「拨不出去 / 登记失败」，且当天后续 1 分钟持续失败")
        else:
            print(f"  ✅ 未触发限流")

        await asyncio.gather(*[p.close() for p in phones], return_exceptions=True)


async def block_test(n_ws=20, n_rest=50):
    """检测：REST 的同步 SQLite 操作是否阻塞事件循环（观测 WS 心跳 RTT 抖动）"""
    header(f"Phase 4 · 事件循环阻塞检测（{n_ws} WS + {n_rest} 并发 REST）")
    print("  原理：REST 处理器内的同步 SQLite 若跑在事件循环上，")
    print("       则它执行期间所有 WS 心跳都会被卡住 → 心跳 RTT 出现尖峰。\n")
    connector = aiohttp.TCPConnector(limit=0)
    async with aiohttp.ClientSession(connector=connector) as s:
        phones = [Phone(s, i) for i in range(1, n_ws + 1)]
        await asyncio.gather(*[p.connect() for p in phones], return_exceptions=True)
        online = [p for p in phones if p.ok]
        print(f"  在线连接: {len(online)}")

        async def probe(recorder, stop):
            """持续探测心跳，记录带时间戳的 RTT"""
            while not stop.is_set():
                for p in online:
                    r = await p.ping(timeout=10)
                    if r > 0:
                        recorder.append((time.monotonic(), r))
                await asyncio.sleep(0.05)

        stop = asyncio.Event()
        idle_rec, load_rec = [], []

        # 基线：空闲 4s
        t = asyncio.create_task(probe(idle_rec, stop))
        await asyncio.sleep(4)
        stop.set()
        await t
        print(f"  ① 空闲基线心跳 RTT: {fmt_stats([r for _, r in idle_rec])}  (n={len(idle_rec)})")

        # 加载：并发 REST
        stop2 = asyncio.Event()
        t2 = asyncio.create_task(probe(load_rec, stop2))
        tasks = [rest(s, "/api/v1/visits", params={"pin": tpin(i % n_ws + 1), "page_size": "200"})
                 for i in range(n_rest)]
        t0 = time.monotonic()
        await asyncio.gather(*tasks, return_exceptions=True)
        el = time.monotonic() - t0
        stop2.set()
        await t2
        lat = [r for _, r in load_rec]
        print(f"  ② 加载中心跳 RTT: {fmt_stats(lat)}  (n={len(lat)}, 并发 REST {n_rest} 个耗时 {el:.2f}s)")

        idle_p50 = percentile([r for _, r in idle_rec], 50) if idle_rec else 0
        load_p99 = percentile(lat, 99) if lat else 0
        load_max = max(lat) if lat else 0
        print(f"\n  对比: 空闲 P50={idle_p50:.1f}ms  →  加载 P99={load_p99:.1f}ms  Max={load_max:.1f}ms")
        if load_max > idle_p50 * 3 and load_max > 200:
            print(f"  ⚠️  检测到明显抖动尖峰（Max 为空闲基线的 {load_max/max(idle_p50,0.1):.1f} 倍）")
            print(f"      → 证据支持「同步 DB / 事件循环阻塞」假设")
        else:
            print(f"  ✅ 未见明显阻塞（尖峰在合理范围）")

        await asyncio.gather(*[p.close() for p in phones], return_exceptions=True)


async def cleanup_all():
    """确认没有残留连接：再打一次 health 看在线数"""
    header("Phase 5 · 收尾检查")
    async with aiohttp.ClientSession() as s:
        async with s.get(f"{BASE}/health", timeout=aiohttp.ClientTimeout(total=8)) as r:
            h = await r.json()
            print(f"  当前云端在线连接={h.get('total_connections')}  活跃分组={h.get('total_groups')}")
            print(f"  uptime={h.get('uptime_seconds')}s")


# ==================== 入口 ====================
def parse_levels(s):
    return [int(x) for x in s.split(",") if x.strip()]


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["preflight", "ws-ramp", "rest-burst",
                                      "morning", "block", "cleanup", "all"])
    ap.add_argument("--levels", default="20,50,100")
    ap.add_argument("--count", type=int, default=120)
    ap.add_argument("--users", type=int, default=20)
    args = ap.parse_args()

    print(f"AutoDial 线上压测 | 目标 {HOST}:{PORT} | {datetime.now():%Y-%m-%d %H:%M:%S}")
    print(f"出口 IP 由服务端观测（本机所有请求共享同一 NAT 出口）")

    if args.stage == "preflight":
        await preflight()
    elif args.stage == "ws-ramp":
        await ws_ramp(parse_levels(args.levels))
    elif args.stage == "rest-burst":
        await rest_burst(args.count)
    elif args.stage == "morning":
        await morning_storm(args.users)
    elif args.stage == "block":
        await block_test(n_ws=args.users, n_rest=args.count)
    elif args.stage == "cleanup":
        await cleanup_all()
    elif args.stage == "all":
        await preflight()
        await ws_ramp(parse_levels(args.levels))
        await rest_burst(args.count)
        await morning_storm(args.users)
        await cleanup_all()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n中断")
