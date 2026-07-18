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
RUN pip install --no-cache-dir websockets>=12.0 aiohttp>=3.11

# 复制应用文件
COPY python/cloud_relay.py .
COPY python/dashboard.html .
RUN mkdir -p /app/data

# 创建 headless 启动脚本（无托盘图标，纯后台运行）
RUN echo '#!/usr/bin/env python3' > /app/entrypoint.py && \
    echo '"""Docker entrypoint - runs cloud relay server without tray icon"""' >> /app/entrypoint.py && \
    echo 'import asyncio, sys, os' >> /app/entrypoint.py && \
    echo 'sys.path.insert(0, "/app")' >> /app/entrypoint.py && \
    echo 'os.environ["APPDATA"] = "/app/data"' >> /app/entrypoint.py && \
    echo '' >> /app/entrypoint.py && \
    echo 'from cloud_relay import run_server, log_info, log_error' >> /app/entrypoint.py && \
    echo '' >> /app/entrypoint.py && \
    echo 'async def main():' >> /app/entrypoint.py && \
    echo '    try:' >> /app/entrypoint.py && \
    echo '        await run_server()' >> /app/entrypoint.py && \
    echo '    except KeyboardInterrupt:' >> /app/entrypoint.py && \
    echo '        log_info("SERVER", None, "Received SIGTERM, shutting down...")' >> /app/entrypoint.py && \
    echo '    except Exception as e:' >> /app/entrypoint.py && \
    echo '        log_error("SERVER", None, f"Fatal: {e}")' >> /app/entrypoint.py && \
    echo '        sys.exit(1)' >> /app/entrypoint.py && \
    echo '' >> /app/entrypoint.py && \
    echo 'if __name__ == "__main__":' >> /app/entrypoint.py && \
    echo '    asyncio.run(main())' >> /app/entrypoint.py

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:35430/health || exit 1

EXPOSE 35430

VOLUME ["/app/data"]

CMD ["python", "/app/entrypoint.py"]
