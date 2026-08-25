# CORS 白名单策略

**日期**:2026-08-22 · 涉及 `daemon.ts::isAllowedOrigin`

daemon 监听 `127.0.0.1:63820`,理论上会被这台机器上任何打开的网页请求到。只反射白名单里的 origin(`vscode-webview://...` 或 `http://127.0.0.1:<hub-port>`),不用通配符 `*`——通配符会让用户平时用的浏览器里随便一个网页都能对着这个本地 daemon 发 `/api/switch|remove|login`,构成对着真实 Google 账号切换器的 CSRF。
