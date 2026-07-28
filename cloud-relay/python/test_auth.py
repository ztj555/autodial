import asyncio, json, websockets, aiohttp, sys

async def test_all():
    tests = []

    # Admin presets default_pin for a device
    _admin_token = None
    async def preset(device_id, dpin):
        nonlocal _admin_token
        async with aiohttp.ClientSession() as s:
            if _admin_token is None:
                async with s.get('http://127.0.0.1:35430/api/v1/login?user=18335162275&pass=123456') as r:
                    d = await r.json()
                    _admin_token = d.get('token', '')
            url = f'http://127.0.0.1:35430/api/v1/device-set-default-pin?device_id={device_id}&default_pin={dpin}&token={_admin_token}'
            async with s.get(url) as r:
                d = await r.json()
                return d.get('ok')

    # === 场景1: 设备无 default_pin → 拒绝 ===
    print("=== 场景1: 设备未注册 → 拒绝 ===")
    try:
        async with websockets.connect('ws://127.0.0.1:35430') as ws:
            await ws.send(json.dumps({'type':'phone_hello','pin':'13800000001','deviceName':'Redmi-K40-001'}))
            r = json.loads(await asyncio.wait_for(ws.recv(), timeout=3))
            print(f'  响应: {r["type"]} reason: {r.get("reason","")}')
            assert r['type'] == 'auth_fail', f'FAIL: 期望 auth_fail, 实际 {r["type"]}'
            assert '未在云端注册' in r.get('reason',''), f'FAIL: 原因不对'
            print('  PASS')
            tests.append(('场景1: 无default_pin被拒', True))
    except Exception as e:
        print(f'  FAIL: {e}')
        tests.append(('场景1', False))

    # === 场景2: 管理员预设 default_pin 后，设备用正确 PIN → auth_ok ===
    print("=== 场景2: 预设默认PIN后正确登录 ===")
    try:
        ok = await preset('Redmi-K40-001', '13800000001')
        print(f'  预设结果: {ok}')
        async with websockets.connect('ws://127.0.0.1:35430') as ws:
            await ws.send(json.dumps({'type':'phone_hello','pin':'13800000001','deviceName':'Redmi-K40-001'}))
            r = json.loads(await asyncio.wait_for(ws.recv(), timeout=3))
            print(f'  响应: {r["type"]}')
            assert r['type'] == 'auth_ok', f'FAIL: 期望 auth_ok, 实际 {r["type"]}'
            print('  PASS')
            tests.append(('场景2: 预设后正确PIN通过', True))
    except Exception as e:
        print(f'  FAIL: {e}')
        tests.append(('场景2', False))

    # === 场景3: 设备用不同 PIN + 扩展不在线 → 拒绝 ===
    print("=== 场景3: 换PIN+扩展离线 → 拒绝 ===")
    try:
        async with websockets.connect('ws://127.0.0.1:35430') as ws:
            await ws.send(json.dumps({'type':'phone_hello','pin':'13900000002','deviceName':'Redmi-K40-001'}))
            r = json.loads(await asyncio.wait_for(ws.recv(), timeout=3))
            print(f'  响应: {r["type"]} reason: {r.get("reason","")}')
            assert r['type'] == 'auth_fail', f'FAIL: 期望 auth_fail'
            assert '插件未激活' in r.get('reason','') or 'CRM' in r.get('reason',''), f'FAIL: 原因不对: {r.get("reason","")}'
            print('  PASS')
            tests.append(('场景3: 换PIN扩展离线被拒', True))
    except Exception as e:
        print(f'  FAIL: {e}')
        tests.append(('场景3', False))

    # === 场景4: 扩展模拟在线 → 授权流程 ===
    print("=== 场景4: 扩展在线→授权流程 ===")
    try:
        # preset for another device
        await preset('Samsung-S20-002', '13900000003')

        async with aiohttp.ClientSession() as s:
            # 模拟扩展轮询：为 PIN 13800000004 注册活跃状态
            async with s.get('http://127.0.0.1:35430/api/v1/auth/pending?pin=13800000004') as resp:
                await resp.json()  # 这会触发 track_ext_activity
            print('  扩展已注册在线状态')

            # 设备尝试换 PIN
            phone = await websockets.connect('ws://127.0.0.1:35430')
            await phone.send(json.dumps({'type':'phone_hello','pin':'13800000004','deviceName':'Samsung-S20-002'}))
            r = json.loads(await asyncio.wait_for(phone.recv(), timeout=3))
            print(f'  手机收到: {r["type"]}')
            assert r['type'] == 'auth_pending', f'FAIL: 期望 auth_pending, 实际 {r["type"]}'
            rid = r['request_id']

            # 扩展查询 pending
            async with s.get('http://127.0.0.1:35430/api/v1/auth/pending?pin=13800000004') as resp:
                d = await resp.json()
                print(f'  Pending: {len(d.get("pending",[]))}条')
                assert len(d.get('pending',[])) > 0

            # 扩展响应授权
            async with s.get(f'http://127.0.0.1:35430/api/v1/auth/respond?request_id={rid}&allow=1') as resp:
                d = await resp.json()
                assert d.get('ok')

            r2 = json.loads(await asyncio.wait_for(phone.recv(), timeout=3))
            print(f'  手机最终: {r2["type"]}')
            assert r2['type'] == 'auth_ok'
            print('  PASS')
            tests.append(('场景4: 扩展在线授权流程', True))
            await phone.close()
    except Exception as e:
        print(f'  FAIL: {e}')
        import traceback; traceback.print_exc()
        tests.append(('场景4', False))

    print("\n=== 结果 ===")
    for name, ok in tests:
        print(f'  {"PASS" if ok else "FAIL"} - {name}')
    return all(ok for _, ok in tests)

if __name__ == '__main__':
    ok = asyncio.run(test_all())
    sys.exit(0 if ok else 1)
