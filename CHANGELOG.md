# AutoDial 更新日志

> 仓库：github.com/ztj555/autodial

---

## 2026-07-18 云服务器管理 + 文档整理

### 云服务器管理弹窗重构
- 服务器卡片三行结构：别名+URL → 状态+别名按钮 → 操作按钮
- ServerEntry 新增 alias 字段，持久化存储，网络获取支持行末别名
- 当前服务器自动显示连接状态（🟢已连接 / 🟡未连接），边框+背景色变化
- 默认服务器首次启动自动设为「当前」
- 四端统一兼容别名格式（Android/Go/Electron/Extension）
- 默认云服务器改为 101.34.65.254:35430

### 文档清理
- 删除过时的 optimization/、docs/、CRM分析、优化建议
- 更新 CHANGELOG、README

---

## 2026-07-16 设置页重构 + 状态大盘优化

### 设置页大改
- 卡片拆分：主题/通知拆为独立卡片（外观 → 主题与外观、通知与提示）
- 所有行统一 settingRow 模板（连续卡片+分隔线，与APP拨号设置一致）
- 折叠卡片标题后加醒目实心箭头 ▶/▼（16sp bold），5 个卡片全部统一
- 头部副标题全部动态化：跨屏连接设置跟随策略，APP拨号设置跟随模式+动画
- 状态大盘 + marginBottom=50dp 与跨屏连接间距拉开
- ScrollView 去掉滚动条

### 状态大盘优化
- 「云端已连接，等待拨号」圆点+文字均改为绿色
- 圆点前加连接策略标签：自动隐藏，仅LAN/仅云端显示醒目标签
- 合并「连接已断开」→「未连接电脑」，状态从 11 种减到 10 种
- 连接超时文案缩短，连接失败时显示原因提示

### 构建 & 签名
- 更换签名密钥：RSA2048 证书（O=AutoDial），防止华为误报诈骗
- 新仓库 github.com/ztj555/autodial（原 bug 仓库封存）
- CI 同时构建 Release + Debug 两个 APK
- 修复密钥相对路径问题

### 其他
- 顶部断开按钮：「断开」→「断开连接」+ 左移 20dp
- 局域网/云中转图标缩至 16dp 与头部一致

---

## 2026-07-12 云端部署 + 稳定修复 + 运维体系建立

### 云中继稳定性修复
- 16 SQLite handlers: conn.close() moved to finally block
- Headless server: run_tray() wrapped in try/except

### 腾讯云部署 (101.34.65.254)
- Ubuntu 22.04.4, 1Panel v2.0.15, Docker + Supervisor
- Quick commands at /opt/autodial/scripts/

### 默认服务器地址
- 所有端默认改为 101.34.65.254:35430
