# 又一次账号损坏:自动捕获的猜测机制在我们的环境里结构性地不可能猜对(2026-08-23)

**日期**:2026-08-23 · 涉及 `daemon.ts`、`semanticLocator.ts`、`addAccountPrompt.ts`

**发生了什么**:用户用新 Google 账号 `user-beta@example.com` 完成登录后,daemon 的自动捕获(`watchForNewSignIn()`)把它存成了 `user-gamma@example.com`——一个此前已经被 `remove` 删掉、根本不该存在的账号名。上一版加的"回滚已知账号"守卫没拦住,因为 `user-gamma` 当时已经不在已知列表里了,守卫只保护"已知账号不被覆盖",没有覆盖"编错新账号名字"这种情况。

**根因,而且这次是决定性的**:`connect` 不带参数时靠 `recentAntigravityEmail()` 猜账号 ID,而这个函数扫的是 `~/.gemini/antigravity-cli/log/`——独立 `agy` CLI 工具的日志目录。我们的 hub 是 `--app_data_dir=antigravity` 启动的,写的是完全不同的 `~/.gemini/antigravity/log/`,现场验证过后者**从不产生** `email=` 这个格式的日志行(`grep -al 'email=' antigravity/log/*.log` 结果为 0)。

也就是说这不是"日志滞后一会儿,等等就好"——**这套猜测机制在我们的环境里结构性地不可能猜对**,永远冻结在 `antigravity-cli/log` 最后一次被写入时的邮箱(这次是 10:54,那时活跃账号恰好是 user-gamma),不管用户后来通过 hub 登录成谁,猜出来的都是同一个值。上一版的"逐次加固守卫"方向从一开始就错了:问题不是猜测偶尔失手,是猜测的信息源和真实事件毫不相干。

**修法:不再猜,读真实身份**。Antigravity 原生 Account 面板("Email <address> Sign Out")本身就显示着当前真正登录的邮箱——这是唯一可靠的来源。新增 `SemanticLocator.findAccountPanelEmail()`:匹配邮箱格式的叶子文本节点,且上下文包含 "Sign Out" 字样(面板平时 `display:none` 但节点始终在 DOM 里,不需要先点开);现场验证过打开我们自己的账号弹窗(5 行,同样都是邮箱)不会干扰这个匹配,因为弹窗行的上下文是 "Switch"/"In Use",不是 "Sign Out"。

流程整体改成:daemon 侧删掉整个 `watchForNewSignIn()` 轮询,新增 `POST /api/add-account/report-identity`,只接受显式 `accountId`——不再有任何猜测代码路径。前端在 `settings-standalone` iframe(Account 面板只在这里)里轮询该面板的邮箱,读到后主动上报。`connect <显式ID>` 因为 ID 来源可信,不再需要 snapshot/restore 那套撤销保护——那套保护针对的正是"写入前不知道对不对"的场景,现在写之前就已经确定是对的。

`finish` 端点(手动兜底,已无 UI 调用)保留了旧的猜测逻辑作为**次选**,但现在优先接受调用方显式传入的 `accountId`——用 curl 强制收尾时,应该传真实邮箱,不要依赖猜测。

**现场恢复**:受损的 `user-gamma@example.com` 档案已用用户确认的真实邮箱 `user-beta@example.com` 重新 `connect`(显式 ID,安全),再 `remove` 掉那个错标条目。最终 5 个账号,`user-beta` active,无残留。
