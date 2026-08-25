# 监听器泄漏与无条件重渲染(2026-08-23)

**日期**:2026-08-23 · 涉及 `accountPopup.ts`、`main.ts`、`settingsEnhancer.ts`

**1. 每开一次弹窗泄漏一个 window 监听器**。`createAccountPopup()` 里挂了 `window.addEventListener('ag-account-changed', ...)`,但 `closePopup()` 只做了 `popupInstance.remove()`——**移除 DOM 节点不会解绑挂在 window 上的监听器**。而 `openPopup()` 每次打开都会新建一个弹窗,加上鼠标悬停左下角就会触发打开,所以鼠标每扫过一次就漏一个。每个泄漏的监听器都会在此后每次 `ag-account-changed`(20s 轮询 + 每次切换)时,对一个已经脱离文档的节点做完整 innerHTML 重建。

用 CDP `DOMDebugger.getEventListeners` 实测确认:**5 次开关正好泄漏 5 个**监听器。

修法:`createAccountPopup()` 建一个 `AbortController`、挂在元素上,监听器用 `{ signal }` 注册;新增 `destroyAccountPopup()`,由 `closePopup()` 调用。注意 `closePopup()` 里的 abort 必须在"节点是否还在文档里"的判断**之外**执行——节点早已移出文档时,监听器依然活着。修完复测:**0 泄漏**。

同一类问题在 Settings 卡片上也有:监听器在卡片创建时绑定,但切换 Settings tab 会重渲整个页面、把卡片一起带走,下一个 tick 又建一个新的,旧监听器留下来继续渲染脱离的节点——每切一次 tab 漏一个。修法相同(模块级 `AbortController`,建新卡片前 abort 掉旧的)。

**2. 每 1.5s 无条件重写 innerHTML,会吃掉点击**。`injectSettingsEnhancements()` 为了保持锚定每 1.5s 跑一次,里面无条件调 `renderSettingsCard()`,而它是整块 `innerHTML =` 重建。用户点 Switch/Remove 时,如果重渲染正好发生在 mousedown 和 mouseup 之间,**click 事件根本不会触发**(元素已经被换掉了),表现就是"点了没反应"。

修法:按渲染用到的数据算一个签名,不变就直接 return。少数会改变"非数据状态"的调用点显式传 `force`:切换后要清掉行上的 inline opacity(即使切换被取消、数据没变)、Check All Accounts 后要把按钮文案从 "Checking accounts..." 改回来。

弹窗侧同理加了签名守卫,原因是列表现在可滚动了——20s 轮询不管有没有变化都会重建 DOM,正在滚动的用户会被弹回列表顶部。

**验证**(实时页面):弹窗正常打开、5 行、"Best account remaining / 5 connected accounts"、徽章 97%(取最大值而非 500%)、列表 `overflow-y: auto`、`max-height` 405px 随视口计算、关闭干净、0 泄漏。
