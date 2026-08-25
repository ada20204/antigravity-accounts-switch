# 决策记录索引

为什么这么做、试过但失败的方案、以及失败的证据——按主题查,不用整份翻。新的在前;标 `(已被取代)`/`(历史)` 的仅供追溯,结论以后出现的同主题条目为准。

- [多账号消失:agent-hub-accounts 把 route 废弃、换了 schema](./2026-08-25-route-schema-break.md) — 数据没丢,是上游 CLI 把 `route` 降级成废弃别名、schema 换了(`accounts`→`results`、`active`→`is_active`),`daemon.ts`/`accountStore.ts` 改用 `list`/`current --verify`。

- [Review 复查:借鉴 agent-hub-accounts 那批改动的 14 条发现全部修复](./2026-08-25-review-14-findings-fixed.md) — 最严重的一条:reaper 宽限期没算上整窗口 reload 的真实耗时,可能杀掉添加账号流程正在用的 hub;`knownPlans` 文件名加版本号避免新旧 daemon 混跑互相破坏数据;symlink 检查改成原子 `O_NOFOLLOW`。
- [从 agent-hub-accounts 借鉴的 4 个设计](./2026-08-25-agent-hub-accounts-patterns-adopted.md) — 持久化 JSON 原子写+防符号链接;hub 归属从 CDP target 反推改成直接持有 pid;状态加 schema 版本标记;结构门限写成 `npm test`。
- [DECISIONS.md 拆成 docs/decisions/](./2026-08-24-decisions-doc-split.md) — 按用户提供的 project-structure 规则,单文件 501 行/28 主题过了"扁平化够用"的门槛,拆成一条一份 + 本索引;代码里 43 处指针全部改指向具体新文件。
- [目录结构整理:daemon 端文件搬进 src/daemon/](./2026-08-24-project-structure-cleanup.md) — daemon 端 6 个文件从平铺 `src/` 根下移到 `src/daemon/`,和 `runtime/` 对称;删空目录 `src/patcher/`;`tsx` 转正为 devDependency。
- [提交 b9ad69f 复查:10 条发现,聚焦注释规范](./2026-08-23-review-b9ad69f-followup-10-findings.md) — `begin()` 两处"假成功"回归、Settings 卡片监听器再次泄漏、`isKeychainActiveAvailable` 丢的容错、`renderGuard` 竞态+去重、CORS 注释重复违反指针约定。
- [账号等级(Plan)](./2026-08-23-account-plan-tier.md) — plan 字段原来是纯瞎猜(Ultra 永远不可能出现);改成从 Settings → Account 页 "Your Plan: ..." 真实 DOM 读取并按账号持久化。
- [添加账号原生登录页不出现](./2026-08-23-add-account-native-signin-missing.md) — 根因:同端口 respawn 只刷新了 iframe,扩展宿主不知道 hub 换了;修成 `begin()` 专用整窗口 reload。
- [首次 code review(xhigh):17 条发现全部修复](./2026-08-23-first-code-review-17-findings.md) — CORS 从未强制拒绝、shell 注入、TOCTOU 竞态、硬编码路径、配额环自嵌套等——本仓库第一轮正式 review 的完整记录。
- [不做账号登出(Log out)](./no-account-logout.md) — 多账号系统靠密文捕获/写回实现秒切,真登出会撤销 refresh token、跟这个模式直接冲突,所以不做登出入口。
- [官方 Sign Out 入口在哪](./2026-08-22-native-sign-out-entry-point.md) — 我们的弹窗曾拦截点击、彻底堵死官方 Account/Sign Out 面板的入口;已改成不拦截原生点击。
- [credential_drift 是什么、为什么会出现](./credential-drift-explained.md) — 常驻 hub 会周期性刷新 OAuth token 并写回 Keychain,不需要任何切换动作就会让"当前账号"记录漂移,是架构固有特性不是 bug。
- [CDP 注入替代 bridge.js patch](./cdp-injection-vs-bridge-patch.md) — bridge.js 的 CSP 静默拦截动态 `<script src>` 注入;改用 CDP 直接打进内层 iframe,绕开两层 CSP 问题。
- [CORS 白名单策略](./cors-allowlist-policy.md) — daemon 只反射白名单里的 origin,不用通配符 `*`,防止本机任意网页对着 daemon 发起 CSRF。
- [(已被取代)Hub 重启:为什么改成整窗口 reload](./superseded-hub-restart-window-reload.md) — 单独 reload 一个已经没有进程监听的 iframe 会卡死;记录了这个已被后续"同端口 respawn"取代的中间方案。
- [Profile 悬浮徽标:为什么不拦截原生点击](./profile-hover-badge-no-intercept.md) — 头像角上叠加独立小徽标触发我们的弹窗,原生按钮完全不挂拦截逻辑,两个点击目标互不干扰。
- [Settings 卡片锚点:改用 data-testid](./2026-08-23-settings-card-anchor-data-testid.md) — 定稿方案:取全部 `[data-testid="quota-progress-circle"]` 的最近公共祖先当容器,不再依赖会跟着官方文案变的显示文本。
- [(历史)Settings 页文本匹配式卡片锚点定位](./historical-settings-card-anchor-text-match.md) — 已被上面 data-testid 版取代;记录了"靠标题文本 + 最近公共祖先"这版为什么不稳。
- [Profile 触发器同步:为什么不能用纯坐标启发式](./profile-trigger-sync-not-coordinate.md) — 坐标启发式在 Settings iframe 里把左侧导航栏误判成 profile 容器,导致 tab 名称被写成邮箱;改用语义匹配 + 无匹配时显式返回 null。
- [账号切换语义:为什么不跳过"已经是 active"的情况](./account-switch-semantics.md) — `isActive` 缓存会因 credential_drift 漂移,跳过点击会让用户在漂移后彻底无法强制拉回状态。
- [window.confirm()/alert() 在 VS Code webview 里静默失效](./webview-confirm-alert-silent-failure.md) — 两个原生 API 被沙箱环境静默 no-op(不抛错也不弹窗),曾表现为"所有确认操作点了没反应";自建 `confirmDialog.ts` 替换。
- [Settings 卡片的几个小决策](./settings-card-minor-decisions.md) — 不做侧边栏导航项、Add account 不在卡片里重复、Remove 是"忘记"不是登出、Check All Accounts 的确认文案为什么必须单独写。
- [多账号下的配额数字与弹窗显示](./2026-08-23-multi-account-quota-display.md) — 修了三个真实显示 bug:配额百分比累加到 500%、5 个账号全显示 100% 没法选、弹窗账号一多被裁掉且无法滚动。
- [监听器泄漏与无条件重渲染](./2026-08-23-listener-leak-unconditional-rerender.md) — 每开一次弹窗漏一个 window 监听器(实测 5 开 5 漏);1.5s 无条件重渲染会在 mousedown/mouseup 之间吃掉点击。
- [添加账号(定稿):走原生浏览器登录,不再开 Terminal](./2026-08-23-add-account-native-browser-final.md) — 复用 hub 自己的登录页(`ANTIGRAVITY_OPEN_URL` → 系统浏览器),daemon 只负责摘凭证和捕获新凭证,不碰登录本身。
- [(历史)添加账号:为什么必须开一个真实 Terminal](./historical-add-account-terminal-required.md) — 已被上面原生浏览器方案取代;记录了 `agy login` 为什么必须交互式 TTY、以及"必须先 connect 再 login"这个坑。
- [两个流程复盘](./2026-08-23-two-incidents-retro.md) — 添加账号后忘了重启 hub 导致会话仍在旧账号上;切换时 7 秒零反馈没有加载提示;记录了尚未验证的 `ANTIGRAVITY_OPEN_URL` 免 Terminal 设想。
- [⚠️ 永远不要裸调 `connect`](./2026-08-23-never-bare-connect-call.md) — 实际损坏过一个账号:不带参数的 `connect` 靠猜邮箱,把凭证写错了档案;改成能确定 ID 就必须显式传,不确定就走可撤销的 snapshot/restore。
- [又一次账号损坏:自动捕获的猜测机制结构性地不可能猜对](./2026-08-23-account-corruption-guessing-broken.md) — 猜测函数扫的日志目录我们的 hub 从不写入,不是滞后是永远猜不对;改成从原生 Account 面板 DOM 读取真实登录邮箱,彻底去掉猜测。
- [移除账号:实际语义比"本地忘记"更重](./remove-account-semantics.md) — Remove 会真的删除保存的凭证副本文件,要回来必须重新完整登录,不是点一下就能恢复;文案已按真实语义重写。
- [切换耗时:计时埋点为什么一开始测不准,以及第一个优化点](./2026-08-22-switch-timing-instrumentation.md) — 第一版计时漏掉了 VS Code 重新初始化整个 workbench 的 35-40s;补齐埋点后拆解出真实耗时构成,并验证了 SIGHUP/Restart Extension Host/serverUrl 后门三条路都走不通。
- [✅ 真正的优化:同端口自行 respawn(30-36s → ~7s)](./2026-08-22-same-port-respawn-optimization.md) — 打破"必须由 VS Code spawn 新 hub"这个默认前提,自己在同端口起新 hub 只需 reload iframe,砍掉 VS Code 重建整窗口的开销。
