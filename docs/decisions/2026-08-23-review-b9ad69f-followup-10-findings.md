# 提交 b9ad69f 复查(10 条发现,聚焦注释规范)全部修复(2026-08-23)

对刚提交的 `b9ad69f`(17 条修复 + 添加账号登录页修复 + Plan 检测)做了一轮针对性复查,重点看注释是否符合"设计理由归 DECISIONS.md,代码里只留指针"这条约定。10 条发现全部确认并修复:

**1+2. `begin()` 在真的没做成的情况下也会报成功(hubRestart.ts + daemon.ts)**——两个独立的口子都指向同一个后果:`restartInProgress` 并发保护分支直接 return,从不调用 `onStopped`(信号丢在半路,没有被回传),但只返回 `onStoppedError: undefined`,`begin()` 只看这个字段就以为清凭证成功了;另外窗口 reload 失败时 `windowReloaded` 只是个局部变量,没当结构化字段传出去,同样被 `begin()` 判定为成功。两条都恰好复现了这次自己刚做的修复本来要堵的场景。**修法**:并发保护分支里,如果调用方传了 `onStopped`,显式把 `onStoppedError` 设成"没跑到"(复用 `begin()` 已经在检查的字段,不用加新字段);`HubRestartResult` 新增 `reloadFailed` 字段,两处 `windowReloaded===false` 的地方都设它,`begin()` 的判断改成 `onStoppedError || reloadFailed` 才算真正失败。

**3. Settings 卡片监听器在切 tab 时又漏了(settingsEnhancer.ts)**——`bindUntilRemoved` 按元素引用去重,但切 Settings tab 会销毁旧卡片、下一 tick 建一个全新的 div——WeakMap 里是不同的 key,旧监听器根本不会被 abort。代码里原有的注释还写着"rebinding...automatically retires the old listener",这句是错的。**修法**:模块级 `lastBoundCard` 显式记住上一个绑定过的元素,建新卡片前先手动 `unbind(lastBoundCard)`。

**4. `isKeychainActiveAvailable()` 丢了"宁可信其有"的容错(cliRunner.ts)**——用 `git show` 核实过:重构前的 `isSignedOut()` 有 `catch { return false }`("can't tell — don't cry wolf"),重构后的版本完全没有 catch,一次偶发的 `execFile` 失败就会让 `/api/add-account/status` 整个 500,流程明明还在进行中,banner 却因为轮询失败而消失。**修法**:补回 try/catch,失败时返回 `true`(不是 `false`)——因为调用方是 `signedOut: !(await isKeychainActiveAvailable())`,要 `!true===false` 才能还原原来"假设未登出"的偏向。

**5+10. `renderGuard.ts` 的延迟渲染队列:窗口期 + 不去重**——`flushPending()` 跑之前不重新检查 `pointerDown`,两次点击挨得很近时,新手势的 mousedown 可能在上一次的 `setTimeout(0)` 触发前就已经开始,DOM 又在手势中途被替换掉,复现同一类吃掉点击的 bug;另外 `pending` 是 `Set<()=>void>`,但每个调用点传的都是当场新建的闭包,引用去重形同虚设,长按手势期间会攒好几个逻辑上重复的待渲染任务。**修法**:`flushPending()` 开头加 `if (pointerDown) return`,不需要重新调度——下一次手势的 `mouseup` 本来就无条件会再触发一次；`renderOrDefer` 签名改成 `(key: HTMLElement, fn)`,`pending` 换成 `Map<HTMLElement, fn>`,同一个目标元素的重复请求自然合并成一个。

**6. `/api/report-plan` 被重复调用了 ~13 次(settingsEnhancer.ts)**——判断"要不要上报"时拿新读到的 DOM 文本去跟本地 20s 才刷新一次的账号缓存比,缓存没跟上的这段时间里,1.5s 一次的 tick 会把同一个值重复 POST 十几次。**修法**:去重逻辑挪进 `AccountStore.reportPlan()` 自己维护的 `lastReportedPlan` Map,跟无关的 20s 刷新周期解耦,调用方不用再自己判断"变没变"。

**7. 第三份原地复制的 tmpdir JSON 读写模式(daemon.ts)**——`pendingAdd`、`lastAddedAccountId` 已经各自手搓过一遍"读 JSON、容忍缺失/损坏、写入或删除"的逻辑,这次给 `knownPlans` 加持久化时又抄了一遍,同一个文件里三份。**修法**:提取 `loadJsonFile`/`saveJsonFile` 两个小的通用 helper(用得到的地方只在这一个文件内,没必要单独开新文件),三组读写函数都改成薄封装,各自的校验/兼容逻辑放进 `validate` 回调保留。

**8. 注释规范:CORS 说明又被重复写了一遍而不是指回 DECISIONS.md(daemon.ts + httpUtils.ts)**——这次改动把本来一行的指针注释,在 `daemon.ts` 的请求处理器里(~11 行)和 `httpUtils.ts` 的 `isAllowedOrigin` 上方(~15 行)各自独立重写了一遍完整理由,两份措辞还不一样。DECISIONS.md 本身已经有专门的"CORS 白名单策略"一节 + 上面第 1 条的完整记录,代码里的两份纯属信息冗余,违反项目自己的约定。**修法**:两处都收回成一行指针。

**9(文档准确性). CORS 白名单实际比 DECISIONS.md 写的宽**——上面第 1 条的记录读起来像是这个 CSRF 洞已经完全堵上了,实际上 `isAllowedOrigin()` 放行任意端口的 `127.0.0.1:*`(hub 端口每次重启都变,钉死不现实),本机另一个端口的网页依然能带合法 Origin 调 `/api/remove`、`/api/report-plan`。这不是代码要改的地方,是文档过度宣称——已经在第 1 条记录后面补了一句范围澄清。

**验证**:`tsc --noEmit` 已过。daemon.ts/hubRestart.ts/cliRunner.ts 的改动仍需重启 daemon 才生效,尚未现场重跑测试。
