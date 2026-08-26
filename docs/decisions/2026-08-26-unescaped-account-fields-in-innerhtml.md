# 弹窗/Settings 卡片拼 innerHTML 没转义,plan 字段几乎不做校验

发现于对当前架构的一次团队评审。`accountPopup.ts`/`settingsEnhancer.ts` 用模板
字符串拼 `innerHTML`,`acc.name`/`acc.plan`/`acc.issue`/`acc.id` 全程没有转义
——`confirmDialog.ts`/`progressOverlay.ts` 一直用的是 `textContent`/DOM API,
这两个文件是例外,不是项目的既定做法。

`acc.plan` 来自 `/api/report-plan` 写入的 `knownPlans[accountId]`,这个接口
原来只检查两个字段"存在",不检查类型和长度。本机任何一个凑对 Origin 头的
网页(CORS 白名单本来就允许任意 `127.0.0.1:<port>`,见
[`cors-allowlist-policy.md`](./cors-allowlist-policy.md))理论上能往这个字段塞
任意字符串,落盘后在真实的 Antigravity webview 里被当 HTML 渲染出来——等于
在 IDE 自己的窗口里拿到脚本执行权限,再借此调用 switch/remove。`accountId`
不检查类型这一点还有第二个问题:它被当对象键写入 `knownPlans[accountId]`,
传 `"__proto__"` 且 `label` 为对象时是真实的原型链污染,不只是理论风险。

修复两层:
1. **转义是主要防线**:`domUtils.ts` 新增 `escapeHtml()`,两个文件所有拼进
   `innerHTML` 的动态字段全部过一遍——不管来源是否已经"应该"是安全格式,
   转义后即使真的存了脏数据也无法被解析成标签。
2. **`/api/report-plan` 加校验是第二层**:`accountId`/`label` 必须是字符串,
   `label` 限长 64,`accountId` 拒绝 `__proto__`/`prototype`/`constructor`——
   参考 agent-hub-accounts 自己 `identifiers.ts` 里同一个防护的做法。

`/api/connect` 的 `accountId` 没有单独加校验:它只经过 `execFile` 的 argv
数组传给 CLI(不会被当 shell 字符串解析),真正落盘前还要过 CLI 自己的
`accountId()` 校验器,渲染层的转义已经覆盖了它作为 HTML 内容出现的那条路径。
