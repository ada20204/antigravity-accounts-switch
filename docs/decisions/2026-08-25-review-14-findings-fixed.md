# Review 复查:借鉴 agent-hub-accounts 那批改动的 14 条发现全部修复

对上一条(`2026-08-25-agent-hub-accounts-patterns-adopted.md`)引入的改动做了一轮 xhigh code review,14 条全部确认并修复。按严重性:

**1(最严重). reaper 可能杀掉添加账号流程正在用的 hub(`hubRestart.ts`)**——10 秒宽限期从 spawn 时刻算,但 `begin()` 走的整窗口 reload 只等 CDP 命令 ack,不等 VS Code 真正重建完(实测 20-30 秒),`restartInProgress` 在 7-9 秒左右就清掉,刚好卡在宽限期内侧。**修法**:`ownedHubPids` 每条记录带上 `graceMs`,默认对应 iframe 快速刷新的 10 秒,`restartAntigravityHub()` 一旦确定走 `'window'` 策略就把这条记录的 `graceMs` 改成 45 秒(留足 20-30 秒实测值的余量)。

**2. reaper 看不到跨重启的孤儿、也看不到扩展自己 spawn 的 hub**——`ownedHubPids` daemon 一重启就空了。现在采用安全取舍：`ownedHubPids` 里的 pid 走精确路径(不用等两次确认,10/45 秒宽限期到了且没人引用就收);不在这个表里的 pid 不再根据瞬时 CDP 空引用推断回收，避免把启动中的真实 Hub 误杀。

**3. `knownPlans` 新旧 daemon 混跑会互相破坏数据**——新的 `{schema, plans}` 包装结构变了,老版本读取逻辑("是不是个 object")会把整个包装对象当成 plans 映射本身用。**修法**:不只是加校验,直接把文件名从 `...plans.json` 改成 `...plans-v1.json`——老代码永远不会去读这个新文件名,不存在混读的可能;`PendingAdd`/`LastAddedAccountId` 只是加了字段(旧代码能安全忽略不认识的字段),不需要同样处理。

**4-7. `hubRestart.ts` 剩余四条**:health check 超时的 hub 现在在 `spawnHubOnSamePort()` 里当场杀掉,不再等 reaper 下一轮;新增 `terminateHub()` 共享 helper(SIGTERM→等退出→SIGKILL),`stopHubProcesses()` 和 `reapOrphanedHubs()` 都用它,reaper 不再是发完 SIGTERM 就当作完事;`ownedHubPids` 现在缓存 `port`,reaper 不用每 30 秒重新 `ps` 一次。

**8-11. `jsonStore.ts` 整体重写**:symlink 检查从"先 `lstatSync` 查再操作"(有 TOCTOU 窗口)改成 `O_NOFOLLOW`/`O_EXCL` 直接开文件(原子,没有窗口期);delete 分支不再挡在 symlink 检查后面(unlink 天然安全,不会跟踪符号链接);`loadJsonFile` 读失败(非 ENOENT)现在会记日志,不再完全静默。

**12. schema tag 写了但两个 store 从不读**——`PendingAdd`/`LastAddedAccountId` 现在会检查 `schema` 字段,遇到认不出的版本直接拒绝(不猜),只有完全没有这个字段的老文件才走一次性兼容。

**13. 真正的凭证文件反而没保护**——`daemon.ts` 的 `snapshotProfiles()`/`restoreProfile()`(操作 agent-hub-accounts 的凭证副本目录)现在用同款 `O_NOFOLLOW` + 原子写,比 `jsonStore.ts` 保护的记账文件价值高得多,之前反而没管。

**14. 结构测试三处问题**:引用错了文档——那句方法论原文其实来自你的 `~/.claude/methodology/rules/habits/project-structure.md`,不是仓库里的 `2026-08-23-review-b9ad69f-followup-10-findings.md`,注释已改正;行数统计有 off-by-one(`split('\n').length` 对以换行符结尾的文件多算一行,实际生效上限是 499 不是 500),改成先去掉一个结尾换行符再切;例外名单从"永久豁免"改成"棘轮"——记录加入时的行数(`daemon.ts` 831、`hubRestart.ts` 624),之后只要继续变大就会报错,不是放任不管。

## 验证

`tsc --noEmit` 全程干净;`npm test` 两条结构测试都过。daemon 端改动(`hubRestart.ts`、`daemon.ts`、`jsonStore.ts`)一如既往需要重启 daemon 才会生效,还没有现场重跑验证过实际的 hub 回收/reload 时序。
