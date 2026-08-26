# 前端写死了 63820,多窗口下会连到别的窗口的 daemon

发现于对当前架构的一次团队评审。`extension.ts` 的 `listenOnFreePort()` 从
63820 起向后找空闲端口,就是因为设计上每个窗口的 daemon 端口不固定;
`cdpInjector.ts` 也正确地把真实端口拼进注入的 `<script src>`/`<link href>`。
但 `accountStore.ts` 里 `DAEMON_URL` 是写死的字符串常量 `http://127.0.0.1:63820`
——runtime.js 本身从对的端口加载,加载完之后所有 API 调用却都打到 63820。

单窗口时两者恰好相等,看不出问题。开第二个窗口时,后激活的窗口拿到
63821(或更高)的端口,但它的弹窗依然向 63820 发请求——也就是第一个窗口的
daemon。点切换/删除,改的是第一个窗口的账号状态,自己窗口的 hub 和 Keychain
完全没动。必现,不是偶发竞态。

修复:daemon 端口通过注入表达式里的 `window.__AG_DAEMON_PORT__ = <port>`
在脚本执行前写入全局变量(和 `<script src>`/`<link href>` 用的是同一个值),
`accountStore.ts` 的 `DAEMON_URL` 改成读这个全局变量的 getter,缺失时才退回
63820。没有依赖 `import.meta.url`——生产构建是 `vite.config.ts` 里的 `iife`
格式经 `<script type="module">` 加载,这个组合下 Rollup 对 `import.meta.url`
的重写行为不可靠(`document.currentScript` 对 module 脚本恒为 null),显式
全局变量更直接、不依赖构建格式的隐含假设。
