# Antigravity Accounts Switch

<p align="center">
  <strong>专为 Google Antigravity 打造的多账号管理与配额看板增强插件</strong><br>
  <em>非官方社区增强扩展</em>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=174c39a3-faa3-63fd-8133-ee3abd1e2a01.antigravity-accounts-switch">
    <img src="https://img.shields.io/visual-studio-marketplace/v/174c39a3-faa3-63fd-8133-ee3abd1e2a01.antigravity-accounts-switch?label=Marketplace&logo=visual-studio-code" alt="Visual Studio Marketplace Version" />
  </a>
  <a href="https://github.com/ada20204/antigravity-accounts-switch/releases">
    <img src="https://img.shields.io/github/v/release/ada20204/antigravity-accounts-switch?label=Release" alt="GitHub Release" />
  </a>
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" />
  </a>
</p>

<p align="center">
  <strong>简体中文文档</strong> | <a href="./README.md">English Documentation</a>
</p>

---

> [!NOTE]
> **免责声明**：*Antigravity Accounts Switch* 为独立的第三方开源社区工具，**非** Google LLC 或 Alphabet Inc. 官方产品，亦未与 Google 存在任何附属、赞助或官方背书关系。“Google” 与 “Antigravity” 均为 Google LLC 的商标。

专为 Google Antigravity（VS Code 插件）打造的多账号管理与配额看板增强插件。提供多账号无缝切换、同心环配额看板、状态栏实时监控、邮箱脱敏、凭据导入导出以及官方扩展启动超时自愈保护。

---

## ⚡ 前置准备

为使本插件的本地守护进程能够安全连接至 Antigravity 界面沙箱（无需对系统核心文件进行破坏性篡改）：

1. 请确保已安装官方 **Google Antigravity** 扩展。
2. 启动 VS Code 时附带 CDP 调试端口参数：
   ```bash
   code --remote-debugging-port=9222
   ```
   *（提示：可将 `--remote-debugging-port=9222` 配置在桌面快捷方式启动参数或终端别名中）。*

---

## 🌟 核心特性

### 1. ⚡ 一键平滑切换账号
- **多处快速入口**：支持在左下角账号弹窗（Account Popup）或 Models 设置页配额看板中一键切换账号。
- **任务中断防护**：切换前智能弹出确认窗口，提醒正在进行的生成任务，防止误触导致对话或生成中断。
- **平滑重启会话**：无缝热载入目标账号凭据并重连，无需繁琐的重新网页授权。

### 2. 📊 嵌入式多账号配额看板
- **原生级无缝嵌入**：深度融合于 Models / Settings 页面，设计风格与 Antigravity 原生界面高度统一。
- **同心环可视化 (Concentric Quota Rings)**：
  - **外环**：Gemini 5h / 周维度配额剩余百分比；
  - **内环**：Claude 3.5 Sonnet & GPT 5h / 周维度配额剩余百分比；
  - **动态色彩**：配额余量根据健康度（充裕 / 预警 / 耗尽 / 异常）呈现动态颜色指引。
- **多重组合排序 (Multi-Column Sorting)**：支持按方案等级（Ultra → Pro → Free）、Gemini 额度、Claude 额度连续点击叠加优先级排序。
- **全量巡检 (Check All Accounts)**：一键依次快速轮巡所有已连接账号以同步最新真实额度。
- **自适应视口响应**：针对侧边栏、宽屏以及不同容器尺寸，智能在完整看板与紧凑卡片间自适应切换，杜绝界面抖动。

### 3. 🛡️ 账号隐私脱敏
- **一键脱敏开关**：支持一键将账号邮箱进行脱敏隐藏（例如 `myaccount@gmail.com` 自动显示为 `mya***nt@gmail.com`）。
- **全链路保护**：弹窗列表、Models 看板、状态栏、切换确认弹窗及进度蒙层全面同步脱敏状态，录屏分享或演示时无需担心隐私泄露。

### 4. 🌐 中英文双语无缝切换 (i18n)
- **界面一键切换**：在账号弹窗右上角支持快捷切换简体中文（ZH）与 English（EN）。
- **深度本地化**：从看板表头、提示说明、操作按钮，到切换确认弹窗与异常警报均提供完整地道的双语支持。

### 5. 🚀 底部状态栏实时监控
- **常驻状态展示**：在 VS Code 底部状态栏实时显示当前活跃账号及配额状态。
- **富文本 Hover 详情**：鼠标悬停即刻查看账号方案等级、Gemini 配额（周/5h）、第三方模型配额（周/5h）以及异常状态提示。

### 6. 📦 凭据备份与多机迁移 (Export & Import)
- **账号导出 (Export)**：一键将当前所有已连接的账号配置与凭据导出为备份文件。
- **账号导入 (Import)**：在备用机器或新工作区上一键导入，免去重复登录授权的繁琐流程。

### 7. 🔧 官方插件超时自愈 (Official Extension Patching)
- **启动守护**：针对官方 `google.google-antigravity` 扩展偶发因启动耗时超过 15s 而出现 `[LAUNCH ERROR] Timed out waiting for server` 的 Bug，插件内置自动修补机制，将启动等待容限智能延长至 60s，从根源上保障 Antigravity 稳定拉起。

---

## 📖 使用指南

### 添加新账号
1. 点击左下角 Antigravity 账号头像，展开账号切换弹窗。
2. 点击 **“添加新账号”**（Add new account），在弹窗确认后系统将注销当前临时登录。
3. 按照 Antigravity 官方指引完成新 Google 账号的 OAuth 登录流程。
4. 登录完成后，插件将自动捕获并持久化该新账号凭据，随后可随时互相切换。

### 切换账号
- **方式一**：点击左下角账号头像，在弹窗列表中点击对应账号右侧的 **“切换”**（Switch）按钮。
- **方式二**：在 Antigravity Models / Settings 页面的“多账号配额看板”中，点击目标账号行的 **“切换”** 按钮。

### 管理与排序
- 在看板表头点击 **“账号/方案”**、**“Gemini”** 或 **“Claude & GPT”**，即可根据对应字段进行升降序排列，多次点击可叠加排序权重。
- 点击 **“重置”** 可一键恢复初始账号顺序。
- 点击 **“全量巡检”** 可自动轮巡刷新所有账号配额。

---

## ⚙️ 扩展配置项

可以在 VS Code 的 `Settings`（`Ctrl+,` 或 `Cmd+,`）中搜索 `antigravityAccountsSwitch` 进行个性化配置：

| 配置键名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `antigravityAccountsSwitch.maskEmails` | `boolean` | `true` | 是否对账号邮箱进行脱敏隐藏（例如显示为 `dev***er@example.com`） |
| `antigravityAccountsSwitch.language` | `string` | `"zh"` | 界面显示语言，可选 `"zh"` (简体中文) 或 `"en"` (English) |
| `antigravityAccountsSwitch.verboseLogging` | `boolean` | `false` | 是否在输出通道（Output Channel）打印详细调试日志 |

---

## 🔒 隐私与安全性声明

- **纯本地存储**：所有账号凭据与配额数据均严格存储在您本机的本地安全存储中，绝不上传至任何第三方服务器或云端服务。
- **安全提示**：导出文件包含本地登录凭证，请妥善保管导出的备份文件，避免向不受信任的人员分享。

---

## 📄 开源协议

[MIT License](./LICENSE)。Designed with ❤️ for Google Antigravity users.
