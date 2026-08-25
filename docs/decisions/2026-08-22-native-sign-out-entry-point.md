# 官方 Antigravity 的 Sign Out 入口在哪(2026-08-22 现场核实)

官方确实有登出功能,藏在一个 "Account" 面板里(内容是 `Email` + 账号邮箱 + `Sign Out` 按钮),通过 CDP 查证:

- 触发方式:点击左下角那个 "Test User / user-test@example.com" 按钮(`<button>`,与 `SemanticLocator.findProfileTrigger()` 定位到的**是同一个元素**),会切换显示这个 Account 面板(平时 `display:none`)。
- **严重问题**:`main.ts` 里全局点击监听器在 capture 阶段对这个按钮做了 `e.stopPropagation() + e.preventDefault()`,拦截下来去弹我们自己的账号切换弹窗。这意味着**我们的插件激活期间,用户点这个按钮再也打不开官方 Account/Sign Out 面板了**——官方登出入口被我们的弹窗盖住、彻底不可达,不是"我们不提供登出所以用户去官方那边登出"这种安全的分工,而是"官方入口被我们误伤屏蔽掉了"。

**需要修复**:这是本次发现里优先级最高的一个 bug,和"故意不做 logout"的决策本身无关——不管做不做我们自己的登出,都不该挡住用户访问官方的。修复方向待定(比如:检测到是"专门点头像本身"而不是我们弹窗的展开态时放行原生事件;或者我们弹窗里加个"更多账号设置"链接跳回官方 Account 面板),下次处理时优先做这个。

**后续更新(2026-08-22 稍晚)**:已改成不拦截原生点击的方案——头像角上叠加独立小徽标 + 悬停展开,原生点击/官方 Sign Out 完全不受影响。见 `main.ts` 的 `ensureProfileBadge()`。
