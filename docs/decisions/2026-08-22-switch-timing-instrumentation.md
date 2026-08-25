# 切换耗时:计时埋点为什么一开始测不准,以及第一个优化点

**日期**:2026-08-22 · 涉及 `daemon.ts`、`hubRestart.ts`、`cdpInjector.ts`、`main.ts`

第一版 `[TIMING] switch` 日志(`cliMs`/`hubStopMs`/`windowReloadMs`/`grandTotalMs`)测出来的总耗时只有 ~1 秒,但实测从"hub restart result"打出来到前端真正重新发出 `GET /api/accounts` 之间,日志时间戳相差 **35~40 秒**。原因是 `windowReloadMs` 测的只是 CDP `Page.reload()` 这条命令本身的往返时间——这条命令一旦让 VS Code 开始导航就立刻返回,并不等页面真正加载完、插件重新激活、新 `agy --hub` 冷启动到健康(`waitForServerReady` 最多轮询 15 秒)。这一整段真实耗时完全没被计时覆盖。

在这之上还叠加了一个纯人为的浪费:`main.ts` 原来只有弹窗被打开时才会 `fetchLiveAccounts()`,常驻的只有一个 20 秒的后台轮询——就算 VS Code 和新 hub 已经完全就绪,UI 数据也要平白再等最多 20 秒才会刷新。

**已做的第一个优化**:脚本一注入就立刻主动 fetch 一次(`main.ts` 顶层直接调用,不再只在弹窗打开或轮询触发时调用),砍掉这段纯等待。

**补的埋点**(还没做进一步优化,先能测出真实数字):`cdpInjector.ts` 的注入成功日志改用带时间戳的 `log()`(`[CDP_INJECT] injected into ...`),`accountStore.ts` 新增 `logRuntimeBoot()`,脚本启动时打一条 `runtime booted, fetching accounts` 到 daemon 日志。现在可以用 `[HUB_RESTART] reloaded VS Code window` → `[CDP_INJECT] injected into ...` → `[FRONTEND] ... runtime booted` 三个时间戳算出"reload 命令发出"到"脚本重新注入"到"前端真正活过来"分别花了多久,而不是只能靠人工数日志间隔猜。

**实测拆解(2026-08-22 稍晚)**:单独起一个 `agy --hub` 进程直接测(spawn 到 HTTP 200)只要 **6.15s**;`acquireInstalledBinaryPath` 里每次 start 都会做的更新清单请求(`fetchReleaseManifest`,打 `antigravity-cli-auto-updater-...run.app/manifests/darwin_arm64.json`)实测 **~0.56s**。两者相加 ~6.7s,而实际观测到的整窗口 reload 总耗时是 30-36s——差额 24-29s 基本可以确定是 VS Code 自己重新初始化整个 workbench UI + 其它所有插件一起重新 `activate()` 的开销,不是 hub 或本插件的问题。

**已验证不可行的方向:单独用 `Developer: Restart Extension Host` 替代整窗口 reload**。用 CDP 模拟按键(Cmd+Shift+P → 输入命令 → 回车)实测:命令确实执行了(旧 hub 进程被杀,和 `deactivate()` 里的 `serverManager.stop()` 行为吻合),但等了 60 秒**没有任何新 hub 被拉起、也没有 webview 重新连接**——iframe 还停在死端口上,和"卡死"bug 现象完全一样,最后还是靠 `Page.reload()` 救回来的。

根本原因:整窗口 reload 会触发 VS Code 自己"恢复之前的面板布局"逻辑,面板一恢复可见就会重新 `resolveWebviewView`,顺带重新调用 `serverManager.start()`；而 `Restart Extension Host` 只重启插件宿主进程本身,不会主动帮你把已经打开的 webview 面板重新"点亮"——面板还在,但没人去戳它重新 resolve,新 hub 也就永远不会被拉起。要用这条路真正省时间,还得再自己想办法自动触发面板重新可见(比如模拟切走再切回),可靠性和复杂度都不比现在这个方案低,投入产出比不划算,已放弃这个方向。

**结论**:24-29s 这部分目前认为是 VS Code 自身机制的硬成本,没有找到更轻量、同样可靠的替代触发方式。真正的硬成本只有 hub 冷启动 + 更新检查那 ~6.7s,除非换更快的启动路径否则很难再压缩。

**又查了两条路,都是死路(2026-08-22 更晚)**:

1. **给 `agy --hub` 发 SIGHUP 让它原地重读 Keychain,不用整个重启**——实测:进程直接忽略 SIGHUP(发完照样存活、端口照样 200),不会做任何重载。二进制里 `HandleSIGHUP`/`Ignoring SIGHUPs` 大概率是"daemon 存活过终端断开"这种通用行为(常见于长驻进程,防止 SSH/终端断开时收到 SIGHUP 被杀),跟账号切换无关。没有任何信号能让已经在跑的 hub 原地重新读取凭证——`AuthProvider` 一旦在启动时绑定,只能靠重启进程才能换。

2. **`antigravity.serverUrl` 配置后门**——`desktopSetup()`(L295853)里,这个配置(或环境变量 `ANTIGRAVITY_SERVER_URL`)一旦设置,会整个跳过 `serverManager.start()`(不做二进制更新检查网络请求、不自己 spawn),直接把配置的 URL 当成已经在跑的远程 server 用。本来是给连远程 cloudtop/Jetski server 用的后门。但改这个配置触发的 `onDidChangeConfiguration` 处理(L282480)只调用 `provider.refresh()`——和 `Restart Extension Host`/`antigravity.reconnect` 命令是**同一个清缓存函数**,不会让已经打开的 webview 面板重新 resolve。就算我们自己常驻管理并预热一个 hub、把这个配置指过去,充其量只能省掉 window reload 之后"再等新 hub 冷启动"那 ~6.7s(挪到 reload 前并行做),换来的代价是要自己接管 hub 进程生命周期、要持久改用户的 VS Code 设置(这个字段语义是"远程服务器",UI 上大概率会显示 "Remote Antigravity server" 之类的文案),而且完全动不了真正的大头(24-29s 的 VS Code 自身重新初始化)。投入产出比不划算,不建议做。

三条路(SIGHUP / Restart Extension Host / serverUrl 后门)都查过了,没有一条能绕开"必须让 VS Code 整窗口重新识别面板"这个硬约束。
