# daemon 折进 extension host,取代 LaunchAgent

取代 [`2026-08-25-private-packaging-launchagent.md`](./2026-08-25-private-packaging-launchagent.md)——那条决策本身没做错什么,是需求变了:用户明确要"最终结构一定是一个插件",而不只是"私下装得方便"。

## 为什么不是简单地把 LaunchAgent 换成 VSIX

一开始的想法是:保留独立 daemon 进程,只是把"怎么启动它"从 LaunchAgent 换成 VSIX 装好后跑一段安装脚本。研究了 `~/antigravity-sync-mcp`(用户自己的另一个项目,`packages/sidecar`)之后发现这个想法本身就错了方向。

`packages/sidecar/src/extension.js` 的 `activate(context)`(716 行)完全没有为它自己的核心逻辑(CDP 心跳、auto-accept 轮询)启动任何独立后台进程——就是 `setInterval`,通过 `context.subscriptions.push({dispose: ...})` 注册。`deactivate()`(2188 行)只有一行:`stopAutoAccept()`。VS Code 自己的扩展生命周期就是全部的进程生命周期管理,不需要 PID 文件、崩溃重启、安装脚本。sidecar 唯一 spawn 独立进程的地方(`restart-worker.js`)只用于一件事:重启 Antigravity App 本身——这是唯一"必须活得比 extension host 更久"的任务,常规逻辑不需要。

这直接解决了这一整个 session 反复出现的问题:daemon 端每次改完代码,都要提醒用户"记得去 Terminal 重启",而且不止一次忘了提醒或者用户忘了做,导致验证的其实是旧代码。daemon 折进 extension host 之后,"装/更新/重载扩展"和"重启 daemon"是同一件事,VS Code 自己保证这件事做对。

## 两个 LaunchAgent 方案不需要处理、但这个方案必须处理的问题

单一全局 daemon(不管是手动跑还是 LaunchAgent)只有一份,不存在"多份互相打架"的问题。折进 extension host 之后,**每个 VS Code 窗口都有自己独立的 extension host 进程**,也就有了自己独立的一份 daemon——这带来两个新问题,都是在真机上核实过、不是假设:

1. **CDP 端口 9222 是整个 VS Code 实例共享的,不是每窗口一个。** `ps aux` 核实:当前跑着的 3 个 renderer 进程,命令行里的 `--remote-debugging-port=9222` 和 `--vscode-window-config=vscode:a92c...` 完全一致——这个 flag 是整个 App 启动时定的,不是每次开窗口单独给。
2. **`agy --hub` 是每窗口各一个**,机器上已经观察到两个并存(不同 workspace,不同端口)。

两者叠加:如果 `activate()` 直接 `listen(63820)`,第二个窗口的 extension host 会 `EADDRINUSE`;如果 `cdpInjector.ts` 不做端口过滤,一个窗口的注入循环会看见并试图注入*所有*窗口的 iframe,不只是自己的。而且 `hubRestart.ts` 原来的 `findHubPids()`(`pgrep -f "agy --hub"`)本来就没有任何按窗口区分的逻辑——单一全局 daemon 下这是隐藏的假设,没暴露成 bug;多 daemon 下会变成真的 bug(`restartAntigravityHub()` 可能重启了别的窗口的 hub)。

### 修法

- **daemon 端口**:`extension.ts` 的 `listenOnFreePort()`,从 63820 往上试到 63829,直接对真实 `server.listen()` 试(不是先探测再 listen,那样有 TOCTOU 窗口)。注入 loader 的 `<script src>` 在注入那一刻就把这个端口写进去(反正每次注入本来就知道往哪个 target 打)。
- **hub 归属**:`hubRestart.ts` 新增 `setOwnWorkspacePaths()`(`activate()` 里用 `vscode.workspace.workspaceFolders` 设一次),`findHubPids()` 内部按每个 pid 的 `--add-dir` 参数(`readHubSpec()` 早就读出来了,只是原来没用来过滤)比对是否属于本窗口的 workspace folder——这正是 Antigravity 自己的 extension 当初 spawn hub 时用来生成 `--add-dir` 的同一个信号,不是新发明的判断依据。三处调用点(`stopHubProcesses`、`reapOrphanedHubs`、`restartAntigravityHub`)全部受益,不用逐个改。工作区为空(没打开文件夹)时退化成不过滤——这种情况下没有 `--add-dir` 可比对,维持旧行为好过瞎猜。
- **CDP 注入范围**:新增 `getOwnHubPorts()`(在 `hubRestart.ts`,复用同一套过滤后的 `findHubPids()`),`cdpInjector.ts` 每个 tick 先问一遍"我自己的 hub 端口有哪些",只对这些端口上的 iframe 做 target 匹配。

## 顺带修的一个新出现的竞态

`addAccountBeginInFlight`(`/api/add-account/begin` 的重入保护)原来是一个进程内变量——单一全局 daemon 下这就够了。多 daemon 之后,窗口 A 进程里的这个变量对窗口 B 的进程完全不可见,`pendingAdd` 落盘能防住大部分场景,但它要等好几个 await(一次 `--verify`、可能的 `connect`、一次完整 hub 重启)之后才写盘,这段窗口期内两个窗口都发起 begin() 是有真实可能被同时放行的。改成跨进程文件锁(`ADD_ACCOUNT_LOCK_FILE`,`O_CREAT|O_EXCL`,同款 jsonStore.ts 已经在用的原子写模式),带一个 60 秒过期回收(某个窗口的 daemon 在持锁期间崩溃,不能让 add-account 永久锁死)。

`pendingAdd`/`lastAddedAccountId`/`knownPlans` 这三个仍然共享同一份 `os.tmpdir()` 文件、不按窗口区分——这是刻意的,不是遗漏:它们描述的是一个共享的底层事实(Keychain 只有一个活跃槽位;plan 标签是按账号不是按窗口),窗口 B 应该看得到窗口 A 触发的 sign-out 状态,而不是各自维护一份互相不知道对方存在的假象。

## Output Channel 日志

daemon 折进 extension host 之后,日志除了原来那份文件,也该能在 `View > Output` 里看到。参考了 sidecar 的 `structured-log.js`(66-99 行):每条日志写一份完整记录到文件,同时写一行精简版到 Output Channel,用一个 `debug` 级别开关控制要不要显示——一次调用两个目的地,一个音量开关。

按现有 tag 实际触发频率分类(不是按 level,这个项目的日志本来就是按 tag 分类的,沿用这个划分维度更自然):

- **默认显示**(一次性或者跟真实用户操作一一对应):`BOOT`、`SWITCH`、`TIMING`、`HUB_RESTART`、`ADD_ACCOUNT`、`CONNECT`、`LOGIN`、`REMOVE`、`PLAN`、`CDP_INJECT`(只在真正注入时记,不在"已存在"的空转 tick 记)、`JSON_STORE`(只在非 ENOENT 的读错误时记)、`HUB_REAP` 里两条真正执行了回收的行。
- **仅 verbose**(`antigravityAccountsEnhancer.verboseLogging` 打开才在 Output 里显示,文件里始终都有):`REQ`(每个 HTTP 请求都记,频率最高)、`FRONTEND`(前端每次上报都记)、`HUB_REAP` 里"looks orphaned (1/2)"这条计数进度行(会重复打印,不是一次性事件)。

## 现场踩的坑:ESM 扩展装上之后完全不激活,且没有任何报错

装好 `.vsix`、重启之后,`activate()` 一次都没跑过——判断依据:我们自己的 Output Channel(`activate()` 第一行就创建)在频道下拉列表里压根不存在,daemon 端口(63820-63829)没有任何进程监听,日志文件里重启后再没出现过新行(连 `[BOOT]` 都没有)。这台机器启动 VS Code 时只开了 `--remote-debugging-port`,没开 `--inspect-extensions`,CDP 摸不到 extension host 进程,看不到它自己的报错——只能靠端口/日志/Output 频道这些外部信号反推。

根因:这个仓库的根 `package.json` 原来带 `"type": "module"`(因为 `src/runtime/`、`test/*.mjs` 这些一直是 ESM 写法),`tsconfig.extension.json` 之前没覆盖 `module`,继承了基础配置的 `ESNext`,编译出来的 `out/daemon/*.js` 是真正的 `import`/`export` 语法。VS Code 的 extension host 通过 `require()` 加载 `main` 指向的文件——`require()` 没法加载 ES module,这个失败发生在我们自己的任何代码跑起来之前,所以什么都打印不出来,只会在 VS Code 内部日志(这台机器上摸不到)留痕。

`antigravity-sync-mcp` 的 sidecar 早就避开了这整类问题:它是纯 CommonJS(没有 `"type": "module"`),这是已经在这个具体 Antigravity 版本上验证过能跑的组合,应该一开始就照抄,而不是假设"现代 VS Code 支持 ESM 扩展"这个不确定的前提。

### 修法

- `tsconfig.extension.json` 加 `"module": "CommonJS"`——`src/daemon/**` 单独编译成 CJS,`src/runtime/**`(Vite 打包)和 `test/*.mjs`(扩展名本身就固定是 ESM)都不受影响。
- 根 `package.json` 去掉 `"type": "module"`——检查过仓库里没有任何东西真的依赖这个字段:`vite.config.ts` 由 Vite 自己处理,`.mjs` 文件的模块类型不看这个字段,`src/runtime/**` 由 Vite 打包不受它影响。去掉之后整个仓库默认 CommonJS,跟 `tsc` 现在的输出直接一致,不需要再往 `out/` 里塞一个单独的 `package.json` 覆盖类型这种更绕的方案。
- `extension.ts` 里原来用 `import.meta.url` + `fileURLToPath` 定位自己的路径(ESM 专属,CommonJS 编译目标下 TypeScript 直接编译报错),改成 CommonJS 原生就有的 `__dirname`,不需要额外 import。

## 现场看到的 `[LAUNCH ERROR]`:Antigravity 原生扩展怎么"同步"新 hub 的

真实切换一次之后,Antigravity 自己的 Output 频道(不是我们的)打出一行:
`[LAUNCH ERROR] Server process exited unexpectedly with code 0, signal null`。
查了它自己的 `AntigravityServerManager`(`extension.js`)——`serverProcess.on('exit', ...)`
的处理逻辑就两行:

```js
this.serverProcess = undefined;
this.serverUrl = undefined;
```

**它不会重新适配我们换上去的新 hub,也不会自动重新 spawn**——同端口快速换血
(`spawnHubOnSamePort`)杀掉的是它自己当初 spawn 出来、它自己盯着的那个进程,它唯一
的反应是把自己的记账清空成"没有服务器在跑"。只要没有别的东西再去调用它的
`start()`,它这个"我以为没有服务器"的状态和 webview 实际连着的新 hub 之间的错位
会一直稳定存在,不会自己修复,也不会造成额外问题。真正会触发它重新调用
`start()`的场景——比如打开一个新面板——正是 `docs/decisions/2026-08-22-same-port-respawn-optimization.md`
里"两个 hub 合法共存"那条已经点出来、reaper 也已经在处理的场景:新面板会让它在
一个新的临时端口上再起一个它自己知道的 hub,旧的那个(我们换上去、它已经"忘记"
的)就靠 reaper 的两层判断收掉。这条 `[LAUNCH ERROR]` 日志本身只是噪音,不代表
出了新问题。

## 日志"有效信息占比"

现场跑起来之后发现好几行日志有效信息被淹没在噪音里:

- `[CDP_INJECT] injected into <url>` 打印的是完整 URL,而 query string(`?extensionView=true&extensionVariant=vs-code&useWebSocket=true&hostTheme=dark&enableMicrophone=false&workspaceUri=...`)每次都一模一样,真正有用的只有"是 main 还是 settings 视图"和端口号。`cdpInjector.ts` 新增 `describeTarget()`,只打印这两样。
- `[SWITCH] cli succeeded <id> <300字符原始JSON>`——能走到这一行本身就说明 CLI 没抛错,原始 JSON 没有额外信息,紧接着的 `[TIMING]` 已经把结果结构化打过一遍了,纯重复。去掉了 300 字符截断,只留账号 id。
- `[SWITCH]`/`[ADD_ACCOUNT]`/`[HUB_RESTART]` 里三处直接把整个 `HubRestartResult` 对象打进日志(`hub restart result`、`hub restarted into signed-out state`、`hub restarted onto captured account`、`sign-in restart result`)——这个对象已经有一个专门做人类可读摘要的字段 `detail`(比如 "respawned hub on port 49454 (pid 68658), reloaded 2 iframe(s)"),四处全部改成只打 `.detail`;失败时该有的信号(`onStoppedError`/`reloadFailed`)本来就会经由后面的 `throw`/`FAILED` 日志行浮现,不会因为这次精简丢掉。

## 验证

`npx tsc --noEmit` 干净;`npm run compile`(`tsc -p tsconfig.extension.json`)产出 `out/daemon/*.js`;`npm run build:runtime` 照常产出 `dist/runtime.js`;`npm run package`(`vsce package --no-dependencies --no-rewrite-relative-links --allow-missing-repository`)成功产出 `.vsix`,内容核对过(`out/daemon/`、`dist/`、`package.json`、`README.md`,没有 `src/`/`test/`/`docs/`)。`npm test` 两条结构测试都过(`extension.ts` 993 行、`hubRestart.ts` 663 行都记进了行数棘轮)。

**还没有现场验证的**:装这份 `.vsix` 到真实 Antigravity、单窗口下完整走一遍切换/添加账号流程;开两个窗口验证端口分配、hub 归属过滤、CDP 注入范围确实按窗口隔离;Output Channel 里确认 tag 分类符合预期。这些需要你在 GUI 会话里手动装/测——和这个 session 里所有 daemon 端改动一样,不是我能从这边验证的。
