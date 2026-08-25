# 添加账号原生登录页不出现(2026-08-23)

现象:点击"添加新账号"后一直卡在插件自己画的 "awaiting sign-in" banner,原生 Google 登录页从不出现;手动重启(整个 VS Code 窗口)后才恢复正常。日志显示 `begin()` 的 hub 重启每次都成功("reloaded 2 iframe(s)",无报错),但当天从 07:16 到 09:27 的多次真实尝试全部以 `finish FAILED No new sign-in detected yet` 收场——**这个问题当天在 17 条 review 修复之前就已反复出现,不是那轮修复引入的回归**。

根因:`begin()` 一直用的是账号切换那条"快速路径"——自己 kill 旧 hub、原端口 spawn 新 hub,再用 CDP 对 webview iframe 执行 `location.reload()`。这只刷新了 iframe 内容,VS Code 扩展宿主(extension host)完全不知道 hub 被换掉了,它自己那套"检测到没有 hub → 展示登录页"的原生逻辑从未被触发。普通切换账号不受影响,是因为凭证依然有效,iframe 刷新拿到新数据就够了;但 add-account 需要的是"真正让扩展宿主重新确认一次登出状态",这只有让 VS Code 重新加载整个窗口(`Page.reload` 在 workbench 顶层 target 上)才能触发——这正是用户手动重启能解决问题的原因。

修复:`restartAntigravityHub()` 新增 `options.reloadStrategy`,`'window'` 时复用已有的 `reloadWorkbenchWindow()`(整窗口 reload)代替 `reloadIframesOnPort()`,其余(kill+同端口 spawn 新 hub)逻辑不变。只有 `begin()` 传 `{ reloadStrategy: 'window' }`;普通 switch/finish/cancel 仍走原来的 iframe-only 快速刷新,不受影响。见 `src/hubRestart.ts` 的 `restartAntigravityHub()` 和 `src/daemon.ts` 的 `begin()` 调用处。

尚未现场验证(需要真实触发一次添加账号流程确认原生登录页确实出现);`tsc --noEmit` 已过。
