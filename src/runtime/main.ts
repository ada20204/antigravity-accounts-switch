import './ui/styles.css';
import { createAccountPopup, destroyAccountPopup } from './ui/accountPopup';
import { injectSettingsEnhancements } from './ui/settingsEnhancer';
import { startAddAccountPromptLoop } from './ui/addAccountPrompt';
import { SemanticLocator } from './adapters/semanticLocator';
import { AccountStore } from './services/accountStore';

console.log('[Antigravity Multi-Account Enhancer] Runtime clean event init...');

let popupInstance: HTMLElement | null = null;
let badgeInstance: HTMLElement | null = null;
let hoverBoundTrigger: HTMLElement | null = null;
let closeTimer: number | null = null;

const HOVER_CLOSE_DELAY_MS = 300;

function cancelScheduledClose(): void {
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

function closePopup(): void {
  cancelScheduledClose();
  if (popupInstance) {
    // Must run even when the node is already out of the document — removing
    // the element does not detach its window-level listener.
    destroyAccountPopup(popupInstance);
    popupInstance.remove();
  }
  popupInstance = null;
}

function scheduleClose(): void {
  cancelScheduledClose();
  closeTimer = window.setTimeout(closePopup, HOVER_CLOSE_DELAY_MS);
}

function openPopup(triggerEl: HTMLElement | null): void {
  cancelScheduledClose();
  if (popupInstance && document.body.contains(popupInstance)) return;

  popupInstance = createAccountPopup();
  const trigger = triggerEl || SemanticLocator.findProfileTrigger();

  if (trigger) {
    const pos = SemanticLocator.getAnchorPosition(trigger);
    popupInstance.style.position = 'fixed';
    popupInstance.style.bottom = `${pos.bottom}px`;
    popupInstance.style.left = `${pos.left}px`;
    popupInstance.style.width = `${pos.width}px`;
    popupInstance.style.zIndex = '999999';
  } else {
    popupInstance.style.position = 'fixed';
    popupInstance.style.bottom = '60px';
    popupInstance.style.left = '16px';
    popupInstance.style.width = '300px';
    popupInstance.style.zIndex = '999999';
  }

  // Hovering the popup itself must also keep it open / re-arm the close timer.
  popupInstance.addEventListener('mouseenter', cancelScheduledClose);
  popupInstance.addEventListener('mouseleave', scheduleClose);

  document.body.appendChild(popupInstance);
}

export function togglePopup(e?: MouseEvent, triggerEl?: HTMLElement) {
  if (e) e.stopPropagation();
  if (popupInstance && document.body.contains(popupInstance)) {
    closePopup();
    return;
  }
  openPopup(triggerEl ?? null);
}

function positionBadge(badge: HTMLElement, trigger: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  badge.style.position = 'fixed';
  badge.style.left = `${rect.right - 10}px`;
  badge.style.top = `${rect.top - 4}px`;
  badge.style.display = rect.width > 0 && rect.height > 0 ? 'flex' : 'none';
}

// Independent badge overlaid on the native profile button's corner — never
// intercepts its click. See docs/decisions/profile-hover-badge-no-intercept.md.
function ensureProfileBadge(): void {
  const trigger = SemanticLocator.findProfileTrigger();
  if (!trigger) return;

  if (trigger !== hoverBoundTrigger) {
    hoverBoundTrigger = trigger;
    trigger.addEventListener('mouseenter', () => openPopup(trigger));
    trigger.addEventListener('mouseleave', scheduleClose);
  }

  if (!badgeInstance || !document.body.contains(badgeInstance)) {
    badgeInstance = document.createElement('button');
    badgeInstance.id = 'ag-profile-badge';
    badgeInstance.className = 'ag-profile-badge';
    badgeInstance.title = 'Switch Antigravity account';
    badgeInstance.addEventListener('mouseenter', () => openPopup(trigger));
    badgeInstance.addEventListener('mouseleave', scheduleClose);
    badgeInstance.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopup(e as unknown as MouseEvent, trigger);
    });
    document.body.appendChild(badgeInstance);
  }
  positionBadge(badgeInstance, trigger);
}

(window as any).AntigravityEnhancerRuntime = {
  createPopup: createAccountPopup,
  togglePopup: togglePopup,
  locateTrigger: () => SemanticLocator.findProfileTrigger()
};

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (!target) return;
  if (popupInstance && popupInstance.contains(target)) return;
  if (badgeInstance && badgeInstance.contains(target)) return;
  if (popupInstance && !popupInstance.contains(target)) {
    closePopup();
  }
}, true);

window.addEventListener('resize', () => {
  const trigger = SemanticLocator.findProfileTrigger();
  if (trigger && badgeInstance) positionBadge(badgeInstance, trigger);
});

// MutationObserver instead of blind polling: both functions just need to
// re-run whenever the native DOM they anchor to might have changed (the
// badge's profile trigger, the Settings card's anchor section) — a DOM
// mutation is exactly the signal for that, and reacts within a frame instead
// of waiting up to a fixed interval. rAF-coalesces a burst of mutation
// records (e.g. streaming chat text updating every few ms) into one check
// per frame rather than running once per record.
let mutationCheckScheduled = false;
function scheduleMutationCheck(): void {
  if (mutationCheckScheduled) return;
  mutationCheckScheduled = true;
  requestAnimationFrame(() => {
    mutationCheckScheduled = false;
    ensureProfileBadge();
    injectSettingsEnhancements();
  });
}
new MutationObserver(scheduleMutationCheck).observe(document.body, { childList: true, subtree: true });

// Fallback poll — safety net for a change the observer's childList/subtree
// config doesn't catch (e.g. an attribute/style-only visibility flip with no
// node added or removed), same reasoning as cdpInjector.ts's own fallback
// poll after its move to event-driven CDP detection. Relaxed interval since
// this is now backup, not the primary detection path.
setInterval(scheduleMutationCheck, 5000);

setTimeout(() => {
  injectSettingsEnhancements();
  ensureProfileBadge();
}, 600);

// Fetch immediately on boot — otherwise a fresh injection (e.g. right after
// the post-switch VS Code window reload) sits on stale/default data for up
// to one full poll interval before anything refreshes it.
AccountStore.logRuntimeBoot();
AccountStore.fetchLiveAccounts();

// A sign-in in progress outlives this page (the sign-out step reloads it), so
// the banner is rebuilt from daemon state on boot rather than held in page
// state. The loop paces itself — see addAccountPrompt.ts.
startAddAccountPromptLoop();

// Read-only background poll so the ACTIVE badge doesn't go stale between
// user actions — see docs/decisions/credential-drift-explained.md.
setInterval(() => {
  AccountStore.fetchLiveAccounts();
}, 20000);
