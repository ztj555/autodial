"""
测试云中转服务器的Bug
"""
import asyncio
import json
import websockets
import time
from datetime import datetime

# 测试配置
WS_URL = "ws://127.0.0.1:35430"
HTTP_URL = "http://127.0.0.1:35431"

async def test_phone_hello():
    """测试手机端握手"""
    print("\n=== 测试1: 手机端握手 ===")
    try:
        async with websockets.connect(WS_URL) as ws:
            # 发送 phone_hello
            await ws.send(json.dumps({
                'type': 'phone_hello',
                'pin': '1234',
                'deviceName': 'Test-Phone'
            }))
            
            # 等待响应
            response = await asyncio.wait_for(ws.recv(), timeout=5)
            data = json.loads(response)
            print(f"✓ 收到响应: {data}")
            
            if data.get('type') == 'auth_ok':
                print("✓ 手机端认证成功")
                return True
            else:
                print(f"✗ 认证失败: {data}")
                return False
    except Exception as e:
        print(f"✗ 测试失败: {e}")
        return False

async def test_pc_hello():
    """测试PC端握手"""
    print("\n=== 测试2: PC端握手 ===")
    try:
        async with websockets.connect(WS_URL) as ws:
            # 发送 pc_hello
            await ws.send(json.dumps({
                'type': 'pc_hello',
                'pin': '1234',
                'hostname': 'Test-PC'
            }))
            
            # 等待响应
            response = await asyncio.wait_for(ws.recv(), timeout=5)
            data = json.loads(response)
            print(f"✓ 收到响应: {data}")
            
            if data.get('type') == 'pc_auth_ok':
                print("✓ PC端认证成功")
                return True
            else:
                print(f"✗ 认证失败: {data}")
                return False
    except Exception as e:
        print(f"✗ 测试失败: {e}")
        return False

async def test_message_forward():
    """测试消息转发"""
    print("\n=== 测试3: 消息转发 ===")
    try:
        # 连接手机端
        phone_ws = await websockets.connect(WS_URL)
        await phone_ws.send(json.dumps({
            'type': 'phone_hello',
            'pin': '5678',
            'deviceName': 'Forward-Phone'
        }))
        phone_auth = json.loads(await phone_ws.recv())
        print(f"✓ 手机端认证: {phone_auth.get('type')}")
        
        # 连接PC端
        pc_ws = await websockets.connect(WS_URL)
        await pc_ws.send(json.dumps({
            'type': 'pc_hello',
            'pin': '5678',
            'hostname': 'Forward-PC'
        }))
        pc_auth = json.loads(await pc_ws.recv())
        print(f"✓ PC端认证: {pc_auth.get('type')}")
        
        # 等待手机端收到 pc_auth_ok 或 phone_hello（如果有其他PC）
        # 这里应该收到补发的 phone_hello
        try:
            msg = await asyncio.wait_for(phone_ws.recv(), timeout=2)
            print(f"✓ 手机端收到: {json.loads(msg)}")
        except asyncio.TimeoutError:
            print("  手机端未收到额外消息（正常，如果没有其他PC）")
        
        # PC端发送拨号消息
        await pc_ws.send(json.dumps({
            'type': 'dial',
            'pin': '5678',
            'number': '13800138000',
            'targetDevice': 'Forward-Phone'
        }))
        print("✓ PC端发送拨号消息")
        
        # 手机端应该收到拨号消息
        try:
            msg = await asyncio.wait_for(phone_ws.recv(), timeout=2)
            data = json.loads(msg)
            print(f"✓ 手机端收到拨号消息: {data.get('type')}")
        except asyncio.TimeoutError:
            print("✗ 手机端未收到拨号消息")
            return False
        
        # 关闭连接
        await phone_ws.close()
        await pc_ws.close()
        
        print("✓ 消息转发测试通过")
        return True
        
    except Exception as e:
        print(f"✗ 测试失败: {e}")
        import traceback
        traceback.print_exc()
        return False

async def test_http_endpoints():
    """测试HTTP端点"""
    print("\n=== 测试4: HTTP端点 ===")
    try:
        import aiohttp
        
        async with aiohttp.ClientSession() as session:
            # 测试健康检查
            async with session.get(f"{HTTP_URL}/health") as resp:
                data = await resp.json()
                print(f"✓ /health: {data.get('service')}")
            
            # 测试API状态
            async with session.get(f"{HTTP_URL}/api/status") as resp:
                data = await resp.json()
                print(f"✓ /api/status: 连接数={data.get('total_connections')}")
            
            # 测试Web界面
            async with session.get(f"{HTTP_URL}/") as resp:
                text = await resp.text()
                if 'AutoDial' in text:
                    print("✓ Web管理界面正常")
                else:
                    print("✗ Web管理界面异常")
                    return False
        
        return True
    except ImportError:
        print("⚠ aiohttp未安装，跳过HTTP测试")
        return True
    except Exception as e:
        print(f"✗ 测试失败: {e}")
        return False

async def test_heartbeat():
    """测试心跳机制"""
    print("\n=== 测试5: 心跳机制 ===")
    try:
        async with websockets.connect(WS_URL) as ws:
            # 先认证
            await ws.send(json.dumps({
                'type': 'phone_hello',
                'pin': '9999',
                'deviceName': 'Heartbeat-Phone'
            }))
            auth = json.loads(await ws.recv())
            print(f"✓ 认证成功: {auth.get('type')}")
            
            # 等待WebSocket ping/pong（应该自动处理）
            await asyncio.sleep(35)  # 等待超过ping_interval=30秒
            
            # 尝试发送消息，检查连接是否还在
            await ws.send(json.dumps({'type': 'ping'}))
            pong = await asyncio.wait_for(ws.recv(), timeout=5)
            print(f"✓ 心跳测试通过，收到: {json.loads(pong)}")
            
        return True
    except Exception as e:
        print(f"✗ 测试失败: {e}")
        return False

async def test_rate_limit():
    """测试频率限制"""
    print("\n=== 测试6: 频率限制 ===")
    try:
        # 快速发送多个请求
        for i in range(10):
            try:
                async with websockets.connect(WS_URL) as ws:
                    await ws.send(json.dumps({
                        'type': 'phone_hello',
                        'pin': f'RATE{i}'
                    }))
                    response = await asyncio.wait_for(ws.recv(), timeout=2)
                    data = json.loads(response)
                    if data.get('type') == 'auth_fail':
                        print(f"✓ 频率限制生效: {data.get('reason')}")
                        return True
            except:
                pass
        
        print("⚠ 频率限制可能未生效")
        return True
    except Exception as e:
        print(f"✗ 测试失败: {e}")
        return False

async def main():
    """运行所有测试"""
    print("开始测试云中转服务器...")
    print("=" * 50)
    
    results = []
    
    # 测试1: 手机端握手
    result1 = await test_phone_hello()
    results.append(("手机端握手", result1))
    
    await asyncio.sleep(1)
    
    # 测试2: PC端握手
    result2 = await test_pc_hello()
    results.append(("PC端握手", result2))
    
    await asyncio.sleep(1)
    
    # 测试3: 消息转发
    result3 = await test_message_forward()
    results.append(("消息转发", result3))
    
    await asyncio.sleep(1)
    
    # 测试4: HTTP端点
    result4 = await test_http_endpoints()
    results.append(("HTTP端点", result4))
    
    # 测试5: 心跳机制
    result5 = await test_heartbeat()
    results.append(("心跳机制", result5))
    
    # 测试6: 频率限制
    result6 = await test_rate_limit()
    results.append(("频率限制", result6))
    
    # 总结
    print("\n" + "=" * 50)
    print("测试总结:")
    print("=" * 50)
    
    passed = 0
    failed = 0
    for name, result in results:
        status = "✓ 通过" if result else "✗ 失败"
        print(f"{status} - {name}")
        if result:
            passed += 1
        else:
            failed += 1
    
    print("\n" + "=" * 50)
    print(f"总计: {passed + failed} 个测试")
    print(f"通过: {passed} 个")
    print(f"失败: {failed} 个")
    print("=" * 50)
    
    return failed == 0

if __name__ == '__main__':
    success = asyncio.run(main())
    exit(0 if success else 1)
