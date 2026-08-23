export interface AnchorPosition {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
}

export class SemanticLocator {
  /**
   * 强逻辑 1: 精准查找左下角/导航栏的用户个人资料 Interactive 容器
   * 策略: 寻找包含用户邮箱或名字的文本节点，向上回溯至最近的交互容器
   */
  public static findProfileTrigger(): HTMLElement | null {
    // 1. 优先通过 data-testid 或标准 ID 查找
    const direct = document.querySelector<HTMLElement>(
      '[data-testid="user-profile"], [data-testid="account-button"], [data-testid="user-avatar"], #user-profile-button'
    );
    if (direct && this.isElementVisible(direct)) return direct;

    // 2. 强语义特征匹配: 查找包含邮箱格式 (@) 且属于交互容器的元素
    const allElements = Array.from(document.querySelectorAll<HTMLElement>('div, span, p, button, a'));
    
    // 匹配包含邮箱特征的文本节点
    const emailNode = allElements.find(el => {
      const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === Node.TEXT_NODE ? el.textContent?.trim() : '';
      return text && /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(text);
    });

    if (emailNode) {
      // 向上回溯到可点击的容器（button、带 role="button" 或最外层 flex 行）
      const interactiveContainer = emailNode.closest<HTMLElement>(
        'button, [role="button"], [tabindex], div.cursor-pointer, div[class*="profile"], div[class*="user"], div[class*="account"]'
      );
      if (interactiveContainer) return interactiveContainer;
      
      // 如果没有显式 role，取包含头像和邮箱的直接外层父容器
      if (emailNode.parentElement && emailNode.parentElement.parentElement) {
        return emailNode.parentElement.parentElement;
      }
      return emailNode.parentElement;
    }

    // 3. 兜底: 查找左下角包含 img 头像的交互容器
    const avatarImgs = Array.from(document.querySelectorAll<HTMLElement>('img')).filter(img => {
      const rect = img.getBoundingClientRect();
      return rect.width > 16 && rect.width < 48 && rect.height > 16 && rect.height < 48 && rect.left < 200;
    });

    if (avatarImgs.length > 0) {
      const bestImg = avatarImgs[avatarImgs.length - 1]; // 最底部的头像
      return bestImg.closest<HTMLElement>('button, [role="button"], div') || bestImg.parentElement;
    }

    return null;
  }

  /**
   * 强逻辑 2: 动态计算相对锚点的绝对贴靠位置
   */
  public static getAnchorPosition(trigger: HTMLElement): AnchorPosition {
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    
    // 默认弹窗出现在触发器上方
    const bottom = window.innerHeight - rect.top + margin;
    let left = rect.left;
    
    // 边界安全防护: 防止弹窗超出屏幕右边界
    const popupWidth = 300;
    if (left + popupWidth > window.innerWidth) {
      left = window.innerWidth - popupWidth - 12;
    }
    if (left < 12) left = 12;

    return {
      bottom,
      left,
      width: popupWidth
    };
  }

  /**
   * 定位 Models 页面承载全部原生配额区块的容器（我们的卡片作为它的最后一个子元素）。
   *
   * 用官方测试钩子 [data-testid="quota-progress-circle"] 取所有配额环的最近公共祖先，
   * 不依赖任何显示文本或 class 名——原因见 docs/DECISIONS.md, "Settings 页卡片锚点定位"。
   * 我们自己的环用的是 class="ag-quota-ring"、不带 data-testid，所以不会自我干扰。
   */
  public static findQuotaSectionContainer(): HTMLElement | null {
    const rings = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="quota-progress-circle"]')
    );
    if (rings.length === 0) return null;

    let ancestor: HTMLElement | null = rings[0];
    while (ancestor && !rings.every(ring => ancestor!.contains(ring))) {
      ancestor = ancestor.parentElement;
    }
    return ancestor;
  }

  /**
   * 原生 Account 面板("Email <address> Sign Out")当前显示的邮箱——这是判断
   * "现在到底登录着谁"唯一可靠的来源。
   *
   * 为什么不能信任 agent-hub-accounts 的 `connect`(不带参数时靠猜):它扫的是
   * `~/.gemini/antigravity-cli/log/`,而我们的 hub 是 `--app_data_dir=antigravity`,
   * 写的是完全不同的 `~/.gemini/antigravity/log/`——两者不通,而且后者压根不产生
   * `email=` 格式的日志行。所以那个猜测机制在我们的环境里不是"会滞后",是
   * **结构性地永远猜不对**,冻结在很久以前某次跑 `agy` CLI 时最后一次留下的邮箱。
   * 已经真实损坏过一个账号(把新登录的凭证存进了一个不相干的旧邮箱名下)。
   * 详见 docs/DECISIONS.md。
   *
   * Account 面板平时 `display:none`,但邮箱文本节点始终在 DOM 里,不需要先点开
   * 头像触发显示。只在 Settings 页(`settings-standalone`)存在。
   *
   * 排除我们自己弹窗里的邮箱行:那些出现在
   * `#ag-enhancer-multi-account-popup`/`#ag-settings-multi-subscription-card`
   * 内部,上下文是 "Switch"/"In Use",不是 "Sign Out"——用后者精确匹配即可天然
   * 排除,不用去猜我们自己的 DOM id。
   */
  public static findAccountPanelEmail(): string | null {
    const leaves = Array.from(document.querySelectorAll<HTMLElement>('div, span, p'));
    const emailLeaf = leaves.find(el => {
      if (el.childNodes.length !== 1 || el.childNodes[0].nodeType !== Node.TEXT_NODE) return false;
      const text = el.textContent?.trim() ?? '';
      if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(text)) return false;
      const context = el.parentElement?.parentElement?.innerText ?? '';
      return /Sign Out/i.test(context);
    });
    return emailLeaf ? emailLeaf.textContent!.trim() : null;
  }

  private static isElementVisible(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== 'none';
  }
}
