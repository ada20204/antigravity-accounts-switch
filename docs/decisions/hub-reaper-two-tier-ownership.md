# Hub 回收器为什么只回收 owned hub

## 唯一安全的判断规则

两个 hub 可以合法共存(见 `2026-08-22-same-port-respawn-optimization.md`):
我们自己换上去、服务已开着的 webview 的那个,加上用户开新面板时扩展自己另起
一个的那个。两个都不是"旧的",各自服务不同的 webview,按存活时间杀会误杀
还有人用的那个。唯一安全的规则是"没有任何 iframe 还在引用这个端口"。

## 为什么不再回收 unowned hub

- **Owned**(记在 `ownedHubPids` 里,`spawnHubOnSamePort` 写入的):我们确定
  是自己 spawn 的,一个孤零零的 owned hub、没有 iframe 引用,不管当前还有
  几个其他 hub,都能直接判定该收——不需要推断。宽限期是"距离 spawn 过了
  多久"而不是"连续几次看到孤立",因为"扩展还没来得及给它接上 iframe"这种
  误判在这里不成立:`restartAntigravityHub()` 是在返回之前、同步地把 iframe
  接到自己 spawn 的 hub 上的。宽限期按 pid 各自记录(`ownedHubPids` 的
  `graceMs`),因为实际接线要多久取决于走的是哪条 reload 路径——`'window'`
  策略的等待比单纯 iframe reload 长得多。

- 早期版本还尝试回收 `findHubPids()` 返回的 unowned hub：连续两次看到 CDP
  没有引用，且同时存在至少两个 hub，就发送 SIGTERM。这个推断在启动/更新窗口
  中不成立：Hub 可能已经监听端口，但 iframe 尚未出现在 CDP 快照里，导致真实
  Antigravity 服务被误判为孤儿并被杀掉。现在跨 daemon 生命周期的 unowned hub
  不再自动回收；宁可保留一个无主进程，也不能破坏用户正在启动的服务。

回收器只处理本 daemon 在 `spawnHubOnSamePort()` 中明确记录的 `ownedHubPids`，并
继续使用对应的启动宽限期和 CDP 引用检查。daemon 重启后不会恢复旧的 ownership，
这是有意的安全取舍。
