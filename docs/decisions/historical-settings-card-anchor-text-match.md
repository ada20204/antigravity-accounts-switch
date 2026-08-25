# (历史)Settings 页 "Claude and GPT models" 卡片锚点定位

**日期**:2026-08-22 · 涉及 `semanticLocator.ts::findLastModelsSectionCard`(已被上面那版取代并删除)

**第一版**:从标题往上爬,找第一个有 `border` 的祖先元素,当成区块边界。实测从标题到最外层爬 8 层祖先,`borderWidth` 全部是 `0px`——这个页面的分区边框根本不是靠 border 画的。于是永远退化成兜底的 `label.parentElement`(标题所在的那一小行),导致我们的卡片被插进标题和它下面的 Weekly/Five Hour 数据行之间,卡在区块中间,而且因为兜底位置不稳定,还会出现"先出现在上方、又跳到下方"的反复横跳。

**现在的做法**:结构性定位——找到标题 `"Claude and GPT models"` 和区块内最后一行 `"Five Hour Limit Remaining"`(页面上出现两次,Gemini 一次、Claude/GPT 一次,取最后一个)两个叶子文本节点各自的位置,从标题往上爬,找到第一个"同时包含这两个节点"的祖先——这个最近公共祖先就是整个区块的真实边界。不依赖 border、也不依赖会跟官方版本走的 Tailwind class 名。
