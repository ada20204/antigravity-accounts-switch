import { AccountStore } from '../services/accountStore';
import { showConfirm, showAlert } from './confirmDialog';
import { showProgress } from './progressOverlay';
import { bindUntilRemoved, unbind, shouldSkipRender, renderOrDefer, withActionPending } from './renderGuard';
import { escapeHtml, simplifyTier } from '../adapters/domUtils';
import { t, getLang, setLang, getMaskEmails, setMaskEmails, maskEmail } from './i18n';

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
  bindUntilRemoved(container, 'ag-lang-changed', () => renderOrDefer(container, () => renderPopupContent(container)));
  bindUntilRemoved(container, 'ag-mask-changed', () => renderOrDefer(container, () => renderPopupContent(container)));

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
  const isMasked = getMaskEmails();
  const currentLang = getLang();
  const isZh = currentLang === 'zh';
  const activeDisplayName = maskEmail(activeAccount?.name, isMasked);

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
    currentLang,
    isMasked,
    accounts.map(a => [a.id, a.name, a.plan, a.quotaPercent, a.isActive, a.issue ?? '', a.geminiWeekly ?? '', a.gemini5h ?? '', a.threePWeekly ?? '', a.threeP5h ?? '', a.tokenMask]),
  ]);
  if (shouldSkipRender(container, signature)) return;

  container.innerHTML = `
    <div class="ag-switch-header">
      <div class="ag-switch-header-user">
        <div class="ag-switch-avatar" style="background:${activeAccount?.color || '#6b7280'};">${initial(activeDisplayName || '?')}</div>
        <span class="ag-switch-user-name" title="${escapeHtml(activeAccount?.id || '')}">${escapeHtml(activeDisplayName || 'User')}</span>
      </div>
      <div class="ag-switch-header-controls">
        <button class="ag-popup-mini-btn" id="ag-popup-toggle-mask" title="${escapeHtml(isMasked ? t().maskBtnMaskedTitle : t().maskBtnPlainTitle)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            ${isMasked
              ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
              : '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'}
          </svg>
        </button>
        <button class="ag-popup-mini-btn" id="ag-popup-toggle-lang" title="${escapeHtml(t().langBtnTitle)}">
          ${escapeHtml(t().langBtn)}
        </button>
      </div>
    </div>

    <div class="ag-switch-summary-card">
      <div class="ag-switch-summary-left">
        <svg class="ag-switch-summary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 6v6l4 2"/>
        </svg>
        <div class="ag-switch-summary-text">
          <div class="ag-switch-summary-title">${count === 0 ? escapeHtml(t().noAccounts) : escapeHtml(t().popupBestQuota)}</div>
          <div class="ag-switch-summary-sub">${escapeHtml(t().popupConnectedAccounts(count))}</div>
        </div>
      </div>
      <div class="ag-switch-total-badge">${count === 0 ? '—' : `${bestPercent}%`}</div>
    </div>

    <div class="ag-switch-subs-list">
      ${accounts.length === 0 ? `
        <div class="ag-switch-empty">
          ${escapeHtml(t().emptyTip)}
          ${currentLoginEmail ? `
            <div style="margin-top:10px;">
              <button class="ag-switch-action-btn" id="ag-adopt-current-login">${escapeHtml(t().adoptLogin(maskEmail(currentLoginEmail, isMasked)))}</button>
            </div>
          ` : ''}
        </div>
      ` : ''}
      ${accounts.map(acc => {
        const tier = simplifyTier(acc.plan);
        const tierClass = `tier-${tier.toLowerCase()}`;
        const displayName = maskEmail(acc.name, isMasked);
        const weeklyLabel = isZh ? '周' : 'Wk';
        const tooltip = `Gemini: 5h ${acc.gemini5h != null ? acc.gemini5h + '%' : '—'} · ${weeklyLabel} ${acc.geminiWeekly != null ? acc.geminiWeekly + '%' : '—'}\nClaude/GPT: 5h ${acc.threeP5h != null ? acc.threeP5h + '%' : '—'} · ${weeklyLabel} ${acc.threePWeekly != null ? acc.threePWeekly + '%' : '—'}`;
        return `
        <div class="ag-switch-sub-item ${acc.isActive ? 'active' : ''}" data-account-id="${escapeHtml(acc.id)}" title="${escapeHtml(tooltip)}">
          <div class="ag-switch-sub-left">
            <div class="ag-dot ag-dot-avatar" style="background-color: ${acc.color};">${initial(displayName)}</div>
            <div class="ag-switch-sub-info">
              <div class="ag-switch-sub-name">
                <span class="ag-name-text" title="${escapeHtml(acc.id)}">${escapeHtml(displayName)}</span>
                <span class="ag-tier-badge ${escapeHtml(tierClass)}">${escapeHtml(tier)}</span>
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
        ${escapeHtml(t().popupAddAccount)}
      </button>
    </div>
  `;


  container.querySelector('#ag-popup-toggle-mask')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setMaskEmails(!getMaskEmails());
    renderPopupContent(container);
  });

  container.querySelector('#ag-popup-toggle-lang')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setLang(getLang() === 'zh' ? 'en' : 'zh');
    renderPopupContent(container);
  });

  container.querySelectorAll('.ag-switch-sub-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      const id = el.dataset.accountId;
      if (id) {
        await withActionPending(el, async () => {
          await AccountStore.confirmAndSwitch(id);
        });
      }
    });
  });

  container.querySelector('#ag-add-sub-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Keeps the one fact the user can't recover from being wrong about — that
    // this signs them out here — and the one reassurance that makes it safe to
    // agree to. Everything else belongs in the banner that follows.
    const proceed = await showConfirm(t().confirmSignOutAdd);
    if (!proceed) return;

    // Kept up on success: begin() restarts the hub, and the resulting reload is
    // what tears this down — at which point the sign-in screen is showing and
    // the banner (rebuilt from daemon state) takes over.
    const progress = showProgress(t().progressSignOutAddTitle, t().progressSignOutAddDetail);
    const started = await AccountStore.beginAddAccount();
    if (!started.ok) {
      progress.close();
      await showAlert(t().couldNotStartSignIn(started.error));
    }
  });

  container.querySelector('#ag-adopt-current-login')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentLoginEmail) return;
    const isMasked = getMaskEmails();
    const maskedCurrent = maskEmail(currentLoginEmail, isMasked);
    const proceed = await showConfirm(t().confirmAdopt(maskedCurrent));
    if (!proceed) return;
    const btn = container.querySelector('#ag-adopt-current-login') as HTMLElement;
    if (btn) btn.textContent = t().saving;
    const result = await AccountStore.triggerConnect(currentLoginEmail);
    if (!result.ok) await showAlert(`Could not save ${maskedCurrent}: ${result.error}`);
    renderPopupContent(container);
  });
}
