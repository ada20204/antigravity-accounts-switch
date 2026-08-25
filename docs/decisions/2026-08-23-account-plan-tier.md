# 账号等级(Plan)(2026-08-23)

之前 `accountStore.ts` 里的 plan 字段是纯瞎猜:默认 `'Google AI Pro'`,只有 `issue === 'eligibility_failed'` 才翻成 `'Free'`——`'Google AI Ultra'` 这个值代码里从来没被赋过,不可能出现。核实过 `agent-hub-accounts` 的 `route --json` schema:没有任何 plan/tier/subscription 字段,CLI 侧拿不到。

现场用 CDP 翻了 Settings → General → Account 卡片,找到真实来源:`<div class="text-sm font-medium">Your Plan: Antigravity Starter Quota</div>`(当前唯一验证过的账号,Free 档,原文措辞是 "Antigravity Starter Quota" 不是字面 "Free")。这行字只在 Settings 的 General 子页存在,而且只反映"当前激活账号"的等级——不像邮箱那样随时能读到全部账号。

方案(照搬"永远不要猜,读真实 DOM"这条本项目一路的原则,和邮箱识别同款思路):
- `semanticLocator.ts` 新增 `findAccountPlanLabel()`,精确匹配 `Your Plan:` 前缀的叶子文本节点。
- `settingsEnhancer.ts` 每 1.5s tick 顺手查一次(只在页面真的显示这行字时才有值),变化了才上报,不是每 tick 硬发。
- daemon 新增 `knownPlans`(与 `pendingAdd`/`lastAddedAccountId` 同款、`os.tmpdir()` 持久化的按账号 id 存储)+ `POST /api/report-plan`(前端上报,daemon 只信任、不猜测)+ `/api/accounts` 响应里按 `account_id` 合并进去。
- `accountStore.ts` 的 `plan` 字段从封闭的三态 union 改成 `string`,真实取自 daemon,没观测到时诚实显示 `'Unknown'`,不再是瞎猜的默认值。

`tsc --noEmit` 已过;`/api/report-plan` 这个新 daemon 端点尚未现场验证——需要重启 daemon 才会生效。
