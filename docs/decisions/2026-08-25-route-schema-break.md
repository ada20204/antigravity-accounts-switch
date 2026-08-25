# 多账号消失:agent-hub-accounts 把 route 废弃、换了 schema

## 现象

Settings 卡片和弹窗突然一个账号都不显示了,像是数据丢了。

## 诊断

数据完全没丢——`~/.agent-hub/plugins/accounts/state/credentials/` 下 6 个账号的凭证文件全都在,`agent-hub-accounts list --json` 也能正常读出全部 6 个账号、状态正常。问题出在 `agent-hub-accounts` 自己这几天一直在迭代(它的 `CHANGELOG.md` Unreleased 区块能看到:"Retire route context health/cooldown/capacity synthesis; keep `route` only as a deprecated spelling of the cache-only quota batch"),`route` 命令被降级成一个废弃别名:

- `route --verify` 现在直接报错拒绝(`route is a deprecated cache-only alias and does not accept --verify`),不再是"能跑但结果不准",是**跑不了**。
- `route --json`(不带 verify)还能跑,但 schema 整个换了:`agent_hub.account_quota_batch.v2`,顶层是 `results` 数组,**没有 `accounts` 字段、没有 `active` 字段**。

`daemon.ts` 的 `/api/accounts` 一直在读 `parsed.accounts ?? []` ——这个字段现在恒为 `undefined`,`?? []` 静默兜底成空数组,前端拿到"零账号",UI 上看起来就是"账号全没了",没有任何报错。

## 修法

改用当前的替代命令,不是给旧命令打补丁:

- 账号列表(`/api/accounts`):`route --json` → `list --json`(schema `agent_hub.account_list.v3`)。
- 精确判断当前激活账号(`resolveActiveAccountId()`、`begin()` 里的 `exactMatch`):`route --verify --json` → `current --verify --json`。**注意这不是一对一替换**——`current` 只返回当前激活的那(几)个账号,不像老的 `route --verify` 那样顺带给出全部已知账号列表。`begin()` 里原来一次调用拿两样东西(`knownAccountIds` 全量 + `exactMatch`),现在拆成两次调用:`list --json` 拿全量,`current --verify --json` 拿精确匹配。

字段跟着改名/挪位置:
- `acc.active` → `acc.is_active`
- `acc.groups.gemini.weekly/five_hour`(固定 key 的对象)→ `acc.quota.groups[]`(数组,每个 group 有 `name` 和 `buckets[]`,按 `id`(如 `gemini-weekly`、`gemini-5h`)查找,不是固定路径——`accountStore.ts` 新增 `findQuotaBucket()` 处理)
- `acc.issue` → `acc.quota.issue`

**意外收获**:`quota.user_tier.name` 现在是 CLI 原生字段,直接就是 "Google AI Pro"/"Antigravity Starter Quota" 这类文本——`/api/accounts` 顺手加了一条 fallback:`knownPlans[id] ?? acc.quota?.user_tier?.name ?? null`,没被 daemon 自己观测过(没打开过 Settings)的账号现在也不用显示 "Unknown" 了。DOM 抓取(`findAccountPlanLabel()`)暂时保留没动——两者不冲突,`knownPlans` 优先——但这说明那套 DOM 抓取的必要性已经下降,以后可以考虑要不要整个换成读这个字段,不在这次改动范围内。

## 验证

`tsc --noEmit` 干净。用真实 `list --json` 输出跑了一遍和 `accountStore.ts` 完全一致的转换逻辑(临时脚本,已清理),6 个账号全部正确解析:`is_active` 精确到 `djordjejeremic111`、plan 名称正确、配额百分比合理(缺 `gemini-5h` 桶的免费账号正确只用 weekly 算)。daemon 端改动仍需重启才生效,还没有在真实运行的 daemon 上现场跑通。
