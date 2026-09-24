# Antigravity Accounts Switch

<p align="center">
  <strong>Multi-account Switcher & Real-time Quota Dashboard for Google Antigravity</strong><br>
  <em>An unofficial community enhancement extension</em>
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
  <a href="./README.zh-CN.md">简体中文文档</a> | <strong>English Documentation</strong>
</p>

---

> [!NOTE]
> **Disclaimer**: *Antigravity Accounts Switch* is an independent, open-source community extension. It is **not** an official product of Google LLC or Alphabet Inc., nor is it affiliated with, sponsored by, or endorsed by Google. "Google" and "Antigravity" are trademarks of Google LLC.

A powerful productivity enhancement for developers using Google Antigravity in VS Code. It provides seamless multi-account switching, an embedded quota dashboard with concentric progress rings, real-time status bar monitoring, privacy masking, credential export/import, and startup timeout auto-repair.

---

## ⚡ Prerequisites

To allow the extension's local daemon to connect safely to Antigravity's interface sandbox via Chrome DevTools Protocol without modifying system core files:

1. Ensure the official **Google Antigravity** extension is installed.
2. Launch VS Code with the debugging port enabled:
   ```bash
   code --remote-debugging-port=9222
   ```
   *(Tip: You can add `--remote-debugging-port=9222` to your desktop shortcut or shell alias).*

---

## 🌟 Key Features

### 1. ⚡ Instant Multi-Account Switching
- **Multiple Quick Access Points**: Switch accounts effortlessly with one click from either the bottom-left account popup or the embedded quota dashboard in Models / Settings.
- **Generation Interruption Guard**: Confirmation modal warns about active generation tasks before switching, preventing accidental context loss.
- **Smooth Session Reload**: Seamlessly hot-reloads Antigravity with target credentials without needing manual browser sign-in reauthorization.

### 2. 📊 Embedded Quota Dashboard
- **Native-Look Integration**: Deeply embedded directly in the Models / Settings page, adhering to Antigravity's native design aesthetics.
- **Concentric Quota Rings**:
  - **Outer Ring**: Gemini 5h / Weekly quota percentage remaining.
  - **Inner Ring**: Claude 3.5 Sonnet & GPT 5h / Weekly quota percentage remaining.
  - **Dynamic Colors**: Color-coded indicators (Green, Blue, Orange, Red) reflect quota health in real time.
- **Multi-Column Sorting**: Click column headers (Account Tier Ultra → Pro → Free, Gemini Quota, Claude Quota) to stack priority and toggle ascending/descending order.
- **Check All Accounts**: Quickly switches through all saved accounts sequentially to refresh true server quotas.
- **Adaptive Responsive Layout**: Intelligently switches between full dashboard view and compact mode across different sidebar widths, avoiding layout jitter.

### 3. 🛡️ Privacy & Email Masking
- **One-Click Masking Toggle**: Easily toggle email desensitization (e.g. `myaccount@gmail.com` displays as `mya***nt@gmail.com`).
- **End-to-End Privacy Protection**: Popup list, Models dashboard, status bar, confirmation modals, and progress overlays all respect the masking setting—ideal for screen recording, presentations, and screenshots.

### 4. 🌐 Seamless Bilingual Support (i18n)
- **One-Click Language Switch**: Toggle between English (EN) and Simplified Chinese (ZH) instantly in the account popup.
- **Full Localization**: Every label, table header, tooltip, confirmation dialog, progress message, and error alert is fully localized.

### 5. 🚀 Real-time Status Bar Monitor
- **Persistent Status**: View current active account, tier, and remaining quota directly in the VS Code status bar.
- **Rich Markdown Tooltip**: Hover over the status bar item to inspect detailed Gemini and 3rd-party model quotas, tiers, and any account issues.

### 6. 📦 Credential Backup & Migration (Export & Import)
- **Export Accounts**: Back up all connected account profiles and credentials to a single JSON file.
- **Import Accounts**: Quickly restore credentials on a secondary machine or fresh environment without repeating Google OAuth.

### 7. 🔧 Official Extension Timeout Protection
- **Startup Auto-Patch**: Automatically extends the official `google.google-antigravity` extension's launch timeout from 15s to 60s, preventing `[LAUNCH ERROR] Timed out waiting for server` errors during slow cold starts.

---

## 📖 Usage Guide

### Adding a New Account
1. Click the Antigravity account avatar in the bottom-left corner to open the switcher popup.
2. Click **“Add new account”** and confirm the prompt (your current account is safely retained locally).
3. Complete the Google OAuth sign-in flow following Antigravity's standard instructions.
4. Once signed in, the extension automatically detects and stores the new account.

### Switching Accounts
- **Option 1**: Click the bottom-left avatar and click **“Switch”** next to any saved account.
- **Option 2**: In Antigravity's Models / Settings page, click **“Switch”** on any account row in the dashboard.

### Sorting & Quota Inspection
- Click **“Account / Tier”**, **“Gemini”**, or **“Claude & GPT”** in the dashboard header to sort. Click repeatedly to toggle order or combine priorities.
- Click **“Reset”** to return to default account order.
- Click **“Check All Accounts”** to run an automated quota check across all accounts.

---

## ⚙️ Extension Settings

Configure via VS Code Settings (`Ctrl+,` / `Cmd+,`) by searching `antigravityAccountsSwitch`:

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `antigravityAccountsSwitch.maskEmails` | `boolean` | `true` | Desensitize and mask account email addresses in the UI and status bar. |
| `antigravityAccountsSwitch.language` | `string` | `"zh"` | Display language for the UI and notifications (`"zh"`: Chinese, `"en"`: English). |
| `antigravityAccountsSwitch.verboseLogging` | `boolean` | `false` | Output verbose debug log lines to the Output Channel. |

---

## 🔒 Security & Privacy

- **100% Local Storage**: All account tokens and quota data remain strictly on your local machine. No data is ever sent to third-party servers.
- **Credentials Safety**: Exported backup files contain authentication tokens. Keep them confidential.

---

## 📄 License

[MIT License](./LICENSE). Designed with ❤️ for Google Antigravity users.
