# 未解决事项

跟 `docs/decisions/`(已经定论、为什么这么做)不同——这份列的是还没做完/还没验证/还没决定的事,做完了从这里删掉,不是标记完成后继续留着。

- **多窗口场景没有现场验证过**。`2026-08-26-extension-host-daemon.md` 里按窗口分配端口、按 `--add-dir` 过滤 hub 归属的设计,只做过代码层面的推导和单窗口测试,没有真正开两个 Antigravity 窗口跑一遍确认端口分配、hub 归属过滤、CDP 注入范围确实按窗口隔离。

- **rescue banner 的账号数 0→N 重渲染修复没有现场验证过**。`2026-08-26-extension-host-restart-experiment.md` 记录的那次事故顺手修了 `syncRescueBanner()` 的"渲染一次就再也不更新"的 bug,改动本身编译测试都过了,但"确实从 0 变到非 0 的那一刻按钮正确出现"这个具体转场还没有真机验证过。

- **`export`/`import` 账号功能还没接进我们的 UI**。`src/daemon/accounts/`(vendor 自 agent-hub-accounts,见 `2026-08-26-vendor-agent-hub-accounts.md`)还没搬 `transfer.ts`——已经确认了它的行为(事务性回滚、bundle 里含真实凭据)和"应该走 vscode.window.showOpenDialog/showSaveDialog"这个方向,但接入方案(daemon 新路由、UI 入口放哪)还没有正式定下来。

- **除 Keychain 和会话缓存外,是否还有第三处登录态来源没查清**。清掉 Keychain 槽位 + `~/.gemini/jetski-standalone-oauth-token` 这两处**通常**能让 Antigravity 显示登录页,但实测出现过清掉后仍是登录态的情况——`finish` 因此设计成不依赖任何文件是否存在来判断,只认"`connect` 能不能读到活动凭证",绕开了这个问题而不是解决它。

- **全新状态(空账号列表)下,没有"收编当前已登录账号"的入口**。如果用户装完插件时 Antigravity 本来就登录着,现在点 Add new account 会走一遍完整的登出→登录流程;更省事的做法是先做一次 `connect` 把现有登录直接收编,不需要真的登出再登回来,但这条路径目前 UI 上没有入口。
