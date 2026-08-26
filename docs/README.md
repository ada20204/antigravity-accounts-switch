# 文档索引

先看这里,再决定翻哪一份。

## 现行文档

| 文档 | 回答什么问题 |
|---|---|
| [`FLOWS.md`](./FLOWS.md) | **实际发生什么**。三种状态下的完整流程:全新状态、已登录稳态、登出并添加新账号。想知道"现在是怎么跑的",看这份。 |
| [`decisions/`](./decisions/README.md) | **为什么这么做**。每条设计取舍单独一份文件,原因、试过但失败的方案、以及失败的证据。想知道"为什么不用另一种更简单的做法",先看 [`decisions/README.md`](./decisions/README.md) 的索引按主题找,大概率已经试过并记录了为什么不行。 |
| [`ISSUES.md`](./ISSUES.md) | **还没做完/还没验证的事**。跟 `decisions/` 不同——那是已经定论的,这份是还开着的,做完就从里面删掉。 |

代码注释刻意保持简短,只留结论和指向这里的引用。**不要把设计原理写回代码注释**,那样会变成两处需要同步的真相。

## 项目结构

```
src/
  daemon/       daemon 逻辑,现在跑在 Antigravity extension host 进程里——见下面"开工前"
    extension.ts     activate()/deactivate() 入口 + HTTP 路由(原 daemon.ts 的内容整体搬进来)
    hubRestart.ts    agy --hub 进程生命周期管理(现在按 workspace folder 过滤,只管本窗口自己的 hub)
    cdpInjector.ts   往 VS Code webview 注入 runtime bundle 的 CDP 循环(同样按本窗口的 hub 端口过滤)
    cliRunner.ts     agent-hub-accounts CLI 的注入安全封装
    httpUtils.ts     共享的请求体读取/响应/CORS 白名单
    logger.ts        文件日志 + VS Code Output Channel(按 tag 分默认可见/仅 verbose)
  runtime/      注入进 Antigravity webview 的前端代码(浏览器环境,非 Node)
    adapters/    读取/改写 Antigravity 原生 DOM 的适配层(语义定位、邮箱/Plan 抓取)
    services/    AccountStore——状态与 daemon 通信
    ui/          实际渲染的组件(账号弹窗、Settings 卡片、渲染防抖工具等)
    main.ts      前端入口,由 daemon 自己在 /runtime.js 提供
scripts/       bridge.js 的 patch/unpatch(历史方案,已被 CDP 注入取代)、Keychain 诊断脚本
docs/          见上表
```

两侧永远不共享 import——`daemon/` 现在跑在 extension host(仍是 Node 进程),`runtime/` 是浏览器里的注入代码,中间只通过 HTTP(daemon 自己挑的端口,63820-63829)通信,没有第三条路径。见 [`FLOWS.md`](./FLOWS.md) 了解两者具体怎么协作。

## 历史文档(勿作依据)

以下三份是早期产物,均已在开头标注失效点,保留只为追溯当时的判断:

- [`2026-08-22-session-review-and-next-steps.md`](./2026-08-22-session-review-and-next-steps.md) —— 过程快照,多处结论已被推翻
- [`ANTIGRAVITY_ARCHITECTURE_AND_MULTI_ACCOUNT_DESIGN.md`](./ANTIGRAVITY_ARCHITECTURE_AND_MULTI_ACCOUNT_DESIGN.md) —— 架构设想,其中切号流水线第 3 步(`RESTART_LS`)从未实现
- [`ANTIGRAVITY_MULTI_ACCOUNT_DELIVERY_AND_OPERATION_GUIDE.md`](./ANTIGRAVITY_MULTI_ACCOUNT_DELIVERY_AND_OPERATION_GUIDE.md) —— 联调指南,添加账号一节已整体作废

## 开工前必须知道的几件事

**日常使用**:`npm run package`(`vsce package`)产出 `.vsix`,在 Antigravity 里
"Install from VSIX" 装一次。daemon 现在跑在 extension host 进程里,装/更新/重载
扩展本身就是重启 daemon——不再需要 Terminal、LaunchAgent 或另开 Vite。见
[`decisions/2026-08-26-extension-host-daemon.md`](./decisions/2026-08-26-extension-host-daemon.md)。

1. **VS Code 必须开着 CDP 端口 9222。** 注入完全依赖它——页面 CSP 封死了常规
   `<script src>` 注入。这条不管 daemon 跑在哪里都躲不掉;已确认这个端口是整个
   VS Code 实例共享的(开几个窗口都是同一个 9222),不是每窗口各一个。
2. **每个 VS Code 窗口是完全独立的一份 daemon**(各自的 extension host 进程,
   各自在 63820-63829 里挑一个空闲端口,只管自己窗口对应的 `agy --hub`——按
   `--add-dir` 匹配 workspace folder,不会碰到别的窗口的 hub)。开两个窗口互不
   干扰,但也意味着"重启 daemon"是按窗口来的,不是全局一次性的。
3. **改 `src/daemon/` 的代码后需要重新编译再重载窗口**:`npm run compile`(tsc
   编译到 `out/`)+ Antigravity 里 "Reload Window"。改 `src/runtime/` 的代码走
   `npm run dev`(Vite),daemon 自己 serve 的是 `npm run build:runtime` 的产物,
   改完前端代码同样要重新构建(或跑 dev server 临时调试,见下)。
4. **日志有两处**:文件在 `$TMPDIR/antigravity-accounts-enhancer.log`(macOS 上
   在 `/var/folders/...`,不是 `/tmp`,每个窗口的 daemon 都写同一份),排查从
   tail 这个文件开始,主要 tag:`[SWITCH]` `[TIMING]` `[HUB_RESTART]` `[HUB_REAP]`
   `[ADD_ACCOUNT]` `[FRONTEND]`。VS Code 里 `View > Output`,选 "Antigravity
   Accounts" 频道,能看到同样内容的一个精简版(`REQ`/`FRONTEND` 这类高频 tag 默认
   不显示,打开设置 `antigravityAccountsEnhancer.verboseLogging` 才会显示——文件
   里永远都有,只是 Output 面板默认过滤掉高噪音的)。
