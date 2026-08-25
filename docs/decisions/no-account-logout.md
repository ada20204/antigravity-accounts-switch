# 不做账号登出(Log out)

**日期**:2026-08-22 · **2026-08-23 补充边界**

**结论**:多账号管理里不提供"登出当前账号"这个**功能入口**,已从弹窗 UI 里移除 `#ag-logout-btn`。

> **和"添加账号"流程的边界**(2026-08-23):添加账号时确实会把你在本机登出一次,这**不违反**本决策。区别在于那是**纯本地清除**(删 hub 会话缓存 + `security delete-generic-password`),不调用任何登出/撤销接口,所以 refresh token 不会被服务端撤销,已保存的密文副本依然有效——`cancel` 能随时 `switch` 回来就是证明。本节反对的是**真登出**(会 revoke 的那种)。见 "添加账号(定稿)"。

**原因**:
- 这套多账号系统的 shared-live 模式本质是:登录一次后把 macOS Keychain 里的 OAuth 密文原样"捕获(capture)→ 切换时写回(activate)",实现快速切号,从不重新走一遍真实登录。
- 真正的 Antigravity/Google 登出会让服务端撤销(revoke)对应的 refresh token。一旦撤销,`agent-hub-accounts` 里为该账号保存的密文副本就失效了,该账号会从"可秒切"降级为"必须重新完整登录"——这和多账号快速切换的设计目标直接冲突。
- 核实过:`agent-hub-accounts` CLI(`dist/cli.js`)里根本没有 `logout` 子命令(只有 `connect/login/switch/run/list/ls/current/doctor/route/use/select/remove/quota`),说明这条边界在后端设计时就已经是有意排除的,不是遗漏。
- 之前 UI 上的 "Log out current" 按钮实际也没有绑定任何点击事件(死代码),点击没有任何效果,属于误导性 UI,已一并清理。

**安全的替代操作**:`accountStore.ts::removeAccount()` → daemon `/api/remove` → CLI `remove`,只是从本地 registry 里忘记这个账号,不触碰真实 Google 会话,不会导致密文失效。这个方法已经存在但目前没有接到任何按钮上,是否要作为"移除账号"的正式入口留待后续决定。
