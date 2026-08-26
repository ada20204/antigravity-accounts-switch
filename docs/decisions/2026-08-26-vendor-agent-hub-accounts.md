# 把 agent-hub-accounts 的账号管理核心搬进本仓库,不再要求用户单独装它

用户要求:装这个插件不能再额外要求装 `agent-hub-accounts`,但要沿用同一套存储
(Keychain 槽位 + 凭证备份文件),这样老用户的数据零迁移,机器上如果还留着
`agent-hub-accounts` 也不冲突。这轮改动由一次三人架构师团队评审驱动(当前架构
评审、吸纳方案设计、安全评审各一份独立报告),细节见下。

## 搬了什么、没搬什么

`agent-hub-accounts` 的账号核心逻辑本身零运行时依赖(只用 Node 内置模块),
适合直接复制而不是发布成 npm 包或重写:

| 搬进 `src/daemon/accounts/` | 对应上游 | 备注 |
|---|---|---|
| `files.ts` | `support/files.ts` | 加固过,见下"为什么没有原样照搬" |
| `identifiers.ts` | `accounts/identifiers.ts` | 原样 |
| `types.ts` | `accounts/types.ts` | 原样 |
| `keychain.ts` | `accounts/keychain.ts` | 原样(含 export/importProfile,为未来 export/import UI 留着) |
| `registry.ts` | `accounts/registry.ts` | 原样 |
| `live.ts` | `accounts/live.ts` | 原样 |
| `quota.ts` | `accounts/quota.ts` | 只留缓存读取路径,见下 |
| `manager.ts` | `accounts/manager.ts` | 原样 |
| `processControl.ts` | `cli/process-control.ts` | 只留 `openAntigravityLogin`,`runAntigravity` 是 isolated-hub 专用,不需要 |
| `paths.ts` | `cli/options.ts` 的 `settings()` | 裁到本项目用得到的字段 |
| `loginCli.ts` | (新)`cli.ts` 的极简替代 | 只暴露 Terminal 脚本要的 3 个子命令 |
| `index.ts` | (新) | 进程生命周期单例装配,对应 `cli.ts` 每次调用现拼装那四个对象 |

没搬:`isolated/**`(多实例执行引擎,本插件从不使用)、`cli/**` 和 `cli.ts`
本体(参数解析/帮助文本/表格渲染,没有 CLI 就不需要)、`transfer.ts`
(export/import——`docs/ISSUES.md` 里已经记着这块还没接进 UI,等真正做的时候
再搬)。`quota.ts` 只留了 `QuotaCache` 的读取路径:`/api/quota-refresh` 本来
就已经是纯缓存读(`quota --all --json` 不带 `--refresh`,这次团队评审顺带
发现的),真正会写缓存的路径需要为每个账号起一个 isolated hub,超出这次范围。

## 为什么没有原样照搬 `files.ts`(安全评审的具体建议)

上游 `assertSafePath()` 是 `lstatSync` 检查再操作,检查和操作之间有竞态窗口。
这仓库自己处理凭证文件时(`extension.ts` 已删掉的 `readCredentialFile`/
`restoreProfile`)一直用 `O_NOFOLLOW`/`O_EXCL` 直接开文件,不留这个窗口。
`files.ts` 的 `readJson`/`writeJson`/锁文件读取全部改成这个模式;`writeJson`
的 tmp 文件本来就靠 `O_EXCL` 防符号链接(细节见文件内注释),这里只是补齐
一致性。

## 为什么调用 `manager.ts`,不直接调 `keychain.ts`(安全评审的具体建议)

`AntigravityAccountService.switchAccount()`/`capture()` 内置了写入前后重新读
一遍 registry 版本号、写完用 `profileMatchesActive()` 校验的机制——这正是
[`2026-08-23-never-bare-connect-call.md`](./2026-08-23-never-bare-connect-call.md)
那次账号损坏事故之后本该有、但当时没有的第二道防线。全部改动都经过
`accountService`,没有一处直接摸 `keychain.activate()`/`capture()`。

## 顺带删掉的一处重复(两位架构师独立发现)

`extension.ts` 原来自己手搓了一份"备份/还原凭证文件"逻辑
(`snapshotProfiles`/`restoreProfile`/`profileFileFor`,约 60 行),专门给
`finish` 端点"猜测落到已知账号就回滚"这一步用。这其实是把 `keychain.ts`
已有的 `exportProfile`/`importProfile` 又实现了一遍——两处理解同一个文件
格式,是历史事故的根因模式。这次连同猜测逻辑一起删掉了,见下一节。

## `finish` 端点不再猜测(顺带修复,不是新引入的问题)

`finish` 手动兜底端点(无 UI 调用)原来在没传 `accountId` 时会走
`agent-hub-accounts` 自己的 bare `connect` 逻辑——扫 `~/.gemini/antigravity-cli/log/`
猜邮箱,猜不到就退化成 `generatedAccountId()`(随机 ID)。
[`2026-08-23-account-corruption-guessing-broken.md`](./2026-08-23-account-corruption-guessing-broken.md)
现场验证过:这个日志目录属于独立 `agy` CLI,不是本项目实际使用的
`agy --hub`(写的是 `~/.gemini/antigravity/log/`),扫的目录**从不产生**
`email=` 格式的行——也就是说这条猜测路径在本项目的实际部署下结构性地不可能
猜对,今天不修就是明天的第三次账号损坏事故。

vendor 不是照原样搬运这个坏掉的行为的理由,搬的时候直接删:`finish` 现在
没有 `accountId` 就直接拒绝,提示改用 `report-identity`(真正的完成路径,
从 Account 面板 DOM 读真实邮箱)或手动传真实邮箱。Terminal 登录脚本
(`buildLoginTerminalScript`)里两处 bare `connect` 同理改成新的
`loginCli.js connect [email]`——不传邮箱时只在活跃凭证已经匹配某个已保存
账号时才二次确认保存(安全),真正全新账号那一步没有邮箱来源(headless
脚本读不到 DOM),直接报错指向应用内流程,不再退化成随机 ID。

## 存储路径:实测和真实安装的 CLI 完全一致

`paths.ts` 复刻的默认公式(`~/.agent-hub/plugins/accounts/state/...`)已经
在真实机器上验证:vendor 版计算出的 `registryPath`/`livePath` 和已安装的
`agent-hub-accounts status --json` 报告的路径逐字节相同。进一步做了一次
只读比对——vendor 版的 `accountService.overview('')` 对真实的、已经跑了
137 代、6 个真实账号的 `registry.json` 跑出来的结果,和真实 CLI 的
`list --json`(剔除 schema 字段名的差异后)**逐字节相同**。这是"golden-diff"
验证,只读不写,不碰任何真实凭据的写路径。

## schema 版本:冻结在今天,不追踪上游

`agent_hub.accounts.v4`(注册表,仍兼容读 v1-v3)、`agent_hub.account_live.v2`、
`agent_hub.antigravity_credential.v2`(仍兼容读 v1)、
`agent_hub.account_quota_cache.v3`(仍兼容读 v1-v2)——这是 fork 时刻的版本。
以后 `agent-hub-accounts` 自己再往上加版本,不是这个项目的责任,除非真的
出现了新格式的文件需要读,那时候按需给 `parseRegistry()` 等函数加一段新
分支即可,不是持续追更上游的义务。

## 上线前怎么验证,不碰真实凭据

`test/accounts.test.mjs`:复用 agent-hub-accounts 自己测试套件的假
`security` 二进制机制(`AGENT_HUB_ACCOUNTS_TEST_SECURITY_BIN` + JSON 状态
文件模拟 Keychain),在临时目录里跑 capture→switch→remove 全流程,断言每一步
的 `is_active` 状态符合预期——尤其覆盖"切回另一个账号后,前一个账号必须不再
显示 active"这个历史事故的确切场景。`npm test` 现在会先 `npm run compile`
再跑这个测试,两台机器(本容器 Linux + 实际 Mac host)都跑绿。

## 移除的模块

`src/daemon/cliRunner.ts` 整个删除——`runCli`/`runCliJson`(execFile 包一层
CLI)、`isKeychainActiveAvailable`/`detachActiveKeychainLogin`(`require()`
agent-hub-accounts 内部编译产物的那两个函数,`docs/ISSUES.md` 里挂了很久的
遗留耦合)全部被进程内直接调用取代。`isKeychainActiveAvailable()` 原来的
"读不到就假装已登录,别自己吓自己"这条兜底(`docs/decisions/2026-08-23-review-b9ad69f-followup-10-findings.md`
finding 4)现在也不需要了——它是为了兼容子进程可能整个起不来的情况设计的,
`keychain.activeAvailable()` 本身是同步调用,不会有这种"进程根本没起来"的
歧义状态。

## agent-hub-accounts 本体不受影响

不改这个仓库任何一行代码,继续作为独立工具正常安装使用;如果同一台机器
上两者都在,读写的是完全相同的文件和 Keychain 槽位,不冲突。
