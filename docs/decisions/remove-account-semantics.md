# 移除账号:实际语义比"本地忘记"更重

**日期**:2026-08-22 · 涉及 `daemon.ts::/api/remove`、`settingsEnhancer.ts`

之前 UI 上写的是"This only forgets it locally — you can reconnect it later",**这句话是错的**。查 `cli.ts` 的 remove 分支和 `keychain.ts::remove`:满足 `auth_kind === "oauth-subscription" && credential_source === "agy-profile"` 时会执行 `keychain.remove(accountId)`,而它做的是 `fs.unlinkSync(this.profilePath(normalized))`——把插件保存的那份凭证副本文件直接删掉。

所以准确语义是三条:
- **会**删除保存的凭证副本 → 之后无法再切回这个账号,想要回来必须重新走一遍完整的交互式登录(不是点一下 connect 就行)。
- **不会**撤销 Google OAuth、**不会**登出(CLI 文档明确:`Login never invokes agy /logout or an OAuth revoke endpoint`)。
- 不影响这个 Google 账号在别处的任何状态。

文案已按这三条重写。另外 daemon 侧加了一道拦截:**拒绝移除当前正在使用的账号**(先 `route --json` 查 `active`,命中就返回 409 `ACCOUNT_ACTIVE`)。否则会把正在跑的 hub 脚下的凭证抽掉,留下一个"活着的会话,但它的账号已经不在注册表里"的错乱状态。要移除得先切到别的账号。

`accountStore.ts` 里 `removeAccount()`/`triggerLogin()`/`triggerConnect()` 相应改成返回 `{ok, error}` 而不是吞掉异常——daemon 会因为上面这条 409 拒绝请求,如果继续静默失败,UI 上看起来和"删成功了"一模一样。
