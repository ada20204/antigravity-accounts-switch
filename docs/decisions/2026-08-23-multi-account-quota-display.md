# 多账号下的配额数字与弹窗显示

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
