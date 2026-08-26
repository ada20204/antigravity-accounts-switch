import { leafEmailText, isLeafTextNode } from './domUtils';

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
    const emailNode = allElements.find(el => leafEmailText(el) !== null);

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
   * 不依赖任何显示文本或 class 名——原因见 docs/decisions/2026-08-23-settings-card-anchor-data-testid.md。
   * 我们自己的环用的是 class="ag-quota-ring"、不带 data-testid，所以不会自我干扰。
   */
  public static findQuotaSectionContainer(): HTMLElement | null {
    const rings = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="quota-progress-circle"]')
    );
    if (rings.length === 0) return null;

    // Starts from the PARENT of the first ring, not the ring itself.
    // Node.contains() is true for a node containing itself, so with exactly
    // one ring on the page, starting at rings[0] made the loop below exit
    // immediately and return the ring element as its own "container" —
    // settingsEnhancer.ts then appendChild'd our card straight into the
    // native ring widget, visibly breaking it, until a second ring appeared
    // and the container got recomputed correctly. Starting one level up
    // guarantees the returned element is never one of the rings themselves,
    // for both the one-ring and multi-ring case.
    let ancestor: HTMLElement | null = rings[0].parentElement;
    while (ancestor && !rings.every(ring => ancestor!.contains(ring))) {
      ancestor = ancestor.parentElement;
    }
    return ancestor;
  }

  /**
   * 原生 Account 面板当前显示的邮箱——判断"现在到底登录着谁"唯一可靠的来源,
   * 不能用 agent-hub-accounts `connect` 的猜测机制。详见
   * docs/decisions/2026-08-23-account-corruption-guessing-broken.md。
   *
   * 面板平时 `display:none` 但文本节点始终在 DOM 里,不需要先点开头像;只在
   * Settings 页(`settings-standalone`)存在。用 "Sign Out" 上下文匹配,天然
   * 排除我们自己弹窗里 "Switch"/"In Use" 语境的邮箱行。
   */
  public static findAccountPanelEmail(): string | null {
    const leaves = Array.from(document.querySelectorAll<HTMLElement>('div, span, p'));
    const emailLeaf = leaves.find(el => {
      if (leafEmailText(el) === null) return false;
      const context = el.parentElement?.parentElement?.innerText ?? '';
      return /Sign Out/i.test(context);
    });
    return emailLeaf ? leafEmailText(emailLeaf) : null;
  }

  /**
   * 原生 Settings → General → Account 卡片里的 "Your Plan: <label>" 行——这是
   * 判断账号等级(Free/Pro/Ultra)唯一的真实来源。`route --json` 的 schema 里
   * 没有 plan/tier/subscription 字段(现场核实过),而这行文字只在 Settings
   * 的 General 子页存在,且只反映"当前激活账号"的等级——不是每个已保存账号
   * 都能同时读到,调用方需要按账号 id 自行持久化。见
   * docs/decisions/2026-08-23-account-plan-tier.md。
   */
  public static findAccountPlanLabel(): string | null {
    const PREFIX = 'Your Plan:';
    const leaves = Array.from(document.querySelectorAll<HTMLElement>('div, span, p'));
    const node = leaves.find(el => isLeafTextNode(el) && (el.textContent?.trim().startsWith(PREFIX) ?? false));
    if (!node) return null;
    const label = node.textContent!.trim().slice(PREFIX.length).trim();
    return label || null;
  }

  private static isElementVisible(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== 'none';
  }
}
