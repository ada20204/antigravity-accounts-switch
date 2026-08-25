# 两个流程复盘(2026-08-23)

**日期**:2026-08-23 · 涉及 `daemon.ts`、`accountStore.ts`、`progressOverlay.ts`

**修:添加账号后从不重启 hub**。`login` 成功后,新账号成为 Keychain 的活动登录,但常驻 hub 内存里还是旧凭证——于是 `route` 报新账号 active、UI 显示 ACTIVE,**而实际聊天还在旧账号上**。这就是本次会话最开始那个"切换了但会话框还是原账号"的 bug,当时只在 switch 路径上修了,添加路径一直漏着。

难点在于登录脚本是 detached 跑在 Terminal 里的,daemon 不知道它什么时候结束。解法:新增 `POST /api/hub-restart`,由脚本自己在 `connect` 成功后 `curl` 回来触发。curl 失败也不会让脚本挂掉,只提示"重启 VS Code 生效"。

**修:切换时 7 秒零反馈**。`/api/switch` 是故意先回响应再重启 hub 的(否则响应会被它自己触发的 reload 掐断),所以前端 ~150ms 就拿到成功回执,然后**静默 6.5 秒**,面板毫无预兆地整个重载。加了 `progressOverlay.ts`:确认后立刻盖一个"Switching to X…"的模态,一直挂着。

关键设计:**成功时不主动关闭它**——iframe reload 会把整个 document 换掉,那一刻正是新账号真正生效的时刻,所以 reload 本身就是完成信号。提前关掉只会让陈旧 UI 再露 6 秒然后又突然变白。只有失败(回滚)时才显式关闭并报错。另加 30s 超时兜底,避免重启失败时留下永久模态。

**待定:用 ANTIGRAVITY_OPEN_URL 取代 Terminal + TUI**。在 `agy` 二进制里确认存在 `ANTIGRAVITY_OPEN_URL: %s`,而 `extension.js` 里 hub 的 stdout 监听会捕获这行并 `vscode.env.openExternal(uri)` 打开浏览器——也就是说**存在一条走浏览器、不需要交互式 TUI 的登录路径**。

设想的流程:`connect` 保存当前 → 摘掉活动凭证 → 用我们已有的同端口 respawn 重启 hub(但要 pipe stdout 而不是 ignore)→ hub 发现没凭证、打印 `ANTIGRAVITY_OPEN_URL:` → 我们 `open` 这个 URL → 用户在浏览器里登录 → hub 拿到凭证写回 Keychain → `connect` 捕获成新账号。额外好处:hub 全程就是新账号,连"添加后要重启"这一步都省了。

**尚未验证**,因为要确认 hub 在没有凭证时确实会打印这一行,就得真的把当前登录摘掉,风险太高不便擅自在实机上做。要推进的话需要先商量一个安全的验证方式。
