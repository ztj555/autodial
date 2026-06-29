# Phosphor 图标替换 & BugFix 记录

> 日期: 2026-06-29 ~ 2026-06-30  
> 范围: AutoDial Android 全量 UI  
> 图标源: [Phosphor Icons](https://phosphoricons.com/) Regular weight

---

## 一、新增资源 (12 个 VectorDrawable)

| 文件名 | Phosphor 图标 | 用途 |
|--------|-------------|------|
| `ic_ph_wifi_high.xml` | wifi-high | 底部导航"设置"Tab |
| `ic_ph_list_numbers.xml` | list-numbers | 底部导航"记录"Tab |
| `ic_ph_chart_bar.xml` | chart-bar | 底部导航"统计"Tab、统计页标题 |
| `ic_ph_note_pencil.xml` | note-pencil | 底部导航"登记"Tab、登记页标题 |
| `ic_ph_clipboard_text.xml` | clipboard-text | 通话记录页标题 |
| `ic_ph_phone_outgoing.xml` | phone-outgoing | 拨出通话类型图标、上次通话提示 |
| `ic_ph_phone_incoming.xml` | phone-incoming | 来电通话类型图标 |
| `ic_ph_phone_x.xml` | phone-x | 未接通话类型图标、权限提示 |
| `ic_ph_sim_card.xml` | sim-card | 记录卡片 SIM 卡图标 |
| `ic_ph_house.xml` | house | 连接页标题图标 |
| `ic_ph_book_open_text.xml` | book-open-text | 连接页"使用说明"图标 |
| `ic_ph_magnifying_glass.xml` | magnifying-glass | (预留) |

所有 VectorDrawable 格式: `viewport 256x256`, `size 24dp`, `fillColor="#000000"` (运行时着色)。

---

## 二、UI 布局改动

### 2.1 底部导航栏 (`activity_main.xml`)

4 个 Tab 图标全部替换为 Phosphor，尺寸保持 **24dp**:

```xml
<!-- 设置 -->  ic_tab_connect     → ic_ph_wifi_high
<!-- 记录 -->  ic_tab_records     → ic_ph_list_numbers
<!-- 统计 -->  ic_tab_stats       → ic_ph_chart_bar
<!-- 登记 -->  ic_tab_register    → ic_ph_note_pencil
```

### 2.2 通话记录页 (`fragment_call_log.xml`)

| 元素 | 之前 | 之后 |
|------|------|------|
| 标题 | `📋 通话记录` | `drawableStart="ic_ph_clipboard_text"` + 纯文字 |
| 权限提示 | `📵 需要通话记录权限` | `drawableStart="ic_ph_phone_x"` + 纯文字 |
| 上次通话图标 | 无 | `ImageView` + `ic_ph_phone_outgoing` |

间距收紧:
- 根布局 `paddingTop`: 12dp → 0dp (标题贴顶)
- 区块间距: 拨号栏/提示/列表 `marginTop` 统一 10dp → 6dp

### 2.3 记录卡片 (`item_call_log.xml`)

| 元素 | 之前 | 之后 |
|------|------|------|
| SIM 卡图标 | `ic_phone_small` | `ic_ph_sim_card` |
| 通话类型 | emoji 文字 (📤📥📵) | Phosphor drawableStart + 中文标签 |

卡片间距收紧:
- `paddingTop/Bottom`: 16dp → 10dp
- `marginTop`: 8dp → 4dp
- 分隔线 `marginTop`: 6dp → 4dp

### 2.4 其他页面

| 页面 | 改动 |
|------|------|
| 连接页 (`fragment_connect.xml`) | 🏠 → `ic_ph_house`, 📖 → `ic_ph_book_open_text` |
| 统计页 (`fragment_stats.xml`) | 📊 → `ic_ph_chart_bar` (💰我的财库保留 emoji) |
| 登记页 (`fragment_register.xml`) | 📝 → `ic_ph_note_pencil` |

---

## 三、Kotlin 代码改动

### 3.1 `CallLogFragment.kt` — 通话类型图标渲染

```kotlin
// 修复前 (Bug): 只有图标没有文字
holder.callType.text = ""  // ❌ 文字被清空
holder.callType.setCompoundDrawables(null, d, null, null)  // 图标放 top

// 修复后: 图标在文字左边，同时显示标签
val (typeText, iconRes, tintColor) = when (record.type) {
    OUTGOING -> Triple("拨出", ic_ph_phone_outgoing, green)
    INCOMING -> Triple("来电", ic_ph_phone_incoming, green)
    MISSED   -> Triple("未接", ic_ph_phone_x, red)
    else     -> Triple("", ic_ph_phone_outgoing, green)
}
holder.callType.text = typeText
val d = ContextCompat.getDrawable(context, iconRes)
d?.setTint(tintColor)
holder.callType.setCompoundDrawablesWithIntrinsicBounds(d, null, null, null)
holder.callType.setTextColor(tintColor)
```

通话状态文字 (`callStatus`) 无改动 — 逻辑验证通过。

长按菜单保持原有 emoji: `📞 重拨` / `💬 发短信给`

### 3.2 `ThemeManager.kt` — Drawable 着色保护

```kotlin
// 修复: 跳过已有 colorFilter 的 drawable，防止覆盖代码显式设置的颜色
if (d != null) {
    try {
        if (d.colorFilter == null) d.setTint(tc)  // ✅ 安全检查
    } catch (_: Exception) {}
}
```

### 3.3 `ConnectFragment.kt` — 卡片透明度全局广播

```kotlin
// 之前: 仅局部应用
ThemeManager.applyToView(requireView(), colors)

// 之后: 通知所有已注册 Fragment 刷新
ThemeManager.notifyRefresh()
```

---

## 四、Bug 修复记录

| Bug | 根因 | 修复 |
|-----|------|------|
| 通话记录文字不显示 | `holder.callType.text = ""` 清空了文字标签 | 恢复中文标签 + Phosphor 图标并排 |
| lastCallHintBanner 图标不显示 | `TextView` 使用了无效的 `android:src` 属性 | 改为 `ImageView` + `android:src` |
| 卡片透明度仅连接页生效 | `applyToView` 仅局部刷新 | 改用 `notifyRefresh()` 全局广播 |
| auto-tint 覆盖显式着色 | 无 `colorFilter` 检查直接 `setTint` | 增加 `d.colorFilter == null` 检查 |

---

## 五、保留未改的内容

- 💰 财运 / 财气 emoji — 属于情绪装饰
- 长按菜单 `📞 重拨` / `💬 发短信给` — 功能提示
- 💡 提示类 emoji — 用户认知习惯

---

## 六、涉及文件清单

```
android-app/app/src/main/
├── res/drawable/
│   ├── ic_ph_wifi_high.xml          [新增]
│   ├── ic_ph_list_numbers.xml       [新增]
│   ├── ic_ph_chart_bar.xml          [新增]
│   ├── ic_ph_note_pencil.xml        [新增]
│   ├── ic_ph_clipboard_text.xml     [新增]
│   ├── ic_ph_phone_outgoing.xml     [新增]
│   ├── ic_ph_phone_incoming.xml     [新增]
│   ├── ic_ph_phone_x.xml            [新增]
│   ├── ic_ph_sim_card.xml           [新增]
│   ├── ic_ph_house.xml              [新增]
│   ├── ic_ph_book_open_text.xml     [新增]
│   └── ic_ph_magnifying_glass.xml   [新增]
├── res/layout/
│   ├── activity_main.xml            [修改] Tab 图标替换
│   ├── fragment_call_log.xml        [修改] 标题图标 + 间距 + Bug修复
│   ├── fragment_stats.xml           [修改] 标题图标
│   ├── fragment_register.xml        [修改] 标题图标
│   ├── fragment_connect.xml         [修改] 标题图标 + 使用说明图标
│   └── item_call_log.xml            [修改] SIM图标 + 通话类型 + 间距
└── java/com/autodial/app/
    ├── CallLogFragment.kt           [修改] 通话类型渲染 + Bug修复
    ├── ThemeManager.kt              [修改] 着色保护 + notifyRefresh
    └── ConnectFragment.kt           [修改] 全局透明度通知
```
