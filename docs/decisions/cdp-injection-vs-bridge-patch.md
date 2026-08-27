# CDP 注入替代 bridge.js patch

**日期**:2026-08-22 · 涉及 `cdpInjector.ts`

bridge.js(`vscode-webview://` 外层 wrapper)跑在严格 CSP(`script-src 'self' 'sha256-...'`)下,会静默拦截动态 `<script src="http://localhost:5173/...">` 注入——现场用 CDP 验证过:脚本确实被 append 了,零报错,但 `window.AntigravitySwitchRuntime` 始终 `undefined`。

改用 CDP(`127.0.0.1:9222`)注入,原因:CDP 注入的脚本不受页面自身 CSP 约束,而且可以直接打进 CSP 更宽松的内层内容 iframe(`.../settings-standalone`),不用去碰外层 wrapper——一次性绕开两个问题。

依赖 VS Code 开着 CDP 端口;端口没开时轮询循环只是继续重试,不报错、不影响用户。这套方案只读 target 列表 + eval 我们自己的 bootstrap 代码,完全不碰 `extension.js`/`bridge.js` 或 `OnAntigravityReady` 握手,所以不带"卡在 Loading"的那类风险(那类风险是 patch 外层 wrapper 的 iframe 接线才会有的)。

**幂等注入检查**:`injectInto()` 不按 target id 缓存"已经注入过"——VS Code 会在原地重新加载 iframe 的 document(同一个 CDP target id,全新的 window),这种情况下按 id 缓存会误以为已经注入过,实际脚本已经被冲掉了。所以每个 tick 都重新做一次幂等检查(`if (window.AntigravitySwitchRuntime) return 'present'`),这是唯一能可靠自愈的办法。
