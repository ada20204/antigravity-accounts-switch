import { SubscriptionAccount } from '../services/accountStore';
import { SemanticLocator } from './semanticLocator';

export class ProfileSyncAdapter {
  /**
   * 精确同步：只修改左下角真正的 Profile 触发器，严禁污染左侧导航栏
   */
  public static syncBottomTrigger(activeAccount: SubscriptionAccount): void {
    try {
      // Reuses SemanticLocator (not a standalone heuristic) so it returns null
      // in the Settings iframe, which has no real trigger — see
      // docs/DECISIONS.md, "Profile 触发器同步".
      const bottomProfile = SemanticLocator.findProfileTrigger();

      if (bottomProfile) {
        // Leaf nodes only — textContent containing '@' on a non-leaf ancestor
        // would be the avatar/icon wrapper; overwriting it destroys the subtree.
        const textNodes = Array.from(bottomProfile.querySelectorAll<HTMLElement>('div, span, p'));
        const isLeafText = (t: HTMLElement) => t.childNodes.length === 1 && t.childNodes[0].nodeType === Node.TEXT_NODE;
        const emailNode = textNodes.find(t => isLeafText(t) && t.textContent?.includes('@'));
        if (emailNode) {
          emailNode.textContent = activeAccount.id;
        }

        const nameNode = textNodes.find(t => t !== emailNode && t.childNodes.length === 1 && t.childNodes[0].nodeType === Node.TEXT_NODE);
        if (nameNode) {
          nameNode.textContent = activeAccount.name;
        }

        // Does not touch the <img> avatar — see docs/DECISIONS.md, "头像".
        console.log('[ProfileSyncAdapter] Safely updated bottom trigger strictly in container');
      }
    } catch (e) {
      console.warn('[ProfileSyncAdapter] Error in sync:', e);
    }
  }
}
