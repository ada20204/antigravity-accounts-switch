# extension.ts 拆分:路由 vs 装配

`docs/ISSUES.md` 挂了很久的一条("extension.ts 该拆了")。拆成三份:

- `extension.ts`(282 行)——只剩 `activate()`/`deactivate()`、CORS/静态文件/端口分配这些 server 装配代码,不再包含任何 `/api/*` 业务逻辑。
- `routes.ts`(348 行)——`/api/accounts`、`/api/switch`、`/api/connect`、`/api/remove`、`/api/login`、`/api/report-plan`、`/api/quota-refresh`、`/api/hub-restart`。
- `addAccountRoutes.ts`(275 行)——`/api/add-account/*` 五个端点单独一份,这是原文件里最大的一块(`begin()` 一个handler就快 100 行),先拆出去,`routes.ts` 本身仍然超过 500 行门限。

共享的可变状态(`pendingAdd`/`lastAddedAccountId`/`knownPlans`/`port`)通过一个 `RouteState` 对象引用在三个文件间传递——`extension.ts` 持有并在 setter 里做落盘,`routes.ts`/`addAccountRoutes.ts` 只读写同一个对象的字段,不会拿到过期快照。落盘逻辑(文件路径、schema 版本、锁文件)留在 `extension.ts`,因为这些是跟 `activate()` 生命周期绑定的装配细节,不是路由业务逻辑本身。

`routes.ts` 和 `addAccountRoutes.ts` 都刻意不 `import 'vscode'`——纯路由逻辑只需要 `accountService`/`keychain`/`registry`/`restartAntigravityHub`/`log`,这几个都不碰 extension host API。

`test/structure.test.mjs` 的 `LINE_LIMIT_EXCEPTIONS` 里 `extension.ts` 那条直接删掉了(282 行,不再需要豁免),`hubRestart.ts` 那条还留着,没动。
