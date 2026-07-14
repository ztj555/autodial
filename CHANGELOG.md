# AutoDial v4.1.0 更新日志

> 最后修改：2026-07-12

---

## 2026-07-12 云端部署 + 稳定修复 + 运维体系建立

### 云中继稳定性修复 (cloud_relay_v2.py)
- 16 SQLite handlers: conn.close() moved to finally block (connection leak fix)
- Headless server: run_tray() wrapped in try/except (Ubuntu Server compatibility)
### 腾讯云部署 (101.34.65.254)
- Ubuntu 22.04.4, 1Panel v2.0.15, Docker + Supervisor dual-instance (35430/35440)
- Quick commands: 7 scripts at /opt/autodial/scripts/, CSV import template
### 默认服务器地址
- All clients: default cloud URL changed to 101.34.65.254:35430

---

# AutoDial v4.1.0 更新日志 (continued)

> 历史更新请查看 git log
