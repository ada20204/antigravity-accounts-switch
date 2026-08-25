# 首次 code review(xhigh,17 条发现)全部修复(2026-08-23)

**日期**:2026-08-23 · 新增 `src/cliRunner.ts`、`src/httpUtils.ts`、`src/runtime/adapters/domUtils.ts`、`src/runtime/ui/renderGuard.ts`

对本仓库做的第一轮正式 code review(5+5 维度 × 8 候选、二次验证、差距扫描),17 条发现全部确认并修复。逐条记录,严重性从高到低:

**1. CORS 白名单算了但从不强制拒绝(daemon.ts)**——`isAllowedOrigin()` 的结果只用来决定要不要设 `Access-Control-Allow-Origin` 响应头,从没用来拒绝请求。而这个头只控制浏览器让不让页面 JS **读**响应,不控制请求**发不发得出去**——`/api/login`、`/api/add-account/begin` 这类不带自定义 Content-Type 的"simple request"根本不会触发预检,本机任意浏览器 tab 打开的任意网页都能直接把它们打进来,静默把用户登出、杀/重启 hub、切活动登录,CORS 检查从头到尾没机会跑。这正是"CORS 白名单策略"那节以为已经堵上的那类 CSRF,实际只堵了一半。**修法**:origin 存在且不在白名单里,直接 403 拒绝,不进入任何 handler;origin 缺失(curl、我们自己的 Terminal 脚本)视为本地可信访问——浏览器发起的跨域 fetch/XHR 无论是否触发预检都会带 Origin,伪造不了这个头的缺失。**范围澄清(2026-08-23 复查)**:这堵的是跨域/远程网页发起的 CSRF,不是"任何本机访问"——`isAllowedOrigin()` 放行任意端口的 `127.0.0.1:*`(hub 每次重启端口都会变,钉死单一端口不现实),所以本机另一个端口上跑的、不相关的网页依然能带着合法 Origin 调 `/api/remove`、`/api/report-plan` 这类改状态的接口。和"缺失 Origin 视为本地可信访问"是同一套"本机访问本来就信任"的威胁模型,不是遗漏。

**2. Shell 注入:accountId 原样拼进 execAsync 的 shell 字符串(daemon.ts,5 处)**——`switch/connect/remove/cancel/report-identity` 全部是 `` execAsync(`node ... "${accountId}" --json`) `` 这种写法,accountId 来自请求体或 DOM 抓取,没有任何转义。配合第 1 条(能从外部网页发请求),邮箱里带个双引号就能跑任意命令。**修法**:新增 `cliRunner.ts` 的 `runCli(args: string[])`,用 `execFile` 而不是 `exec`——参数以 argv 数组形式直接传给系统调用,永远不经过 shell 解析,这类注入变得结构性不可能,不管 accountId 里有什么字符。顺带把原来散落 14 处的 `execAsync(...) + JSON.parse(stdout)` 收成 `runCli`/`runCliJson` 两个函数。

**3. `/api/add-account/begin` 的重入锁有 TOCTOU 竞态(daemon.ts)**——`if (pendingAdd) throw` 是同步检查,但 `pendingAdd` 要等 `--verify`、可选 `connect`、完整 hub 重启这几个 await 之后才会被设置。两个 begin() 请求前后脚到达,都能在 pendingAdd 还是 null 时通过检查,后一个的 `setPendingAdd()` 会悄悄覆盖前一个的 `backupAccountId`,导致后续 Cancel 切回错误的账号。**修法**:新增独立的 `addAccountBeginInFlight` 标志,在检查的**同一个同步块**里立刻置位(中间不经过任何 await),彻底关闭这个竞态窗口。

**4. `AGENT_HUB_DIST` 硬编码成 `<home>/work/agent-hub-accounts/dist`(daemon.ts)**——同一行代码旁边的 `CREDENTIALS_DIR`/`HUB_TOKEN_FILE` 早就在用 `os.homedir()`,唯独这个路径写死成了一个人的用户名,~15 处 CLI 调用全靠它,换个人换台机器直接不能用。**修法**:`cliRunner.ts` 里改成 `process.env.AGENT_HUB_ACCOUNTS_DIST || path.join(os.homedir(), 'work', 'agent-hub-accounts', 'dist')`,可覆盖,默认值对当前这台机器现场验证过仍然解析正确。

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
