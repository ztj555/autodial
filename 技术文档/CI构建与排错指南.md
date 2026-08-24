# AutoDial 云端构建与 CI 排错指南

> 面向 Android APK 的 GitHub Actions 远程构建全流程 + 2026-08-24 实战排错经验沉淀。
> 修订：2026-08-24（v4.7.0 workflow 定稿，构建成功）

---

## 一、云端远程构建 APK（GitHub Actions）

### 1.1 工作流概览

`.github/workflows/android-build.yml`（v4.7.0）步骤链（10 步）：

| # | 步骤 | 作用 | 备注 |
|---|------|------|------|
| 1 | Checkout code | 拉取仓库 | actions/checkout@v4 |
| 2 | Set up JDK 17 | 安装 JDK 17 | actions/setup-java@v4 |
| 3 | Verify Android SDK | 检查/补装 SDK 组件 | 用 runner 预装 SDK（`/usr/local/lib/android/sdk`，licenses 已预接受）；缺 `platforms;android-34` 才用 `yes \| sdkmanager` 兜底 |
| 4 | Setup Gradle | Gradle 缓存 | gradle/actions/setup-gradle@v3（缓存失败仅为警告，不影响构建） |
| 5 | Bootstrap Gradle wrapper | **重新生成真 wrapper** | 仓库 `gradlew` 是 stub，CI 下载 Gradle 8.2 后跑 `gradle wrapper --gradle-version 8.2` 覆盖生成 |
| 6 | Decode Keystore | 还原签名密钥 | 仅当 `KEYSTORE_BASE64` 非空 |
| 7 | Build Debug APK | 构建 debug | `./gradlew assembleDebug --info --no-daemon --stacktrace`，**无需密钥** |
| 8 | Build Signed Release APK | 构建签名 release | 仅当 4 个签名 Secrets 全部配置 |
| 9-10 | Upload * APK | 上传产物 | `if-no-files-found: error`：缺产物立即失败（防止假绿） |

### 1.2 触发方式

```yaml
on:
  workflow_dispatch:          # 手动触发（Actions 页面右上角 Run workflow）
  push:
    branches: [ master ]      # 任何 master push 都触发（无 paths 过滤）
  pull_request:
    branches: [ master ]
```

> ⚠️ 经验：**只修改 workflow 文件本身**的 push，GitHub 可能不产生新 run（路径过滤/文件自引用触发存在不确定性）。验证 workflow 改动最可靠的方式是 Actions 页面手动 **Run workflow**。

### 1.3 签名 Secrets 配置（公开仓库）

仓库 `Settings → Secrets and variables → Actions → New repository secret`，添加 4 项（值只填一次，之后无法查看）：

| Secret | 值 | 说明 |
|--------|-----|------|
| `KEYSTORE_BASE64` | `base64 -w0 android-app/autodial-release.p12` 输出 | Windows：`certutil -encode` 后去除头尾两行 |
| `KEYSTORE_PASSWORD` | keystore 密码 | 与本地 `keystore.properties` 一致 |
| `KEY_ALIAS` | 密钥别名 | 默认 `autodial` |
| `KEY_PASSWORD` | key 密码 | 同上 |

**降级策略**：任一 Secrets 缺失 → CI 自动跳过签名 release，只产出 `app-debug`，**不会失败**；4 个齐全才额外产出签名 `app-release`。

> ⚠️ 安全：`*.p12`、`keystore.properties`、`.git-credentials.local` 均在 `.gitignore`（详见根 README 部署指南）。密钥只经 Secrets 进入 CI，绝不入库。

### 1.4 查看日志与下载产物

1. 打开 https://github.com/ztj555/autodial/actions
2. 点击最新一次 run → 左侧步骤树逐个展开看日志；红叉步骤即失败点
3. 页面底部 **Artifacts** 区：`app-debug`（Debug 签名）/ `app-release`（正式签名，需 Secrets 齐全）→ 点击下载 APK

正常构建耗时：2~4 分钟。若 <1 分钟"成功"且无产物，属于假绿，见 2.2 排查。

### 1.5 本地构建对照

```bash
cd android-app
cp keystore.properties.example keystore.properties   # 填入真实密钥（或改用环境变量）
./gradlew assembleRelease    # 需密钥（keystore.properties 或环境变量）
./gradlew assembleDebug      # 无需密钥
```

> ⚠️ 本地 `gradlew` 目前是 stub（见 2.2#6），本地构建请直接用系统 Gradle 8.2：`gradle assembleDebug`。

---

## 二、CI 构建排错经验（2026-08-24 实战）

### 2.1 六轮故障复盘表

| 轮 | 表面现象 | 真正原因 | 修复 |
|----|----------|----------|------|
| 1 | `请设置环境变量 KEYSTORE_PASSWORD/KEY_PASSWORD...`（line 35） | 旧 build.gradle 无条件 throw；CI 在 `gradle wrapper` 步骤配置阶段评估时触发 | 仅 release 任务要求密钥（wantsRelease 判断）+ workflow 按 secrets 守卫 |
| 2 | `Invalid workflow file: Unrecognized named-value: 'secrets'`（Line 42/53） | step-level `if` 直接引用 `secrets.X` 被表达式解析器拒认（与 `on: pull_request` 共存时尤甚） | job-level `env` 注入 secrets，step `if` 统一用 `env.X` |
| 3 | `./gradlew: Permission denied`（exit 126） | Windows 提交的 gradlew 无 Unix 执行位（git 索引 100644） | `git update-index --chmod=+x` 置 100755 + workflow 内 `chmod +x` 兜底 |
| 4 | setup-android@v3 卡在 `Accept? (y/N):` | 该 action 内部 `sdkmanager --licenses` 交互式确认卡死（cmdline-tools 16.0 行为变化） | 移除该 action，改用 runner 预装 SDK |
| 5 | 20s/33s "Success" 但无 APK | Upload 步骤 `if-no-files-found: warn` 把缺产物当 warning 吞掉，掩盖 Build 失败 | 改 `if-no-files-found: error`，缺产物即 fail |
| 6 | Build 步骤只输出 `Please run: gradle wrapper --gradle-version 8.2` | **`gradlew` 是 4 行 echo stub**，`./gradlew` 从没真正启动过 Gradle | CI 新增 Bootstrap wrapper 步骤用 Gradle 8.2 重新生成真 wrapper |

### 2.2 各坑详解

**坑 1 — 签名密钥缺失抛错**
- build.gradle 中签名密码必须从环境变量/keystore.properties 读取（禁止硬编码）；缺失时仅当请求 release 任务才抛错，debug/CI 常规构建不受影响。
- CI 上 Secrets 未配置时不应硬跑 `assembleRelease`，用 `if` 守卫降级。

**坑 2 — step-level `if` 里的 `secrets` 上下文**
- GitHub Actions 表达式解析器对 `if: ${{ secrets.X != '' }}` 在部分校验路径会报 `Unrecognized named-value: 'secrets'`，导致 **Invalid workflow file**，整个 run 直接不执行。
- 规避：job-level `env: SECRET_VAR: ${{ secrets.X }}` 注入，step `if: env.SECRET_VAR != ''`。env 上下文在 step `if` 中永远可用且不受 trigger 类型影响。

**坑 3 — Windows 提交的文件执行位**
- Windows 上 `git add` 不保留 Unix 执行位，提交的 `gradlew` 到 Linux runner 后 `Permission denied`（exit 126）。
- 修复：`git update-index --chmod=+x path` 提交（索引变 100755），并在 workflow 加 `chmod +x` 兜底。

**坑 4 — setup-android 的 license 交互卡死**
- `android-actions/setup-android@v3` 在新 runner 上会重新下载 cmdline-tools 16.0，内部 `sdkmanager --licenses` 输出许可证后停在 `Accept? (y/N):` 等待输入，步骤挂起。
- 规避：**不用该 action**。ubuntu-latest runner 预装完整 Android SDK（含 platforms;android-34、build-tools;34.0.0，licenses 已预接受），直接使用；缺组件时自行 `yes | sdkmanager ...` 补装。

**坑 5 — Upload 的 `if-no-files-found: warn` 掩盖真失败**
- 构建失败时 APK 不存在，Upload 步骤 `warn` 只产生 warning 不冒泡到 job，**整体显示绿色假 Success**。
- 教训：产物类步骤一律 `if-no-files-found: error`，缺产物即 fail，问题立即暴露。

**坑 6 — gradlew 是 stub（本次真凶）**
- 仓库 `android-app/gradlew` 曾是 4 行占位脚本：
  ```sh
  #!/bin/sh
  # Gradle wrapper stub - will be regenerated by GitHub Actions
  echo "Please run: gradle wrapper --gradle-version 8.2"
  ```
  `./gradlew assembleDebug` 只是 echo 后 exit 0，**从未编译**。凡是对它跑的命令（含 `--version`）都会"假成功"，且能把所有外层问题（缺 SDK、缓存失败等）都伪装成无关警告。
- 修复：workflow 中 **Bootstrap Gradle wrapper** 步骤——下载 Gradle 8.2 distribution，`gradle wrapper --gradle-version 8.2` 重新生成完整 wrapper（jar + properties + gradlew + gradlew.bat）。

### 2.3 关键教训

1. **先读脚本内容，再谈权限/环境/产物**。"文件存在"≠"文件正确"。排查 `./gradlew` 相关问题第一步是 `cat gradlew` 看它是不是真脚本。
2. **1 分钟内"成功"且无产物的 CI 一定有问题**。正常 Android 构建至少 2 分钟。
3. **检查产物是否真的存在**，不要只看 job 绿/红。Upload 类步骤的 warn/error 配置决定了"假绿"是否可能发生。
4. **只改 workflow 文件的 push 可能不触发**，验证 workflow 改动优先用手动 Run workflow。
5. 排错时逐层确认：配置阶段 → wrapper 可用性 → SDK 组件 → 编译 → 产物上传，每层都有独立验证手段。

---

## 三、GitHub Actions 常见陷阱速查

| 陷阱 | 现象 | 规避 |
|------|------|------|
| `paths` 过滤 + 只改 workflow/README | push 后无新 run | 去掉 paths，或手动 Run workflow |
| step `if` 用 `secrets.X` | Invalid workflow file | env 中转，用 `env.X` |
| Windows 提交的脚本无执行位 | Permission denied 126 | `git update-index --chmod=+x` |
| `setup-android@v3` | license 交互卡死 | 用 runner 预装 SDK |
| Upload `warn` 吞缺产物 | 假绿无产物 | `if-no-files-found: error` |
| wrapper 脚本是 stub | 构建"秒成功"无产物 | `gradle wrapper --gradle-version X` 重新生成 |
| Gradle cache IPv6 报错 | `Failed to save cache entry`（Access Denied/IPv6） | 仅警告，不影响产物；可禁用缓存或配置 IPv4 |
| Node 20 弃用警告 | actions 运行时提示 | 升级 actions 大版本（非阻塞） |
