# 邮箱叶子节点匹配为什么只在一个地方实现

这个检查(判断一个 DOM 节点是不是"只包含一个邮箱格式文本"的叶子节点)原来
在三处独立实现:`semanticLocator.ts` 的 `findProfileTrigger`/`findAccountPanelEmail`,
`profileSyncAdapter.ts` 的 `syncBottomTrigger`。三份已经互相漂移——
`profileSyncAdapter.ts` 用的是裸 `.includes('@')`,不是另外两处用的锚定正则,
导致任何"只是碰巧包含 @ 符号"的叶子节点(比如某个图标的 title 文本)都会被
误当成 profile 的邮箱节点并覆盖掉。

这个检查是安全关键的:`report-identity` 流程(见
[`2026-08-23-account-corruption-guessing-broken.md`](./2026-08-23-account-corruption-guessing-broken.md))
靠它来决定该把哪个账号的凭证覆盖掉。三份独立实现意味着修复一处安全 bug
不会自动传播到另外两处——现在统一收进 `domUtils.ts` 的 `leafEmailText()`,
三个调用点全部改成 import 这一份。
