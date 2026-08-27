# 全新状态下"收编当前已登录账号"的入口

`docs/ISSUES.md` 里挂着的一条:装完插件时如果 Antigravity 本来就登录着,点
"Add new account" 会走一遍完整的登出→登录,没有更省事的路。

## 为什么只能放在 Settings 卡片,不能放弹窗

判断"现在到底登录着谁"唯一可靠的来源是 `SemanticLocator.findAccountPanelEmail()`
(读原生 Account 面板的邮箱文本节点),而这个面板**只存在于 `settings-standalone`
iframe**——账号弹窗活在主面板 iframe 里,读不到这个 DOM。所以入口只能加在
`settingsEnhancer.ts` 的 Settings 卡片空状态里,弹窗空状态改成提示文字指过去。

## 为什么不需要新的 daemon 路由

`/api/connect` 传显式 `accountId` 时已经是"把当前活跃凭证存成这个账号"的语义
(`accountService.capture(id, id, true)`,`createProfile: true` 会自动建新
profile)——这正好就是"收编"要的效果,不需要新增端点。`AccountStore.triggerConnect(accountId)`
也已经存在,直接复用。整个改动纯粹是加一个 UI 入口:空状态下检测到
`findAccountPanelEmail()` 有值,就渲染一个按钮,点击后确认 + 调用现成的
`triggerConnect`。

## 确认文案为什么不说"会登出"

因为这条路径**不会**登出、不会重启 hub、不碰 Keychain 之外的任何东西——纯粹是
把"已经在用的登录"另存一份记录。文案特意点明"不会改变 Antigravity 里任何东西",
和"Add new account"按钮那条会登出的确认文案区分开,避免用户误以为两者等价而选错。
