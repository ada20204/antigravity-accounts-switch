# (历史快照,勿作依据)会话汇总与下一步设计讨论(2026-08-22)

> ⚠️ **这是 2026-08-22 当天的过程快照,多处已被推翻,不要用它理解现状。**
> 结论以 [`DECISIONS.md`](./DECISIONS.md) 为准,流程以 [`FLOWS.md`](./FLOWS.md) 为准。
>
> 主要失效点:
> - "hub 重启 = CDP 触发内层 iframe `location.reload()`" —— 实测无效(那个端口上已经没有进程),后改整窗口 reload,现在是同端口自行 respawn。
> - "`findModelsUsageHeader()`" —— 该函数已删除,卡片锚点改用 `data-testid="quota-progress-circle"`。
> - "不做账号登出" —— 边界已细化:添加账号会做**纯本地**登出(不 revoke),见 DECISIONS.md 同名章节的补充。
> - 文末"弹窗 vs 卡片功能重叠"的整改建议 —— 已按另一套方案落地(弹窗=展示+切换+添加,卡片=配额统计)。

## 一、今天的发现汇总(按主题,不按时间线)

### 1. 核心链路:从"点了没反应"到打通

- **注入机制**:`bridge.js` 文本 patch 那条路径被页面自身 CSP(`script-src 'self' 'sha256-...'`)彻底挡死,从未真正执行过。改为 CDP 直连内层 iframe 注入(`cdpInjector.ts`),已验证弹窗/卡片都能正常渲染、拿到真实数据。iframe 会被 VS Code 原地重载导致注入丢失,已改成不依赖 target id 缓存的幂等轮询,自愈。
- **权限**:通过 SSH 拉起的进程读不出 macOS Keychain 密文(`security ... -w` exit 36,典型的非 GUI 会话被拒),不是代码 bug。daemon 必须从用户自己的正常 Terminal 启动。
- **CORS 漏洞**:daemon 原来是 `Access-Control-Allow-Origin: *`,配合无鉴权的 `/api/switch|remove|login`,本地任意网页都能 CSRF 触发账号切换/删除。已改为按 origin 白名单校验。
- **切换不生效的根因**:Keychain 写对了,但常驻的 `agy --hub` 进程只在启动时绑定一次 AuthProvider,不会感知 Keychain 变化。设计并实现了 `hubRestart.ts`:优雅 SIGTERM(超时 SIGKILL 兜底,和插件自己 `stop()` 一致)+ CDP 触发内层 iframe `location.reload()`,让插件重新拉起 hub。已在真实环境验证:切换 → hub 重启 → Chat 面板真的变成新账号。

### 2. 两次同类型 UI bug:DOM 选择器过宽

- `profileSyncAdapter.ts`:邮箱节点查找没限定"必须是纯文本叶子节点",覆写时把整个子树连带图标一起冲掉,只剩一行裸文本。已修。
- `settingsEnhancer.ts` 侧边栏导航注入:`textContent.includes(...)` 在粗粒度选择器上匹配,命中 15-20 个元素,`[0]` 抓到的是**整个 App 根节点**(2.8 万字符),注入点完全错位且扰动了 General 页面布局。按你的意见,这个功能(只是省一次滚动的低价值快捷方式)**已整体移除**,不再修补。

### 3. 视觉样式

- Settings 卡片用到的 CSS class(`.ag-settings-custom-card`/`.ag-card-*`/`.ag-sub-box-*`)在样式表里从未定义过,只有弹窗那套 `.ag-enhancer-*` 有样式,导致卡片渲染成裸文字堆叠。已从官方页面现场提取真实 design token(`rounded-xl` 12px、透明底 + `rgba(255,255,255,0.05)` 描边、`viewBox 0 0 32 32` 环形进度条结构、`--vscode-*` 主题变量)补齐,现在视觉上和官方风格一致。

### 4. 代码结构清理

- 删掉未使用的 `findSettingsMountPoint()`,换成真正被调用的 `findModelsUsageHeader()`,`settingsEnhancer.ts` 不再自己重复实现一遍查找逻辑。
- `accountPopup.ts`/`settingsEnhancer.ts` 重复的"确认弹窗 + 跳过已激活账号"逻辑收进 `AccountStore.confirmAndSwitch()`。
- 新增 `logger.ts`(daemon/cdpInjector/hubRestart 共用的持久化日志)。

### 5. 产品/UX 层发现(今天最后几轮,尚未处理)

- **弹窗 vs Settings 卡片功能高度重叠**:切换、新增订阅、刷新配额两边都有;只有"登出"(弹窗独有)和"按模型细分配额"(卡片独有)有差异化,且这差异更像实现时的疏漏,不像刻意分工。
- **"Log out current" 按钮是死代码**:从未绑定点击事件;`agent-hub-accounts` CLI 压根没有 `logout` 命令。已记录决策(见 `DECISIONS.md`):shared-live 模式靠密文捕获-回写实现秒切,真登出会让 Google 撤销 refresh token,密文报废,和整套设计冲突,所以不该做。
- **严重问题**:官方真正的 Account/Sign Out 面板,是点左下角 "用户名/邮箱" 按钮弹出的,而这个按钮和我们 `SemanticLocator.findProfileTrigger()` 抓到的**是同一个元素**。我们在 capture 阶段拦截了它的点击去弹自己的窗——插件运行期间,用户**彻底无法访问官方登出入口**。这已经不是"我们不提供登出"的问题,是我们把官方功能盖住了。**这是目前唯一"从没问题变成真问题"的功能性倒退,优先级最高。**
- **"Refresh All" 按钮的真实行为被验证清楚**:后台会依次真实切换 Keychain 到每一个账号(含已知 `eligibility_failed` 的账号)查询配额,再切回来——比单个"Switch"动作更激进,却没有任何确认提示。作为对照,官方原生刷新按钮(在 "Models & Usage" 标题旁)做的事完全不同:只对**当前已认证的这一个账号**,通过已建立的 WebSocket 发两个 ConnectRPC(`RetrieveUserQuotaSummary` + `GetLoadCodeAssist`,均带 `forceRefresh:true`),不切账号、不碰 Keychain、瞬间完成、零副作用。根本原因是:官方设计里没有"多账号聚合"这个概念——这是我们自己加出来的功能,shared-live 架构下,只有当前账号处于"已认证"状态,想拿别的账号的配额,除了真的切过去问一遍,目前没有更安全的路径。

---

## 二、下一步怎么做:多视角讨论

### 视角 A:安全/风险优先

按风险从高到低排列该做的事:

1. **修复官方 Sign Out 入口被阻塞**——这是主动造成的功能性倒退,不是"锦上添花",应该最先处理。修复方向:不能简单地在我们的点击处理器上"放行原生事件"(因为我们的 `stopPropagation`/`preventDefault` 本来就是为了不让点击穿透触发官方那个隐藏面板的切换,如果放开,点头像会同时弹两个东西,体验更差)。更合理的方向可能是:我们的弹窗里加一个明确的"更多账号设置"或类似官方措辞的入口,直接跳转/触发官方 Account 面板,把入口"补还"给用户,而不是简单地不拦截。
2. **"Refresh All" 补确认提示**,参照 "Switch" 的先例,并且措辞要明确说明"这不是官方那种无副作用刷新,会依次切换账号"——不能只是简单复用 Switch 那句文案,否则用户还是不知道后果有多大。
3. CORS 白名单目前是硬编码的 origin 正则,长期看这类字符串匹配随着 VS Code/agy 版本升级有漂移风险,但不紧急,先记录。

### 视角 B:产品/信息架构

核心问题是弹窗和卡片各写了一套完整功能,没有主次。三种可能的分工方向:

- **方案 1**:弹窗做"高频快操作"(只保留切换 + 跳转到官方账号设置的链接),卡片做"低频详情管理"(新增订阅、按模型明细、批量刷新及其风险提示)。低频/重操作只在一处,不重复。
- **方案 2**:反过来,弹窗只做只读展示(看一眼当前状态),所有操作都引导去 Settings 卡片。
- **方案 3**:弹窗保留独立性但砍掉"新增订阅"和"批量刷新"这两个重操作,只留切换,理由是这两个操作值得让用户"郑重地"去 Settings 页面做,而不是从一个悬浮小窗顺手点掉。

个人倾向 1 和 3 的结合:切换是高频操作,两处都该有;新增/批量刷新这类有实际后果(会话中断、可能要等 OAuth 流程)的操作只保留在卡片一处。

### 视角 C:工程/架构

当前"多账号聚合配额"完全靠 shared-live 的"切进去问一圈再切回来",本质是用一个越来越重的操作(现在还接了 hub 重启)换一份低频的展示信息,性价比在变差。真正对齐官方"零副作用查配额"体验的路径,是 `agent-hub-accounts` 已经在做但还没做完的 **isolated-hub**(每账号独立 HOME + standalone token + `GetUserStatus`/ConnectRPC,不碰系统 Keychain)。目前 isolated-hub 只验收了 no-tools 的 `probe`/`exec`,还没有"只读配额查询"这个最小能力。

建议:向 `agent-hub-accounts` 提一个具体需求——isolated-hub 优先做一个"只查配额、不动 Keychain、不用完整 Cascade/Agent 通道"的最小子集(本质就是对每个账号的 standalone worker 调一次 `GetUserStatus` 或等价的 quota RPC)。一旦有这个能力,我们的 "Refresh All" 和多账号配额展示可以整体换成零风险实现,不再需要依赖 shared-live 切换,这条"高风险操作换低频信息"的账就还清了。这是中期方向,不是这次要做的事。

### 视角 D:用户心智模型

今天验证清楚了官方刷新按钮的行为模式(快、安全、零副作用)。我们的 "Refresh All" 视觉上和它很像(同一个页面、同一种措辞"刷新"),用户会自然地套用"官方刷新=无风险"的预期来理解它——这不只是"少了个确认框"的问题,是命名和视觉相似度本身在制造错误预期。除了加确认提示,值得考虑换一个更谨慎的措辞(比如不叫 "Refresh All" 而是强调"逐个账号检查"),或者用不同的视觉样式(不用官方同款的圆形按钮),让用户一眼就能分辨这是我们自己的、有代价的操作,不是官方那种轻量刷新。

---

## 三、待你决定的具体问题

1. 官方 Sign Out 入口被阻塞——同意"加一个跳转官方面板的入口"这个修复方向吗,还是有别的想法?
2. "Refresh All" 先只加确认提示,还是要连措辞/视觉一起改?
3. 弹窗 vs 卡片的功能分工,倾向视角 B 里的哪个方案(或都不是,你有别的思路)?
4. isolated-hub 的"只读配额查询"最小能力,要不要现在就整理成一份具体需求发给 `agent-hub-accounts` 那边,还是先放着?
