import { ProfileSyncAdapter } from '../adapters/profileSyncAdapter';
import { showConfirm, showAlert } from '../ui/confirmDialog';
import { showProgress } from '../ui/progressOverlay';

export interface SubscriptionAccount {
  id: string;
  name: string;
  // The exact text Antigravity's own Settings → Account page shows after
  // "Your Plan: " for whichever account was active when it was last observed
  // — see docs/DECISIONS.md, "账号等级(Plan)". Not a closed Free/Pro/Ultra
  // union: there is no CLI field for this, so it can only ever be real text
  // actually seen in that DOM, or 'Unknown' before it's been seen once.
  plan: string;
  quotaPercent: number;
  color: string;
  isActive: boolean;
  tokenMask: string;
  issue?: string | null;
  geminiWeekly?: number;
  gemini5h?: number;
}

export class AccountStore {
  private static STORAGE_KEY = 'ag_enhancer_accounts';
  private static DAEMON_URL = 'http://127.0.0.1:63820';

  // Fire-and-forget: ships logs to the daemon's log file (webview devtools
  // console isn't tailable after the fact).
  private static remoteLog(message: string, data?: unknown): void {
    try {
      fetch(`${this.DAEMON_URL}/api/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: 'info', message, data })
      }).catch(() => {});
    } catch {
      // never let logging break the actual flow
    }
  }

  // Timestamped daemon-log marker for "this injected script instance came up
  // and started fetching" — diffed against [HUB_RESTART]/[CDP_INJECT] to see
  // real end-to-end switch latency. See docs/DECISIONS.md, "切换耗时".
  public static logRuntimeBoot(): void {
    this.remoteLog('runtime booted, fetching accounts', { pageOrigin: window.location.origin });
  }

  public static async fetchLiveAccounts(): Promise<SubscriptionAccount[]> {
    try {
      const res = await fetch(`${this.DAEMON_URL}/api/accounts`);
      if (res.ok) {
        const data = await res.json();
        const colors = ['#688e57', '#3b58cc', '#b5a999', '#a6334f', '#2e8b57', '#f6b26b'];
        const accounts: SubscriptionAccount[] = (data.accounts || []).map((acc: any, idx: number) => {
          const gemWeekly = acc.groups?.gemini?.weekly?.remaining_fraction != null ? Math.round(acc.groups.gemini.weekly.remaining_fraction * 100) : null;
          const gem5h = acc.groups?.gemini?.five_hour?.remaining_fraction != null ? Math.round(acc.groups.gemini.five_hour.remaining_fraction * 100) : null;
          // Whichever limit is closer to running out is the one that will
          // actually block you, so the headline number is the lower of the two.
          // Showing five-hour alone made every account read "100%" (it refills
          // constantly) while the weekly figures that actually differed between
          // accounts stayed invisible — useless for picking one to switch to.
          const known = [gem5h, gemWeekly].filter((v): v is number => v != null);
          const quota = known.length > 0 ? Math.min(...known) : (acc.issue ? 0 : 100);

          return {
            id: acc.account_id,
            name: acc.account_id.split('@')[0],
            plan: acc.plan ?? 'Unknown',
            quotaPercent: quota,
            color: colors[idx % colors.length],
            isActive: Boolean(acc.active), // schema v2 field is `active`, not `current` — see docs/DECISIONS.md
            tokenMask: '••••••••',
            issue: acc.issue ?? (acc.credential_drift ? 'credential_drift' : null),
            geminiWeekly: gemWeekly || 0,
            gemini5h: gem5h || 0
          };
        });

        if (accounts.length > 0) {
          this.saveAccounts(accounts);
          const active = accounts.find(a => a.isActive);
          if (active) ProfileSyncAdapter.syncBottomTrigger(active);
          window.dispatchEvent(new CustomEvent('ag-account-changed', { detail: { source: 'fetch' } }));
          return accounts;
        }
      }
    } catch (e) {
      console.warn('[AccountStore] Daemon unavailable, falling back to cache:', e);
    }
    return this.getAccounts();
  }

  // Returns [] when nothing is cached yet. This used to seed three hardcoded
  // accounts — real addresses paired with invented quota figures (91%, 100%,
  // "eligibility_failed") — which rendered identically to live data, so a fresh
  // install showed three accounts that did not exist and numbers that were
  // never measured. An empty list is the only honest answer before the first
  // successful fetch; the UI renders an empty state for it.
  public static getAccounts(): SubscriptionAccount[] {
    const raw = localStorage.getItem(this.STORAGE_KEY);
    if (raw) {
      try { return JSON.parse(raw); } catch (e) {}
    }
    return [];
  }

  public static saveAccounts(accounts: SubscriptionAccount[]): void {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(accounts));
  }

  // Averaged, not summed. Summing produced "500% Active (5 accounts)" once a
  // few accounts were connected — a percentage above 100 reads as a bug no
  // matter what it was meant to convey. `best` is the more actionable number
  // (the account with the most headroom is the one worth switching to), so
  // both are exposed and the UI labels whichever it shows.
  public static getTotalQuota(): { averagePercent: number; bestPercent: number; count: number } {
    const accounts = this.getAccounts();
    if (accounts.length === 0) return { averagePercent: 0, bestPercent: 0, count: 0 };

    const values = accounts.map(a => (a.issue ? 0 : a.quotaPercent));
    const sum = values.reduce((acc, v) => acc + v, 0);
    return {
      averagePercent: Math.round(sum / values.length),
      bestPercent: Math.max(...values),
      count: accounts.length,
    };
  }

  public static async switchAccount(id: string): Promise<boolean> {
    console.log('[AccountStore] Seamlessly switching account to:', id);
    this.remoteLog('switchAccount called', { id, pageOrigin: window.location.origin });

    const previousAccounts = this.getAccounts().map(acc => ({ ...acc }));
    const previousActive = previousAccounts.find(a => a.isActive) || null;

    // 1. 本地状态即时更新（乐观更新，失败时会回滚）
    const accounts = this.getAccounts();
    let targetActive: SubscriptionAccount | null = null;
    accounts.forEach(acc => {
      acc.isActive = (acc.id === id);
      if (acc.isActive) targetActive = acc;
    });
    this.saveAccounts(accounts);

    if (targetActive) {
      ProfileSyncAdapter.syncBottomTrigger(targetActive);
    }

    window.dispatchEvent(new CustomEvent('ag-account-changed', { detail: { activeId: id } }));

    // 2. 调用 Daemon 写入 Keychain；失败必须回滚，否则 UI 会显示已切换到一个实际上后端没切过去的账号
    try {
      const res = await fetch(`${this.DAEMON_URL}/api/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: id })
      });
      if (!res.ok) {
        throw new Error(`Daemon returned ${res.status}`);
      }
      console.log('[AccountStore] Keychain slot updated successfully');
      this.remoteLog('switchAccount daemon call succeeded', { id });
      await this.fetchLiveAccounts(); // re-read real state, don't trust the optimistic flip
      return true;
    } catch (e: any) {
      // CORS block and network error both surface as generic "Failed to
      // fetch" (browser hides the real reason) — the daemon's REQ log (or
      // its absence) is what actually tells them apart.
      console.error('[AccountStore] Daemon switch call failed, rolling back:', e);
      this.remoteLog('switchAccount daemon call FAILED, rolling back', {
        id,
        errorName: e?.name,
        errorMessage: e?.message,
        daemonUrl: this.DAEMON_URL,
        pageOrigin: window.location.origin
      });
      this.saveAccounts(previousAccounts);
      if (previousActive) {
        ProfileSyncAdapter.syncBottomTrigger(previousActive);
      }
      window.dispatchEvent(new CustomEvent('ag-account-changed', { detail: { activeId: previousActive?.id, error: true } }));
      return false;
    }
  }

  // Shared by every UI entry point so confirmation wording can't drift between
  // them. Does not skip on cached isActive — see docs/DECISIONS.md, "账号切换语义".
  public static async confirmAndSwitch(id: string): Promise<boolean> {
    const proceed = await showConfirm('Switching accounts restarts the Antigravity connection and interrupts any in-progress response. Continue?');
    if (!proceed) return false;

    const progress = showProgress(
      `Switching to ${id}…`,
      'Antigravity will reload automatically once the new account is live. This takes a few seconds.'
    );
    let ok = false;
    try {
      ok = await this.switchAccount(id);
    } finally {
      // Only torn down on failure. On success the overlay is meant to survive
      // until the iframe reload replaces the whole document — that reload IS
      // the completion signal, so closing early would just restore a stale UI
      // for a few seconds and then blank it anyway.
      if (!ok) progress.close();
    }
    if (!ok) {
      await showAlert('Could not switch accounts. Your previous account is still active — see the daemon log for details.');
    }
    return ok;
  }

  // Opens a Terminal window where the interactive sign-in runs — `login` can't
  // run inside the daemon (see docs/DECISIONS.md, "添加账号"). The sign-in and
  // the follow-up capture both happen in that window, so there's nothing left
  // to drive from here afterwards except a refresh.
  public static async triggerLogin(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.DAEMON_URL}/api/login`, { method: 'POST' });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        return { ok: false, error: detail.error || `Daemon returned ${res.status}` };
      }
      return { ok: true };
    } catch (e: any) {
      console.error('[AccountStore] Login trigger failed:', e);
      this.remoteLog('triggerLogin FAILED', { errorName: e?.name, errorMessage: e?.message });
      return { ok: false, error: e?.message || 'Could not reach the local accounts daemon.' };
    }
  }

  // --- Browser-based add-account (see docs/DECISIONS.md, "添加账号") ---
  // begin() signs out so the hub serves its native sign-in page; the actual
  // Google sign-in is Antigravity's own flow, we don't drive it. finish()
  // captures whatever ended up signed in; cancel() puts the old account back.
  public static async beginAddAccount(): Promise<{ ok: boolean; backupAccountId?: string; error?: string }> {
    return this.postJson('/api/add-account/begin');
  }

  public static async finishAddAccount(): Promise<{ ok: boolean; accountId?: string; isNewAccount?: boolean; error?: string }> {
    return this.postJson('/api/add-account/finish');
  }

  public static async cancelAddAccount(): Promise<{ ok: boolean; restored?: string; error?: string }> {
    return this.postJson('/api/add-account/cancel');
  }

  public static async getAddAccountStatus(): Promise<{ pending: boolean; backupAccountId?: string; justAdded?: string | null; signedOut?: boolean }> {
    try {
      const res = await fetch(`${this.DAEMON_URL}/api/add-account/status`);
      if (!res.ok) return { pending: false };
      return await res.json();
    } catch {
      return { pending: false };
    }
  }

  private static async postJson(path: string, body?: unknown): Promise<any> {
    try {
      const res = await fetch(`${this.DAEMON_URL}${path}`, {
        method: 'POST',
        ...(body !== undefined
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      });
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: parsed.error || `Daemon returned ${res.status}` };
      return parsed;
    } catch (e: any) {
      this.remoteLog(`${path} FAILED`, { errorName: e?.name, errorMessage: e?.message });
      return { ok: false, error: e?.message || 'Could not reach the local accounts daemon.' };
    }
  }

  // Reports who the Account panel DOM shows as signed in — see
  // docs/DECISIONS.md, "永远不要裸调 connect". noop:true means the daemon didn't
  // act on it (no flow in progress, or it's still the backed-up account).
  public static async reportAddedIdentity(accountId: string): Promise<{ ok: boolean; noop?: boolean; accountId?: string; isNewAccount?: boolean; error?: string }> {
    return this.postJson('/api/add-account/report-identity', { accountId });
  }

  // Reports the "Your Plan: ..." label the Settings → Account page just
  // showed for whichever account is active right now — see
  // SemanticLocator.findAccountPlanLabel() and docs/DECISIONS.md, "账号等级
  // (Plan)". Fire-and-forget: a failed report just means the plan stays
  // 'Unknown' or shows a stale value until the next successful observation,
  // not a broken flow.
  public static reportPlan(accountId: string, label: string): void {
    void this.postJson('/api/report-plan', { accountId, label });
  }

  public static async triggerConnect(accountId?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.DAEMON_URL}/api/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId })
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        return { ok: false, error: detail.error || `Daemon returned ${res.status}` };
      }
      await this.fetchLiveAccounts();
      return { ok: true };
    } catch (e: any) {
      console.error('[AccountStore] Connect trigger failed:', e);
      return { ok: false, error: e?.message || 'Could not reach the local accounts daemon.' };
    }
  }

  // Returns the failure reason instead of swallowing it — the daemon refuses to
  // remove the signed-in account (409 ACCOUNT_ACTIVE), and silently doing
  // nothing would look identical to a successful removal in the UI.
  public static async removeAccount(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.DAEMON_URL}/api/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: id })
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        this.remoteLog('removeAccount refused', { id, status: res.status, error: detail.error });
        return { ok: false, error: detail.error || `Daemon returned ${res.status}` };
      }
      this.remoteLog('removeAccount succeeded', { id });
      await this.fetchLiveAccounts();
      return { ok: true };
    } catch (e: any) {
      console.error('[AccountStore] Remove trigger failed:', e);
      this.remoteLog('removeAccount FAILED', { id, errorName: e?.name, errorMessage: e?.message });
      return { ok: false, error: e?.message || 'Could not reach the local accounts daemon.' };
    }
  }

  public static async refreshAllQuotas(): Promise<void> {
    try {
      await fetch(`${this.DAEMON_URL}/api/quota-refresh`, { method: 'POST' });
      await this.fetchLiveAccounts();
    } catch (e) {
      console.error('[AccountStore] Quota refresh failed:', e);
    }
  }
}
