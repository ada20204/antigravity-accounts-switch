# 添加账号流程的状态为什么落盘,以及 knownAccountIds 是干什么的

## 为什么落盘,不是内存变量

`pendingAdd`(记录 backupAccountId,给 Cancel 用)和 `lastAddedAccountId`
(一次性的"刚添加了 X"通知)都写进 `os.tmpdir()`,不是简单的模块内变量。

`pendingAdd`:sign-out 那一步会触发 webview reload,页面状态直接被销毁,
所以只能存在 daemon 这边。落盘是因为 daemon 自己也可能重启(daemon 崩溃、
extension host 重启、VS Code 更新)——这不是假设:重启发生在流程中途,
如果不落盘,标记直接丢失,用户停在一个已经登出的页面,没有任何按钮能完成
或取消这次添加。2026-08-26 的 `workbench.action.restartExtensionHost`
实验事故(`2026-08-26-extension-host-restart-experiment.md`)就是这个场景
的真实重演,只是那次是 `setPendingAdd()` 压根没跑到,不是跑完了又丢——两种
失败模式指向同一个结论:这条状态必须落盘。

`lastAddedAccountId` 原来是纯内存的("一次性通知,不值得持久化"),但同样的
daemon-restart 竞态打中过它:report-identity 设置这个字段和前端下一次轮询
读取这个字段之间,如果 daemon 正好重启,切换本身已经通过 CLI 落地成功了,
但"Added X"这条确认提示永远不会出现——没有报错,只是流程悄悄完成却没告诉
用户。改成和 `pendingAdd` 同一条落盘规则,不再是逐字段单独判断。

## 横幅为什么不能是点击那一刻打开的普通弹窗

`beginAddAccount()` 会登出并重启 hub,这会重载整个 webview,把页面当时持有的
任何状态(包括一个刚打开的弹窗)全部销毁。所以"有一个添加流程正在进行"这个
标志只能放在 daemon 那边、随页面重新注入时去问一遍——这也是横幅能在用户
中途手动 reload 窗口、或者 daemon 自己重启之后依然正确恢复的原因,不是刻意
加的特性,是这个持久化设计的自然结果。

## 为什么没有 Done 按钮

按一下"完成"只是把用户已经用登录动作告诉过我们的事情又重复说一遍——真正
判断"登录完成了没有"靠的是 `report-identity`(前端读 Account 面板 DOM 主动
上报),不是等用户自己点确认。`Cancel` 留着,因为"我不想登了,把旧账号还给我"
是一个真实的、猜不出来的用户意图,和"登录完成了"不是同一类信号。

## 横幅为什么只在主面板 iframe 显示

`location.pathname !== '/settings-standalone'` 才渲染。Settings 页不会
展示 Antigravity 的原生登录页,在那儿提示"去登录"没有意义;更实际的问题是
如果两个 iframe 都渲染横幅,Done/Cancel 会在几秒内同时可点,输的那次点击
会报"没有进行中的登录"——两份互相不知道对方存在的横幅争抢同一个后端状态。

## 轮询频率为什么自适应

没有进行中的登录时 30s 一次(纯兜底),横幅显示期间收紧到 2.5s(这时要
及时发现 daemon 已经自动捕获完成)。横幅的显示/消失完全由 daemon 单一
状态决定,没有别的地方能在背后悄悄改它,所以稳态下不需要高频轮询——
实测把 `status` 请求频率从 235 次/分压到了 2 次/分。

## knownAccountIds 是干什么用的

区分"一个全新账号登录"和"只是换到了另一个已保存的账号"的唯一依据。只比较
`backupAccountId` 是否变化不够——切到任何一个**已经保存过**的其他账号,
`backupAccountId` 照样会变,如果不比对 `knownAccountIds`,这种情况会被
误报成"添加了新账号",而这个账号其实早就在列表里。

## 落盘机制复用

三份状态(`pendingAdd`、`lastAddedAccountId`、`knownPlans`)统一用
`jsonStore.ts` 的 `loadJsonFile`/`saveJsonFile`(原子 temp+rename 写入,
symlink 安全)——原来是各自手写一套"从 tmpdir 读 JSON、容忍缺失/损坏、
写入或删除"的逻辑,三份重复。`validate` 参数带各自还需要的向后兼容/校验。

每份状态的持久化 shape 都带 `schema` 标记字段(仿照 agent-hub-accounts 的
`src/accounts/registry.ts`),按标记迁移或拒绝,不靠"猜字段存不存在"——现在
只有 v1,还没真正触发过迁移,但这样以后格式变了才有明确的版本锚点,不用再
像 `knownAccountIds` 那样临时打个"字段可能不存在"的补丁。

三份状态刻意仍然是全机器共享一份文件(不按窗口拆分)——见 `jsonStore.ts`
文件头注释和 `2026-08-26-extension-host-daemon.md`:它们描述的是一个共享的
底层事实(唯一的 Keychain 活跃槽位、按账号而非按窗口的 plan 标签),不是
每窗口各自独立的状态。
