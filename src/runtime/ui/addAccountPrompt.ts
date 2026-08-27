// The banner shown while a browser sign-in is in progress.
//
// It cannot be a normal modal opened by the click that started the flow:
// beginAddAccount() signs out and restarts the hub, which reloads this whole
// webview and destroys anything the page was holding. So the daemon owns the
// "a sign-in is underway" flag, and every freshly injected runtime asks for it
// on boot and rebuilds this banner if needed. That also means the banner
// reappears correctly if the user reloads the window mid-sign-in.
//
// There is deliberately no "Done" button. Pressing one would only have told us
// something the user already told us by signing in — see reportIdentityTick()
// below for how completion is actually detected. Cancel stays, because "I
// changed my mind, give me my old account back" is a real intent we cannot
// infer.

import { AccountStore } from '../services/accountStore';
import { SemanticLocator } from '../adapters/semanticLocator';
import { showAlert } from './confirmDialog';
import { showProgress } from './progressOverlay';

const BANNER_ID = 'ag-add-account-banner';
const RESCUE_ID = 'ag-signed-out-banner';

// Two speeds, because the cost and the value are both concentrated in the rare
// window when a sign-in is actually running. Idle polling used to run at 5s in
// both iframes and became the single noisiest caller in the system (235 requests
// against 81 for the actual account data) for a flow used maybe twice a day.
const IDLE_POLL_MS = 30000;
const ACTIVE_POLL_MS = 2500;

// The runtime is injected into both content iframes, but only the main panel
// is where Antigravity renders its sign-in screen — a banner in the Settings
// tab is telling the user to act on something that isn't there. Worse, two
// live banners means Cancel is clickable in both for the seconds it takes the
// other to notice, and the loser reports "no sign-in in progress".
function ownsBanner(): boolean {
  return window.location.pathname !== '/settings-standalone';
}

export async function syncAddAccountPrompt(): Promise<number> {
  if (!ownsBanner()) return IDLE_POLL_MS;

  const status = await AccountStore.getAddAccountStatus();
  const existing = document.getElementById(BANNER_ID);

  if (!status.pending) {
    existing?.remove();
    // The daemon captured a sign-in since the last check: confirm which account
    // landed, and pull the list so it shows up without waiting for its own poll.
    if (status.justAdded) {
      await AccountStore.fetchLiveAccounts();
      await showAlert(`Added ${status.justAdded}. It is now your active account.`);
    }
    syncRescueBanner(status.signedOut === true);
    return status.signedOut ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  }

  // A sign-in is underway, so the sign-out is expected and its own banner is
  // the right thing to show.
  document.getElementById(RESCUE_ID)?.remove();

  if (existing) return ACTIVE_POLL_MS;

  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.className = 'ag-add-banner';
  banner.innerHTML = `
    <div class="ag-add-banner-text">
      <div class="ag-add-banner-title">Adding an account</div>
      <div class="ag-add-banner-detail">
        Sign in with the new Google account — it will be added automatically.
        Cancel restores ${status.backupAccountId ?? 'your previous account'}.
      </div>
    </div>
    <div class="ag-add-banner-actions">
      <button class="ag-confirm-btn" id="ag-add-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(banner);

  banner.querySelector('#ag-add-cancel')?.addEventListener('click', async () => {
    const progress = showProgress('Restoring your previous account…');
    const result = await AccountStore.cancelAddAccount();
    if (!result.ok) {
      progress.close();
      await showAlert(`Could not restore the previous account: ${result.error}`);
      return;
    }
    banner.remove();
  });

  return ACTIVE_POLL_MS;
}

// Shown when Antigravity is signed out and no add-account flow explains it —
// after a cancelled sign-in, a daemon restart that lost the flow, or a sign-out
// done outside this tool.
//
// This state is a dead end without it: with nobody signed in there is no
// profile avatar in the corner, so findProfileTrigger() finds nothing, the
// badge never renders, and the popup that holds the account list cannot be
// opened. The user is left looking at a sign-in page with no indication that
// several saved accounts are one click away.
//
// It opens that same popup rather than duplicating the account list, so
// switching keeps going through exactly one code path.
function syncRescueBanner(signedOut: boolean): void {
  const existing = document.getElementById(RESCUE_ID) as HTMLElement | null;
  if (!signedOut) {
    existing?.remove();
    return;
  }

  const count = AccountStore.getAccounts().length;
  // Re-renders on a count change instead of a one-time `if (existing) return`
  // bail — the account list is frequently still empty on the very first tick
  // after a fresh injection (fetchLiveAccounts() hasn't resolved yet), so the
  // banner used to permanently freeze in its "no known accounts, no button"
  // form even after the real list loaded moments later. dataset.count dedups
  // so an unchanged count (the common case) skips the innerHTML rewrite.
  if (existing && existing.dataset.count === String(count)) return;

  const banner = existing ?? document.createElement('div');
  banner.id = RESCUE_ID;
  banner.className = 'ag-add-banner';
  banner.dataset.count = String(count);
  banner.innerHTML = `
    <div class="ag-add-banner-text">
      <div class="ag-add-banner-title">Signed out of Antigravity</div>
      <div class="ag-add-banner-detail">
        ${count > 0
          ? `${count} saved account${count === 1 ? '' : 's'} available — switch back to one of them, or sign in normally to add a new one.`
          : 'Sign in with Google to get started. The account will be saved automatically.'}
      </div>
    </div>
    <div class="ag-add-banner-actions">
      ${count > 0 ? '<button class="ag-confirm-btn ag-confirm-ok" id="ag-rescue-switch">Switch account</button>' : ''}
    </div>
  `;
  if (!existing) document.body.appendChild(banner);

  banner.querySelector('#ag-rescue-switch')?.addEventListener('click', (e) => {
    e.stopPropagation();
    (window as any).AntigravitySwitchRuntime?.togglePopup();
  });
}

// Detects a completed sign-in by reading the real email straight out of
// Antigravity's own Account panel DOM and reporting it — this is the fix for a
// real incident where the previous approach (daemon-side polling that guessed
// the id from agy's log files) filed a brand new sign-in under a stale,
// unrelated account name and destroyed it. See
// docs/decisions/2026-08-23-never-bare-connect-call.md. The panel only exists on the Settings page.
function ownsIdentityReport(): boolean {
  return window.location.pathname === '/settings-standalone';
}

async function reportIdentityTick(): Promise<number> {
  if (!ownsIdentityReport()) return IDLE_POLL_MS;

  const status = await AccountStore.getAddAccountStatus();
  if (!status.pending) return IDLE_POLL_MS;

  const email = SemanticLocator.findAccountPanelEmail();
  if (email) await AccountStore.reportAddedIdentity(email);
  // Whether or not an email was found/accepted this tick, a sign-in is still
  // in progress — the caller (main iframe's syncAddAccountPrompt) picks up the
  // resulting pending:false and justAdded on its own next poll.
  return ACTIVE_POLL_MS;
}

// Self-scheduling rather than setInterval, so the interval can follow whether a
// sign-in is actually in progress. Runs both halves every tick — exactly one
// applies per iframe (see ownsBanner()/ownsIdentityReport()), and the other
// returns immediately without any network call.
export function startAddAccountPromptLoop(): void {
  const tick = async () => {
    let next = IDLE_POLL_MS;
    try {
      const [bannerNext, identityNext] = await Promise.all([syncAddAccountPrompt(), reportIdentityTick()]);
      next = Math.min(bannerNext, identityNext);
    } catch {
      // daemon unreachable — back off to idle and try again
    }
    setTimeout(tick, next);
  };
  void tick();
}
