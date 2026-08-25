# ✅ 真正的优化:同端口自行 respawn(30-36s → ~7s)

**日期**:2026-08-22 · 涉及 `hubRestart.ts`

前面三条路全部卡在同一个前提上:**默认必须由 VS Code 来 spawn 新 hub**。但这个前提本身是错的——我们完全可以自己 spawn。

之前"只 reload 单个 iframe"之所以失败,唯一原因是杀掉 hub 后那个端口上没有进程在监听了,iframe 重新请求必然 connection refused。那么**我们自己在同一个端口上起一个新 hub**,iframe 的 URL 就依然有效,只需要 reload iframe,VS Code 那套"重建整个窗口"的开销就完全不需要了。

**实测结果(现场跑通)**:

| 阶段 | 耗时 |
|---|---|
| SIGTERM 旧 hub 到退出 | 1112ms |
| 自己在同端口 spawn 新 hub 到健康 | 5930ms |
| reload iframe | 8ms |
| **总计** | **7062ms** |

对比整窗口 reload 的 30-36s,**快 4-5 倍**。reload 后验证 iframe 内容完全正常(Settings 各 tab、项目列表、账号信息都在,`window.AntigravityEnhancerRuntime` 也自动重新注入了),零 chrome-error。

**实现要点**:
- **原样复制 argv,不要照模板重建**:`readHubSpec()` 直接读活进程的 `ps -o command=` 和 `lsof -d cwd`。extension 会按 workspace folder 逐个追加 `--add-dir`,还会拼上用户配置的 `serverArgs`——照固定模板重建会静默丢掉这些,起出来的 hub 对 workspace 的视野和原来不一致。
- **必须 `detached: true` + `unref()`**:否则 daemon 一重启就会连带把用户的 hub 杀掉。
- **保留整窗口 reload 作为 fallback**:同端口 respawn 任何一步失败(读不到 argv、端口被占、新 hub 起不来)都回退到老方案,保证最差情况不比以前糟。

**双 hub 场景与异步回收**:我们 SIGTERM 掉 extension 自己 spawn 的那个 hub 时,它的 `exit` 回调会把 `serverProcess`/`serverUrl` 清空。已经打开的 webview 不受影响(它们指向我们的新 hub),但**如果用户之后新开一个 Antigravity 面板**,extension 会走 `start()` 再 spawn 一个它自己的 hub(新的临时端口),这时机器上会同时有两个 hub。两者读同一个 Keychain 槽位,账号一致,功能上不冲突。

> ⚠️ **下面两道"保险"已经不是现在的回收逻辑。** 2026-08-25 改成直接跟踪自己 spawn 的 hub pid(`ownedHubPids`),不再需要从 CDP target 反推归属,见 [`2026-08-25-agent-hub-accounts-patterns-adopted.md`](./2026-08-25-agent-hub-accounts-patterns-adopted.md) 第 2 条。这段仍保留是因为"两个 hub 不能按新旧回收、只能按有没有 iframe 引用来判断"这个结论没变,是新旧两版逻辑共同的前提。

这两个 hub **不能按"新旧"来回收**——它们各自服务不同的 webview:我们的在原端口服务已经打开的 iframe,extension 那个在新端口服务新面板,杀掉任意一个都会让对应的 webview 变成 connection refused。唯一安全的判据是**"还有没有 iframe 指向这个端口"**。

`startHubReaperLoop()`(30s 一轮)按这个判据异步回收:从 CDP target 列表里收集所有被引用的 `127.0.0.1:<port>`,任何 hub 的端口不在其中即为孤儿。两道保险:
- **要求连续两次判定为孤儿才动手**。extension 是先 spawn hub、等 `waitForServerReady` 通过后才把 iframe 接上去的,单次快照可能正好落在这个空档里,把刚起来的 hub 误判成孤儿。
- **只有存在 2 个及以上 hub 时才回收**。只剩一个 hub 且没有 iframe 指向它,那只是用户把所有 Antigravity 面板关了、后端闲置着,是 extension 正常的持有状态,不该由我们去杀。

另外 CDP 不可达时直接跳过这一轮(判断不了谁在用,就假定都在用),`restartInProgress` 期间也跳过(重启过程中状态本来就是不一致的)。

**剩余耗时构成**:7s 里 5.9s 是 hub 二进制冷启动(实测单独起也要 6.15s,是硬成本),1.1s 是等旧进程优雅退出。想再压缩只能从"预热一个 hub"之类的方向想,但那要自己接管整个进程生命周期,复杂度陡增,当前不做。
