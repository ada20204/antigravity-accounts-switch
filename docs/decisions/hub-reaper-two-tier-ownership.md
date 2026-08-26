# Hub 回收器为什么分两层(owned / unowned)

## 唯一安全的判断规则

两个 hub 可以合法共存(见 `2026-08-22-same-port-respawn-optimization.md`):
我们自己换上去、服务已开着的 webview 的那个,加上用户开新面板时扩展自己另起
一个的那个。两个都不是"旧的",各自服务不同的 webview,按存活时间杀会误杀
还有人用的那个。唯一安全的规则是"没有任何 iframe 还在引用这个端口"。

## 为什么是两层,不是一层

- **Owned**(记在 `ownedHubPids` 里,`spawnHubOnSamePort` 写入的):我们确定
  是自己 spawn 的,一个孤零零的 owned hub、没有 iframe 引用,不管当前还有
  几个其他 hub,都能直接判定该收——不需要推断。宽限期是"距离 spawn 过了
  多久"而不是"连续几次看到孤立",因为"扩展还没来得及给它接上 iframe"这种
  误判在这里不成立:`restartAntigravityHub()` 是在返回之前、同步地把 iframe
  接到自己 spawn 的 hub 上的。宽限期按 pid 各自记录(`ownedHubPids` 的
  `graceMs`),因为实际接线要多久取决于走的是哪条 reload 路径——`'window'`
  策略的等待比单纯 iframe reload 长得多。

- **Unowned**(`findHubPids()` 返回的其余部分:扩展自己 spawn 的,或者上一轮
  daemon 生命周期里我们自己拥有过、但这一轮已经不记得的):没有直接的归属
  信号,只能沿用旧版本"从 CDP target URL 反推"那套逻辑,配两个保护:连续两次
  观测到孤立(单次快照可能刚好拍到扩展还没来得及接线的中间状态),以及只在
  ≥2 个 hub 同时存在时才动手(单独一个没有 iframe 引用的 hub,可能只是扩展
  自己养着的、还没用上的后备)。保留这一层是为了让"daemon 重启"不会整个丢失
  回收能力——`ownedHubPids` 每次启动都是空的,早期版本只看这张表,daemon 一
  重启就相当于失明。
