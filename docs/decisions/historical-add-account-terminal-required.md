# (历史)添加账号:为什么必须开一个真实 Terminal

**日期**:2026-08-22 · 涉及 `daemon.ts::/api/login`、`accountPopup.ts`

原来的 `/api/login` 是 `execAsync("node cli.js login --json")`,**这个调用永远不可能成功**。查 `agent-hub-accounts` 源码(`src/cli/process-control.ts::openAntigravityLogin`),`login` 有三道硬拦截,每一道都能单独让上面这行失败:

1. `if (json) throw new AccountStateError("login is interactive and does not support --json")` —— 我们恰好传了 `--json`。
2. `if (!process.stdin.isTTY || !process.stdout.isTTY) throw "login requires an interactive terminal"` —— daemon 经 `execAsync` 起的子进程没有 TTY。
3. 真正干活的是 `spawnSync(agy, [], { stdio: "inherit" })` —— 把终端交给交互式 agy 登录 UI,阻塞到用户完成为止。这种东西本质上没法藏在一个 HTTP 请求后面。

所以改成 daemon 写一个临时 shell 脚本、用 `osascript` 打开 Terminal.app 去跑它。脚本里连着做两步:`login`(交互式 Google 登录)、成功后 `connect`(把新登录捕获保存)——`login` 自己的提示也是"New agy login is active. Run connect to save it",两步必须成对出现,放在同一个窗口里做完最省心,前端就不用再驱动第二步了。登录失败时脚本会说明"之前的账号已自动恢复"(这是 `openAntigravityLogin` 自己的行为:检测到新登录没完成会 `keychain.activate(current.account_id)` 回滚)。

前端因此只剩:确认 → 请求开窗 → 提示用户去那个窗口完成 → 用户点 OK 后重新 `fetchLiveAccounts()`。确认文案里明确写了"会先把当前账号保存下来,取消登录会自动恢复",因为这个流程中途确实会把本地登录态摘掉,不说清楚会让人以为出故障了。

**实测踩到的第二个坑:必须先 `connect` 再 `login`**(2026-08-23)。第一版脚本直接跑 `login`,实测报错:

```
agent-hub-accounts: current agy login is not safely saved; run agent-hub-accounts connect first
```

来源是 `openAntigravityLogin` 的前置检查:

```js
const current = live.current("antigravity-cli");
if (!current || !keychain.profileMatchesActive(current.account_id)) throw ...
```

它在把当前登录态 `detachActive()` 摘掉之前,坚持要求当前账号已经**逐字节保存**过——这样万一新登录没完成,才能 `keychain.activate(current.account_id)` 安全回滚。但这正好撞上 credential_drift:常驻的 `agy --hub` 会周期性刷新 OAuth token 并写回同一个 Keychain 槽位,所以正常用几分钟后,保存的副本就和实时凭证对不上了,`profileMatchesActive()` 返回 false,`login` 直接拒绝启动。也就是说**这个报错是常态而非异常**。

注意 `current --json` 看不出这个问题:它读的是缓存(输出里 `active_verification: "cached"`),显示 `credential_drift: false`、`is_active: true` 一切正常;`login` 做的才是实时 Keychain 比对。要复现得用 `--verify`(但注意 SSH 会话读不了 Keychain,在 SSH 里跑 `--verify` 会因为完全无关的原因失败,得到误导性结论)。

修复:脚本改成三步 —— `connect`(重新捕获当前已漂移的凭证,让前置检查通过)→ `login`(交互式登录新账号)→ `connect`(保存新账号)。第一步用不带参数的 `connect`,和 CLI 报错里给的指引一致(它会从 agy 最近日志里自动识别当前登录邮箱,比我们从外面猜一个 ID 传进去更贴近"现在实际登录的是谁")。每步失败都有独立的说明和退出,并明确告知有没有改动过状态。
