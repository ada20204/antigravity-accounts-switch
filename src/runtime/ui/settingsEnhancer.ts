import { AccountStore, type SubscriptionAccount } from '../services/accountStore';
import { SemanticLocator } from '../adapters/semanticLocator';
import { showConfirm, showAlert } from './confirmDialog';
import { bindUntilRemoved, unbind, shouldSkipRender, renderOrDefer, withActionPending } from './renderGuard';
import { escapeHtml, simplifyTier } from '../adapters/domUtils';

// bindUntilRemoved dedups by element reference — it only replaces a binding
// made on the SAME element. A Settings tab switch destroys our card and the
// code below builds a brand-new one, which is a different WeakMap key, so
// nothing would abort the old binding without this. Tracked here instead of
// relying on element identity, closing the leak bindUntilRemoved's per-
// element dedup can't close on its own. See docs/decisions/2026-08-23-review-b9ad69f-followup-10-findings.md.
let lastBoundCard: HTMLElement | null = null;

export function injectSettingsEnhancements() {
  // Single-pass DOM scan for plan label and current login email
  const { plan: planLabel, email: currentLoginEmail } = SemanticLocator.scanSettingsMetadata();
  if (planLabel) {
    const active = AccountStore.getAccounts().find(a => a.isActive);
    if (active) AccountStore.reportPlan(active.id, planLabel);
  }
  if (AccountStore.getAccounts().length === 0 && currentLoginEmail) {
    AccountStore.rememberCurrentLogin(currentLoginEmail);
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

function getQuotaColor(percent: number | null | undefined): string {
  if (percent == null) return '#6b7280';
  if (percent < 20) return '#ef4444';
  if (percent < 50) return '#f59e0b';
  return '#22c55e';
}

function renderConcentricRing(options: {
  fiveHour: number | null | undefined;
  weekly: number | null | undefined;
  issue?: string | null;
  label: string;
}): string {
  const { fiveHour, weekly, issue, label } = options;
  const hasIssue = Boolean(issue);
  const fiveHVal = hasIssue ? 0 : fiveHour;
  const weeklyVal = hasIssue ? 0 : weekly;

  const weeklyClamped = weeklyVal != null ? Math.max(0, Math.min(100, weeklyVal)) : null;
  const fiveHClamped = fiveHVal != null ? Math.max(0, Math.min(100, fiveHVal)) : null;

  // Outer ring (Weekly): R=16, stroke-width=3. C = 2 * PI * 16 ≈ 100.53
  const outerR = 16;
  const outerC = 2 * Math.PI * outerR;
  const outerOffset = weeklyClamped != null ? outerC * (1 - weeklyClamped / 100) : outerC;
  const outerColor = hasIssue ? '#ef4444' : getQuotaColor(weeklyClamped);

  // Inner ring (5h): R=11, stroke-width=3. C = 2 * PI * 11 ≈ 69.12
  const innerR = 11;
  const innerC = 2 * Math.PI * innerR;
  const innerOffset = fiveHClamped != null ? innerC * (1 - fiveHClamped / 100) : innerC;
  const innerColor = hasIssue ? '#ef4444' : getQuotaColor(fiveHClamped);

  const tooltip = `${label}\n外环(周配额): ${weeklyVal != null ? weeklyVal + '%' : '无'}\n内环(5h配额): ${fiveHVal != null ? fiveHVal + '%' : '无'}`;

  return `
    <svg class="ag-concentric-ring" viewBox="0 0 40 40" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}">
      <!-- Outer Track (Weekly) -->
      <circle class="ag-ring-track" cx="20" cy="20" r="${outerR}"></circle>
      ${weeklyClamped != null ? `
      <circle class="ag-ring-value" cx="20" cy="20" r="${outerR}"
        style="stroke:${outerColor};stroke-dasharray:${outerC.toFixed(2)};stroke-dashoffset:${outerOffset.toFixed(2)};"></circle>
      ` : ''}

      <!-- Inner Track (5h) -->
      <circle class="ag-ring-track" cx="20" cy="20" r="${innerR}" style="${fiveHClamped == null ? 'opacity:0.2;' : ''}"></circle>
      ${fiveHClamped != null ? `
      <circle class="ag-ring-value" cx="20" cy="20" r="${innerR}"
        style="stroke:${innerColor};stroke-dasharray:${innerC.toFixed(2)};stroke-dashoffset:${innerOffset.toFixed(2)};"></circle>
      ` : ''}
    </svg>
  `;
}

export type SortColumn = 'tier' | 'gemini' | 'claude';
export type SortDirection = 'desc' | 'asc';

export interface SortCriterion {
  column: SortColumn;
  direction: SortDirection;
}

let currentSortCriteria: SortCriterion[] = (() => {
  try {
    const saved = localStorage.getItem('ag_sort_criteria');
    if (saved) {
      const parsed = JSON.parse(saved) as SortCriterion[];
      if (Array.isArray(parsed)) {
        return parsed.filter(p => (p.column === 'tier' || p.column === 'gemini' || p.column === 'claude') && (p.direction === 'desc' || p.direction === 'asc'));
      }
    }
    const old = localStorage.getItem('ag_settings_sort_mode');
    if (old === 'quota-desc') return [{ column: 'gemini', direction: 'desc' }];
    if (old === 'quota-asc') return [{ column: 'gemini', direction: 'asc' }];
  } catch {}
  return [];
})();

function getTierWeight(plan?: string | null): number {
  const t = simplifyTier(plan);
  return t === 'Ultra' ? 3 : t === 'Pro' ? 2 : t === 'Free' ? 1 : 0;
}

function compareByCriterion(a: SubscriptionAccount, b: SubscriptionAccount, crit: SortCriterion): number {
  const mult = crit.direction === 'desc' ? -1 : 1;
  if (crit.column === 'tier') {
    const diff = getTierWeight(a.plan) - getTierWeight(b.plan);
    return diff !== 0 ? diff * mult : 0;
  }
  // 5h quota is primary metric, fallback to weekly if tied
  const isGem = crit.column === 'gemini';
  const fiveA = a.issue ? -1 : ((isGem ? a.gemini5h : a.threeP5h) ?? -1);
  const fiveB = b.issue ? -1 : ((isGem ? b.gemini5h : b.threeP5h) ?? -1);
  if (fiveA !== fiveB) return (fiveA - fiveB) * mult;

  const wkA = a.issue ? -1 : ((isGem ? a.geminiWeekly : a.threePWeekly) ?? -1);
  const wkB = b.issue ? -1 : ((isGem ? b.geminiWeekly : b.threePWeekly) ?? -1);
  return wkA !== wkB ? (wkA - wkB) * mult : 0;
}

function sortAccounts(list: SubscriptionAccount[], criteria: SortCriterion[]): SubscriptionAccount[] {
  if (criteria.length === 0) return [...list];
  return [...list].sort((a, b) => {
    for (const crit of criteria) {
      const cmp = compareByCriterion(a, b, crit);
      if (cmp !== 0) return cmp;
    }
    return a.name.localeCompare(b.name);
  });
}

function renderSortIndicator(col: SortColumn, criteria: SortCriterion[]): string {
  const idx = criteria.findIndex(c => c.column === col);
  if (idx < 0) return '';
  const arrow = criteria[idx].direction === 'desc' ? '↓' : '↑';
  const rank = criteria.length > 1 ? `<sup>${idx + 1}</sup>` : '';
  return `<span class="ag-sort-indicator">${arrow}${rank}</span>`;
}

function handleHeaderSortClick(card: HTMLElement, col: SortColumn) {
  const existingIdx = currentSortCriteria.findIndex(c => c.column === col);
  if (existingIdx === 0) {
    if (currentSortCriteria[0].direction === 'desc') {
      currentSortCriteria[0].direction = 'asc';
    } else {
      currentSortCriteria.shift(); // 3rd click: remove from stack
    }
  } else if (existingIdx > 0) {
    const [item] = currentSortCriteria.splice(existingIdx, 1);
    item.direction = 'desc';
    currentSortCriteria.unshift(item);
  } else {
    currentSortCriteria.unshift({ column: col, direction: 'desc' });
  }
  if (currentSortCriteria.length > 3) currentSortCriteria.length = 3;
  try {
    localStorage.setItem('ag_sort_criteria', JSON.stringify(currentSortCriteria));
  } catch {}
  renderSettingsCard(card, true);
}

// Re-renders only on a signature change (renderGuard's shouldSkipRender),
// plus renderOrDefer at both call sites for real data landing mid-gesture —
// see docs/decisions/2026-08-23-listener-leak-unconditional-rerender.md.
// `force` covers the one remaining case: resetting a UI-only artifact (the
// refresh button's label) the signature check can't see needs resetting.
function renderSettingsCard(card: HTMLElement, force = false) {
  const rawAccounts = AccountStore.getAccounts();
  const accounts = sortAccounts(rawAccounts, currentSortCriteria);
  const { averagePercent, count } = AccountStore.getTotalQuota();

  // Only checked when the list is empty — one DOM scan, same cost as
  // findAccountPlanLabel() above. Lets a fresh install (or one where every
  // saved account got removed) adopt whatever Antigravity is already signed
  // into directly, instead of the only other path being a full sign-out →
  // sign-in round trip. See docs/decisions/2026-08-27-adopt-current-login.md.
  const currentLoginEmail = accounts.length === 0 ? SemanticLocator.findAccountPanelEmail() : null;

  const signature = JSON.stringify([
    currentSortCriteria,
    averagePercent,
    count,
    currentLoginEmail,
    accounts.map(a => [a.id, a.name, a.plan, a.quotaPercent, a.isActive, a.issue ?? '', a.geminiWeekly ?? '', a.gemini5h ?? '', a.threePWeekly ?? '', a.threeP5h ?? '']),
  ]);
  if (shouldSkipRender(card, signature, force)) return;

  // Responsive mode detection: compact when container < 520px (e.g. Chat popover)
  const initialWidth = card.clientWidth || card.parentElement?.clientWidth || 0;
  if (initialWidth > 0) {
    card.classList.toggle('ag-compact', initialWidth < 520);
  }
  const inPopover = Boolean(card.closest('[role="dialog"], [role="menu"], [class*="popover"], [class*="flyout"], [class*="dropdown"], [class*="quick-input"]'));
  card.classList.toggle('ag-in-popover', inPopover);

  if (typeof ResizeObserver !== 'undefined' && !card.dataset.hasResize) {
    card.dataset.hasResize = 'true';
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (width > 0) {
          card.classList.toggle('ag-compact', width < 520);
        }
      }
    });
    ro.observe(card);
  }

  card.innerHTML = `
    <div class="ag-card-header">
      <div class="ag-card-title-group">
        <span class="ag-card-title ag-title-full">Connected Subscriptions & Multi-Account Quota</span>
        <span class="ag-card-title ag-title-compact">Accounts Quota</span>
        <span class="ag-card-badge ag-badge-full">${count === 0 ? 'No accounts connected' : `${averagePercent}% avg across ${count} account${count === 1 ? '' : 's'}`}</span>
        <span class="ag-card-badge ag-badge-compact">${count === 0 ? '0' : `${averagePercent}% avg`}</span>
      </div>
      <div class="ag-card-actions">
        ${currentSortCriteria.length > 0 ? `
          <button class="ag-card-add-btn ag-btn-reset-sort" id="ag-settings-reset-sort" title="Reset all sorting and return to default account order">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:3px;flex-shrink:0;">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
            </svg>
            Reset
          </button>
        ` : ''}
        <button class="ag-card-add-btn ag-btn-check-all ag-btn-admin" id="ag-settings-refresh-all" title="Switches through every connected account to check its quota — not the same as the official per-account refresh">Check All Accounts</button>
        <button class="ag-card-add-btn ag-btn-export ag-btn-admin" id="ag-settings-export" title="Save all connected accounts, including their credentials, to a file you choose">Export</button>
        <button class="ag-card-add-btn ag-btn-import ag-btn-admin" id="ag-settings-import" title="Load accounts from a previously exported file">Import</button>
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
      ` : `
        <div class="ag-grid-header">
          <div class="ag-header-cell ag-header-sortable" data-sort-col="tier" title="Sort by Account Tier (Ultra → Pro → Free). Consecutive clicks prioritize and toggle direction.">
            <span>Account / Tier</span>
            ${renderSortIndicator('tier', currentSortCriteria)}
          </div>
          <div class="ag-header-cell ag-col-center ag-header-sortable" data-sort-col="gemini" title="Sort by Gemini 5h Quota. Consecutive clicks prioritize and toggle direction.">
            <span class="ag-col-label-full">Gemini</span>
            <span class="ag-col-label-compact" title="Gemini Quota">G</span>
            ${renderSortIndicator('gemini', currentSortCriteria)}
          </div>
          <div class="ag-header-cell ag-col-center ag-header-sortable" data-sort-col="claude" title="Sort by Claude & GPT 5h Quota. Consecutive clicks prioritize and toggle direction.">
            <span class="ag-col-label-full">Claude & GPT</span>
            <span class="ag-col-label-compact" title="Claude & GPT Quota">C</span>
            ${renderSortIndicator('claude', currentSortCriteria)}
          </div>
          <div class="ag-col-center">Status</div>
          <div class="ag-col-action-header ag-btn-admin"></div>
        </div>
      `}
      ${accounts.map(acc => {
        const tier = simplifyTier(acc.plan);
        const tierClass = `tier-${tier.toLowerCase()}`;
        return `
        <div class="ag-sub-box ${acc.isActive ? 'active' : ''}" data-account-id="${escapeHtml(acc.id)}" title="${acc.isActive ? 'Current active account' : 'Click to switch to this account'}">
          <div class="ag-sub-box-row">
            <div class="ag-sub-box-ident">
              <span class="ag-dot" style="background:${acc.color};"></span>
              <span class="ag-sub-box-name" title="${escapeHtml(acc.name)}">${escapeHtml(acc.name)}</span>
              <span class="ag-tier-badge ${escapeHtml(tierClass)}">${escapeHtml(tier)}</span>
            </div>

            <div class="ag-quota-col" title="Gemini&#10;外环(周配额): ${acc.geminiWeekly != null ? acc.geminiWeekly + '%' : '无'}&#10;内环(5h配额): ${acc.gemini5h != null ? acc.gemini5h + '%' : '无'}">
              ${renderConcentricRing({ fiveHour: acc.gemini5h, weekly: acc.geminiWeekly, issue: acc.issue, label: 'Gemini' })}
            </div>

            <div class="ag-quota-col" title="Claude & GPT&#10;外环(周配额): ${acc.threePWeekly != null ? acc.threePWeekly + '%' : '无'}&#10;内环(5h配额): ${acc.threeP5h != null ? acc.threeP5h + '%' : '无'}">
              ${renderConcentricRing({ fiveHour: acc.threeP5h, weekly: acc.threePWeekly, issue: acc.issue, label: 'Claude & GPT' })}
            </div>

            <div class="ag-status-col">
              ${acc.isActive ? `
                <span class="ag-active-badge">Active</span>
              ` : `
                <span class="ag-switch-badge">Switch</span>
              `}
            </div>

            <div class="ag-actions-col ag-btn-admin">
              <button class="ag-remove-icon-btn" data-account-id="${escapeHtml(acc.id)}" title="Remove ${escapeHtml(acc.name)}" aria-label="Remove account">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>
                </svg>
              </button>
            </div>
          </div>

          ${acc.issue ? `
          <div class="ag-sub-box-mask" style="display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#ef4444;font-size:11px;">⚠️ ${escapeHtml(acc.issue)}</span>
            <span style="font-size:11px;color:#9ca3af;">0% Remaining</span>
          </div>
          ` : ''}
        </div>
      `;
      }).join('')}
    </div>
  `;

  card.querySelectorAll('.ag-header-sortable').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const col = (e.currentTarget as HTMLElement).dataset.sortCol as SortColumn;
      if (col) handleHeaderSortClick(card, col);
    });
  });

  card.querySelector('#ag-settings-reset-sort')?.addEventListener('click', (e) => {
    e.stopPropagation();
    currentSortCriteria = [];
    try {
      localStorage.removeItem('ag_sort_criteria');
    } catch {}
    renderSettingsCard(card, true);
  });

  card.querySelectorAll('.ag-sub-box').forEach(box => {
    box.addEventListener('click', async (e) => {
      if ((e.target as HTMLElement).closest('.ag-remove-icon-btn')) return;
      const el = e.currentTarget as HTMLElement;
      if (el.classList.contains('active')) return;
      const id = el.dataset.accountId;
      if (id) {
        await withActionPending(el, async () => {
          await AccountStore.confirmAndSwitch(id);
          renderSettingsCard(card);
        });
      }
    });
  });

  card.querySelectorAll('.ag-remove-icon-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
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

  card.querySelector('#ag-settings-export')?.addEventListener('click', async () => {
    if (accounts.length === 0) {
      await showAlert('No accounts connected yet — nothing to export.');
      return;
    }
    const proceed = await showConfirm(
      `Export ${accounts.length} account${accounts.length === 1 ? '' : 's'} to a file?\n\n` +
      'The file will contain your saved Google account credentials in a portable, ' +
      'NOT encrypted form. Keep it somewhere private — anyone with this file can ' +
      'sign in as these accounts.'
    );
    if (!proceed) return;
    const result = await AccountStore.exportAccounts();
    if (result.cancelled) return;
    if (!result.ok) {
      await showAlert(`Export failed: ${result.error}`);
    } else {
      await showAlert(`Exported ${result.accounts} account${result.accounts === 1 ? '' : 's'} (${result.credentials} with credentials).`);
    }
  });

  card.querySelector('#ag-settings-import')?.addEventListener('click', async () => {
    const proceed = await showConfirm(
      'Import accounts from a file?\n\n' +
      'Any account in the file that matches an ID you already have will be ' +
      'OVERWRITTEN with the file\'s credentials. This cannot be undone. Continue?'
    );
    if (!proceed) return;
    const result = await AccountStore.importAccounts();
    if (result.cancelled) return;
    if (!result.ok) {
      await showAlert(`Import failed: ${result.error}`);
    } else {
      const imported = result.imported?.length ?? 0;
      const overwritten = result.overwritten?.length ?? 0;
      await showAlert(`Imported ${imported} new account${imported === 1 ? '' : 's'}, overwrote ${overwritten}.`);
    }
    renderSettingsCard(card, true);
  });
}
