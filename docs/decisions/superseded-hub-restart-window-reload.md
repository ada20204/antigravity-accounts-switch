# (已被取代)Hub 重启:为什么改成整窗口 reload

> ⚠️ **这一节的结论已经不是现在的做法。** 整窗口 reload 要 30-36s,现在走的是"自己在同端口 respawn"(~7s),见下面 **"✅ 真正的优化:同端口自行 respawn"**。整窗口 reload 仅作为 respawn 失败时的兜底保留。
> 本节保留是因为它记录了"为什么单独 reload iframe 不行"——那个结论至今成立,也是后续方案的前提。

**日期**:2026-08-22 · 涉及 `hubRestart.ts`、`daemon.ts::/api/switch`

**背景**:往 macOS Keychain 共享槽位写入新账号,对已经在跑的 `agy --hub` 进程本身没有任何影响——它的 `AuthProvider` 绑定的是启动时读到的那份密文,常驻内存里继续用旧的(现场对照过 `agy` 的 `cli.log`:`b.codeAssistClient.AuthProvider (...) is same as b.cliAuth (...)`,`server_oauth.go`)。不重启 hub,UI 上显示"已切换",但 Chat/Settings 后端实际还是旧账号。

**第一版实现的问题**:SIGTERM 杀掉 hub 后,直接对着已知的内容 iframe 发 `window.location.reload()`,指望"插件会注意到后端没了,自动重新拉起"。翻了 `extension.js` 源码才发现这个假设是错的——`AntigravityServerManager` 的 `exit` 回调只做 `this.serverProcess = undefined; this.serverUrl = undefined`,**没有任何自动 respawn 逻辑**。新的 hub 只会在下次有代码显式调用 `serverManager.start()` 时才会被拉起(而且换一个新的临时端口),这个调用只发生在 VS Code 重新 resolve 某个 webview 面板的时候,不是 iframe 内部自己发起的 `window.location.reload()` 能触发的。结果就是:reload 只是对着一个已经没有进程监听的旧端口重新发一次请求,永远拿到 connection refused,页面卡死在 `chrome-error://chromewebdata/`,需要用户手动 Reload Window 才能救回来——现场复现过两次。

**现在的做法**:SIGTERM(不用 SIGKILL,和 `extension.js` 里 `AntigravityServerManager.stop()` 一样走优雅退出优先、超时才强杀)杀掉 hub 之后,不再单独 reload 某个 iframe,而是用 CDP 对 VS Code 顶层 page target(不是 iframe subtarget——`Page.reload` 只在顶层 target 上生效)发 `Page.reload()`,效果等同于用户自己按 `Developer: Reload Window`。整个插件重新激活,会话面板重新 resolve,`serverManager.start()` 随之被重新调用,新 hub 干净拉起。

**顺带修的竞态 bug**:`/api/switch` 原本是"CLI 切成功 → 执行 hub 重启(含 reload) → 把 HTTP 响应写回给调用方"。但发起这次 `/api/switch` 请求的往往就是即将被 reload 的那个页面自己——reload 一发生,浏览器直接把这条还没返回的 in-flight fetch 掐断,前端拿到 `TypeError: Failed to fetch`,误判为失败并回滚一个后端其实已经切换成功的账号(现场日志实锤:CLI 明确 succeeded,几毫秒后前端记录 rolling back)。改成先把响应发给调用方,再执行 hub 重启,重启本身变成 fire-and-forget。
