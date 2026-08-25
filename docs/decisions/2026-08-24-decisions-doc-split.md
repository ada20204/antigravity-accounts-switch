# DECISIONS.md 拆成 docs/decisions/(按用户提供的 project-structure 规则)

用户提供了一份个人方法论规则(`~/.claude/methodology/rules/habits/project-structure.md`),核心原则之一是"小项目优先扁平化……只有文件混合多个用户意图、目录失去扫描性或事实 owner 不清时再拆分",推荐骨架里"已接受决策放 `docs/decisions/`(一条一份)"。

**判断依据**:单文件 `DECISIONS.md` 拆分前已经 501 行、28 个独立主题,且这轮会话还在持续变长——已经过了"扁平化够用"的门槛,属于规则里"目录失去扫描性"该拆的那类,不是无目标的历史清算。

**改动**:
- 28 个条目按标题拆成 `docs/decisions/<slug>.md`(日期能确定的用 `YYYY-MM-DD-` 前缀,历史/已取代的用 `historical-`/`superseded-` 前缀),内容原样保留,不重写措辞。
- 新增 `docs/decisions/README.md` 作为索引,每条一行链接 + 一句话摘要,新的在前——和用户自己 memory 系统的 `MEMORY.md` 是同一种结构(索引 + 分散的主题文件),不是我发明的新格式。
- 代码里 43 处 `见 docs/DECISIONS.md, "标题"` 全部改成指向具体的新文件路径,用脚本先解析原文件按 `## ` 标题切分、核对每个标题精确匹配后再落盘,人工核对了每一处引用的上下文语义(部分标题在代码里被截断或只写了前缀,需要靠上下文判断具体指向哪个新文件,不能纯字符串匹配)——4 处原来就没有具体标题、泛指全文的引用,按上下文分别指到了最贴切的具体文件,或者指向新的索引 `docs/decisions/README.md`。
- `docs/README.md`、`docs/FLOWS.md` 里指向 `DECISIONS.md` 的地方同步改成指向 `docs/decisions/`。

**没动的地方**:已经写进旧条目正文里的"DECISIONS.md"字样(比如"提交 b9ad69f 复查"那条讨论"注释该不该指回 DECISIONS.md"这个约定本身)原样保留——那是发生当时的真实措辞,不为了这次拆分去重写历史正文,只有代码里的活链接和两份索引文档需要跟着改。

**验证**:拆分脚本对每个 section 的标题做了断言,28 个全部精确匹配才落盘;之后 grep 全仓库确认 `src/` 下零处残留 `docs/DECISIONS.md` 字符串,且 43 处新路径逐一核实文件确实存在。
