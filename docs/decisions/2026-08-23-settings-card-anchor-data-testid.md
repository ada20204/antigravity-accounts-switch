# Settings 卡片锚点:改用 data-testid(2026-08-23 定稿)

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
