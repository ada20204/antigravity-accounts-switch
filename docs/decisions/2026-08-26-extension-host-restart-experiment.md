# 实验:添加账号的整窗口 reload 能不能换成"重启 extension host"

> **结论:失败,已回退。** 现场测试:点击添加账号后卡在 Antigravity 原生的
> "Signed out"页面,没有切回按钮。查daemon状态发现 `pendingAdd` 是
> `null`——`begin()`的 `setPendingAdd(...)`那一步根本没跑到。`workbench.
> action.restartExtensionHost` 触发的 extension host 销毁,发生在
> `windowReloadFn()`那次调用返回**之后**、`setPendingAdd()`跑之前的那几行
> 之间——2 秒的 race 超时完全没起作用,真实销毁比这快得多。已把
> `setWindowReloadFn`的接线从 `extension.ts` 删掉,`windowReloadFn`
> 恢复成默认的 `reloadWorkbenchWindow`(证明过可靠的 CDP 整窗口方案)。
> 顺带用手动 `switch` 把用户恢复到了原账号——凭据本身没有丢,丢的只是
> "该切回哪个账号"这条记录。
>
> 这次事故也暴露了 rescue banner 的一个独立 bug(和这次实验本身无关,
> 任何一次"pendingAdd 丢失但确实处于登出状态"都会撞上):见下面单独一节。

## 现状(未定论,标记为实验)

`begin()`(添加账号流程的第一步,清掉当前登录)用 `reloadStrategy: 'window'`,
底层是 `hubRestart.ts` 的 `reloadWorkbenchWindow()`——CDP 直接对 workbench 页面
发 `Page.reload`,这是真正的整个 renderer 重建,20-30 秒那种量级
(`docs/decisions/2026-08-22-switch-timing-instrumentation.md`)。原因写在
`restartAntigravityHub()` 的注释里:同端口 respawn 只刷新 iframe 内容,
extension host 不知道 hub 换了,它自己的"要不要显示登录页"检测不会重新触发。

## 为什么这条不是显然能优化的

VS Code 有个更轻量的命令 `workbench.action.restartExtensionHost`——只重启
extension host 进程(重新跑一遍所有扩展的 `activate()`),不重建 renderer/
webview,理论上应该比整窗口 reload 快得多。

但 `reloadWorkbenchWindow()` 的注释("re-resolves the webview panels, which
is what makes the extension spawn a hub")点出了关键:Antigravity 自己的
`AntigravityServerManager.start()` 要重新被调用,靠的**不是** extension host
重启本身,而是它的 **webview 面板被重新创建**(面板创建时去问"有没有现成的
server")。只重启 extension host、不动 webview 的话,面板还是原来那个,
`start()` 未必会被重新触发——如果确实不触发,这个优化就是无效的,登录页
不会出现。

这个不确定性没法靠推理解决,只能实测:`workbench.action.restartExtensionHost`
是 `vscode` 扩展 API,只有真正的扩展代码能调,CDP 摸不到(webview 里的 JS
没有权限执行 workbench 命令),没法从外部单独验证。

## 现在的接线方式

`hubRestart.ts` 新增 `setWindowReloadFn()`(和 `setOwnWorkspacePaths()` 同一个
模式——`hubRestart.ts` 本身不 import `vscode`,靠 `extension.ts` 在
`activate()` 里注入实际实现),**只换了 begin() 走的那一条路径**
(`restartAntigravityHub()` 里 `reloadStrategy === 'window'` 分支);另一处
`reloadWorkbenchWindow()` 调用(same-port-respawn 彻底失败时的整体回退路径,
注释明确写着"re-resolves the webview panels"这个不同的、必须要整窗口重建的
理由)没有动,还是原来的 CDP 整窗口重建。

`extension.ts` 的 `activate()` 里:
```ts
setWindowReloadFn(async () => {
  await Promise.race([
    vscode.commands.executeCommand('workbench.action.restartExtensionHost'),
    new Promise<void>(resolve => setTimeout(resolve, 2000)),
  ]);
  return true;
});
```
加了 2 秒超时兜底——这个命令本身会杀掉发出调用的 extension host 进程(也就是
我们自己),它的 Promise 不一定会在进程真正死之前 resolve,不加超时可能会把
`restartAntigravityHub()` 直接挂死。

## 需要你实测的

装上这次的 `.vsix`,走一遍完整的"添加账号"流程,重点看两件事:

1. **点击添加账号之后,原生的 Google 登录页有没有出现**——如果没出现(比如
   界面停在原来的状态,或者卡住没反应),说明上面的怀疑成立:只重启
   extension host 不够,webview 面板没有被重新创建,这个实验失败,需要我
   改回 `reloadWorkbenchWindow()`。
2. 如果登录页确实出现了,说明重启 extension host 这条路径本身足以让
   Antigravity 重新调用 `start()`——那就是真的省下了整窗口重建的耗时,
   之后可以补测一下具体省了多少秒。

失败了不是坏事,是排除了一个选项、把"为什么必须整窗口重建"这条结论坐实;
不需要额外清理,回退只是把 `setWindowReloadFn` 那段接线删掉,`hubRestart.ts`
默认值本来就还是 `reloadWorkbenchWindow`。

## 顺带修的独立 bug:rescue banner 一旦渲染就再也不更新

`addAccountPrompt.ts`的 `syncRescueBanner()`原来是 `if (existing) return;`
——banner 只在第一次创建时决定内容,之后每次 tick 只要元素还在就直接跳过。
问题是它按 `AccountStore.getAccounts().length` 决定要不要显示"Switch
account"按钮,而这个本地缓存在一次全新注入后的第一个 tick 很可能还是空的
(`fetchLiveAccounts()`还没回来)——banner 一旦在"0 个已知账号"这个空壳版本
下created,后面账号列表真正加载完成也不会触发任何更新,永远卡在这个没有
按钮的版本上。这正是这次事故里用户看到"Sign in with Google to get
started"、却没有"switch back"按钮的直接原因——6 个账号其实都在,只是
banner 创建的那一刻本地缓存还是空的,之后再没重新算过。

修法:把"只创建一次"改成"按 `count` 变化重新渲染"——banner 上存一个
`data-count`,只有这个值真的变了才重写 `innerHTML`(避免没必要的 DOM 抖动),
从 0 变成非 0 时会正确地把按钮加上去。不是这次实验直接导致的,但被这次事故
现场撞见了,顺手一起修了。

## 验证

`npx tsc --noEmit`、`npm run compile`、`npm run build:runtime`、`npm test`、
`npm run package` 全过。`workbench.action.restartExtensionHost` 这条路径
本身已经现场验证过并确认不可行(见文首结论),不需要再测;rescue banner
的修复还没有现场验证过"0→N 账号"这个具体转场,下次真的触发一次signed-out
状态时顺便看一眼。
