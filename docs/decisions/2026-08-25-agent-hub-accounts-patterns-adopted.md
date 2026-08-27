# 从 agent-hub-accounts 借鉴的 4 个设计

看了 `agent-hub-accounts`(`src/support/files.ts`、`src/isolated/lease.ts`、`src/accounts/registry.ts`、`test/project-contract.test.mjs`)之后确认有价值、按顺序采纳的 4 项,不是照抄,每项都按 enhancer 自己的实际场景做了取舍。

## 1. 持久化 JSON:原子写 + 拒绝符号链接,不做跨进程锁

新增 `src/daemon/jsonStore.ts`,`loadJsonFile`/`saveJsonFile` 从 daemon.ts 挪过来,加了两件事:
- 写入先落 `<file>.<pid>.<ts>.tmp` 再 `renameSync` 到目标名——`rename` 在文件系统层面是原子的,daemon 崩在写一半(SIGKILL、OOM)不会留下一个解析不出来的半截文件。
- 读写前检查目标路径不是符号链接——共享的 `os.tmpdir()` 理论上任何本机进程都能在这几个可预测的文件名上放一个符号链接。(最初是 `lstatSync` 检查后再操作,后来按 `docs/decisions/2026-08-26-vendor-agent-hub-accounts.md` 同样的理由升级成 `O_NOFOLLOW`/`O_EXCL` 系统调用级防护,检查和操作之间不再有竞态窗口。)

**没抄的部分**:`agent-hub-accounts` 的 `withFileLock` 是给跨进程场景用的(多个独立 CLI 进程调用可能真的并发)。这个 daemon 是单一常驻 Node 进程,`knownPlans[id]=label; saveKnownPlans()` 这类"改内存 + 存盘"之间没有 `await`,Node 单线程事件循环本身就已经把这类操作串行化了——加一把锁只是在防一个不存在的竞态。`jsonStore.ts` 顶部注释记了这个判断,免得以后有人看着 `agent-hub-accounts` 照抄锁进来。

## 2. Hub 归属判定:改成直接持有,不再从 CDP target 反推

`hubRestart.ts` 新增 `ownedHubPids`(内存态 `Map<pid, {spawnedAt}>`,不落盘——见代码注释,pid 跨 daemon 重启后被无关进程复用是更大的风险,不持久化反而更安全)。`spawnHubOnSamePort()` 成功后记一笔,`stopHubProcesses()` 杀掉的 pid 顺手摘掉。

`reapOrphanedHubs()` 重写:不再需要"连续两次判定孤儿 + 只在 ≥2 个 hub 时才回收"这两道靠猜的保险,因为现在压根不去看不是自己 spawn 的 hub——一个我们自己 spawn 的 hub,没有 iframe 指着它,直接就是可以回收的,不需要知道系统里还有几个其他 hub。原来的"两次确认"窗口是为了防止把刚起来、还没被扩展接上 iframe 的**别人的** hub 误杀;这个顾虑对我们自己 spawn 的 hub 不成立,因为接 iframe 这一步就在同一次 `restartAntigravityHub()` 调用里同步做完的。改成一个简单得多的"距 spawn 是否过了 10 秒"宽限。

`docs/decisions/2026-08-22-same-port-respawn-optimization.md` 里原来那段"接受这个权衡"的记录已经不成立了,这条算是把那个 accepted tradeoff 实际解决掉。

## 3. 持久化状态加 schema 版本标记

三份状态(`PendingAdd`、`LastAddedAccountId`、`knownPlans`)现在都在存盘 JSON 里带一个 `schema: "antigravity-accounts-switch.xxx.v1"` 字段,写的时候永远带上,读的时候优先按新 schema 校验,退回兼容"没有这个字段"的老文件(一次性兼容,不是每加一个字段就再叠一层判断)。`knownPlans` 从裸 `Record<string,string>` 包了一层 `{schema, plans}`。

**目前不是强校验网关**——现在只有一个版本,标了 tag 但读的时候还是宽松接受旧形状。价值在于以后真的要改格式时,有一个明确的版本号可以判断"这是哪个形状",不用再靠"这个字段是不是 undefined"去猜测文件是新是旧。

## 4. 结构门限写成测试,不只是文档约定

新增 `test/structure.test.mjs`(`node --test`,零新依赖,和 `agent-hub-accounts` 同款),两条断言:单文件 ≤500 行、单目录直属文件 ≤12 个。

`daemon.ts`(789 行)和 `hubRestart.ts`(535 行)现在都超限——按 `docs/decisions/2026-08-23-review-b9ad69f-followup-10-findings.md` 里"已有超限路径不做无目标历史清算,再次修改时重新评审"这条,没有借这次机会强行拆分,而是在测试里显式列成 `LINE_LIMIT_EXCEPTIONS`,带注释说明这是已知、被记录过的例外,不是拿来悄悄放过新增违规的口子。以后这两个文件之外的任何文件破限,测试会直接报错。

`package.json` 新增 `"test": "node --test test/*.test.mjs"`。

## 验证

`tsc --noEmit` 全程干净;`npm test` 两条结构测试都过;手动确认过 `daemon.ts` 当前确实是 789 行(超限例外不是摆设)。第 2 条(hub 归属)和其余 daemon 端改动一样,需要重启 daemon 才生效,还没有现场重跑验证过实际的 hub 回收行为。
