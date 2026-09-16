#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AutoDial 云中继 —— 本地开发运行器（改完保存即自动重启）

用法（一般通过同目录的 dev.bat 调起）：
    dev.bat                  起服务 + 监视改动自动重启（端口 35430）
    dev.bat --port 35440     换端口
    dev.bat --no-watch       只跑，不监视（改完自己 Ctrl+C 重起）
    dev.bat --no-open        不自动打开浏览器
    dev.bat --db D:\\x.db     用指定的数据库文件

为什么需要这么个脚本（三个坑，都是实测踩过的）：
  1) cloud_relay_v2.py 在**启动时**把 dashboard.html 一次性读进内存
     （HTML_CONTENT = load_dashboard_html()，见第 1358 行），
     所以改面板/改样式**必须重启进程**才看得到，光刷新浏览器没用；
  2) main() 一旦发现端口被占用，会弹一个 Windows 对话框并**阻塞在那里**，
     自动化脚本必须先替它检查端口，否则整个流程会静默卡死；
  3) 默认数据库落在源码目录、日志落在 %APPDATA%，容易和线上数据混淆，
     这里统一改到 .devdata/ 隔离，删掉该目录即彻底重置。

零侵入：本脚本不修改任何业务代码，只是「盯着文件 + 重启进程」。
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

# ==================== 路径 ====================
HERE = Path(__file__).resolve().parent
PY_DIR = HERE / "python"
ENTRY = PY_DIR / "cloud_relay_v2.py"
DASHBOARD = PY_DIR / "dashboard.html"
DEV_DATA = HERE / ".devdata"

POLL_SEC = 0.4        # 文件轮询间隔
DEBOUNCE_SEC = 0.35   # 保存后的静默期：编辑器常分多次写盘，避免连着重启好几次

IS_WIN = sys.platform == "win32"
# 让子进程自成一个进程组：Ctrl+C 只作用于本脚本，子进程由我们显式收掉
CREATE_NEW_PROCESS_GROUP = 0x00000200


# ==================== 终端输出 ====================
def _enable_ansi() -> None:
    """Win10+ 的控制台默认不开 ANSI 转义，手动打开。"""
    if not IS_WIN:
        return
    try:
        import ctypes

        k = ctypes.windll.kernel32
        handle = k.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_uint32()
        if k.GetConsoleMode(handle, ctypes.byref(mode)):
            k.SetConsoleMode(handle, mode.value | 0x0004)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
    except Exception:
        pass


_enable_ansi()

_DIM, _RST = "\033[2m", "\033[0m"
_CY, _GR, _YL, _RD = "\033[36m", "\033[32m", "\033[33m", "\033[31m"


def say(msg: str, color: str = _CY) -> None:
    print(f"{color}[dev]{_RST} {msg}", flush=True)


# ==================== 端口 ====================
def port_busy(port: int) -> bool:
    """探测端口是否被占用。

    ⚠️ 必须按服务实际绑定的地址（0.0.0.0）来探测，不能探 127.0.0.1：
    Windows 下若已有 socket 绑在 0.0.0.0:35430，另一个 socket 仍能成功绑到
    127.0.0.1:35430（两个地址被视为不冲突），于是会出现
    「预检通过 → 子进程一启动就崩」，正好是这个脚本要避免的卡死。
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        excl = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)  # 仅 Windows 有
        if excl is not None:
            s.setsockopt(socket.SOL_SOCKET, excl, 1)
        s.bind(("0.0.0.0", port))
        return False
    except OSError:
        return True
    finally:
        s.close()


def probe_health(port: int):
    """认一下占用端口的到底是不是 AutoDial —— 提示能精确很多。"""
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return None


# ==================== 文件监视 ====================
def collect_targets() -> list[Path]:
    """监视目标：面板 HTML + python/ 下所有 .py。"""
    targets = [DASHBOARD]
    targets += sorted(PY_DIR.glob("*.py"))
    return [p for p in targets if p.exists()]


def snapshot(targets: list[Path]) -> dict:
    out = {}
    for p in targets:
        try:
            st = p.stat()
            out[p] = (st.st_mtime_ns, st.st_size)
        except OSError:
            out[p] = None
    return out


def syntax_check(paths: list[Path]) -> list[str]:
    """纯内存语法预检：不写任何 .pyc，源码目录保持干净。

    放在重启之前做，好处是语法写错时旧服务还在跑，
    不会出现「一保存服务就没了、浏览器一片空白」的困惑。
    """
    errs = []
    for p in paths:
        try:
            compile(p.read_text(encoding="utf-8"), str(p), "exec")
        except SyntaxError as e:
            errs.append(f"{p.name}:{e.lineno}: {e.msg}")
        except Exception as e:  # 编码错误等
            errs.append(f"{p.name}: {e}")
    return errs


# ==================== 子进程 ====================
def spawn(py_exe: str, port: int, db_path: Path) -> subprocess.Popen:
    env = os.environ.copy()
    env["AUTODIAL_HEADLESS"] = "1"                       # 不起系统托盘，Ctrl+C 就能停
    env["AUTODIAL_DATA_DIR"] = str(DEV_DATA)             # 日志/统计落到 .devdata/
    env["AUTODIAL_DB_PATH"] = str(db_path)               # 数据库也隔离，不污染源码目录
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONUTF8"] = "1"
    # 关键：不设这两个变量的话，首次启动会随机生成管理员密码且只打在日志里
    env.setdefault("AUTODIAL_ADMIN_USER", "admin")
    env.setdefault("AUTODIAL_ADMIN_PASS", "admin")

    flags = CREATE_NEW_PROCESS_GROUP if IS_WIN else 0
    return subprocess.Popen(
        [py_exe, "-B", str(ENTRY), "--port", str(port)],
        cwd=str(PY_DIR),
        env=env,
        creationflags=flags,
    )


def stop(proc: subprocess.Popen | None, timeout: float = 4.0) -> None:
    """先礼后兵：CTRL_BREAK → 等 → terminate → 等 → kill。"""
    if proc is None or proc.poll() is not None:
        return
    try:
        if IS_WIN:
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            proc.terminate()
    except Exception:
        try:
            proc.terminate()
        except Exception:
            pass
    try:
        proc.wait(timeout=timeout)
        return
    except subprocess.TimeoutExpired:
        pass
    say("子进程没响应，强制结束", _YL)
    try:
        proc.kill()
        proc.wait(timeout=3)
    except Exception:
        pass


# ==================== 主流程 ====================
def main() -> int:
    ap = argparse.ArgumentParser(
        prog="dev.bat",
        description="AutoDial 云中继本地开发运行器（改完保存自动重启）",
    )
    ap.add_argument("--port", "-p", type=int, default=35430, help="监听端口（默认 35430）")
    ap.add_argument("--db", default=None, help="数据库文件路径（默认 .devdata/visits.db）")
    ap.add_argument("--no-watch", action="store_true", help="只运行，不监视文件改动")
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    opts = ap.parse_args()

    py_exe = sys.executable
    db_path = Path(opts.db).resolve() if opts.db else (DEV_DATA / "visits.db")
    DEV_DATA.mkdir(parents=True, exist_ok=True)

    print()
    print(f"{_DIM}{'-' * 56}{_RST}")
    say(f"源码目录  {PY_DIR}")
    say(f"数据目录  {DEV_DATA}   {_DIM}(独立于线上，删掉即重置){_RST}")
    say(f"端口      {opts.port}     监视  {'开' if not opts.no_watch else '关'}")
    print(f"{_DIM}{'-' * 56}{_RST}")
    print()

    # 依赖自检（直接跑 python devwatch.py 时会走到这里）
    try:
        import websockets  # noqa: F401
    except ImportError:
        say("当前 Python 没装 websockets，无法启动中继。", _RD)
        say("请用 dev.bat 启动（它会自动准备环境），或执行：", _YL)
        print(f'      "{py_exe}" -m pip install "websockets>=12,<14"')
        return 1

    # 端口预检 —— 必须做，否则子进程会弹 Windows 对话框卡住
    if port_busy(opts.port):
        health = probe_health(opts.port)
        say(f"端口 {opts.port} 已被占用，无法启动。", _RD)
        if health:
            ver = health.get("version") or health.get("app_version") or "?"
            say(f"占用者看着是一个 AutoDial 中继（version={ver}）。", _YL)
        else:
            say("占用者是别的程序（不是 AutoDial 中继）。", _YL)
        say(f'查占用进程： netstat -ano | findstr :{opts.port}', _DIM)
        say("或换个端口： dev.bat --port 35440", _DIM)
        return 1

    url = f"http://127.0.0.1:{opts.port}"
    targets = collect_targets()
    watch = not opts.no_watch

    proc: subprocess.Popen | None = None
    last = snapshot(targets)
    pending = True
    opened = False
    restarts = 0

    def do_restart() -> None:
        nonlocal proc, opened, restarts
        # 只预检真正会被加载的入口文件：测试文件写错不该拦住服务重启
        errs = syntax_check([ENTRY])
        if errs:
            print()
            say("语法没通过，暂不重启（旧服务保持运行）", _RD)
            for e in errs:
                print(f"      {_RD}{e}{_RST}")
            say("修好后保存，会自动重试。", _DIM)
            return
        stop(proc)
        proc = spawn(py_exe, opts.port, db_path)
        restarts += 1
        print()
        say(f"启动完成（第 {restarts} 次）  {_GR}{url}{_RST}")
        print(f"{_DIM}{'-' * 56}{_RST}")
        if not opened and not opts.no_open:
            opened = True
            threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    rc = 0
    try:
        while True:
            if pending:
                pending = False
                do_restart()
                last = snapshot(targets)
                if not watch:
                    if proc is not None:
                        proc.wait()
                    break

            time.sleep(POLL_SEC)
            cur = snapshot(targets)
            if cur != last:
                while True:  # 防抖：等文件不再变化
                    time.sleep(DEBOUNCE_SEC)
                    nxt = snapshot(targets)
                    if nxt == cur:
                        break
                    cur = nxt
                changed = [p for p in cur if cur.get(p) != last.get(p)]
                if changed:
                    names = "、".join(sorted(p.name for p in changed))
                    print()
                    say(f"检测到改动：{names}  -> 重启", _YL)
                    last = cur
                    pending = True
                    continue

            if proc is not None and proc.poll() is not None:
                code = proc.returncode
                print()
                if code and port_busy(opts.port):
                    say(f"启动失败：端口 {opts.port} 已被别的进程占用（不是代码问题）。", _RD)
                    say("换个端口试试： dev.bat --port 35440", _YL)
                    say(f"看是谁占的： netstat -ano | findstr :{opts.port}", _DIM)
                    rc = 1
                    break
                if code:
                    say(f"服务退出了（exit={code}）。看上面的报错，改好保存会自动重启。", _RD)
                else:
                    say("服务已停止。改任意文件保存即自动重启。", _DIM)
                proc = None

    except KeyboardInterrupt:
        print()
        say("收到 Ctrl+C，正在停止 ...", _YL)
    finally:
        if proc is not None:
            stop(proc)
        say("已退出", _DIM)
    return rc


if __name__ == "__main__":
    sys.exit(main())
