# Export/Import 账号功能接进 UI

`docs/ISSUES.md` 里挂着的最后一条大项。方向在条目本身里已经定了(vendor
`transfer.ts` + `vscode.window.showSaveDialog`/`showOpenDialog`),这里记录
具体怎么落地、以及为什么。

## 文件选择器为什么单独拆一个 vscode-有依赖的文件

`routes.ts`/`addAccountRoutes.ts` 刻意保持 vscode-free(见
[`2026-08-27-split-extension-ts-routes.md`](./2026-08-27-split-extension-ts-routes.md))。
但原生文件选择器(`showSaveDialog`/`showOpenDialog`)只能在 extension host 里调,
没有绕开的办法。折中方案:`transferRoutes.ts` 本身仍然 vscode-free,通过依赖注入
接收两个回调(`pickSaveFile`/`pickOpenFile`,返回 `Promise<string | undefined>`,
`undefined` 表示用户点了取消);真正调用 `vscode.window.showSaveDialog` 的代码
留在 `extension.ts` 里——这是全项目里除了 `activate()`本身之外唯一碰 vscode
API 的路由相关代码,边界很清楚。

## 为什么不需要 hub 重启、不需要 begin() 那套安全机制

`exportAccounts()`只读(`keychain.exportProfile()`只读已保存的备份文件,从不碰
Keychain 活跃槽位)。`importAccounts()`会写注册表和备份文件,但同样不碰 Keychain
活跃槽位——不会让任何人被登出或登入,不需要重启 hub。这和 switch/add-account
完全不同类,不需要那套锁/重启机制,只用了和 CLI 一致的 `switchLockPath` 文件锁
(防止和还装着的 agent-hub-accounts CLI 并发写同一批文件)。

## 为什么在合成数据测试上加了一次真正的跨注册表验证

`test/accounts.test.mjs` 新增的第 5 步没有止步于"导出成功、导入返回了正确的
imported 列表"——额外验证了导入进一个**全新、完全独立**的注册表位置后,
`verifiedOverview()` 依然能把这个账号判定为 `is_active: true`。这一步是必要的:
只验证 imported 列表和账号数对不上会漏掉一类真实 bug——bundle 里的凭证字段被
错误映射、截断或者根本没写对,光看返回值的"账号数量"和"是否成功"字段完全看
不出来,只有真正拿这份凭证去和实时 Keychain 状态比对,才能证明 bundle 里存的
是一份可用的凭证,不只是长得像凭证的数据。

写这个测试时还发现一个和 bug 无关但值得记录的细节:`capture()`/`switchAccount()`
不关心密钥字符串的具体格式,但 `importProfile()` 内部会调
`decodeStandaloneToken()` 校验 isolated 密钥必须是 `prefix:base64(JSON 且带
refresh_token)` 这个信封格式——用随手编的字符串当假密钥在前四步能跑通,到
export/import 这步会直接报"unsupported credential envelope"。测试里的假密钥
现在统一用一个 `fakeSecret()` 辅助函数生成信封形状正确的值。

## Settings 卡片按钮,不是弹窗

和 [`2026-08-27-adopt-current-login.md`](./2026-08-27-adopt-current-login.md)
同样的理由不适用于这里——Export/Import 不需要读 Account 面板 DOM,放哪个 iframe
都可以。选 Settings 卡片纯粹是因为这是"批量/不常用的账号管理操作"的自然位置,
和已有的 "Check All Accounts" 按钮放在同一行。
