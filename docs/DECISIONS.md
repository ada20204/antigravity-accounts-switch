# 设计决策记录

## 提交 b9ad69f 复查(10 条发现,聚焦注释规范)全部修复(2026-08-23)

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

## 账号等级(Plan)(2026-08-23)

之前 `accountStore.ts` 里的 plan 字段是纯瞎猜:默认 `'Google AI Pro'`,只有 `issue === 'eligibility_failed'` 才翻成 `'Free'`——`'Google AI Ultra'` 这个值代码里从来没被赋过,不可能出现。核实过 `agent-hub-accounts` 的 `route --json` schema:没有任何 plan/tier/subscription 字段,CLI 侧拿不到。

现场用 CDP 翻了 Settings → General → Account 卡片,找到真实来源:`<div class="text-sm font-medium">Your Plan: Antigravity Starter Quota</div>`(当前唯一验证过的账号,Free 档,原文措辞是 "Antigravity Starter Quota" 不是字面 "Free")。这行字只在 Settings 的 General 子页存在,而且只反映"当前激活账号"的等级——不像邮箱那样随时能读到全部账号。

方案(照搬"永远不要猜,读真实 DOM"这条本项目一路的原则,和邮箱识别同款思路):
- `semanticLocator.ts` 新增 `findAccountPlanLabel()`,精确匹配 `Your Plan:` 前缀的叶子文本节点。
- `settingsEnhancer.ts` 每 1.5s tick 顺手查一次(只在页面真的显示这行字时才有值),变化了才上报,不是每 tick 硬发。
- daemon 新增 `knownPlans`(与 `pendingAdd`/`lastAddedAccountId` 同款、`os.tmpdir()` 持久化的按账号 id 存储)+ `POST /api/report-plan`(前端上报,daemon 只信任、不猜测)+ `/api/accounts` 响应里按 `account_id` 合并进去。
- `accountStore.ts` 的 `plan` 字段从封闭的三态 union 改成 `string`,真实取自 daemon,没观测到时诚实显示 `'Unknown'`,不再是瞎猜的默认值。

`tsc --noEmit` 已过;`/api/report-plan` 这个新 daemon 端点尚未现场验证——需要重启 daemon 才会生效。

## 添加账号原生登录页不出现(2026-08-23)

现象:点击"添加新账号"后一直卡在插件自己画的 "awaiting sign-in" banner,原生 Google 登录页从不出现;手动重启(整个 VS Code 窗口)后才恢复正常。日志显示 `begin()` 的 hub 重启每次都成功("reloaded 2 iframe(s)",无报错),但当天从 07:16 到 09:27 的多次真实尝试全部以 `finish FAILED No new sign-in detected yet` 收场——**这个问题当天在 17 条 review 修复之前就已反复出现,不是那轮修复引入的回归**。

根因:`begin()` 一直用的是账号切换那条"快速路径"——自己 kill 旧 hub、原端口 spawn 新 hub,再用 CDP 对 webview iframe 执行 `location.reload()`。这只刷新了 iframe 内容,VS Code 扩展宿主(extension host)完全不知道 hub 被换掉了,它自己那套"检测到没有 hub → 展示登录页"的原生逻辑从未被触发。普通切换账号不受影响,是因为凭证依然有效,iframe 刷新拿到新数据就够了;但 add-account 需要的是"真正让扩展宿主重新确认一次登出状态",这只有让 VS Code 重新加载整个窗口(`Page.reload` 在 workbench 顶层 target 上)才能触发——这正是用户手动重启能解决问题的原因。

修复:`restartAntigravityHub()` 新增 `options.reloadStrategy`,`'window'` 时复用已有的 `reloadWorkbenchWindow()`(整窗口 reload)代替 `reloadIframesOnPort()`,其余(kill+同端口 spawn 新 hub)逻辑不变。只有 `begin()` 传 `{ reloadStrategy: 'window' }`;普通 switch/finish/cancel 仍走原来的 iframe-only 快速刷新,不受影响。见 `src/hubRestart.ts` 的 `restartAntigravityHub()` 和 `src/daemon.ts` 的 `begin()` 调用处。

尚未现场验证(需要真实触发一次添加账号流程确认原生登录页确实出现);`tsc --noEmit` 已过。

## 首次 code review(xhigh,17 条发现)全部修复(2026-08-23)

**日期**:2026-08-23 · 新增 `src/cliRunner.ts`、`src/httpUtils.ts`、`src/runtime/adapters/domUtils.ts`、`src/runtime/ui/renderGuard.ts`

对本仓库做的第一轮正式 code review(5+5 维度 × 8 候选、二次验证、差距扫描),17 条发现全部确认并修复。逐条记录,严重性从高到低:

**1. CORS 白名单算了但从不强制拒绝(daemon.ts)**——`isAllowedOrigin()` 的结果只用来决定要不要设 `Access-Control-Allow-Origin` 响应头,从没用来拒绝请求。而这个头只控制浏览器让不让页面 JS **读**响应,不控制请求**发不发得出去**——`/api/login`、`/api/add-account/begin` 这类不带自定义 Content-Type 的"simple request"根本不会触发预检,本机任意浏览器 tab 打开的任意网页都能直接把它们打进来,静默把用户登出、杀/重启 hub、切活动登录,CORS 检查从头到尾没机会跑。这正是"CORS 白名单策略"那节以为已经堵上的那类 CSRF,实际只堵了一半。**修法**:origin 存在且不在白名单里,直接 403 拒绝,不进入任何 handler;origin 缺失(curl、我们自己的 Terminal 脚本)视为本地可信访问——浏览器发起的跨域 fetch/XHR 无论是否触发预检都会带 Origin,伪造不了这个头的缺失。**范围澄清(2026-08-23 复查)**:这堵的是跨域/远程网页发起的 CSRF,不是"任何本机访问"——`isAllowedOrigin()` 放行任意端口的 `127.0.0.1:*`(hub 每次重启端口都会变,钉死单一端口不现实),所以本机另一个端口上跑的、不相关的网页依然能带着合法 Origin 调 `/api/remove`、`/api/report-plan` 这类改状态的接口。和"缺失 Origin 视为本地可信访问"是同一套"本机访问本来就信任"的威胁模型,不是遗漏。

**2. Shell 注入:accountId 原样拼进 execAsync 的 shell 字符串(daemon.ts,5 处)**——`switch/connect/remove/cancel/report-identity` 全部是 `` execAsync(`node ... "${accountId}" --json`) `` 这种写法,accountId 来自请求体或 DOM 抓取,没有任何转义。配合第 1 条(能从外部网页发请求),邮箱里带个双引号就能跑任意命令。**修法**:新增 `cliRunner.ts` 的 `runCli(args: string[])`,用 `execFile` 而不是 `exec`——参数以 argv 数组形式直接传给系统调用,永远不经过 shell 解析,这类注入变得结构性不可能,不管 accountId 里有什么字符。顺带把原来散落 14 处的 `execAsync(...) + JSON.parse(stdout)` 收成 `runCli`/`runCliJson` 两个函数。

**3. `/api/add-account/begin` 的重入锁有 TOCTOU 竞态(daemon.ts)**——`if (pendingAdd) throw` 是同步检查,但 `pendingAdd` 要等 `--verify`、可选 `connect`、完整 hub 重启这几个 await 之后才会被设置。两个 begin() 请求前后脚到达,都能在 pendingAdd 还是 null 时通过检查,后一个的 `setPendingAdd()` 会悄悄覆盖前一个的 `backupAccountId`,导致后续 Cancel 切回错误的账号。**修法**:新增独立的 `addAccountBeginInFlight` 标志,在检查的**同一个同步块**里立刻置位(中间不经过任何 await),彻底关闭这个竞态窗口。

**4. `AGENT_HUB_DIST` 硬编码成 `/Users/developer/work/agent-hub-accounts/dist`(daemon.ts)**——同一行代码旁边的 `CREDENTIALS_DIR`/`HUB_TOKEN_FILE` 早就在用 `os.homedir()`,唯独这个路径写死成了一个人的用户名,~15 处 CLI 调用全靠它,换个人换台机器直接不能用。**修法**:`cliRunner.ts` 里改成 `process.env.AGENT_HUB_ACCOUNTS_DIST || path.join(os.homedir(), 'work', 'agent-hub-accounts', 'dist')`,可覆盖,默认值对当前这台机器现场验证过仍然解析正确。

**5. `/api/remove` 的"防止删当前账号"检查用的是未验证的缓存(daemon.ts)**——`begin()` 和 `/api/connect` 早就因为"缓存 route 在 Keychain 已经是别的账号凭证时仍然报告某账号 active"这个真实损坏过账号的坑,改用了 `route --verify`;`/api/remove` 漏改了,还在用裸 `route --json`。**修法**:抽出 `resolveActiveAccountId()` 作为"当前到底是谁登录"的唯一入口(已经存在,这次是把 `/api/remove` 接进去),`route`/`current` 不再允许被拿来做这类判断——本文件里任何"这个账号是不是当前激活"的判断都必须走这一个函数。

**6. `restartAntigravityHub` 的 `onStopped` 回调抛出异常时,hub 已经被杀但调用方以为"什么都没变"(hubRestart.ts)**——整个函数体是 `try{...}finally{...}`,没有 `catch`。`begin()` 传进去的 `onStopped`(删 token 文件 + 摘 Keychain)一旦抛错,异常会在 `stopHubProcesses()` 已经把 hub 杀掉**之后**才往外传,最终被 `begin()` 自己的 catch 捕获,回给前端"Nothing was changed"——但 hub 真的已经死了,没有任何后续重启动作。**修法**:`onStopped` 的异常被捕获、记录进返回值的 `onStoppedError` 字段,重启流程**照常继续**(永远不会因为回调失败就把 hub 晾死),`begin()` 检查这个字段,如果非空就明确告诉用户"hub 已恢复运行,但登出是否成功不确定",而不是二选一地在"hub 死了"和"什么都没变"之间说谎。

**7. `findQuotaSectionContainer()` 只有一个配额环时会把环自己当成"容器"返回(semanticLocator.ts)**——`Node.contains()` 对自身返回 true,`ancestor = rings[0]` 起步时,循环体在只有一个环的情况下永远不会执行,直接把环元素自己当结果返回。`settingsEnhancer.ts` 再 `appendChild` 进去,相当于把订阅卡片塞进了原生配额环控件内部,视觉上直接破图,要等出现第二个环才会重新算对。**修法**:起始点改成 `rings[0].parentElement`,保证返回值永远不会是环元素自身。现场用 CDP 验证过:切到 Models tab(4 个环),卡片正确挂载、不嵌套进任何环、是容器的最后一个子元素。

**8. `syncBottomTrigger` 的邮箱匹配比另外两份宽松,已经在实际代码里跑偏(profileSyncAdapter.ts)**——`semanticLocator.ts` 两处用的是锚定正则 `^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`,`profileSyncAdapter.ts` 这份复制品用的是裸 `.includes('@')`——任何只是碰巧包含 `@` 的叶子文本节点(一个图标 title 之类)都会被当成邮箱节点直接覆写。这段匹配逻辑是安全关键的(`report-identity` 靠它决定往哪个账号头上写凭证,参见"又一次账号损坏"一节),三份复制品里已经有一份跑偏,证明了"复制三份"本身就是问题。**修法**:新增 `domUtils.ts` 的 `leafEmailText()`,三处全部改成调用它。

**9. `findWorkbenchPageTarget()` 在多个 VS Code 窗口同时打开时无法区分该重载哪一个(hubRestart.ts)**——CDP `/json` 是个平铺列表,iframe target 和它所属的顶层 page target 之间没有暴露父子关系,原来的实现直接取第一个匹配的 `workbench.html` target,可能会重载一个完全无关的窗口,而真正需要恢复的那个纹丝不动。**修法**:多个匹配时不猜,直接返回 null 并打日志说明原因——调用方本来就把"没找到 target"当成"reload 失败,hub 保持关闭直到手动 reload"处理,这个结果是真实、可诊断的,比装作重载对了要好。

**10-13. 四处重复实现,分别抽成共享工具**:
  - 弹窗和卡片各自实现了一遍"渲染签名脏检查"(不同常量名、不同字段列表)→ `renderGuard.ts` 的 `shouldSkipRender()`。
  - 弹窗和卡片各自实现了一遍 AbortController 监听器泄漏防护(一个存在 DOM 节点属性上,一个存在模块级变量里)→ `renderGuard.ts` 的 `bindUntilRemoved()`/`unbind()`。
  - `daemon.ts` 里 `req.on('data')/req.on('end')` 的请求体读取模板手写了 5 遍,错误响应形状已经在 `{error}` 和 `{error,code}` 之间跑偏 → `httpUtils.ts` 的 `readJsonBody()`/`respondError()`。
  - `ACTIVE_AVAILABLE_SNIPPET`/`DETACH_ACTIVE_SNIPPET` 各自复制了一遍 `require()` 前导两行 → `cliRunner.ts` 的 `keychainSnippet()` 构造函数。

**14. `settingsEnhancer.ts` 为了重置一行的 inline opacity,重建整张卡片(所有行、所有监听器)**——`accountPopup.ts` 处理一模一样的场景(切换时把行调暗,切换完恢复)用的是直接 `el.style.opacity = ''`,`settingsEnhancer.ts` 却传 `force=true` 触发整卡重渲染,而"更浅层"的正确做法就在旁边那个文件里。**修法**:改成和 `accountPopup.ts` 一致的单元素直接重置,`force` 只保留给真正没法靠数据脏检查覆盖的场景(Check All Accounts 按钮文案重置)。

**15. 渲染签名脏检查只是降低了"mousedown/mouseup 之间元素被销毁吃掉点击"这个 bug 复现的概率,没有真正关闭这类 bug**——20 秒后台轮询触发的重渲染,只有在数据字节相同时才会被脏检查跳过;但配额数字(five-hour 回补、weekly drift)在正常使用中相当一部分轮询周期确实会变,一旦真实数据变化恰好落在用户按下到点击 Switch/Remove 之间,脏检查救不了,元素照样在 click 事件派发前被整体替换——浏览器对"mousedown 目标在 click 派发前从文档里消失"的标准行为就是直接丢弃这次 click,和最初要修的 bug一模一样,只是变少发了。**修法**:`renderGuard.ts` 新增 `renderOrDefer()`,靠捕获阶段的全局 `mousedown`/`mouseup` 监听追踪"鼠标是否按下",按下期间的渲染请求排队,在 `mouseup` 的 `setTimeout(0)` 里才真正执行——`click` 在真实用户交互里是 `mouseup` 后同一个任务内同步派发的,这个延迟保证浏览器已经在原始、未被替换的元素上把 `click` 派发完,再执行排队的重渲染。仅包裹后台/周期触发的渲染调用(20s 轮询回调、1.5s 锚定 tick);点击处理函数自己在异步操作 resolve 之后调用的重渲染不受影响,因为那时手势早就结束了。

**16. add-account 流程的状态在"持久化到磁盘"和"只存内存"两个档位之间没有统一规则(daemon.ts)**——`pendingAdd` 因为"daemon 重启会丢、丢了用户就卡在登出状态无路可退"这个真实事故被改成持久化到磁盘,`lastAddedAccountId` 当时被认为"一次性通知,不值得持久化",留在内存里。但 daemon 重启如果恰好卡在 `report-identity` 设置它、和前端下一次 `/api/add-account/status` 轮询读它之间,账号切换本身是成功的(CLI 早已落地),"Added X" 这条确认提示却会无声消失——没有报错,流程完成了但从没告诉用户完成了。**修法**:新增 `LAST_ADDED_FILE`,和 `PENDING_ADD_FILE` 走同一套持久化/清除逻辑,两个字段不再按"这个字段有没有真的出过事"来分别决定要不要持久化。

**17. hub-reaper 靠 CDP target URL 里的端口号字符串匹配来判断某个 hub 是不是"孤儿",不是直接追踪自己 spawn 出来的 PID**——CDP 的 `/json` 平铺列表里没有任何字段能把一个 iframe target 直接关联回它所属的 hub 进程,端口号字符串匹配是目前唯一可用的信号,"连续两次判定孤儿 + 只在 ≥2 个 hub 时回收"这两道保险本质上是在补偿"没有直接的归属句柄"这件事,不是在双重校验一个已经可靠的信号。评审后决定接受这个权衡、不做功能改动:改动本身收益不确定(VS Code/CDP target URL 的形状目前没有变化的迹象),而现有的保险机制已经把最坏情况限制在"错误地不回收一个空闲 hub",不会误杀正在被使用的那个。仅在代码里补了一段注释记录这次评审结论,供以后如果真的出问题时参考。

**验证**:`tsc --noEmit` 全程干净通过。前端相关的 7-15 条已现场用 CDP 重新加载页面验证:零 JS 运行时错误,配额卡片正确挂载且不嵌套进原生控件,弹窗开关 6 个账号正常渲染。daemon 端的改动(1-6、16)需要在 Terminal 里重启 daemon 才会生效,还没有现场重跑验证过。

## 不做账号登出(Log out)

**日期**:2026-08-22 · **2026-08-23 补充边界**

**结论**:多账号管理里不提供"登出当前账号"这个**功能入口**,已从弹窗 UI 里移除 `#ag-logout-btn`。

> **和"添加账号"流程的边界**(2026-08-23):添加账号时确实会把你在本机登出一次,这**不违反**本决策。区别在于那是**纯本地清除**(删 hub 会话缓存 + `security delete-generic-password`),不调用任何登出/撤销接口,所以 refresh token 不会被服务端撤销,已保存的密文副本依然有效——`cancel` 能随时 `switch` 回来就是证明。本节反对的是**真登出**(会 revoke 的那种)。见 "添加账号(定稿)"。

**原因**:
- 这套多账号系统的 shared-live 模式本质是:登录一次后把 macOS Keychain 里的 OAuth 密文原样"捕获(capture)→ 切换时写回(activate)",实现快速切号,从不重新走一遍真实登录。
- 真正的 Antigravity/Google 登出会让服务端撤销(revoke)对应的 refresh token。一旦撤销,`agent-hub-accounts` 里为该账号保存的密文副本就失效了,该账号会从"可秒切"降级为"必须重新完整登录"——这和多账号快速切换的设计目标直接冲突。
- 核实过:`agent-hub-accounts` CLI(`dist/cli.js`)里根本没有 `logout` 子命令(只有 `connect/login/switch/run/list/ls/current/doctor/route/use/select/remove/quota`),说明这条边界在后端设计时就已经是有意排除的,不是遗漏。
- 之前 UI 上的 "Log out current" 按钮实际也没有绑定任何点击事件(死代码),点击没有任何效果,属于误导性 UI,已一并清理。

**安全的替代操作**:`accountStore.ts::removeAccount()` → daemon `/api/remove` → CLI `remove`,只是从本地 registry 里忘记这个账号,不触碰真实 Google 会话,不会导致密文失效。这个方法已经存在但目前没有接到任何按钮上,是否要作为"移除账号"的正式入口留待后续决定。

## 官方 Antigravity 的 Sign Out 入口在哪(2026-08-22 现场核实)

官方确实有登出功能,藏在一个 "Account" 面板里(内容是 `Email` + 账号邮箱 + `Sign Out` 按钮),通过 CDP 查证:

- 触发方式:点击左下角那个 "Tiffy Gitto / user-alpha@example.com" 按钮(`<button>`,与 `SemanticLocator.findProfileTrigger()` 定位到的**是同一个元素**),会切换显示这个 Account 面板(平时 `display:none`)。
- **严重问题**:`main.ts` 里全局点击监听器在 capture 阶段对这个按钮做了 `e.stopPropagation() + e.preventDefault()`,拦截下来去弹我们自己的账号切换弹窗。这意味着**我们的插件激活期间,用户点这个按钮再也打不开官方 Account/Sign Out 面板了**——官方登出入口被我们的弹窗盖住、彻底不可达,不是"我们不提供登出所以用户去官方那边登出"这种安全的分工,而是"官方入口被我们误伤屏蔽掉了"。

**需要修复**:这是本次发现里优先级最高的一个 bug,和"故意不做 logout"的决策本身无关——不管做不做我们自己的登出,都不该挡住用户访问官方的。修复方向待定(比如:检测到是"专门点头像本身"而不是我们弹窗的展开态时放行原生事件;或者我们弹窗里加个"更多账号设置"链接跳回官方 Account 面板),下次处理时优先做这个。

**后续更新(2026-08-22 稍晚)**:已改成不拦截原生点击的方案——头像角上叠加独立小徽标 + 悬停展开,原生点击/官方 Sign Out 完全不受影响。见 `main.ts` 的 `ensureProfileBadge()`。

## 账号 credential_drift 是什么、为什么会出现

**日期**:2026-08-22

`agent-hub-accounts` 的 `route`/`overview` 接口里,`is_active` 是"保存的密文和当前系统 Keychain 里的密文逐字节比较"的结果(`manager.ts` `keychain.profileMatchesActive`),`credential_drift` 是"我们自己 `live.json` 记录的上次切换目标"和 `is_active` 对不上时才为 true。

根本原因:VS Code 里常驻的 `agy --hub` 进程只要在跑,就会周期性刷新自己的 OAuth token(实测 15~70 分钟一次),刷新出来的新 token 会直接写回同一个共享 Keychain 槽位——不需要任何切换动作,光是正常用着 Chat,Keychain 内容就会和我们记录的"当前账号"自然对不上。这是 shared-live 架构的固有特性,不是 bug,也不是这次改动引入的。

**顺带修的真 bug**:`accountStore.ts` 一直在读 `acc.current`,但 `agent-hub-accounts` 的 schema 已经从 v1 升到 v2,字段改名成了 `acc.active`——导致不管真实状态如何,前端永远读到 `undefined`,所有账号永远显示"未激活"。已修正为读 `acc.active`,并把 `credential_drift` 接入现有的 `issue` 展示逻辑,漂移了会直接在卡片上显示出来。

## CDP 注入替代 bridge.js patch

**日期**:2026-08-22 · 涉及 `cdpInjector.ts`

bridge.js(`vscode-webview://` 外层 wrapper)跑在严格 CSP(`script-src 'self' 'sha256-...'`)下,会静默拦截动态 `<script src="http://localhost:5173/...">` 注入——现场用 CDP 验证过:脚本确实被 append 了,零报错,但 `window.AntigravityEnhancerRuntime` 始终 `undefined`。

改用 CDP(`127.0.0.1:9222`)注入,原因:CDP 注入的脚本不受页面自身 CSP 约束,而且可以直接打进 CSP 更宽松的内层内容 iframe(`.../settings-standalone`),不用去碰外层 wrapper——一次性绕开两个问题。

依赖 VS Code 开着 CDP 端口;端口没开时轮询循环只是继续重试,不报错、不影响用户。这套方案只读 target 列表 + eval 我们自己的 bootstrap 代码,完全不碰 `extension.js`/`bridge.js` 或 `OnAntigravityReady` 握手,所以不带"卡在 Loading"的那类风险(那类风险是 patch 外层 wrapper 的 iframe 接线才会有的)。

**幂等注入检查**:`injectInto()` 不按 target id 缓存"已经注入过"——VS Code 会在原地重新加载 iframe 的 document(同一个 CDP target id,全新的 window),这种情况下按 id 缓存会误以为已经注入过,实际脚本已经被冲掉了。所以每个 tick 都重新做一次幂等检查(`if (window.AntigravityEnhancerRuntime) return 'present'`),这是唯一能可靠自愈的办法。

## CORS 白名单策略

**日期**:2026-08-22 · 涉及 `daemon.ts::isAllowedOrigin`

daemon 监听 `127.0.0.1:63820`,理论上会被这台机器上任何打开的网页请求到。只反射白名单里的 origin(`vscode-webview://...` 或 `http://127.0.0.1:<hub-port>`),不用通配符 `*`——通配符会让用户平时用的浏览器里随便一个网页都能对着这个本地 daemon 发 `/api/switch|remove|login`,构成对着真实 Google 账号切换器的 CSRF。

## (已被取代)Hub 重启:为什么改成整窗口 reload

> ⚠️ **这一节的结论已经不是现在的做法。** 整窗口 reload 要 30-36s,现在走的是"自己在同端口 respawn"(~7s),见下面 **"✅ 真正的优化:同端口自行 respawn"**。整窗口 reload 仅作为 respawn 失败时的兜底保留。
> 本节保留是因为它记录了"为什么单独 reload iframe 不行"——那个结论至今成立,也是后续方案的前提。

**日期**:2026-08-22 · 涉及 `hubRestart.ts`、`daemon.ts::/api/switch`

**背景**:往 macOS Keychain 共享槽位写入新账号,对已经在跑的 `agy --hub` 进程本身没有任何影响——它的 `AuthProvider` 绑定的是启动时读到的那份密文,常驻内存里继续用旧的(现场对照过 `agy` 的 `cli.log`:`b.codeAssistClient.AuthProvider (...) is same as b.cliAuth (...)`,`server_oauth.go`)。不重启 hub,UI 上显示"已切换",但 Chat/Settings 后端实际还是旧账号。

**第一版实现的问题**:SIGTERM 杀掉 hub 后,直接对着已知的内容 iframe 发 `window.location.reload()`,指望"插件会注意到后端没了,自动重新拉起"。翻了 `extension.js` 源码才发现这个假设是错的——`AntigravityServerManager` 的 `exit` 回调只做 `this.serverProcess = undefined; this.serverUrl = undefined`,**没有任何自动 respawn 逻辑**。新的 hub 只会在下次有代码显式调用 `serverManager.start()` 时才会被拉起(而且换一个新的临时端口),这个调用只发生在 VS Code 重新 resolve 某个 webview 面板的时候,不是 iframe 内部自己发起的 `window.location.reload()` 能触发的。结果就是:reload 只是对着一个已经没有进程监听的旧端口重新发一次请求,永远拿到 connection refused,页面卡死在 `chrome-error://chromewebdata/`,需要用户手动 Reload Window 才能救回来——现场复现过两次。

**现在的做法**:SIGTERM(不用 SIGKILL,和 `extension.js` 里 `AntigravityServerManager.stop()` 一样走优雅退出优先、超时才强杀)杀掉 hub 之后,不再单独 reload 某个 iframe,而是用 CDP 对 VS Code 顶层 page target(不是 iframe subtarget——`Page.reload` 只在顶层 target 上生效)发 `Page.reload()`,效果等同于用户自己按 `Developer: Reload Window`。整个插件重新激活,会话面板重新 resolve,`serverManager.start()` 随之被重新调用,新 hub 干净拉起。

**顺带修的竞态 bug**:`/api/switch` 原本是"CLI 切成功 → 执行 hub 重启(含 reload) → 把 HTTP 响应写回给调用方"。但发起这次 `/api/switch` 请求的往往就是即将被 reload 的那个页面自己——reload 一发生,浏览器直接把这条还没返回的 in-flight fetch 掐断,前端拿到 `TypeError: Failed to fetch`,误判为失败并回滚一个后端其实已经切换成功的账号(现场日志实锤:CLI 明确 succeeded,几毫秒后前端记录 rolling back)。改成先把响应发给调用方,再执行 hub 重启,重启本身变成 fire-and-forget。

## Profile 悬浮徽标:为什么不拦截原生点击

**日期**:2026-08-22 · 涉及 `main.ts::ensureProfileBadge`

见上面"官方 Sign Out 入口"一节的后续更新。当前方案:头像角上叠加一个独立的小徽标 DOM 元素(不是原生按钮的子节点),点击/悬停这个徽标才会打开我们自己的账号切换弹窗;原生按钮本身完全不挂任何拦截逻辑,点击照常打开官方 Account/Sign Out 面板。两个独立点击目标,互不干扰。

原生触发器和徽标都额外挂了 `mouseenter` 打开弹窗、`mouseleave` 延迟 300ms 关闭(防止鼠标从触发器斜着移进弹窗时中途被判定"离开"关掉)。

## Settings 卡片锚点:改用 data-testid(2026-08-23 定稿)

**日期**:2026-08-23 · 涉及 `semanticLocator.ts::findQuotaSectionContainer`、`settingsEnhancer.ts`

下面那一版(文本匹配 + 最近公共祖先)虽然比再上一版稳,但根子上还是**依赖显示文本**("Claude and GPT models"、"Five Hour Limit Remaining"),官方改文案、加区块、或者渲染慢一点都会失手,所以"锚定总有问题"一直没根治。

现场用 CDP 枚举页面上的 `data-testid`,发现官方有一批稳定的测试钩子:

```
settings-nav-item-General / -Appearance / -Models / -Customizations / -Browser / -Account ...
workspace-customizations-view, add-mcp-button, migration-warning-banner,
quota-progress-circle      ← 就是配额环
```

**定稿做法**:取所有 `[data-testid="quota-progress-circle"]`(实测 4 个)的最近公共祖先,那就是"承载全部原生配额区块"的容器(实测 `div.flex.flex-col.gap-4`),我们的卡片直接 `appendChild` 进去当最后一个子元素。好处:

- 完全不依赖显示文本,官方改文案/换语言都不影响;
- 不关心有几个配额区块(Gemini、Claude&GPT,以后再加也自动覆盖);
- `appendChild` 天然就是"排在所有原生内容之后",不用再算"我的前一个兄弟是不是锚点";
- 卡片成为容器的子元素,直接继承原生的 `gap-4` 间距,视觉上和原生区块对齐。

**自我干扰检查**:我们自己的环用的是 `class="ag-quota-ring"`、**不带 data-testid**,现场实测 `.ag-quota-ring[data-testid]` 数量为 0,所以公共祖先的计算不会把自己算进去。这点在代码注释里也标了,以后改卡片样式时别给自己的 svg 加上这个 testid。

**顺手根治了"反复横跳"**:新逻辑**故意不设任何 fallback 位置**。老版本在锚点还没渲染出来时会先退到"页面标题正下方",等锚点出现了再把卡片挪下去——这个"先放一处、再搬家"的动作本身就是用户看到的跳动。现在锚点不存在就什么都不做,等下一个 tick,自然不会跳。另外 `appendChild` 每次调用都会真的操作 DOM,所以加了 `card.parentElement !== container || container.lastElementChild !== card` 的守卫,避免 1.5s 的定时器每次都去和页面抢 DOM。

实测:非 Models tab 时 `rings=0`、不注入卡片(正确);切到 Models tab 后容器解析正确,卡片稳定落在两个原生区块之后。

## (历史)Settings 页 "Claude and GPT models" 卡片锚点定位

**日期**:2026-08-22 · 涉及 `semanticLocator.ts::findLastModelsSectionCard`(已被上面那版取代并删除)

**第一版**:从标题往上爬,找第一个有 `border` 的祖先元素,当成区块边界。实测从标题到最外层爬 8 层祖先,`borderWidth` 全部是 `0px`——这个页面的分区边框根本不是靠 border 画的。于是永远退化成兜底的 `label.parentElement`(标题所在的那一小行),导致我们的卡片被插进标题和它下面的 Weekly/Five Hour 数据行之间,卡在区块中间,而且因为兜底位置不稳定,还会出现"先出现在上方、又跳到下方"的反复横跳。

**现在的做法**:结构性定位——找到标题 `"Claude and GPT models"` 和区块内最后一行 `"Five Hour Limit Remaining"`(页面上出现两次,Gemini 一次、Claude/GPT 一次,取最后一个)两个叶子文本节点各自的位置,从标题往上爬,找到第一个"同时包含这两个节点"的祖先——这个最近公共祖先就是整个区块的真实边界。不依赖 border、也不依赖会跟官方版本走的 Tailwind class 名。

## Profile 触发器同步:为什么不能用纯坐标启发式

**日期**:2026-08-22 · 涉及 `profileSyncAdapter.ts::syncBottomTrigger`

我们的 runtime 会同时注入到主 Chat iframe 和 Settings(`settings-standalone`)iframe。真正的左下角 profile 触发器只存在于前者的 DOM 里,后者压根没有这个元素。

第一版 `syncBottomTrigger` 自己用一套独立的坐标启发式找"profile 容器"(`rect.bottom > 窗口高度-80 && rect.left < 220 && width>100 && height>24`),在 Settings 页面里没有真实触发器可匹配时,退化成随便匹配一个贴左边、够高够宽、底部接近窗口底部的 div——Settings 左侧导航栏(General/Models/... 那一列)整列刚好满足这个条件,于是它被当成了"profile 容器",里面第一个叶子文本节点(`"General"`)被当成邮箱/名字节点直接覆写,tab 名称被换成了当前账号邮箱。

修复:改成复用 `SemanticLocator.findProfileTrigger()`(先做语义匹配——找邮箱格式的叶子文本节点,再回溯到可交互容器;兜底才用 16-48px 的头像图片,范围严格得多),在没有真实触发器的场景(比如 Settings iframe)直接返回 `null`,不再瞎猜。

**头像**:不覆写原生 `<img>` 头像标签——那是真实的 Google 头像,`agent-hub-accounts` 的账号数据里也没有 avatar 字段,之前拿同一张 stock 图片覆盖所有账号,是在用假信息销毁真信息,不是增加信息。

## 账号切换语义:confirmAndSwitch 为什么不跳过"已经是 active"的情况

**日期**:2026-08-22 · 涉及 `accountStore.ts::confirmAndSwitch`

`isActive` 缓存字段来自上一次 fetch 到的结果,而 shared-live 架构下"当前账号"会在几分钟内自然漂移(见上面 credential_drift 一节:hub 自己周期性刷新 token 就会改写 Keychain,不需要任何切换动作)。如果按缓存的 `isActive` 跳过点击("反正已经是 active 了,不用真的切"),用户在漂移发生后会彻底没有办法强制把状态拉回到他们以为的那个账号,因为点击本身被拦下来了。真正的后端切换调用即使最终什么都没变,也是安全、幂等的,所以点击一律真正发起一次后端切换请求,不做本地状态短路。

## window.confirm() / alert() 在 VS Code webview 里静默失效

**日期**:2026-08-22 · 涉及 `confirmDialog.ts` 及所有调用点(`accountStore.ts`、`accountPopup.ts`、`settingsEnhancer.ts`)

这是本次调试链路最长的一个 bug:所有需要用户确认的操作(切换账号、添加账号、Check All Accounts、Remove)全都表现为"点了没反应"。现场用 CDP 直接在 settings-standalone iframe 里执行 `window.confirm('test')`,返回 `{"threw":false,"result":false}`——**没有抛错,也没有弹出任何对话框,直接静默返回 `false`**;`window.alert()` 同样不抛错但什么都不显示。VS Code webview 的沙箱环境把这两个原生 API 静默 no-op 掉了。

修复:自建 `confirmDialog.ts`(`showConfirm()`/`showAlert()`,纯 DOM 实现的模态框,返回 Promise),替换掉全部调用点的原生 `confirm()`/`alert()`。

## Settings 卡片的几个小决策

**日期**:2026-08-22 · 涉及 `settingsEnhancer.ts`

- **不做侧边栏导航项**:早期加过一个"侧边栏导航快捷入口",定位它要匹配的"导航列表"文本时,`div, nav` 选择器 + 文本 `.includes()` 太宽,两次都插进了错误的容器,还扰动了不相关的布局。这个功能只省一次滚动,收益不高,风险却是全代码库里对 DOM 最激进的一次改动,直接砍掉——卡片本来就直接展示在它所在的 Models 页面上,不需要额外入口。
- **Add account 只在弹窗里,不在卡片里重复**:卡片(Settings 页)定位是配额统计视图,不是第二个账号管理入口。
- **Remove 是安全的"忘记"操作,不是登出**:和"不做 logout"是同一个决策(见文首),只从本地 registry 里移除,不碰真实 Google 会话、不会让密文失效,可以随时重新连接。
- **"Check All Accounts" 的确认文案特意和"切换账号"不一样**:这个按钮长得、读起来都像官方那个零副作用的单账号 refresh 图标,但它实际会把真实登录依次切过每个已连接账号来查配额(Antigravity 没有原生的多账号配额聚合能力,今天没有无副作用的实现方式),所以确认文案专门把这个差异挑明,不能偷懒复用切换账号的那句话。

## 多账号下的配额数字与弹窗显示

**日期**:2026-08-23 · 涉及 `accountStore.ts`、`accountPopup.ts`、`settingsEnhancer.ts`、`styles.css`

账号涨到 5 个之后暴露出三个显示问题,实时页面上都能直接看到:

**1. "500% Active (5 accounts)"** —— `getTotalQuota()` 把各账号的百分比**累加**了。5 个账号各 100% 就成了 500%。不管本意想表达什么,一个超过 100% 的百分比在 UI 上只会被读成 bug。改成两个都算出来、由调用方选:
- `averagePercent`(平均)—— Settings 卡片的徽章用它,文案改为 "X% avg across N accounts";
- `bestPercent`(最高)—— 弹窗顶部摘要用它,文案改为 "Best account remaining"。选账号时真正有用的是"哪个还有余量",所以弹窗给最高值。

**2. 五个账号全显示 100%,没法据此选账号** —— `quotaPercent` 原来只取 `gemini.five_hour`。实测 5 个账号的 5h 全是 1(它一直在回补),而真正有差异的是 weekly(0.919 / 0.972)。改成取 **`min(five_hour, weekly)`**:哪个更接近耗尽,哪个才是实际会挡住你的限制。同时 Settings 卡片每行把两个数都摊开显示("Gemini weekly X% · 5-hour Y%"),这样那个 min 出来的头条数字是可解释的,不是凭空冒出来的。

**3a. 弹窗最多显示 10 个账号(2026-08-23 补充)** —— 光有视口上限还不够:窗口够高时(实测视口 1245px)能塞下 24 行,一屏几十个账号的列表本身就不好用。所以再加一条**硬上限 10 行**,和视口上限**取更小的那个**:

```
实际可见行数 = min(10, floor((视口高度 - 243) / 41))
```

两条上限用纯 CSS 复合,不需要 JS:弹窗自己是 `max-height: calc(100vh - 96px)` 的 flex 容器,列表是唯一带 `min-height: 0` 的可收缩子项,所以视口不够时列表会被压到自己的 `max-height` 以下、更早开始滚动;窗口够高时则由列表自己的 10 行上限封顶。行高等参数走 CSS 变量(`--ag-row-h: 39px` / `--ag-row-gap: 2px` / `--ag-max-rows: 10`),要改数量只动一个变量。

配套:行必须保持等高,否则"10 行"的算术就不成立——所以账号名加了 `text-overflow: ellipsis` + `white-space: nowrap`(长邮箱换行会让行变高),父级补 `min-width: 0`(不加的话 flex 子项不会收缩,省略号根本不触发),百分比加 `flex-shrink: 0`,行本身也加 `flex-shrink: 0`(被压缩时应该滚动而不是把每行挤扁)。

**实测验证**(灌 20 个假账号):高窗口下列表 420px、正好 10 行可见、`scrollHeight 845 > clientHeight 420` 触发滚动、20 行全部等高(用超长名字验证省略号生效);把弹窗限高强制压到 300px 模拟矮窗口,列表跟着缩到 161px、约 3.7 行,仍可滚动;恢复后回到 10 行。

**3b. 弹窗账号一多会被裁掉且无法滚动** —— `.ag-enhancer-popup` 是按 `bottom` 定位的(列表向上生长),又设了 `overflow: hidden` 且没有高度上限。账号足够多时会顶出视口上沿,而 `overflow:hidden` 只会**静默裁掉头部**,不会给滚动条。改成:弹窗 `max-height: calc(100vh - 96px)` + `display:flex; flex-direction:column`,header/摘要/操作区都 `flex-shrink:0` 保持钉住,只有 `.ag-enhancer-subs-list` 可滚(`overflow-y:auto` + **`min-height:0`**——flex 子项必须显式允许收缩到内容高度以下,overflow 才会真正生效,少了这行滚动条不出现)。

## 监听器泄漏与无条件重渲染(2026-08-23)

**日期**:2026-08-23 · 涉及 `accountPopup.ts`、`main.ts`、`settingsEnhancer.ts`

**1. 每开一次弹窗泄漏一个 window 监听器**。`createAccountPopup()` 里挂了 `window.addEventListener('ag-account-changed', ...)`,但 `closePopup()` 只做了 `popupInstance.remove()`——**移除 DOM 节点不会解绑挂在 window 上的监听器**。而 `openPopup()` 每次打开都会新建一个弹窗,加上鼠标悬停左下角就会触发打开,所以鼠标每扫过一次就漏一个。每个泄漏的监听器都会在此后每次 `ag-account-changed`(20s 轮询 + 每次切换)时,对一个已经脱离文档的节点做完整 innerHTML 重建。

用 CDP `DOMDebugger.getEventListeners` 实测确认:**5 次开关正好泄漏 5 个**监听器。

修法:`createAccountPopup()` 建一个 `AbortController`、挂在元素上,监听器用 `{ signal }` 注册;新增 `destroyAccountPopup()`,由 `closePopup()` 调用。注意 `closePopup()` 里的 abort 必须在"节点是否还在文档里"的判断**之外**执行——节点早已移出文档时,监听器依然活着。修完复测:**0 泄漏**。

同一类问题在 Settings 卡片上也有:监听器在卡片创建时绑定,但切换 Settings tab 会重渲整个页面、把卡片一起带走,下一个 tick 又建一个新的,旧监听器留下来继续渲染脱离的节点——每切一次 tab 漏一个。修法相同(模块级 `AbortController`,建新卡片前 abort 掉旧的)。

**2. 每 1.5s 无条件重写 innerHTML,会吃掉点击**。`injectSettingsEnhancements()` 为了保持锚定每 1.5s 跑一次,里面无条件调 `renderSettingsCard()`,而它是整块 `innerHTML =` 重建。用户点 Switch/Remove 时,如果重渲染正好发生在 mousedown 和 mouseup 之间,**click 事件根本不会触发**(元素已经被换掉了),表现就是"点了没反应"。

修法:按渲染用到的数据算一个签名,不变就直接 return。少数会改变"非数据状态"的调用点显式传 `force`:切换后要清掉行上的 inline opacity(即使切换被取消、数据没变)、Check All Accounts 后要把按钮文案从 "Checking accounts..." 改回来。

弹窗侧同理加了签名守卫,原因是列表现在可滚动了——20s 轮询不管有没有变化都会重建 DOM,正在滚动的用户会被弹回列表顶部。

**验证**(实时页面):弹窗正常打开、5 行、"Best account remaining / 5 connected accounts"、徽章 97%(取最大值而非 500%)、列表 `overflow-y: auto`、`max-height` 405px 随视口计算、关闭干净、0 泄漏。

## 添加账号(定稿):走原生浏览器登录,不再开 Terminal

**日期**:2026-08-23 · 涉及 `daemon.ts` 的 `/api/add-account/*`、`addAccountPrompt.ts`、`accountPopup.ts`

下面那版(开 Terminal 跑 `agy` TUI)能用但很别扭:一个做在编辑器里的 UI,点"添加账号"却弹出一个终端窗口让你在 TUI 里操作。

**更好的路子**就是 Antigravity 自己的流程:没有凭证时 hub 会渲染它自己的登录页,点上面的按钮时 hub 打印 `ANTIGRAVITY_OPEN_URL:`,`extension.js` 监听 hub stdout 捕获这行并 `vscode.env.openExternal()` 跳浏览器。所以我们**完全不需要碰登录本身**,只要负责"把凭证拿走"和"把新凭证存回来",中间那段是原生的。

**第一次实测失败,以及从 antigravity-sync-mcp 学到的两点纠正(2026-08-23)**

第一版跑下来:用户**根本没被登出**,`finish` 捕获到的还是同一个账号。查 `~/antigravity-sync-mcp/packages/sidecar/scripts/restart-worker.js`(它的 `relaunch_with_auth_clear` / `Trigger: account_add` 解决的是同一个问题)后定位到两个错误:

1. **认证不在 Keychain**。那个项目清的是 `state.vscdb` 的 `antigravityAuthStatus` / `antigravityUnifiedStateSync.oauthToken` / `antigravityUnifiedStateSync.userStatus` 三个 key,还要删 `.vscdb.backup` 防止从备份恢复——但那是给**独立的 Antigravity.app** 用的,我们这套 VS Code + 扩展的 DB 里根本没有这些 key(只有 `lastInstalledReleaseBaseUrl`)。**我们环境里的对应物是 `~/.gemini/jetski-standalone-oauth-token`**,即 hub 自己缓存的 session。证据:在 SSH 会话里起的 hub(读 Keychain 返回 exit 36,完全无权限)照样是已认证状态,说明它靠这个文件;而空 HOME 起的 hub 则不会生成它。
2. **时机**。对方代码里那句注释就是我们踩的坑:`// 清空 auth（在进程退出后执行，避免被 Antigravity 写回覆盖）`。第一版是在 hub 还活着时清的,被正在退出的 hub 原样写了回去。为此给 `restartAntigravityHub()` 加了 `onStopped` 钩子,专门提供"所有 hub 已退出、新 hub 尚未启动"这个窗口。

**为什么不备份 session 文件**:它是 hub 的缓存,不是凭证的唯一副本。每次普通的账号切换都只写 Keychain(`switch` → `activate()` → `writeActive`,agent-hub-accounts 从不碰这个文件),而重启 hub 之后账号确实会变——这说明 hub 启动时以 Keychain 为准并据此重建该文件。所以直接删掉即可,恢复交给 `switch`,真正的备份是 `credentials/<id>.json`(`begin` 的第一步 `connect` 已证明它存在)。这也让 `cancel` 退化成一次普通的 `switch` + 重启,走的是被反复验证过的老路径。

**验证过的前提**(没有动实机凭证):
- `detachActive()` 实现是 `security delete-generic-password -s gemini -a antigravity` —— **纯本地删 Keychain 条目,没有任何网络调用或 OAuth 撤销**;`~/.agent-hub/plugins/accounts/state/credentials/` 下的凭证副本文件完全不动,所以 `activate()` / `switch <id>` 随时能还原。
- 在 SSH 会话里起了一个 hub(SSH 读 Keychain 返回 exit 36,天然就是无凭证状态):**照常启动、HTTP 200**,说明 detach 后重启 hub 不会把 hub 弄坏;而且启动时 stdout 里**没有** `ANTIGRAVITY_OPEN_URL`,证实那行是登录页点击后按需发出的,不是启动时发的——所以我们不需要去 pipe hub 的 stdout。

**流程**(daemon 三段式 + 一个状态查询):
1. `POST /api/add-account/begin` —— 先 `connect` 捕获当前凭证(既顺手修掉 drift,又**证明**能还原;失败就直接中止,不做任何破坏性操作),记下备份账号 ID,然后 detach,再用已有的快速同端口 respawn 重启 hub。
2. webview 重载 → hub 无凭证 → 显示原生登录页 → 用户点击 → 浏览器登录(全程原生)。
3. `POST /api/add-account/finish` —— `connect` 捕获现在登录的这个账号,重启 hub。
4. `POST /api/add-account/cancel` —— `switch <备份ID>` 还原,重启 hub。

**为什么"进行中"的状态存在 daemon 而不是页面里**:第 1 步会重启 hub、把 webview 整个重载掉,页面持有的任何状态都会丢。所以 daemon 用 `pendingAdd` 记录,`GET /api/add-account/status` 供查询;runtime 每次注入时都问一遍,需要就重建那个 Done/Cancel 横幅。副作用是这个横幅在用户中途手动 reload 窗口后也能正确恢复。

横幅刻意做成**不遮挡页面**的顶部条(不是模态)——用户必须能够操作它下面 Antigravity 自己的登录页。

**detach 的实现方式**:不在本仓库硬编码 Keychain 的 service/account 常量、也不自己拼 `security` 命令,而是 `node -e` 复用 `agent-hub-accounts` 编译产物里的 `MacKeychain.detachActive()`(经 `settings().credentialsDir` 构造)。少一处需要同步的重复定义,它们的错误处理和后续改动也自动跟上。

旧的 `/api/login`(Terminal + TUI)暂时保留作为兜底,UI 已不再调用。

## (历史)添加账号:为什么必须开一个真实 Terminal

**日期**:2026-08-22 · 涉及 `daemon.ts::/api/login`、`accountPopup.ts`

原来的 `/api/login` 是 `execAsync("node cli.js login --json")`,**这个调用永远不可能成功**。查 `agent-hub-accounts` 源码(`src/cli/process-control.ts::openAntigravityLogin`),`login` 有三道硬拦截,每一道都能单独让上面这行失败:

1. `if (json) throw new AccountStateError("login is interactive and does not support --json")` —— 我们恰好传了 `--json`。
2. `if (!process.stdin.isTTY || !process.stdout.isTTY) throw "login requires an interactive terminal"` —— daemon 经 `execAsync` 起的子进程没有 TTY。
3. 真正干活的是 `spawnSync(agy, [], { stdio: "inherit" })` —— 把终端交给交互式 agy 登录 UI,阻塞到用户完成为止。这种东西本质上没法藏在一个 HTTP 请求后面。

所以改成 daemon 写一个临时 shell 脚本、用 `osascript` 打开 Terminal.app 去跑它。脚本里连着做两步:`login`(交互式 Google 登录)、成功后 `connect`(把新登录捕获保存)——`login` 自己的提示也是"New agy login is active. Run connect to save it",两步必须成对出现,放在同一个窗口里做完最省心,前端就不用再驱动第二步了。登录失败时脚本会说明"之前的账号已自动恢复"(这是 `openAntigravityLogin` 自己的行为:检测到新登录没完成会 `keychain.activate(current.account_id)` 回滚)。

前端因此只剩:确认 → 请求开窗 → 提示用户去那个窗口完成 → 用户点 OK 后重新 `fetchLiveAccounts()`。确认文案里明确写了"会先把当前账号保存下来,取消登录会自动恢复",因为这个流程中途确实会把本地登录态摘掉,不说清楚会让人以为出故障了。

**实测踩到的第二个坑:必须先 `connect` 再 `login`**(2026-08-23)。第一版脚本直接跑 `login`,实测报错:

```
agent-hub-accounts: current agy login is not safely saved; run agent-hub-accounts connect first
```

来源是 `openAntigravityLogin` 的前置检查:

```js
const current = live.current("antigravity-cli");
if (!current || !keychain.profileMatchesActive(current.account_id)) throw ...
```

它在把当前登录态 `detachActive()` 摘掉之前,坚持要求当前账号已经**逐字节保存**过——这样万一新登录没完成,才能 `keychain.activate(current.account_id)` 安全回滚。但这正好撞上 credential_drift:常驻的 `agy --hub` 会周期性刷新 OAuth token 并写回同一个 Keychain 槽位,所以正常用几分钟后,保存的副本就和实时凭证对不上了,`profileMatchesActive()` 返回 false,`login` 直接拒绝启动。也就是说**这个报错是常态而非异常**。

注意 `current --json` 看不出这个问题:它读的是缓存(输出里 `active_verification: "cached"`),显示 `credential_drift: false`、`is_active: true` 一切正常;`login` 做的才是实时 Keychain 比对。要复现得用 `--verify`(但注意 SSH 会话读不了 Keychain,在 SSH 里跑 `--verify` 会因为完全无关的原因失败,得到误导性结论)。

修复:脚本改成三步 —— `connect`(重新捕获当前已漂移的凭证,让前置检查通过)→ `login`(交互式登录新账号)→ `connect`(保存新账号)。第一步用不带参数的 `connect`,和 CLI 报错里给的指引一致(它会从 agy 最近日志里自动识别当前登录邮箱,比我们从外面猜一个 ID 传进去更贴近"现在实际登录的是谁")。每步失败都有独立的说明和退出,并明确告知有没有改动过状态。

## 两个流程复盘(2026-08-23)

**日期**:2026-08-23 · 涉及 `daemon.ts`、`accountStore.ts`、`progressOverlay.ts`

**修:添加账号后从不重启 hub**。`login` 成功后,新账号成为 Keychain 的活动登录,但常驻 hub 内存里还是旧凭证——于是 `route` 报新账号 active、UI 显示 ACTIVE,**而实际聊天还在旧账号上**。这就是本次会话最开始那个"切换了但会话框还是原账号"的 bug,当时只在 switch 路径上修了,添加路径一直漏着。

难点在于登录脚本是 detached 跑在 Terminal 里的,daemon 不知道它什么时候结束。解法:新增 `POST /api/hub-restart`,由脚本自己在 `connect` 成功后 `curl` 回来触发。curl 失败也不会让脚本挂掉,只提示"重启 VS Code 生效"。

**修:切换时 7 秒零反馈**。`/api/switch` 是故意先回响应再重启 hub 的(否则响应会被它自己触发的 reload 掐断),所以前端 ~150ms 就拿到成功回执,然后**静默 6.5 秒**,面板毫无预兆地整个重载。加了 `progressOverlay.ts`:确认后立刻盖一个"Switching to X…"的模态,一直挂着。

关键设计:**成功时不主动关闭它**——iframe reload 会把整个 document 换掉,那一刻正是新账号真正生效的时刻,所以 reload 本身就是完成信号。提前关掉只会让陈旧 UI 再露 6 秒然后又突然变白。只有失败(回滚)时才显式关闭并报错。另加 30s 超时兜底,避免重启失败时留下永久模态。

**待定:用 ANTIGRAVITY_OPEN_URL 取代 Terminal + TUI**。在 `agy` 二进制里确认存在 `ANTIGRAVITY_OPEN_URL: %s`,而 `extension.js` 里 hub 的 stdout 监听会捕获这行并 `vscode.env.openExternal(uri)` 打开浏览器——也就是说**存在一条走浏览器、不需要交互式 TUI 的登录路径**。

设想的流程:`connect` 保存当前 → 摘掉活动凭证 → 用我们已有的同端口 respawn 重启 hub(但要 pipe stdout 而不是 ignore)→ hub 发现没凭证、打印 `ANTIGRAVITY_OPEN_URL:` → 我们 `open` 这个 URL → 用户在浏览器里登录 → hub 拿到凭证写回 Keychain → `connect` 捕获成新账号。额外好处:hub 全程就是新账号,连"添加后要重启"这一步都省了。

**尚未验证**,因为要确认 hub 在没有凭证时确实会打印这一行,就得真的把当前登录摘掉,风险太高不便擅自在实机上做。要推进的话需要先商量一个安全的验证方式。

## ⚠️ 永远不要裸调 `connect`(2026-08-23,实际损坏过一个账号)

**日期**:2026-08-23 · 涉及 `daemon.ts` 的全部 `connect` 调用点

**发生了什么**:切换到 `user-alpha` 之后,调了一次不带参数的 `/api/connect` 想确认"Keychain 里到底是谁"。结果它把 **user-alpha 的凭证写进了 `user-gamma` 的档案**,后者自己的凭证副本被覆盖销毁。加上此前切换时 Keychain 那份也已被覆盖,该账号两份凭证全部丢失,只能重新登录。文件时间戳是铁证:其余四个档案都停在 10:54,只有 `user-gamma%40gmail.com.json` 是 16:41:43——正是那次 `connect` 的时刻。

**根因**:`connect` 不带参数时,账号 ID 来自 `recentAntigravityEmail()`,即**从 agy 最近的日志里猜**,而不是从凭证本身解析。于是它做的是"把**当前活动凭证**存到**日志里最近出现的那个邮箱**名下"——两者不一致时就是静默覆盖,没有任何警告。

**这不是诊断特有的问题**:自动捕获 `watchForNewSignIn()` 也在裸调 `connect`。新账号刚登录时日志往往还没更新,拿到的正是**上一个**账号的邮箱,于是新凭证被写进那个老账号的档案,把一个能用的账号毁掉。正常使用中必然会踩。

**修法**,分两类:

- **能确定 ID 的场合一律显式传入**。`begin` 的备份和 `/api/connect` 改用 `route --verify --json` 定出权威 ID —— `--verify` 会把 Keychain 和每个已保存档案逐字节比对,它标记的 active 才是凭证真正的归属。**不能用 `route`/`current`**:它们读缓存,实测在 Keychain 装着别人凭证时仍然报告某账号 active。定不出归属就**中止**(`/api/connect` 返回 409),绝不猜。
- **无法确定 ID 的场合(自动捕获、`finish` 兜底)改成可撤销**。这两处必须裸调——"还不知道登录的是谁"正是它们存在的理由——所以写入无法预先拦截。改成:调用前 `snapshotProfiles()` 快照全部凭证档案,若捕获结果落在**已知账号**上,就 `restoreProfile()` 把被覆盖的那份放回去,并继续等待。等日志追上来后自然会拿到正确的邮箱。

**第一版守卫写过头了(当天稍后修正)**:`begin` 一开始要求"`--verify` 必须能逐字节匹配出当前凭证的归属",匹配不上就中止。实测立刻踩雷——切换后几十分钟内,常驻 hub 刷新了自己的 OAuth token 并写回同一个 Keychain 槽位,于是活动凭证变成了同一账号的**更新版**,和已保存副本字节不同,`--verify` 找不到 active,添加账号被完全堵死(连报三次 `begin FAILED`)。这正是本文档 credential_drift 一节描述的现象,只是这次撞在了自己的守卫上。

想清楚才发现搞反了主次:**`begin` 里那次捕获只是顺手刷新备份,不是前提**。真正的前提是"存在一个能切回去的已保存账号"——而那份副本本来就在。恢复路径 `cancel` 走的是 `switch <id>`,用的始终是**已保存副本**,根本不碰活动凭证,所以副本旧一点完全不影响。

改成:能逐字节匹配就顺手 `connect` 刷新一下备份;匹配不上(token 轮换的常态)就跳过捕获,只记录"取消时切回哪个账号"(优先 `current` 报告的上次激活账号,且必须确实有已保存副本)。一个账号都没有才中止。**注意这里 `current` 只用来决定"读哪个档案",绝不用来决定"往哪个档案写"**——后者正是毁掉账号的那个错误。

**顺带确认的一件事**:切换机制本身是好的。测试中切到 `user-alpha`,原生 Account 面板确实跟着从 `user-delta@example.com` 变成了 `user-alpha@example.com`。此前看到的面板与凭证不符,是更早那些失败流程留下的陈旧显示,不是切换失效。

## 又一次账号损坏:自动捕获的猜测机制在我们的环境里结构性地不可能猜对(2026-08-23)

**日期**:2026-08-23 · 涉及 `daemon.ts`、`semanticLocator.ts`、`addAccountPrompt.ts`

**发生了什么**:用户用新 Google 账号 `user-beta@example.com` 完成登录后,daemon 的自动捕获(`watchForNewSignIn()`)把它存成了 `user-gamma@example.com`——一个此前已经被 `remove` 删掉、根本不该存在的账号名。上一版加的"回滚已知账号"守卫没拦住,因为 `user-gamma` 当时已经不在已知列表里了,守卫只保护"已知账号不被覆盖",没有覆盖"编错新账号名字"这种情况。

**根因,而且这次是决定性的**:`connect` 不带参数时靠 `recentAntigravityEmail()` 猜账号 ID,而这个函数扫的是 `~/.gemini/antigravity-cli/log/`——独立 `agy` CLI 工具的日志目录。我们的 hub 是 `--app_data_dir=antigravity` 启动的,写的是完全不同的 `~/.gemini/antigravity/log/`,现场验证过后者**从不产生** `email=` 这个格式的日志行(`grep -al 'email=' antigravity/log/*.log` 结果为 0)。

也就是说这不是"日志滞后一会儿,等等就好"——**这套猜测机制在我们的环境里结构性地不可能猜对**,永远冻结在 `antigravity-cli/log` 最后一次被写入时的邮箱(这次是 10:54,那时活跃账号恰好是 user-gamma),不管用户后来通过 hub 登录成谁,猜出来的都是同一个值。上一版的"逐次加固守卫"方向从一开始就错了:问题不是猜测偶尔失手,是猜测的信息源和真实事件毫不相干。

**修法:不再猜,读真实身份**。Antigravity 原生 Account 面板("Email <address> Sign Out")本身就显示着当前真正登录的邮箱——这是唯一可靠的来源。新增 `SemanticLocator.findAccountPanelEmail()`:匹配邮箱格式的叶子文本节点,且上下文包含 "Sign Out" 字样(面板平时 `display:none` 但节点始终在 DOM 里,不需要先点开);现场验证过打开我们自己的账号弹窗(5 行,同样都是邮箱)不会干扰这个匹配,因为弹窗行的上下文是 "Switch"/"In Use",不是 "Sign Out"。

流程整体改成:daemon 侧删掉整个 `watchForNewSignIn()` 轮询,新增 `POST /api/add-account/report-identity`,只接受显式 `accountId`——不再有任何猜测代码路径。前端在 `settings-standalone` iframe(Account 面板只在这里)里轮询该面板的邮箱,读到后主动上报。`connect <显式ID>` 因为 ID 来源可信,不再需要 snapshot/restore 那套撤销保护——那套保护针对的正是"写入前不知道对不对"的场景,现在写之前就已经确定是对的。

`finish` 端点(手动兜底,已无 UI 调用)保留了旧的猜测逻辑作为**次选**,但现在优先接受调用方显式传入的 `accountId`——用 curl 强制收尾时,应该传真实邮箱,不要依赖猜测。

**现场恢复**:受损的 `user-gamma@example.com` 档案已用用户确认的真实邮箱 `user-beta@example.com` 重新 `connect`(显式 ID,安全),再 `remove` 掉那个错标条目。最终 5 个账号,`user-beta` active,无残留。

## 移除账号:实际语义比"本地忘记"更重

**日期**:2026-08-22 · 涉及 `daemon.ts::/api/remove`、`settingsEnhancer.ts`

之前 UI 上写的是"This only forgets it locally — you can reconnect it later",**这句话是错的**。查 `cli.ts` 的 remove 分支和 `keychain.ts::remove`:满足 `auth_kind === "oauth-subscription" && credential_source === "agy-profile"` 时会执行 `keychain.remove(accountId)`,而它做的是 `fs.unlinkSync(this.profilePath(normalized))`——把插件保存的那份凭证副本文件直接删掉。

所以准确语义是三条:
- **会**删除保存的凭证副本 → 之后无法再切回这个账号,想要回来必须重新走一遍完整的交互式登录(不是点一下 connect 就行)。
- **不会**撤销 Google OAuth、**不会**登出(CLI 文档明确:`Login never invokes agy /logout or an OAuth revoke endpoint`)。
- 不影响这个 Google 账号在别处的任何状态。

文案已按这三条重写。另外 daemon 侧加了一道拦截:**拒绝移除当前正在使用的账号**(先 `route --json` 查 `active`,命中就返回 409 `ACCOUNT_ACTIVE`)。否则会把正在跑的 hub 脚下的凭证抽掉,留下一个"活着的会话,但它的账号已经不在注册表里"的错乱状态。要移除得先切到别的账号。

`accountStore.ts` 里 `removeAccount()`/`triggerLogin()`/`triggerConnect()` 相应改成返回 `{ok, error}` 而不是吞掉异常——daemon 会因为上面这条 409 拒绝请求,如果继续静默失败,UI 上看起来和"删成功了"一模一样。

## 切换耗时:计时埋点为什么一开始测不准,以及第一个优化点

**日期**:2026-08-22 · 涉及 `daemon.ts`、`hubRestart.ts`、`cdpInjector.ts`、`main.ts`

第一版 `[TIMING] switch` 日志(`cliMs`/`hubStopMs`/`windowReloadMs`/`grandTotalMs`)测出来的总耗时只有 ~1 秒,但实测从"hub restart result"打出来到前端真正重新发出 `GET /api/accounts` 之间,日志时间戳相差 **35~40 秒**。原因是 `windowReloadMs` 测的只是 CDP `Page.reload()` 这条命令本身的往返时间——这条命令一旦让 VS Code 开始导航就立刻返回,并不等页面真正加载完、插件重新激活、新 `agy --hub` 冷启动到健康(`waitForServerReady` 最多轮询 15 秒)。这一整段真实耗时完全没被计时覆盖。

在这之上还叠加了一个纯人为的浪费:`main.ts` 原来只有弹窗被打开时才会 `fetchLiveAccounts()`,常驻的只有一个 20 秒的后台轮询——就算 VS Code 和新 hub 已经完全就绪,UI 数据也要平白再等最多 20 秒才会刷新。

**已做的第一个优化**:脚本一注入就立刻主动 fetch 一次(`main.ts` 顶层直接调用,不再只在弹窗打开或轮询触发时调用),砍掉这段纯等待。

**补的埋点**(还没做进一步优化,先能测出真实数字):`cdpInjector.ts` 的注入成功日志改用带时间戳的 `log()`(`[CDP_INJECT] injected into ...`),`accountStore.ts` 新增 `logRuntimeBoot()`,脚本启动时打一条 `runtime booted, fetching accounts` 到 daemon 日志。现在可以用 `[HUB_RESTART] reloaded VS Code window` → `[CDP_INJECT] injected into ...` → `[FRONTEND] ... runtime booted` 三个时间戳算出"reload 命令发出"到"脚本重新注入"到"前端真正活过来"分别花了多久,而不是只能靠人工数日志间隔猜。

**实测拆解(2026-08-22 稍晚)**:单独起一个 `agy --hub` 进程直接测(spawn 到 HTTP 200)只要 **6.15s**;`acquireInstalledBinaryPath` 里每次 start 都会做的更新清单请求(`fetchReleaseManifest`,打 `antigravity-cli-auto-updater-...run.app/manifests/darwin_arm64.json`)实测 **~0.56s**。两者相加 ~6.7s,而实际观测到的整窗口 reload 总耗时是 30-36s——差额 24-29s 基本可以确定是 VS Code 自己重新初始化整个 workbench UI + 其它所有插件一起重新 `activate()` 的开销,不是 hub 或本插件的问题。

**已验证不可行的方向:单独用 `Developer: Restart Extension Host` 替代整窗口 reload**。用 CDP 模拟按键(Cmd+Shift+P → 输入命令 → 回车)实测:命令确实执行了(旧 hub 进程被杀,和 `deactivate()` 里的 `serverManager.stop()` 行为吻合),但等了 60 秒**没有任何新 hub 被拉起、也没有 webview 重新连接**——iframe 还停在死端口上,和"卡死"bug 现象完全一样,最后还是靠 `Page.reload()` 救回来的。

根本原因:整窗口 reload 会触发 VS Code 自己"恢复之前的面板布局"逻辑,面板一恢复可见就会重新 `resolveWebviewView`,顺带重新调用 `serverManager.start()`；而 `Restart Extension Host` 只重启插件宿主进程本身,不会主动帮你把已经打开的 webview 面板重新"点亮"——面板还在,但没人去戳它重新 resolve,新 hub 也就永远不会被拉起。要用这条路真正省时间,还得再自己想办法自动触发面板重新可见(比如模拟切走再切回),可靠性和复杂度都不比现在这个方案低,投入产出比不划算,已放弃这个方向。

**结论**:24-29s 这部分目前认为是 VS Code 自身机制的硬成本,没有找到更轻量、同样可靠的替代触发方式。真正的硬成本只有 hub 冷启动 + 更新检查那 ~6.7s,除非换更快的启动路径否则很难再压缩。

**又查了两条路,都是死路(2026-08-22 更晚)**:

1. **给 `agy --hub` 发 SIGHUP 让它原地重读 Keychain,不用整个重启**——实测:进程直接忽略 SIGHUP(发完照样存活、端口照样 200),不会做任何重载。二进制里 `HandleSIGHUP`/`Ignoring SIGHUPs` 大概率是"daemon 存活过终端断开"这种通用行为(常见于长驻进程,防止 SSH/终端断开时收到 SIGHUP 被杀),跟账号切换无关。没有任何信号能让已经在跑的 hub 原地重新读取凭证——`AuthProvider` 一旦在启动时绑定,只能靠重启进程才能换。

2. **`antigravity.serverUrl` 配置后门**——`desktopSetup()`(L295853)里,这个配置(或环境变量 `ANTIGRAVITY_SERVER_URL`)一旦设置,会整个跳过 `serverManager.start()`(不做二进制更新检查网络请求、不自己 spawn),直接把配置的 URL 当成已经在跑的远程 server 用。本来是给连远程 cloudtop/Jetski server 用的后门。但改这个配置触发的 `onDidChangeConfiguration` 处理(L282480)只调用 `provider.refresh()`——和 `Restart Extension Host`/`antigravity.reconnect` 命令是**同一个清缓存函数**,不会让已经打开的 webview 面板重新 resolve。就算我们自己常驻管理并预热一个 hub、把这个配置指过去,充其量只能省掉 window reload 之后"再等新 hub 冷启动"那 ~6.7s(挪到 reload 前并行做),换来的代价是要自己接管 hub 进程生命周期、要持久改用户的 VS Code 设置(这个字段语义是"远程服务器",UI 上大概率会显示 "Remote Antigravity server" 之类的文案),而且完全动不了真正的大头(24-29s 的 VS Code 自身重新初始化)。投入产出比不划算,不建议做。

三条路(SIGHUP / Restart Extension Host / serverUrl 后门)都查过了,没有一条能绕开"必须让 VS Code 整窗口重新识别面板"这个硬约束。

## ✅ 真正的优化:同端口自行 respawn(30-36s → ~7s)

**日期**:2026-08-22 · 涉及 `hubRestart.ts`

前面三条路全部卡在同一个前提上:**默认必须由 VS Code 来 spawn 新 hub**。但这个前提本身是错的——我们完全可以自己 spawn。

之前"只 reload 单个 iframe"之所以失败,唯一原因是杀掉 hub 后那个端口上没有进程在监听了,iframe 重新请求必然 connection refused。那么**我们自己在同一个端口上起一个新 hub**,iframe 的 URL 就依然有效,只需要 reload iframe,VS Code 那套"重建整个窗口"的开销就完全不需要了。

**实测结果(现场跑通)**:

| 阶段 | 耗时 |
|---|---|
| SIGTERM 旧 hub 到退出 | 1112ms |
| 自己在同端口 spawn 新 hub 到健康 | 5930ms |
| reload iframe | 8ms |
| **总计** | **7062ms** |

对比整窗口 reload 的 30-36s,**快 4-5 倍**。reload 后验证 iframe 内容完全正常(Settings 各 tab、项目列表、账号信息都在,`window.AntigravityEnhancerRuntime` 也自动重新注入了),零 chrome-error。

**实现要点**:
- **原样复制 argv,不要照模板重建**:`readHubSpec()` 直接读活进程的 `ps -o command=` 和 `lsof -d cwd`。extension 会按 workspace folder 逐个追加 `--add-dir`,还会拼上用户配置的 `serverArgs`——照固定模板重建会静默丢掉这些,起出来的 hub 对 workspace 的视野和原来不一致。
- **必须 `detached: true` + `unref()`**:否则 daemon 一重启就会连带把用户的 hub 杀掉。
- **保留整窗口 reload 作为 fallback**:同端口 respawn 任何一步失败(读不到 argv、端口被占、新 hub 起不来)都回退到老方案,保证最差情况不比以前糟。

**双 hub 场景与异步回收**:我们 SIGTERM 掉 extension 自己 spawn 的那个 hub 时,它的 `exit` 回调会把 `serverProcess`/`serverUrl` 清空。已经打开的 webview 不受影响(它们指向我们的新 hub),但**如果用户之后新开一个 Antigravity 面板**,extension 会走 `start()` 再 spawn 一个它自己的 hub(新的临时端口),这时机器上会同时有两个 hub。两者读同一个 Keychain 槽位,账号一致,功能上不冲突。

这两个 hub **不能按"新旧"来回收**——它们各自服务不同的 webview:我们的在原端口服务已经打开的 iframe,extension 那个在新端口服务新面板,杀掉任意一个都会让对应的 webview 变成 connection refused。唯一安全的判据是**"还有没有 iframe 指向这个端口"**。

`startHubReaperLoop()`(30s 一轮)按这个判据异步回收:从 CDP target 列表里收集所有被引用的 `127.0.0.1:<port>`,任何 hub 的端口不在其中即为孤儿。两道保险:
- **要求连续两次判定为孤儿才动手**。extension 是先 spawn hub、等 `waitForServerReady` 通过后才把 iframe 接上去的,单次快照可能正好落在这个空档里,把刚起来的 hub 误判成孤儿。
- **只有存在 2 个及以上 hub 时才回收**。只剩一个 hub 且没有 iframe 指向它,那只是用户把所有 Antigravity 面板关了、后端闲置着,是 extension 正常的持有状态,不该由我们去杀。

另外 CDP 不可达时直接跳过这一轮(判断不了谁在用,就假定都在用),`restartInProgress` 期间也跳过(重启过程中状态本来就是不一致的)。

**剩余耗时构成**:7s 里 5.9s 是 hub 二进制冷启动(实测单独起也要 6.15s,是硬成本),1.1s 是等旧进程优雅退出。想再压缩只能从"预热一个 hub"之类的方向想,但那要自己接管整个进程生命周期,复杂度陡增,当前不做。
