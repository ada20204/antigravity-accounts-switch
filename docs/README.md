# 文档索引

先看这里,再决定翻哪一份。

## 现行文档(以这两份为准)

| 文档 | 回答什么问题 |
|---|---|
| [`FLOWS.md`](./FLOWS.md) | **实际发生什么**。三种状态下的完整流程:全新状态、已登录稳态、登出并添加新账号。想知道"现在是怎么跑的",看这份。 |
| [`decisions/`](./decisions/README.md) | **为什么这么做**。每条设计取舍单独一份文件,原因、试过但失败的方案、以及失败的证据。想知道"为什么不用另一种更简单的做法",先看 [`decisions/README.md`](./decisions/README.md) 的索引按主题找,大概率已经试过并记录了为什么不行。 |

代码注释刻意保持简短,只留结论和指向这里的引用。**不要把设计原理写回代码注释**,那样会变成两处需要同步的真相。

## 项目结构

```
src/
  daemon/       本地桥接服务(Node 进程,端口 63820)——见下面"开工前"第 1 条
    daemon.ts       HTTP 路由入口
    hubRestart.ts    agy --hub 进程生命周期管理
    cdpInjector.ts   往 VS Code webview 注入 runtime bundle 的 CDP 循环
    cliRunner.ts     agent-hub-accounts CLI 的注入安全封装
    httpUtils.ts     共享的请求体读取/响应/CORS 白名单
    logger.ts
  runtime/      注入进 Antigravity webview 的前端代码(浏览器环境,非 Node)
    adapters/    读取/改写 Antigravity 原生 DOM 的适配层(语义定位、邮箱/Plan 抓取)
    services/    AccountStore——状态与 daemon 通信
    ui/          实际渲染的组件(账号弹窗、Settings 卡片、渲染防抖工具等)
    main.ts      前端入口,由 scripts/patch.mjs 注入的 loader 加载
scripts/       bridge.js 的 patch/unpatch,以及 Keychain 诊断脚本
docs/          见上表
```

两侧永远不共享 import——`daemon/` 是 Node 进程,`runtime/` 是浏览器里的注入代码,中间只通过 HTTP(daemon 监听 63820)通信,没有第三条路径。见 [`FLOWS.md`](./FLOWS.md) 了解两者具体怎么协作。

## 历史文档(勿作依据)

以下三份是早期产物,均已在开头标注失效点,保留只为追溯当时的判断:

- [`2026-08-22-session-review-and-next-steps.md`](./2026-08-22-session-review-and-next-steps.md) —— 过程快照,多处结论已被推翻
- [`ANTIGRAVITY_ARCHITECTURE_AND_MULTI_ACCOUNT_DESIGN.md`](./ANTIGRAVITY_ARCHITECTURE_AND_MULTI_ACCOUNT_DESIGN.md) —— 架构设想,其中切号流水线第 3 步(`RESTART_LS`)从未实现
- [`ANTIGRAVITY_MULTI_ACCOUNT_DELIVERY_AND_OPERATION_GUIDE.md`](./ANTIGRAVITY_MULTI_ACCOUNT_DELIVERY_AND_OPERATION_GUIDE.md) —— 联调指南,添加账号一节已整体作废

## 开工前必须知道的三件事

仓库里查不到、但每次动手都会撞上的前提:

1. **daemon 必须由你自己在 Terminal.app 启动,不能经 SSH:`npm run daemon`(即 `tsx src/daemon/daemon.ts`)。** macOS Keychain 的 `security -w` 读取需要 GUI 会话,SSH 下静默失败(exit 36),表现为所有账号操作"没反应"。同理,SSH 里跑任何 `--verify` 类命令的失败都不可信。
2. **VS Code 必须开着 CDP 端口 9222。** 注入完全依赖它——页面 CSP 封死了常规 `<script src>` 注入。
3. **日志在 `$TMPDIR/antigravity-accounts-enhancer.log`**(macOS 上在 `/var/folders/...`,不是 `/tmp`)。排查一律从 tail 这个文件开始,主要 tag:`[SWITCH]` `[TIMING]` `[HUB_RESTART]` `[HUB_REAP]` `[ADD_ACCOUNT]` `[FRONTEND]`。
