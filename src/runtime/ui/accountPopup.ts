import { AccountStore } from '../services/accountStore';
import { showConfirm, showAlert } from './confirmDialog';
import { showProgress } from './progressOverlay';
import { bindUntilRemoved, unbind, shouldSkipRender, renderOrDefer } from './renderGuard';

// Deterministic initial, not a stock photo — see docs/DECISIONS.md, "头像".
function initial(name: string): string {
  return (name.trim()[0] || '?').toUpperCase();
}

export function createAccountPopup(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'ag-enhancer-popup';
  container.id = 'ag-enhancer-multi-account-popup';

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

  // The background poll fires ag-account-changed every 20s whether anything
  // moved or not. Rewriting innerHTML then would throw away the account list's
  // scroll position mid-scroll, now that the list actually scrolls.
  const signature = JSON.stringify([
    bestPercent,
    count,
    accounts.map(a => [a.id, a.name, a.plan, a.quotaPercent, a.isActive, a.issue ?? '', a.tokenMask]),
  ]);
  if (shouldSkipRender(container, signature)) return;

  container.innerHTML = `
    <div class="ag-enhancer-header">
      <div class="ag-enhancer-avatar" style="background:${activeAccount?.color || '#6b7280'};">${initial(activeAccount?.name || '?')}</div>
      <span class="ag-enhancer-user-name">${activeAccount?.name || 'User'}</span>
    </div>

    <div class="ag-enhancer-summary-card">
      <div class="ag-enhancer-summary-left">
        <svg class="ag-enhancer-summary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 6v6l4 2"/>
        </svg>
        <div class="ag-enhancer-summary-text">
          <div class="ag-enhancer-summary-title">${count === 0 ? 'No accounts connected' : 'Best account remaining'}</div>
          <div class="ag-enhancer-summary-sub">${count} connected account${count === 1 ? '' : 's'}</div>
        </div>
      </div>
      <div class="ag-enhancer-total-badge">${count === 0 ? '—' : `${bestPercent}%`}</div>
    </div>

    <div class="ag-enhancer-subs-list">
      ${accounts.length === 0 ? `
        <div class="ag-enhancer-empty">
          No accounts connected yet. Use “Add new account” below to connect the
          account you are signed in with.
        </div>
      ` : ''}
      ${accounts.map(acc => `
        <div class="ag-enhancer-sub-item ${acc.isActive ? 'active' : ''}" data-account-id="${acc.id}">
          <div class="ag-enhancer-sub-left">
            <div class="ag-dot ag-dot-avatar" style="background-color: ${acc.color};">${initial(acc.name)}</div>
            <div class="ag-enhancer-sub-info">
              <div class="ag-enhancer-sub-name">${acc.name} · ${acc.plan}</div>
              <div class="ag-enhancer-sub-dots">${acc.issue ? `<span style="color:#ef4444;font-size:10px;">${acc.issue}</span>` : acc.tokenMask}</div>
            </div>
          </div>
          <div class="ag-enhancer-sub-percent" style="${acc.issue ? 'color:#ef4444;' : ''}">
            ${acc.issue ? '0%' : `${acc.quotaPercent}%`}
          </div>
        </div>
      `).join('')}
    </div>

    <div class="ag-enhancer-actions">
      <button class="ag-enhancer-action-btn" id="ag-add-sub-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        Add new account
      </button>
    </div>
  `;

  container.querySelectorAll('.ag-enhancer-sub-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      const id = el.dataset.accountId;
      console.log('[accountPopup] sub-item clicked, accountId =', id);
      if (id) {
        el.style.opacity = '0.5';
        const ok = await AccountStore.confirmAndSwitch(id);
        el.style.opacity = '';
        console.log('[accountPopup] switchAccount resolved:', ok);
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
}
