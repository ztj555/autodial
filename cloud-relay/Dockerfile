# AutoDial Cloud Relay - Docker Image
# 云中继服务 Docker 容器化
FROM python:3.11-slim

LABEL maintainer="AutoDial Team"
LABEL description="AutoDial Cloud Relay Server - WebSocket Message Forwarding"

WORKDIR /app

# 安装系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 安装 Python 依赖 (仅生产必需，跳过 pystray/Pillow/PyInstaller/pytest)
# 注意：版本约束必须加引号。不加引号时 shell 会把 `websockets>=12.0` 里的 `>`
# 当成重定向（把 stdout 写进名为 `=12.0` 的文件），结果装的是无版本约束的包，
# 还会在工作目录留下垃圾文件。
RUN pip install --no-cache-dir "websockets>=12.0" "aiohttp>=3.11"

# 复制应用文件
COPY python/cloud_relay_v2.py .
COPY python/dashboard.html .
RUN mkdir -p /app/data

ENV PYTHONUNBUFFERED=1
ENV AUTODIAL_HEADLESS=1

# 创建 headless 启动脚本（无托盘图标，纯后台运行）
# 必须走 run_headless()：它显式登记全局 event loop 并接管 SIGTERM 优雅退出。
# 早期版本这里直接 asyncio.run(run_server())，全局 loop 恒为 None，
# 所有 _schedule_async（拨号 / 挂断 / 登记推送 / 踢人 / 授权回调）被静默丢弃。
RUN printf '%s\n' \
    '#!/usr/bin/env python3' \
    '"""Docker entrypoint - headless cloud relay (no tray icon)"""' \
    'import os, sys' \
    'sys.path.insert(0, "/app")' \
    'os.environ["APPDATA"] = "/app/data"' \
    'os.environ.setdefault("AUTODIAL_DB_PATH", "/app/data/visits.db")' \
    'from cloud_relay_v2 import run_headless' \
    'if __name__ == "__main__":' \
    '    run_headless()' \
    > /app/entrypoint.py && chmod +x /app/entrypoint.py

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:35430/health || exit 1

EXPOSE 35430

VOLUME ["/app/data"]

CMD ["python", "/app/entrypoint.py"]
