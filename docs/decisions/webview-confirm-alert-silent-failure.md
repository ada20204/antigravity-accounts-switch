# window.confirm() / alert() 在 VS Code webview 里静默失效

**日期**:2026-08-22 · 涉及 `confirmDialog.ts` 及所有调用点(`accountStore.ts`、`accountPopup.ts`、`settingsEnhancer.ts`)

这是本次调试链路最长的一个 bug:所有需要用户确认的操作(切换账号、添加账号、Check All Accounts、Remove)全都表现为"点了没反应"。现场用 CDP 直接在 settings-standalone iframe 里执行 `window.confirm('test')`,返回 `{"threw":false,"result":false}`——**没有抛错,也没有弹出任何对话框,直接静默返回 `false`**;`window.alert()` 同样不抛错但什么都不显示。VS Code webview 的沙箱环境把这两个原生 API 静默 no-op 掉了。

修复:自建 `confirmDialog.ts`(`showConfirm()`/`showAlert()`,纯 DOM 实现的模态框,返回 Promise),替换掉全部调用点的原生 `confirm()`/`alert()`。
