import { AccountStore } from '../services/accountStore';
import { SemanticLocator } from '../adapters/semanticLocator';
import { showConfirm, showAlert } from './confirmDialog';

// Switching Settings tabs re-renders the page and takes our card with it, so
// the next tick builds a fresh one. The listener bound to the previous card
// would otherwise survive and keep re-rendering a detached node on every
// ag-account-changed — one more leaked listener per tab switch.
let cardListenerAbort: AbortController | null = null;

export function injectSettingsEnhancements() {
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
      cardListenerAbort?.abort();
      cardListenerAbort = new AbortController();
      const cardRef = card;
      window.addEventListener(
        'ag-account-changed',
        () => renderSettingsCard(cardRef),
        { signal: cardListenerAbort.signal }
      );
    } else if (card.parentElement !== container || container.lastElementChild !== card) {
      // Re-append only when it isn't already in place — appendChild always
      // mutates the DOM, and doing that every tick would fight the page.
      container.appendChild(card);
    }
    renderSettingsCard(card);
  }

  // No sidebar nav entry — see docs/DECISIONS.md, "Settings 卡片的几个小决策".
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

// injectSettingsEnhancements() runs every 1.5s to keep the card anchored, and
// used to re-render unconditionally — rewriting innerHTML four times a second-ish
// under the user's cursor. A click landing between mousedown and mouseup on a
// Switch/Remove link was simply lost, because the element it started on had been
// replaced. Re-render only when the rendered data actually differs; explicit
// call sites that change non-data state (button labels) pass force.
const RENDER_SIGNATURE_KEY = '__agRenderSignature';

function renderSettingsCard(card: HTMLElement, force = false) {
  const accounts = AccountStore.getAccounts();
  const { averagePercent, count } = AccountStore.getTotalQuota();

  const signature = JSON.stringify([
    averagePercent,
    count,
    accounts.map(a => [a.id, a.name, a.quotaPercent, a.isActive, a.issue ?? '', a.geminiWeekly ?? '', a.gemini5h ?? '']),
  ]);
  if (!force && (card as any)[RENDER_SIGNATURE_KEY] === signature) return;
  (card as any)[RENDER_SIGNATURE_KEY] = signature;

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
        <div class="ag-enhancer-empty">
          No accounts connected yet. Open the account menu in the bottom-left
          corner and choose “Add new account” to connect one.
        </div>
      ` : ''}
      ${accounts.map(acc => {
        const ringColor = acc.issue ? '#ef4444' : acc.quotaPercent < 20 ? '#f59e0b' : '#22c55e';
        return `
        <div class="ag-sub-box ${acc.isActive ? 'active' : ''}" data-account-id="${acc.id}">
          <div class="ag-sub-box-header">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
              <span class="ag-dot" style="background:${acc.color};"></span>
              <span class="ag-sub-box-name">${acc.name}</span>
            </div>
            ${acc.isActive ? '<span style="font-size:10px;color:#4ade80;font-weight:600;white-space:nowrap;">ACTIVE</span>' : ''}
          </div>
          <div class="ag-sub-box-main">
            <span class="ag-sub-box-val" style="${acc.issue ? 'color:#ef4444;' : ''}">
              ${acc.issue ? acc.issue : `${acc.quotaPercent}% Remaining`}
            </span>
            ${renderQuotaRing(acc.issue ? 0 : acc.quotaPercent, ringColor)}
          </div>
          <div class="ag-sub-box-mask" style="display:flex;justify-content:space-between;align-items:center;">
            <span>Gemini weekly ${acc.geminiWeekly ?? 100}% · 5-hour ${acc.gemini5h ?? 100}%</span>
            <span style="display:flex;gap:10px;">
              <span style="font-size:11px;color:#60a5fa;cursor:pointer;" class="ag-switch-btn">${acc.isActive ? 'In Use' : 'Switch'}</span>
              <span style="font-size:11px;color:#9ca3af;cursor:pointer;" class="ag-remove-btn" data-account-id="${acc.id}">Remove</span>
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
        // Forced: the row's inline opacity must be cleared even when the
        // switch changed nothing (cancelled, or already the active account).
        renderSettingsCard(card, true);
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
      // revokes the Google session (see docs/DECISIONS.md, "移除账号").
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
