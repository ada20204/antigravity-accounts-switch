import { AccountStore } from '../services/accountStore';
import { SemanticLocator } from '../adapters/semanticLocator';
import { showConfirm, showAlert } from './confirmDialog';
import { bindUntilRemoved, unbind, shouldSkipRender, renderOrDefer } from './renderGuard';
import { escapeHtml } from '../adapters/domUtils';

// bindUntilRemoved dedups by element reference — it only replaces a binding
// made on the SAME element. A Settings tab switch destroys our card and the
// code below builds a brand-new one, which is a different WeakMap key, so
// nothing would abort the old binding without this. Tracked here instead of
// relying on element identity, closing the leak bindUntilRemoved's per-
// element dedup can't close on its own. See docs/decisions/2026-08-23-review-b9ad69f-followup-10-findings.md.
let lastBoundCard: HTMLElement | null = null;

export function injectSettingsEnhancements() {
  // Opportunistic: only present on the Settings → General sub-page, and only
  // reflects whichever account is active right now. Cheap to check every
  // tick — findAccountPlanLabel() is a single DOM scan — and reportPlan()
  // dedups internally against what it last actually sent, so an account the
  // user never opens this sub-page for just stays 'Unknown' until they do,
  // and calling this unconditionally every tick doesn't spam the daemon. See
  // docs/decisions/2026-08-23-account-plan-tier.md.
  const planLabel = SemanticLocator.findAccountPlanLabel();
  if (planLabel) {
    const active = AccountStore.getAccounts().find(a => a.isActive);
    if (active) AccountStore.reportPlan(active.id, planLabel);
  }

  // Lives as the last child of the native quota container, so it sits below
  // every native quota section and inherits their spacing. Deliberately has NO
  // fallback location: an earlier version fell back to "just under the page
  // title" whenever the real anchor hadn't rendered yet, then moved the card
  // down once it had — which is what made the card visibly jump on load.
  // Doing nothing until the anchor exists is what stops the jumping.
  const container = SemanticLocator.findQuotaSectionContainer();
  if (container) {
    let card = document.getElementById('ag-settings-multi-subscription-card');
    if (!card) {
      card = document.createElement('div');
      card.id = 'ag-settings-multi-subscription-card';
      card.className = 'ag-settings-custom-card';
      container.appendChild(card);
      // Attached once here, not inside renderSettingsCard() — that runs on
      // every 1.5s tick and would pile up a new listener each time otherwise.
      // Switching Settings tabs re-renders the page and takes our card with
      // it, so the NEXT tick builds a brand-new element here — a different
      // bindUntilRemoved key, which is exactly why lastBoundCard exists: it
      // explicitly retires the previous element's binding first.
      if (lastBoundCard) unbind(lastBoundCard);
      const cardRef = card;
      bindUntilRemoved(cardRef, 'ag-account-changed', () => renderOrDefer(cardRef, () => renderSettingsCard(cardRef)));
      lastBoundCard = cardRef;
    } else if (card.parentElement !== container || container.lastElementChild !== card) {
      // Re-append only when it isn't already in place — appendChild always
      // mutates the DOM, and doing that every tick would fight the page.
      container.appendChild(card);
    }
    // This whole function runs every 1.5s (anchoring self-correction) — the
    // render itself must go through renderOrDefer so a tick that lands mid
    // mousedown-to-click on a Switch/Remove row doesn't destroy the row the
    // browser is about to dispatch that click on.
    renderOrDefer(card!, () => renderSettingsCard(card!));
  }

  // No sidebar nav entry — see docs/decisions/settings-card-minor-decisions.md.
  document.getElementById('ag-settings-nav-item')?.remove();
}

// Matches the official [data-testid="quota-progress-circle"] ring: viewBox 0 0 32 32,
// r=13 (circumference ~81.68), track at stroke-opacity 0.4 under a colored value arc.
function renderQuotaRing(percent: number, color: string): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const circumference = 2 * Math.PI * 13;
  const offset = circumference * (1 - clamped / 100);
  return `
    <svg class="ag-quota-ring" viewBox="0 0 32 32" aria-hidden="true">
      <circle class="ag-quota-ring-track" cx="16" cy="16" r="13"></circle>
      <circle class="ag-quota-ring-value" cx="16" cy="16" r="13"
        style="stroke:${color};stroke-dasharray:${circumference};stroke-dashoffset:${offset};"></circle>
    </svg>
  `;
}

// Re-renders only on a signature change (renderGuard's shouldSkipRender),
// plus renderOrDefer at both call sites for real data landing mid-gesture —
// see docs/decisions/2026-08-23-listener-leak-unconditional-rerender.md.
// `force` covers the one remaining case: resetting a UI-only artifact (the
// refresh button's label) the signature check can't see needs resetting.
function renderSettingsCard(card: HTMLElement, force = false) {
  const accounts = AccountStore.getAccounts();
  const { averagePercent, count } = AccountStore.getTotalQuota();

  // Only checked when the list is empty — one DOM scan, same cost as
  // findAccountPlanLabel() above. Lets a fresh install (or one where every
  // saved account got removed) adopt whatever Antigravity is already signed
  // into directly, instead of the only other path being a full sign-out →
  // sign-in round trip. See docs/decisions/2026-08-27-adopt-current-login.md.
  const currentLoginEmail = accounts.length === 0 ? SemanticLocator.findAccountPanelEmail() : null;

  const signature = JSON.stringify([
    averagePercent,
    count,
    currentLoginEmail,
    accounts.map(a => [a.id, a.name, a.quotaPercent, a.isActive, a.issue ?? '', a.geminiWeekly ?? '', a.gemini5h ?? '']),
  ]);
  if (shouldSkipRender(card, signature, force)) return;

  card.innerHTML = `
    <div class="ag-card-header">
      <div class="ag-card-title-group">
        <span class="ag-card-title">Connected Subscriptions & Multi-Account Quota</span>
        <span class="ag-card-badge">${count === 0 ? 'No accounts connected' : `${averagePercent}% avg across ${count} account${count === 1 ? '' : 's'}`}</span>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="ag-card-add-btn" id="ag-settings-refresh-all" title="Switches through every connected account to check its quota — not the same as the official per-account refresh">Check All Accounts</button>
      </div>
    </div>
    
    <div class="ag-card-grid">
      ${accounts.length === 0 ? `
        <div class="ag-switch-empty">
          No accounts connected yet. Open the account menu in the bottom-left
          corner and choose “Add new account” to connect one.
          ${currentLoginEmail ? `
            <div style="margin-top:10px;">
              <button class="ag-card-add-btn" id="ag-adopt-current-login">Use current login (${escapeHtml(currentLoginEmail)})</button>
            </div>
          ` : ''}
        </div>
      ` : ''}
      ${accounts.map(acc => {
        const ringColor = acc.issue ? '#ef4444' : acc.quotaPercent < 20 ? '#f59e0b' : '#22c55e';
        return `
        <div class="ag-sub-box ${acc.isActive ? 'active' : ''}" data-account-id="${escapeHtml(acc.id)}">
          <div class="ag-sub-box-header">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
              <span class="ag-dot" style="background:${acc.color};"></span>
              <span class="ag-sub-box-name">${escapeHtml(acc.name)}</span>
            </div>
            ${acc.isActive ? '<span style="font-size:10px;color:#4ade80;font-weight:600;white-space:nowrap;">ACTIVE</span>' : ''}
          </div>
          <div class="ag-sub-box-main">
            <span class="ag-sub-box-val" style="${acc.issue ? 'color:#ef4444;' : ''}">
              ${acc.issue ? escapeHtml(acc.issue) : `${acc.quotaPercent}% Remaining`}
            </span>
            ${renderQuotaRing(acc.issue ? 0 : acc.quotaPercent, ringColor)}
          </div>
          <div class="ag-sub-box-mask" style="display:flex;justify-content:space-between;align-items:center;">
            <span>Gemini weekly ${acc.geminiWeekly ?? 100}% · 5-hour ${acc.gemini5h ?? 100}%</span>
            <span style="display:flex;gap:10px;">
              <span style="font-size:11px;color:#60a5fa;cursor:pointer;" class="ag-switch-btn">${acc.isActive ? 'In Use' : 'Switch'}</span>
              <span style="font-size:11px;color:#9ca3af;cursor:pointer;" class="ag-remove-btn" data-account-id="${escapeHtml(acc.id)}">Remove</span>
            </span>
          </div>
        </div>
      `;
      }).join('')}
    </div>
  `;

  card.querySelectorAll('.ag-sub-box').forEach(box => {
    box.addEventListener('click', async (e) => {
      const el = e.currentTarget as HTMLElement;
      const id = el.dataset.accountId;
      if (id) {
        el.style.opacity = '0.5';
        await AccountStore.confirmAndSwitch(id);
        // Direct single-element reset, not a full-card force-rebuild — same
        // fix accountPopup.ts already used for the identical scenario. Must
        // run even when the switch changed nothing (cancelled, or already the
        // active account), which is why it's unconditional rather than folded
        // into the data-driven render below.
        el.style.opacity = '';
        // Still re-render normally afterward in case the switch itself did
        // change the data (a real switch changes which account is ACTIVE).
        renderSettingsCard(card);
      }
    });
  });

  card.querySelectorAll('.ag-remove-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = (e.currentTarget as HTMLElement).dataset.accountId;
      if (!id) return;

      // Deliberately not described as "forget locally": remove deletes the
      // saved credential copy, so getting this account back means a full
      // interactive sign-in again, not a one-click reconnect. It still never
      // revokes the Google session (see docs/decisions/remove-account-semantics.md).
      const proceed = await showConfirm(
        `Remove ${id}?\n\nThis deletes the saved credential for this account, so you can no longer switch to it — adding it back requires signing in with Google again. It does NOT sign the account out of Google or affect it anywhere else.`
      );
      if (!proceed) return;

      const result = await AccountStore.removeAccount(id);
      if (!result.ok) {
        await showAlert(`Could not remove ${id}: ${result.error}`);
      }
      renderSettingsCard(card);
    });
  });

  card.querySelector('#ag-adopt-current-login')?.addEventListener('click', async () => {
    if (!currentLoginEmail) return;
    const proceed = await showConfirm(
      `Save ${currentLoginEmail} as a connected account?\n\n` +
      'This does not sign you out or change anything in Antigravity — it just ' +
      'remembers this login so you can switch back to it later.'
    );
    if (!proceed) return;
    const btn = card.querySelector('#ag-adopt-current-login') as HTMLElement;
    if (btn) btn.textContent = 'Saving…';
    const result = await AccountStore.triggerConnect(currentLoginEmail);
    if (!result.ok) {
      await showAlert(`Could not save ${currentLoginEmail}: ${result.error}`);
    }
    renderSettingsCard(card, true);
  });

  card.querySelector('#ag-settings-refresh-all')?.addEventListener('click', async () => {
    const proceed = await showConfirm(
      "Checking all accounts' quota will briefly switch your active Antigravity login through each connected account in turn (interrupting any in-progress response), then switch back. This is NOT the same as the lightweight refresh button on the official page. Continue?"
    );
    if (!proceed) return;
    const btn = card.querySelector('#ag-settings-refresh-all') as HTMLElement;
    if (btn) btn.textContent = 'Checking accounts...';
    await AccountStore.refreshAllQuotas();
    // Forced: restores the button label even if no quota figure moved.
    renderSettingsCard(card, true);
  });
}
