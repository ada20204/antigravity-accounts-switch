# 私用打包:装成 LaunchAgent,不做 .vsix,不上应用商店

> **(已被取代 2026-08-26)** 需求变了:用户明确要"最终结构一定是一个插件",不只是
> "私下装得方便"。daemon 本身折进了 Antigravity extension host,LaunchAgent 这层
> 整个不需要了(连带 `scripts/install.sh`/`uninstall.sh` 已删除)。见
> [`2026-08-26-extension-host-daemon.md`](./2026-08-26-extension-host-daemon.md)。
> 本文保留仅供追溯当时为什么选 LaunchAgent。

## 要解决的问题

每次干活前有三件仓库里查不到的前提:开 Terminal.app(不能 SSH)手动跑
`npm run daemon`;确认 VS Code 开着 CDP 端口 9222;另开一个终端跑
`npm run dev`(Vite)——不然 `cdpInjector.ts` 注入的 loader 指向的
`http://localhost:5173/...` 找不到人应答。三件事只写在 `docs/README.md`
里,新机器/新会话每次都要重新踩一遍。

## 为什么不做成 .vsix

考虑过打包成真正的 VS Code 扩展。两个理由否掉:

1. **不解决实际痛点**。CDP 调试端口是 Electron/Chromium 启动时的参数,一个已经在跑的进程没法被扩展从内部追加这个参数——不管打包成什么形态,"VS Code 得带着 `--remote-debugging-port` 启动"这条都躲不掉,.vsix 并不能替你自动化这一步。
2. **换来的只有工具链成本**。要接入 `@vscode/vsce`、写 manifest、定义 activation events,还不确定 Antigravity 这个 fork 是否真的支持标准的"Install from VSIX"流程——全部代价没有换回任何一条前提的消除。

## 为什么不上应用商店

用户本人已经在这轮对话里明确排除:这套机制的核心能力(CDP 直接改另一个厂商扩展自己的 webview、绕过其 CSP)加上 daemon 本身要读写 OAuth 凭证,大概率过不了商店审核,而且 `agent-hub-accounts` 这个依赖本身也没打算公开。见
[`cdp-injection-vs-bridge-patch.md`](./cdp-injection-vs-bridge-patch.md)。

## 选择:LaunchAgent

真正卡住人的是 daemon 必须在 GUI 登录会话里跑(macOS Keychain 的
`security -w` 在 SSH 下 exit 36)——Terminal.app 能用正是因为它天然带着这个
会话。per-user LaunchAgent(`launchctl bootstrap gui/<uid>`)同样跑在 GUI
会话里,效果等价于"自动帮你开一个 Terminal.app",而且开机自启,不需要每次
手动重开。

这不是凭空设计的方案——host 上已经有 `~/Library/LaunchAgents/
com.agent-hub.listener.plist` 和 `com.agent-hub.loop.plist`(属于另一个项目
`feishu-agent-hub`,和 `agent-hub-accounts` 只是撞了名字前缀,不是同一个东西)
在正常跑,直接照抄了它们的写法:`ProgramArguments` 是裸的
`node <script> <args>`(不走 `npm run`,launchd 不过 shell,也不解析 PATH
里的 `npm`),`WorkingDirectory` 钉死仓库路径,`RunAtLoad`+`KeepAlive` 都开着,
`StandardOutPath`/`StandardErrorPath` 落盘。

`scripts/install.sh`/`uninstall.sh` 把这套 plist 生成+`bootstrap`/`bootout`
封装成一次性命令(`npm run install-daemon` / `uninstall-daemon`),幂等,
可以在 `git pull` 之后随时重跑。

## CDP 端口这条为什么没自动化

打包再怎么换形态都碰不了这条——不管是 LaunchAgent 还是假想中的 .vsix,都
不能往一个已经在跑的 Electron 进程头上追加启动参数,只能在下次启动时生效。
现场核实过(`ssh host` 只读检查):这台机器上 VS Code 已经带着这个参数在跑
(`lsof -iTCP:9222` 能看到 `Code` 进程持有),所以现状是"已经满足",没有做
自动化的必要;如果哪天 VS Code 更新后不再默认带这个参数,再补一个启动器
包装脚本(`open -a "Visual Studio Code" --args --remote-debugging-port=9222`
这类)也不迟——`install.sh` 现在只是打印一句检查提示(`lsof -iTCP:9222
-sTCP:LISTEN -n -P`),没有强制。

## 顺带解决:runtime bundle 不再依赖常驻的 Vite dev server

daemon 自己在 63820 端口新增了 `/runtime.js`(和 `/style.css`)静态路由,
serve `npm run build:runtime` 的产物。`cdpInjector.ts` 的 `LOADER_SRC` 按
`ENHANCER_DEV` 环境变量二选一:`npm run daemon`(继续 `ENHANCER_DEV=1`)走
Vite 热重载源码,行为和之前完全一致;LaunchAgent 装的是不带这个环境变量的
版本,走打包产物,不需要 Vite 常驻。改 `src/runtime/` 代码后要
`npm run build:runtime` 重新打包,LaunchAgent 跑的 daemon 才会拿到新版本
(不会自动感知源码变化——这是刻意的,打包模式本来就不该背着一份随时可能
崩的开发依赖)。

## 验证

`npx tsc --noEmit` 干净。`npm run build:runtime` 产出 `dist/runtime.js`;
daemon 不带 `ENHANCER_DEV` 起时,`curl 127.0.0.1:63820/runtime.js` 能拿到内容,
CDP 注入的 loader 改指向这个地址后现场验证过能正常加载(控制台无报错)。
`scripts/install.sh` 跑完后 `launchctl list | grep antigravity-accounts-
enhancer` 能看到已加载;daemon 端改动(daemon.ts、cdpInjector.ts)照例需要
重启才生效,`npm run install-daemon` 本身就会重新 `bootout`+`bootstrap`,
等同于重启。LaunchAgent 装完之后"关掉 Terminal.app、daemon 还活着、账号切换
仍然正常"这条最终验证还没有现场做过。
