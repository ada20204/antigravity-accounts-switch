# (已被取代)cliRunner.ts 里写死的 keychain.js 路径已经过期,导致添加账号一直失败

> `cliRunner.ts` 连同这里描述的耦合已在
> [`2026-08-26-vendor-agent-hub-accounts.md`](./2026-08-26-vendor-agent-hub-accounts.md)
> 里整个移除——不再 `require()` agent-hub-accounts 的任何内部模块,`activeAvailable`/
> `detachActive` 直接调用 vendor 进来的 `keychain.ts`。这份记录只作历史追溯。

## 现象

`cliRunner.ts` 的 `keychainSnippet()` 直接 `require()` agent-hub-accounts 的
内部模块(不走它的公开 CLI 接口)来实现 `isKeychainActiveAvailable()`/
`detachActiveKeychainLogin()`。路径写的是 `AGENT_HUB_DIST/keychain.js`——
但 agent-hub-accounts 自己重构过,这个文件已经挪到
`AGENT_HUB_DIST/accounts/keychain.js`。旧路径不存在,`require()` 直接抛
`Cannot find module`。

agent-hub-accounts 自己的 `docs/explanation/integrations.md` 里已经写明了
这条 drift("cliRunner.ts 仍加载重构前的 dist/keychain.js"),只是我们这边
一直没同步。

## 实际影响

`isKeychainActiveAvailable()` 有"读不到就假设已登录"的兜底(`catch {return
true}`,继承自重构前 `isSignedOut()`的"不能瞎说已登出"原则)——路径错了之后
每次调用**必定**走进这个 catch,`signedOut` 永远报告 `false`,不管真实
Keychain 状态是什么。

`detachActiveKeychainLogin()` 没有这层兜底,每次调用**必定**抛错。它是
`begin()`(添加账号流程第一步)清除当前登录那个 `onStopped` 回调里的关键
调用——抛错直接导致整个添加账号流程在第一步失败,报错"clearing the current
login may have failed"。

## 修法与验证

把 `keychainSnippet()` 里的路径改成 `accounts/keychain.js`。在真实 macOS
host 上直接跑这段 require+调用验证过:修之前抛 `Cannot find module`,修
之后 `activeAvailable()` 正确返回真实 Keychain 状态。

## 没有解决的部分

这仍然是"绕过公开接口直接 require 内部模块"这类耦合(和
`2026-08-25-route-schema-break.md` 是同一类问题,只是这次挂的是内部模块
路径而不是 CLI schema)——agent-hub-accounts 自己的集成边界文档里也点名
建议改成走已安装命令或版本化接口,不要继续 import 内部构建产物。目前没有
对应的公开 CLI 命令能替代这两个具体操作(`activeAvailable`/
`detachActive`),这次只是把路径修对,没有解决耦合本身。
