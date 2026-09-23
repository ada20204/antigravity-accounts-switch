import { SubscriptionAccount } from '../services/accountStore';
import { SemanticLocator } from './semanticLocator';
import { leafEmailText, isLeafTextNode } from './domUtils';

export class ProfileSyncAdapter {
  /**
   * 精确同步：只修改左下角真正的 Profile 触发器，严禁污染左侧导航栏
   */
  public static syncBottomTrigger(activeAccount: SubscriptionAccount): void {
    try {
      // Reuses SemanticLocator (not a standalone heuristic) so it returns null
      // in the Settings iframe, which has no real trigger — see
      // docs/decisions/profile-trigger-sync-not-coordinate.md.
      const bottomProfile = SemanticLocator.findProfileTrigger();

      if (bottomProfile) {
        // Leaf nodes only — textContent containing '@' on a non-leaf ancestor
        // would be the avatar/icon wrapper; overwriting it destroys the subtree.
        // Uses the same strict, anchored email match as the other two copies
        // of this check (semanticLocator.ts) — this one used to be a bare
        // `.includes('@')`, which meant any leaf node merely containing '@'
        // (a stray icon title, not a real email) got silently overwritten.
        // See docs/decisions/2026-08-23-account-corruption-guessing-broken.md.
        const textNodes = Array.from(bottomProfile.querySelectorAll<HTMLElement>('div, span, p'));
        const emailNode = textNodes.find(t => leafEmailText(t) !== null);
        if (emailNode) {
          emailNode.textContent = activeAccount.id;
        }

        const nameNode = textNodes.find(t => t !== emailNode && isLeafTextNode(t));
        if (nameNode) {
          nameNode.textContent = activeAccount.name;
        }
      }
    } catch (e) {
      console.warn('[ProfileSyncAdapter] Error in sync:', e);
    }
  }
}
