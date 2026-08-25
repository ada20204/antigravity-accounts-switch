# Profile 触发器同步:为什么不能用纯坐标启发式

**日期**:2026-08-22 · 涉及 `profileSyncAdapter.ts::syncBottomTrigger`

我们的 runtime 会同时注入到主 Chat iframe 和 Settings(`settings-standalone`)iframe。真正的左下角 profile 触发器只存在于前者的 DOM 里,后者压根没有这个元素。

第一版 `syncBottomTrigger` 自己用一套独立的坐标启发式找"profile 容器"(`rect.bottom > 窗口高度-80 && rect.left < 220 && width>100 && height>24`),在 Settings 页面里没有真实触发器可匹配时,退化成随便匹配一个贴左边、够高够宽、底部接近窗口底部的 div——Settings 左侧导航栏(General/Models/... 那一列)整列刚好满足这个条件,于是它被当成了"profile 容器",里面第一个叶子文本节点(`"General"`)被当成邮箱/名字节点直接覆写,tab 名称被换成了当前账号邮箱。

修复:改成复用 `SemanticLocator.findProfileTrigger()`(先做语义匹配——找邮箱格式的叶子文本节点,再回溯到可交互容器;兜底才用 16-48px 的头像图片,范围严格得多),在没有真实触发器的场景(比如 Settings iframe)直接返回 `null`,不再瞎猜。

**头像**:不覆写原生 `<img>` 头像标签——那是真实的 Google 头像,`agent-hub-accounts` 的账号数据里也没有 avatar 字段,之前拿同一张 stock 图片覆盖所有账号,是在用假信息销毁真信息,不是增加信息。
