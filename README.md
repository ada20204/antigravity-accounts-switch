# Antigravity Accounts Enhancer

给 Google Antigravity(VS Code 扩展)注入的多账号增强插件:左下角账号面板 + Settings 页配额卡片,一键在多个已连接的 Google 账号间切换、添加新账号、查看各账号的配额和等级。

## 组成

- `src/daemon/` —— 本地 HTTP 桥接服务,现在跑在 Antigravity 自己的 extension host 进程里(`extension.ts` 的 `activate()`),不再是独立进程;每个 VS Code 窗口各自的实例在 63820-63829 里自动挑一个空闲端口。封装调度 [`agent-hub-accounts`](../agent-hub-accounts) CLI,管理 Antigravity 的 `agy --hub` 进程生命周期。
- `src/runtime/` —— 注入进 Antigravity webview 的前端代码(CDP 注入,非常规 `<script src>`,页面 CSP 封死了那条路)。
- `scripts/` —— bridge.js 的 patch/unpatch(历史方案)、Keychain 诊断脚本。

## 运行前提

装好 `.vsix`(Antigravity 里 "Install from VSIX")之后,不再需要手动开 Terminal、装 LaunchAgent 或另开 Vite——装/更新/重载扩展本身就是重启 daemon。唯一剩下的前提:VS Code 要开着 CDP 端口 9222(注入依赖它,页面 CSP 封死了常规 `<script src>`)。原因和其余细节见 [`docs/README.md`](./docs/README.md)。

改这个项目本身的代码时(而不是只是用它),`npm run dev`(Vite)+ VS Code 的 "Reload Window" 仍是主要的迭代方式,见 `docs/README.md` 的"开工前"一节。

## 文档

详细的运行流程、设计取舍和历史记录见 [`docs/README.md`](./docs/README.md)——先看那份索引,再决定翻哪一份。
