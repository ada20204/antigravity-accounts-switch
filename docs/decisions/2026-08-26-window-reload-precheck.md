# begin() 检查能不能 reload,要放在摘凭证之前,不是之后

发现于对当前架构的一次团队评审(3 个独立 agent 分头看)。`restartAntigravityHub()`
原来的顺序是:杀 hub → 跑 `onStopped`(begin() 用它清 Keychain + hub 会话缓存,
也就是真正的登出)→ 尝试 reload。`findWorkbenchPageTarget()` 在检测到多于一个
workbench 窗口时会拒绝猜,返回 `null`——这个拒绝本身是对的(见该函数自己的
注释),但它发生在 `onStopped` 已经跑完之后,`reloadFailed: true` 传到
`begin()` 时,用户已经被登出,而 `setPendingAdd()` 从未执行(因为 `begin()`
在检测到 `reloadFailed` 时会在写入 pendingAdd 之前抛错)。

结果和 [`2026-08-26-extension-host-restart-experiment.md`](./2026-08-26-extension-host-restart-experiment.md)
是同一个失败类别——"不可逆动作在先,检查能不能收尾在后"——但那次需要一段
已经回退的实验代码才能触发,这次只需要平时开两个 Antigravity 窗口,点一次
Add new account 就必现。

修复:`reloadStrategy: 'window'` 时,在杀 hub、跑 `onStopped` 之前先调一次
`findWorkbenchPageTarget()`。找不到唯一目标就直接拒绝整个重启,返回
`reloadFailed: true`,hub 和凭证都不碰。`begin()` 侧的检查(`onStoppedError
|| reloadFailed`)不用改,行为的区别只在于:抛出的"可能失败了"提示现在是真的
——凭证从未被动过,不是动过了才发现回不去。
