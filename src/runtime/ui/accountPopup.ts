import { AccountStore } from '../services/accountStore';
import { showConfirm, showAlert } from './confirmDialog';
import { showProgress } from './progressOverlay';
import { bindUntilRemoved, unbind, shouldSkipRender, renderOrDefer, withActionPending } from './renderGuard';
import { escapeHtml, simplifyTier } from '../adapters/domUtils';

// Deterministic initial, not a stock photo — see docs/decisions/profile-trigger-sync-not-coordinate.md, "头像".
function initial(name: string): string {
  return escapeHtml((name.trim()[0] || '?').toUpperCase());
}

export function createAccountPopup(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'ag-switch-popup';
  container.id = 'ag-switch-multi-account-popup';

  renderPopupContent(container);

  // A background poll firing while the popup happens to be open — not a click
  // gesture, so no mid-click risk here, but still goes through renderOrDefer
  // for consistency with settingsEnhancer.ts's identical listener.
  const signal = bindUntilRemoved(container, 'ag-account-changed', () => renderOrDefer(container, () => renderPopupContent(container)));

  // Fetch live accounts from daemon asynchronously
  AccountStore.fetchLiveAccounts().then(() => {
    if (!signal.aborted) renderPopupContent(container);
  });

  return container;
}

export function destroyAccountPopup(container: HTMLElement): void {
  unbind(container);
}

function renderPopupContent(container: HTMLElement) {
  const accounts = AccountStore.getAccounts();
  const { bestPercent, count } = AccountStore.getTotalQuota();
  const activeAccount = accounts.find(a => a.isActive) || accounts[0];
  // The native Account panel exists only in the settings iframe. The main
  // account-menu iframe cannot inspect it, so settingsEnhancer records the
  // observed identity in same-origin storage for this popup to consume.
  const currentLoginEmail = accounts.length === 0 ? AccountStore.getRememberedCurrentLogin() : null;

  // The background poll fires ag-account-changed every 20s whether anything
  // moved or not. Rewriting innerHTML then would throw away the account list's
  // scroll position mid-scroll, now that the list actually scrolls.
  const signature = JSON.stringify([
    bestPercent,
    count,
    currentLoginEmail,
    accounts.map(a => [a.id, a.name, a.plan, a.quotaPercent, a.isActive, a.issue ?? '', a.geminiWeekly ?? '', a.gemini5h ?? '', a.threePWeekly ?? '', a.threeP5h ?? '', a.tokenMask]),
  ]);
  if (shouldSkipRender(container, signature)) return;

  container.innerHTML = `
    <div class="ag-switch-header">
      <div class="ag-switch-avatar" style="background:${activeAccount?.color || '#6b7280'};">${initial(activeAccount?.name || '?')}</div>
      <span class="ag-switch-user-name">${escapeHtml(activeAccount?.name || 'User')}</span>
    </div>

    <div class="ag-switch-summary-card">
      <div class="ag-switch-summary-left">
        <svg class="ag-switch-summary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 6v6l4 2"/>
        </svg>
        <div class="ag-switch-summary-text">
          <div class="ag-switch-summary-title">${count === 0 ? 'No accounts connected' : 'Best account remaining'}</div>
          <div class="ag-switch-summary-sub">${count} connected account${count === 1 ? '' : 's'}</div>
        </div>
      </div>
      <div class="ag-switch-total-badge">${count === 0 ? '—' : `${bestPercent}%`}</div>
    </div>

    <div class="ag-switch-subs-list">
      ${accounts.length === 0 ? `
        <div class="ag-switch-empty">
          No accounts connected yet.
          ${currentLoginEmail ? `
            <div style="margin-top:10px;">
              <button class="ag-switch-action-btn" id="ag-adopt-current-login">Use current login (${escapeHtml(currentLoginEmail)})</button>
            </div>
          ` : 'Use “Add new account” below to connect one.'}
        </div>
      ` : ''}
      ${accounts.map(acc => {
        const tier = simplifyTier(acc.plan);
        const tierClass = `tier-${tier.toLowerCase()}`;
        const tooltip = `Gemini: 5h ${acc.gemini5h != null ? acc.gemini5h + '%' : '—'} · 周 ${acc.geminiWeekly != null ? acc.geminiWeekly + '%' : '—'}\nClaude/GPT: 5h ${acc.threeP5h != null ? acc.threeP5h + '%' : '—'} · 周 ${acc.threePWeekly != null ? acc.threePWeekly + '%' : '—'}`;
        return `
        <div class="ag-switch-sub-item ${acc.isActive ? 'active' : ''}" data-account-id="${escapeHtml(acc.id)}" title="${escapeHtml(tooltip)}">
          <div class="ag-switch-sub-left">
            <div class="ag-dot ag-dot-avatar" style="background-color: ${acc.color};">${initial(acc.name)}</div>
            <div class="ag-switch-sub-info">
              <div class="ag-switch-sub-name">
                <span class="ag-name-text">${escapeHtml(acc.name)}</span>
                <span class="ag-tier-badge ${tierClass}">${escapeHtml(tier)}</span>
              </div>
              <div class="ag-switch-sub-dots">${acc.issue ? `<span style="color:#ef4444;font-size:10px;">${escapeHtml(acc.issue)}</span>` : acc.tokenMask}</div>
            </div>
          </div>
          <div class="ag-switch-sub-percent" style="${acc.issue ? 'color:#ef4444;' : ''}">
            ${acc.issue ? '0%' : `${acc.quotaPercent}%`}
          </div>
        </div>
      `;
      }).join('')}
    </div>

    <div class="ag-switch-actions">
      <button class="ag-switch-action-btn" id="ag-add-sub-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        Add new account
      </button>
    </div>
  `;

  container.querySelectorAll('.ag-switch-sub-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      const id = el.dataset.accountId;
      console.log('[accountPopup] sub-item clicked, accountId =', id);
      if (id) {
        await withActionPending(el, async () => {
          const ok = await AccountStore.confirmAndSwitch(id);
          console.log('[accountPopup] switchAccount resolved:', ok);
        });
      }
    });
  });

  container.querySelector('#ag-add-sub-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Keeps the one fact the user can't recover from being wrong about — that
    // this signs them out here — and the one reassurance that makes it safe to
    // agree to. Everything else belongs in the banner that follows.
    const proceed = await showConfirm(
      'This signs you out of Antigravity here so you can log in with a different Google account.\n\n' +
      'Your current account is saved first and can be restored at any time. Continue?'
    );
    if (!proceed) return;

    // Kept up on success: begin() restarts the hub, and the resulting reload is
    // what tears this down — at which point the sign-in screen is showing and
    // the banner (rebuilt from daemon state) takes over.
    const progress = showProgress('Signing out so you can add an account…', 'Antigravity will reload and show its sign-in screen.');
    const started = await AccountStore.beginAddAccount();
    if (!started.ok) {
      progress.close();
      await showAlert(`Could not start sign-in: ${started.error}\n\nNothing was changed.`);
    }
  });

  container.querySelector('#ag-adopt-current-login')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentLoginEmail) return;
    const proceed = await showConfirm(
      `Save ${currentLoginEmail} as a connected account?\n\n` +
      'This does not sign you out or change anything in Antigravity.'
    );
    if (!proceed) return;
    const btn = container.querySelector('#ag-adopt-current-login') as HTMLElement;
    if (btn) btn.textContent = 'Saving…';
    const result = await AccountStore.triggerConnect(currentLoginEmail);
    if (!result.ok) await showAlert(`Could not save ${currentLoginEmail}: ${result.error}`);
    renderPopupContent(container);
  });
}
