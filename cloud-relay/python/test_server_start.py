#!/usr/bin/env python3
# 测试云端服务器启动问题

import asyncio
import logging
import sys

# 配置日志
logging.basicConfig(
    level=logging.DEBUG,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger(__name__)

async def test_server():
    """测试服务器启动"""
    try:
        log.info('开始测试服务器启动...')
        
        # 测试1: 导入模块
        log.info('测试1: 导入websockets模块...')
        import websockets
        log.info(f'websockets版本: {websockets.__version__}')
        
        # 测试2: 创建简单的WebSocket服务器
        log.info('测试2: 创建简单的WebSocket服务器...')
        
        async def dummy_handler(ws, path):
            log.info(f'收到连接: {path}')
            await ws.send('Hello from test server!')
            await ws.close()
        
        async with websockets.serve(dummy_handler, '127.0.0.1', 35430):
            log.info('WebSocket服务器启动成功！')
            log.info('等待连接...')
            await asyncio.sleep(10)  # 等待10秒
        
        log.info('测试完成！')
        
    except Exception as e:
        log.error(f'测试失败: {e}')
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    asyncio.run(test_server())
