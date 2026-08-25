# 目录结构整理:daemon 端文件搬进 src/daemon/(2026-08-24)

之前 `daemon.ts`/`hubRestart.ts`/`cdpInjector.ts`/`cliRunner.ts`/`httpUtils.ts`/`logger.ts` 六个 Node 端文件平铺在 `src/` 根下,和 `src/runtime/`(前端注入代码,三层分 adapters/services/ui)不对称——项目还有个从未被 git 追踪过的空目录 `src/patcher/`,和现有的 `scripts/patch.mjs` 没有关系,像是早期设计换过路线后留下的残留。

**改动**(用 `git mv` 保留文件历史,纯移动没有内容改动):
- 六个 daemon 端文件 → `src/daemon/`,和 `src/runtime/` 对称,两侧再无 import 交叉——`daemon/` 是 Node 进程,`runtime/` 是浏览器里的注入代码,唯一通信路径是 HTTP(daemon 监听 63820)。
- 删除空目录 `src/patcher/`。
- `package.json` 新增 `"daemon": "tsx src/daemon/daemon.ts"` 脚本,`tsx` 从"每次靠 `npx` 现拉"改成正式 devDependency——此前一直是 `npm exec tsx src/daemon.ts` 现场解析,没有记在任何文件里,换了个人接手根本无从得知这条命令。
- `docs/README.md` 补了一份目录结构说明和"开工前"那条的具体命令。

**没动的地方**:DECISIONS.md 里其余历史条目提到的 `src/daemon.ts`、`src/cliRunner.ts` 等旧路径原样保留——那是发生当时的真实路径,决策记录不为文件搬家去重写历史;新路径对照表就是本条。三份已标注失效的历史文档(`ANTIGRAVITY_ARCHITECTURE_...`、`ANTIGRAVITY_MULTI_ACCOUNT_...`)同理不改。

**验证**:`tsc --noEmit` 已过(六个文件之间全是相邻 import,整体搬动不受影响);`vite.config.ts`/`scripts/patch.mjs` 核实过,均只引用 `src/runtime/main.ts`,不受这次移动影响。
