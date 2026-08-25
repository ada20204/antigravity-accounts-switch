# 账号流程说明

三种状态下的完整流程。设计取舍的**原因**一律见 [`decisions/`](./decisions/README.md),这里只讲"实际发生什么"。

## 名词:三处凭证

理解流程前必须分清这三处,它们不是一回事:

| 位置 | 谁在用 | 谁会写 |
|---|---|---|
| macOS Keychain(`service=gemini, account=antigravity`)| `agy` CLI、`agent-hub-accounts` | `switch`/`activate`;运行中的 hub 刷新 token 时也会写回 |
| `~/.gemini/jetski-standalone-oauth-token` | 运行中的 hub(会话缓存) | hub 自己;**登录后不保证重新生成** |
| `~/.agent-hub/plugins/accounts/state/credentials/<id>.json` | `agent-hub-accounts` | `connect`/`capture` |

第三处是**我们的备份**——只有它在,账号才能被切回来。前两处是"当前登录态",可以被清掉。

> ⚠️ 已知未解:清掉前两处**通常**能让 Antigravity 显示登录页,但实测出现过清掉后仍是登录态的情况(没有单独的决策记录,只在这里提过)。说明可能还有第三处我们没找到的登录态来源。`finish` 因此不依赖任何文件是否存在来判断,只用 `connect` 能不能读到活动凭证。

---

## 场景 1:全新状态(没有任何已连接账号)

**前提**:`credentials/` 目录为空,localStorage 无缓存。

1. runtime 注入后立刻 `fetchLiveAccounts()` → daemon `route --json` → 返回空列表。
2. UI 显示**空状态**,不再伪造数据:
   - 弹窗:摘要显示 "No accounts connected"、徽章 `—`、列表提示 "No accounts connected yet…"
   - Settings 卡片:徽章显示 "No accounts connected",网格里同样是提示文案
3. 用户此时若已经登录着 Antigravity(常见:装完插件正常在用),点 **Add new account** 并不需要走完整登出——但当前实现一律走"登出→登录"流程。**更省事的做法是先做一次 `connect` 把现有登录收编**,这一步目前 UI 上没有入口(见文末 TODO)。

> 历史 bug:这里原本会往 localStorage 塞三个硬编码账号(真实邮箱 + 编造的 91%/100%/0% 配额),渲染得和真数据一模一样。已改为返回空列表。

---

## 场景 2:已登录的稳态

**前提**:N 个账号已连接,其中一个是当前登录。

### 常驻行为

| 周期 | 动作 |
|---|---|
| 注入时一次 | `logRuntimeBoot()` + `fetchLiveAccounts()`(不等轮询,避免登出重载后干等一整个周期) |
| 1.5s | `ensureProfileBadge()`(徽标跟随原生头像位置)、`injectSettingsEnhancements()`(卡片锚定自纠) |
| 30s | `syncAddAccountPrompt()`(仅主面板 iframe;兜底,不是主要机制) |
| 20s | `fetchLiveAccounts()`(只读,不写 Keychain、不重启 hub) |
| 30s(daemon)| 回收没有任何 iframe 引用的孤儿 hub |

渲染都有签名脏检查:数据没变就不重建 DOM,否则 1.5s 一次的重写会在 mousedown/mouseup 之间吃掉点击。

### 切换账号

1. 点账号行 → 确认框
2. 盖上进度遮罩("Switching to X…")
3. `POST /api/switch` → `agent-hub-accounts switch <id>`(**只写 Keychain**,约 150ms)
4. **daemon 先回响应,再重启 hub** —— 重启会重载发起请求的那个页面,先重启会把响应掐断,前端会误判失败并回滚一个其实已经成功的切换
5. 重启:SIGTERM 旧 hub → 等退出 → 在**同一端口**拉起新 hub → reload 内容 iframe(约 7s,其中 ~6s 是 hub 冷启动)
6. iframe 重载 = 完成信号,遮罩随文档一起消失

失败则回滚本地状态、关闭遮罩、弹错误。

### 移除账号

`Remove` → 确认 → `POST /api/remove`。**daemon 会拒绝移除当前登录的账号**(先查 `route`,命中返回 409),否则会把运行中 hub 脚下的凭证抽走。

移除会删掉 `credentials/<id>.json`,所以之后**无法再切回该账号**,要重新完整登录;但不撤销 Google 授权、不登出。

---

## 场景 3:登出并添加新账号

四个 daemon 接口:`begin` / `finish` / `cancel` / `status`。

```
点 Add new account
   ↓ 确认框("会把你登出,当前账号已保存")
   ↓ 进度遮罩
POST /api/add-account/begin
   ├─ connect            备份当前凭证到 credentials/<id>.json
   │                     ★ 失败即中止,不做任何破坏性操作
   ├─ 记录 backupAccountId,写入磁盘(见下)
   └─ restartAntigravityHub(onStopped)
        ├─ SIGTERM 旧 hub,等它完全退出
        ├─ ★ onStopped 窗口内:删 hub 会话缓存 + 摘 Keychain
        │    必须在这里做——hub 退出过程中会把凭证写回,活着时清等于没清
        └─ 同端口拉起新 hub + reload iframe
   ↓
Antigravity 显示原生登录页(全程原生,我们不介入)
顶部出现我们的横幅:Adding an account / Cancel      ← 只有 Cancel,没有 Done
   ↓
用户在登录页点击 → hub 打印 ANTIGRAVITY_OPEN_URL → 插件开浏览器 → 完成 Google 登录
   ↓
┌─ 正常路径:daemon 自动完成 ────────────────────────────┐
│ watchForNewSignIn(),pending 期间每 2s 一次           │
│   ├─ 试 connect:登出窗口内会一直失败,无副作用          │
│   ├─ 捕获到的账号 == 备份账号 → 忽略                   │
│   │   (hub 自己会把那个 Keychain 槽写回来,不算登录完成) │
│   └─ 捕获到新账号 → 记 justAdded + 清 pending          │
│      ★ 不重启 hub:执行登录的就是当前 hub,已是新账号     │
│ 横幅随之消失,前端弹一句"Added X",并刷新账号列表        │
└─────────────────────────────────────────────────────┘
┌─ 点 Cancel ──────────────────────────────────────────┐
│ POST /api/add-account/cancel                        │
│   ├─ switch <backupAccountId>  (从备份重写 Keychain)  │
│   └─ 清 pending + 重启 hub                            │
│   ★ 不需要手工还原任何文件:hub 重启时从 Keychain 重建   │
└─────────────────────────────────────────────────────┘

`POST /api/add-account/finish` 仍然存在,但**已不在正常流程里**,没有任何 UI 调用它,
仅作为自动捕获失灵时用 curl 强制收尾的兜底。
```

### 登出后不想登新账号了,怎么回去

按可用性从高到低,五条路都能回到已有账号:

0. **救援条**(登出且没有进行中的添加流程时自动出现)—— 顶部显示 "Signed out of Antigravity",点 **Switch account** 打开账号弹窗照常切换。
   这个状态本来是个死路:没人登录 → 左下角没有头像 → `findProfileTrigger()` 找不到 → 徽标不渲染 → 装着账号列表的弹窗根本打不开,用户只看到一个登录页,不知道自己还有几个账号可以切回去。
   判据必须是**实时**的:daemon 用 `MacKeychain.activeAvailable()`(只查槽位是否存在,不读密文、不弹授权),**不能用 `route`**——它是缓存的,实测在 Keychain 槽位完全不存在时仍然报告某账号 active。
1. **点添加横幅上的 Cancel** —— 添加流程进行中时的正常出口,`switch <备份账号>` 切回登出前那个。
2. **在弹窗里直接点任意一个已有账号** —— `/api/switch` 不关心 pending 状态,照常工作。daemon 的监视器会发现"当前登录变成了一个已知账号",据此判定添加流程被放弃并清掉 pending(2s 内),不会误报"添加了新账号"。
3. **`agent-hub-accounts switch <邮箱>`**(Terminal)—— UI 完全不可用时(daemon 挂了、CDP 没连上、注入还没发生)用这条。它才是真正的底层操作,前两条最终也是调它。
4. **删掉 `$TMPDIR/antigravity-accounts-enhancer-pending-add.json`** —— 只在 pending 状态卡住(横幅赖着不走)时需要,单独做这一步不改变任何登录态。

> 注意第 2 条对应的一个 bug 曾经存在:监视器原来只比对"是不是备份账号",于是切到**其它**已有账号会被当成新账号登录,弹一句 "Added X" —— 而那个账号本来就在列表里。现在改为比对 `begin` 时记录的完整已知账号集合。

### 为什么横幅由 daemon 驱动

`begin` 会重载 webview,页面持有的任何状态都会没。所以"进行中"这个标志:

- 存在 **daemon**,不在页面里
- 且**持久化到磁盘**(`$TMPDIR/antigravity-accounts-enhancer-pending-add.json`)——daemon 重启会丢内存态,实测发生过:重启后横幅消失,而用户正处于登出状态,Done/Cancel 都点不到,直接卡死
- **只有主面板 iframe(`location.pathname !== '/settings-standalone'`)显示横幅**。Settings 页不渲染登录页,在那儿提示"去登录"没有意义;而且两份横幅会让 Done 和 Cancel 在几秒内同时可点,输的那次报"没有进行中的登录"。
- 轮询**自适应**:没有进行中的登录时 30s 一次(纯兜底),横幅显示期间 2.5s 一次(此时要及时察觉 daemon 已自动捕获完成)

横幅出现靠"begin 触发重载 → 启动检查",消失靠 daemon 自动捕获或本文档内的 Cancel。因为横幅收归单个 document,没有别的文档能在背后改它的状态,所以稳态下不需要高频轮询——实测 `status` 请求从 235 次/分降到 2 次/分。

手动 reload 窗口、daemon 重启,横幅都能正确恢复。

---

## TODO

- [ ] 空状态下提供"收编当前登录"的入口(直接 `connect`,不必先登出)
- [x] ~~横幅只在有登录页的那个 iframe 显示,并降低 `status` 轮询频率~~(2026-08-23 完成)
- [ ] 查清楚除 Keychain 和会话缓存外,是否还有第三处登录态来源
