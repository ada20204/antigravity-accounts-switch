# 注入检测从轮询改成事件驱动;顺带排查了其余几处轮询

## 问题

装好之后实测,页面出现到我们的 UI(账号弹窗、Settings 卡片)真正渲染出来要等好几秒。查下来是几层轮询叠加的结果,不是单一原因。

## 全项目轮询点排查

`grep -n "setInterval\|setTimeout.*sleep\|while.*Date.now"` 找到 5 处,逐一评估要不要改:

| 位置 | 周期 | 要不要改 | 为什么 |
|---|---|---|---|
| `cdpInjector.ts` 的 CDP target 发现 | 2000ms | **改** | 直接决定"iframe 出现到开始注入"这段延迟,且每次切换账号都会走一遍(same-port-respawn 的 iframe reload) |
| `main.ts` 的 `ensureProfileBadge` | 1500ms | **改** | 决定"注入完成到头像徽标出现"这段延迟 |
| `main.ts` 的 `injectSettingsEnhancements` | 1500ms | **改** | 同上,决定 Settings 卡片出现的延迟 |
| `hubRestart.ts` 的 `probeHubHealth` 轮询(`spawnHubOnSamePort`) | 150ms | **不改** | 真实瓶颈是 `agy --hub` 自己启动要 6-9 秒(实测数据),150ms 的轮询粒度相对 6-9 秒不到 3% 的开销,换成事件驱动省不出多少;而且"进程开始监听端口"本来就没有能订阅的系统级事件,只能探测 |
| `hubRestart.ts` 的 `waitForExit`(`terminateHub`) | 200ms | **不改** | 实测 `hubStopMs` 只有 282-489ms,SIGTERM 到进程真正退出本来就很快,200ms 粒度已经不是瓶颈;而且这个函数处理的是任意 pid(不一定是我们自己 spawn 的),没有 ChildProcess 对象可以监听原生 `exit` 事件 |
| `main.ts` 的 `AccountStore.fetchLiveAccounts` 后台刷新 | 20000ms | **不改** | 这是数据新鲜度轮询(账号/配额会不会过期),不是"等 DOM 出现"——没有事件可订阅(Google 那边配额变了不会推送通知),而且这条本来就是`docs/decisions/credential-drift-explained.md`里刻意设计的行为,不属于这次要解决的延迟问题 |

## 改法

### CDP 注入检测:轮询 → `Target.setDiscoverTargets` 事件

现场用真实 CDP 连接做了验证(不是猜的):对着一个已存在的 iframe target 发
`window.location.reload()`,同时订阅 `Target.setDiscoverTargets`——**`targetInfoChanged` 事件在 reload 调用后 2ms 就到了**,且 target id 不变。这条结论直接决定了架构:事件驱动不仅能覆盖冷启动(扩展激活时 hub 已经在跑),也能覆盖每次切换账号都会走的 same-port-respawn 原地 reload——一开始还担心"同 URL 原地刷新可能不触发任何事件",现场验证排除了这个顾虑。

`cdpInjector.ts` 重写:
- 连一条常驻 WebSocket 到浏览器级 CDP 端点(`GET /json/version` 拿 `webSocketDebuggerUrl`),发 `Target.setDiscoverTargets({discover:true})`——连上的瞬间会收到所有已存在 target 的 `targetCreated` 补发,之后每次 `targetCreated`/`targetInfoChanged` 都会推过来,不用再等下一个轮询周期。
- 单个 target 的注入本身不再需要先 `GET /json` 拿它的 `webSocketDebuggerUrl`——现场核实过 CDP 的规律是 `/devtools/page/<targetId>`,不管 target 自己的 `type` 是不是 `iframe`,直接用事件里带的 `targetId` 拼 URL 连。
- 保留一个 5 秒的兜底轮询(`FALLBACK_POLL_MS`)——不是因为事件不可靠(验证过很可靠),是防止那条常驻 WebSocket 静默卡死又没触发自己的 close/error 处理时,还有个恢复路径。
- `getOwnHubPorts()`(pgrep + 每个 pid 一次 ps/lsof)加了 500ms 的短缓存——现场测过一次 reload 会在 2 秒内连着触发 3 个 `targetInfoChanged`,不加缓存的话每个事件都要重新起一遍子进程。
- 新增 `inFlight` Set 防止同一个 target 被事件和兜底轮询同时并发检查——两边都在等 `getOwnHubPorts()` 的 await 时,如果都判断"还没注入"就都会创建 `<script>` 标签,导致 `main.ts` 被执行两次。

### 前端 DOM 等待:轮询 → MutationObserver

`main.ts` 里 `ensureProfileBadge`/`injectSettingsEnhancements` 各自的 1500ms `setInterval` 换成一个共享的 `MutationObserver`(监听 `document.body` 的 `childList`+`subtree`),原生 DOM 一变就触发,不用等下一个 1.5 秒。用 `requestAnimationFrame` 把一帧内的多次 mutation 记录合并成一次检查(聊天区流式刷新文本时会连续触发大量 mutation record,不这样会一帧内跑很多次)。同样保留一个放宽到 5 秒的兜底轮询,应对 observer 配置(`childList`+`subtree`)本身覆盖不到的情况(比如纯属性/样式变化、没有节点增删)。

## 验证

`npx tsc --noEmit`、`npm run compile`、`npm run build:runtime`、`npm test` 全过,`npm run package` 产出 `.vsix`。现场验证过 CDP 事件本身的可靠性(见上面的实测数据),但完整链路(装上新 `.vsix` 之后,真实测一次切换看感知延迟是不是真的降下来了)还没有做——这个只能你在真实环境里感受。
