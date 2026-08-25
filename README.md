# Antigravity Accounts Enhancer

给 Google Antigravity(VS Code 扩展)注入的多账号增强插件:左下角账号面板 + Settings 页配额卡片,一键在多个已连接的 Google 账号间切换、添加新账号、查看各账号的配额和等级。

## 组成

- `src/daemon/` —— 本地 Node 桥接服务(端口 63820),封装调度 [`agent-hub-accounts`](../agent-hub-accounts) CLI,管理 Antigravity 的 `agy --hub` 进程生命周期。
- `src/runtime/` —— 注入进 Antigravity webview 的前端代码(CDP 注入,非常规 `<script src>`,页面 CSP 封死了那条路)。
- `scripts/` —— bridge.js 的 patch/unpatch,以及 Keychain 诊断脚本。

## 运行前提

1. daemon 必须在 Terminal.app(不能 SSH)启动:`npm run daemon`。原因和其余前提见 [`docs/README.md`](./docs/README.md)。
2. VS Code 需开着 CDP 端口 9222。
3. 前端走 Vite dev server(`npm run dev`),不需要单独构建即可生效;`npm run build:runtime` 只在需要产出可脱离 dev server 的静态 bundle 时才用。

## 文档

详细的运行流程、设计取舍和历史记录见 [`docs/README.md`](./docs/README.md)——先看那份索引,再决定翻哪一份。
