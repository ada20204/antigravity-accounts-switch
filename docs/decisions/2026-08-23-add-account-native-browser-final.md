# 添加账号(定稿):走原生浏览器登录,不再开 Terminal

**日期**:2026-08-23 · 涉及 `daemon.ts` 的 `/api/add-account/*`、`addAccountPrompt.ts`、`accountPopup.ts`

下面那版(开 Terminal 跑 `agy` TUI)能用但很别扭:一个做在编辑器里的 UI,点"添加账号"却弹出一个终端窗口让你在 TUI 里操作。

**更好的路子**就是 Antigravity 自己的流程:没有凭证时 hub 会渲染它自己的登录页,点上面的按钮时 hub 打印 `ANTIGRAVITY_OPEN_URL:`,`extension.js` 监听 hub stdout 捕获这行并 `vscode.env.openExternal()` 跳浏览器。所以我们**完全不需要碰登录本身**,只要负责"把凭证拿走"和"把新凭证存回来",中间那段是原生的。

**第一次实测失败,以及从 antigravity-sync-mcp 学到的两点纠正(2026-08-23)**

第一版跑下来:用户**根本没被登出**,`finish` 捕获到的还是同一个账号。查 `~/antigravity-sync-mcp/packages/sidecar/scripts/restart-worker.js`(它的 `relaunch_with_auth_clear` / `Trigger: account_add` 解决的是同一个问题)后定位到两个错误:

1. **认证不在 Keychain**。那个项目清的是 `state.vscdb` 的 `antigravityAuthStatus` / `antigravityUnifiedStateSync.oauthToken` / `antigravityUnifiedStateSync.userStatus` 三个 key,还要删 `.vscdb.backup` 防止从备份恢复——但那是给**独立的 Antigravity.app** 用的,我们这套 VS Code + 扩展的 DB 里根本没有这些 key(只有 `lastInstalledReleaseBaseUrl`)。**我们环境里的对应物是 `~/.gemini/jetski-standalone-oauth-token`**,即 hub 自己缓存的 session。证据:在 SSH 会话里起的 hub(读 Keychain 返回 exit 36,完全无权限)照样是已认证状态,说明它靠这个文件;而空 HOME 起的 hub 则不会生成它。
2. **时机**。对方代码里那句注释就是我们踩的坑:`// 清空 auth（在进程退出后执行，避免被 Antigravity 写回覆盖）`。第一版是在 hub 还活着时清的,被正在退出的 hub 原样写了回去。为此给 `restartAntigravityHub()` 加了 `onStopped` 钩子,专门提供"所有 hub 已退出、新 hub 尚未启动"这个窗口。

**为什么不备份 session 文件**:它是 hub 的缓存,不是凭证的唯一副本。每次普通的账号切换都只写 Keychain(`switch` → `activate()` → `writeActive`,agent-hub-accounts 从不碰这个文件),而重启 hub 之后账号确实会变——这说明 hub 启动时以 Keychain 为准并据此重建该文件。所以直接删掉即可,恢复交给 `switch`,真正的备份是 `credentials/<id>.json`(`begin` 的第一步 `connect` 已证明它存在)。这也让 `cancel` 退化成一次普通的 `switch` + 重启,走的是被反复验证过的老路径。

**验证过的前提**(没有动实机凭证):
- `detachActive()` 实现是 `security delete-generic-password -s gemini -a antigravity` —— **纯本地删 Keychain 条目,没有任何网络调用或 OAuth 撤销**;`~/.agent-hub/plugins/accounts/state/credentials/` 下的凭证副本文件完全不动,所以 `activate()` / `switch <id>` 随时能还原。
- 在 SSH 会话里起了一个 hub(SSH 读 Keychain 返回 exit 36,天然就是无凭证状态):**照常启动、HTTP 200**,说明 detach 后重启 hub 不会把 hub 弄坏;而且启动时 stdout 里**没有** `ANTIGRAVITY_OPEN_URL`,证实那行是登录页点击后按需发出的,不是启动时发的——所以我们不需要去 pipe hub 的 stdout。

**流程**(daemon 三段式 + 一个状态查询):
1. `POST /api/add-account/begin` —— 先 `connect` 捕获当前凭证(既顺手修掉 drift,又**证明**能还原;失败就直接中止,不做任何破坏性操作),记下备份账号 ID,然后 detach,再用已有的快速同端口 respawn 重启 hub。
2. webview 重载 → hub 无凭证 → 显示原生登录页 → 用户点击 → 浏览器登录(全程原生)。
3. `POST /api/add-account/finish` —— `connect` 捕获现在登录的这个账号,重启 hub。
4. `POST /api/add-account/cancel` —— `switch <备份ID>` 还原,重启 hub。

**为什么"进行中"的状态存在 daemon 而不是页面里**:第 1 步会重启 hub、把 webview 整个重载掉,页面持有的任何状态都会丢。所以 daemon 用 `pendingAdd` 记录,`GET /api/add-account/status` 供查询;runtime 每次注入时都问一遍,需要就重建那个 Done/Cancel 横幅。副作用是这个横幅在用户中途手动 reload 窗口后也能正确恢复。

横幅刻意做成**不遮挡页面**的顶部条(不是模态)——用户必须能够操作它下面 Antigravity 自己的登录页。

**detach 的实现方式**:不在本仓库硬编码 Keychain 的 service/account 常量、也不自己拼 `security` 命令,而是 `node -e` 复用 `agent-hub-accounts` 编译产物里的 `MacKeychain.detachActive()`(经 `settings().credentialsDir` 构造)。少一处需要同步的重复定义,它们的错误处理和后续改动也自动跟上。

旧的 `/api/login`(Terminal + TUI)暂时保留作为兜底,UI 已不再调用。
