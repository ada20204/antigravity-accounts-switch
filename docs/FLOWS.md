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

> `finish` 不依赖任何文件是否存在来判断,只用 `connect` 能不能读到活动凭证——清掉前两处**通常**能让 Antigravity 显示登录页,但不总是;未查清的原因见 [`ISSUES.md`](./ISSUES.md)。

---

## 场景 1:全新状态(没有任何已连接账号)

**前提**:`credentials/` 目录为空,localStorage 无缓存。

1. runtime 注入后立刻 `fetchLiveAccounts()` → `GET /api/accounts`(进程内调用 `accountService.overview()`)→ 返回空列表。
2. UI 显示**空状态**,不再伪造数据:
   - 弹窗:摘要显示 "No accounts connected"、徽章 `—`、列表提示如果 Antigravity 已经登录着可以去 Settings 用一键收编,否则用 Add new account
   - Settings 卡片:徽章显示 "No accounts connected",网格里同样是提示文案——如果检测到原生 Account 面板当前有登录(`findAccountPanelEmail()` 非空),额外渲染一个 **Use current login** 按钮
3. 用户此时若已经登录着 Antigravity(常见:装完插件正常在用),不需要走完整登出:点 Settings 卡片里的 **Use current login** 直接 `connect` 收编当前登录,不碰 Keychain 之外的任何东西。**Add new account**(弹窗底部)仍然是登出→登录流程,适合"换一个新账号"的场景。见 [`decisions/2026-08-27-adopt-current-login.md`](./decisions/2026-08-27-adopt-current-login.md)。

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
3. `POST /api/switch` → 进程内调用 vendor 进来的 `switchAccount()`(**只写 Keychain**)——不再经过单独的 `agent-hub-accounts` 子进程,但底层仍要 `spawnSync('/usr/bin/security', ...)`;vendor 之后没有重新实测过具体耗时,只确定比原来"~150ms(含一次完整 node 子进程启动开销)"更快,不知道快多少
4. **daemon 先回响应,再重启 hub** —— 重启会重载发起请求的那个页面,先重启会把响应掐断,前端会误判失败并回滚一个其实已经成功的切换
5. 重启:SIGTERM 旧 hub → 等退出 → 在**同一端口**拉起新 hub → reload 内容 iframe(约 7s,其中 ~6s 是 hub 冷启动)
6. iframe 重载 = 完成信号,遮罩随文档一起消失

失败则回滚本地状态、关闭遮罩、弹错误。

### 移除账号

`Remove` → 确认 → `POST /api/remove`。**daemon 会拒绝移除当前登录的账号**(先查 `current --verify`,命中返回 409),否则会把运行中 hub 脚下的凭证抽走。

移除会删掉 `credentials/<id>.json`,所以之后**无法再切回该账号**,要重新完整登录;但不撤销 Google 授权、不登出。

### 导出/导入账号(Settings 卡片)

`Export`/`Import` → 确认 → `POST /api/export`/`/api/import` → daemon 弹原生
`showSaveDialog`/`showOpenDialog` 选文件 → 读写 bundle。两者都**不碰 Keychain
活跃槽位**,不会让任何人被登出/登入,不需要重启 hub。导入会**覆盖**已存在的
同 id 账号的凭证,不可撤销;导出的文件里含真实凭据,明文,不加密。见
[`decisions/2026-08-27-export-import.md`](./decisions/2026-08-27-export-import.md)。

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
   判据必须是**实时**的:daemon 用 `MacKeychain.activeAvailable()`(只查槽位是否存在,不读密文、不弹授权),**不能用缓存的 `current`(不带 `--verify`)**——实测在 Keychain 槽位完全不存在时仍然报告某账号 active。
1. **点添加横幅上的 Cancel** —— 添加流程进行中时的正常出口,`switch <备份账号>` 切回登出前那个。
2. **在弹窗里直接点任意一个已有账号** —— `/api/switch` 不关心 pending 状态,照常工作。daemon 的监视器会发现"当前登录变成了一个已知账号",据此判定添加流程被放弃并清掉 pending(2s 内),不会误报"添加了新账号"。
3. **`agent-hub-accounts switch <邮箱>`**(Terminal)—— UI 完全不可用时(daemon 挂了、CDP 没连上、注入还没发生)用这条。它才是真正的底层操作,前两条最终也是调它。
4. **删掉 `$TMPDIR/antigravity-accounts-switch-pending-add.json`** —— 只在 pending 状态卡住(横幅赖着不走)时需要,单独做这一步不改变任何登录态。

> 注意第 2 条对应的一个 bug 曾经存在:监视器原来只比对"是不是备份账号",于是切到**其它**已有账号会被当成新账号登录,弹一句 "Added X" —— 而那个账号本来就在列表里。现在改为比对 `begin` 时记录的完整已知账号集合。

### 横幅由 daemon 驱动,不在页面里

`begin` 会重载 webview,页面持有的任何状态都会没,所以"进行中"这个标志存在
daemon、持久化到磁盘(`$TMPDIR/antigravity-accounts-switch-pending-add.json`)。
原因见 [`decisions/add-account-state-persistence.md`](./decisions/add-account-state-persistence.md)。

行为:
- 只有主面板 iframe(`location.pathname !== '/settings-standalone'`)显示横幅
- 轮询自适应:没有进行中的登录时 30s 一次,横幅显示期间收紧到 2.5s 一次
- 横幅出现靠"begin 触发重载 → 启动检查",消失靠 daemon 自动捕获或点 Cancel
- 手动 reload 窗口、daemon 重启,横幅都能正确恢复
