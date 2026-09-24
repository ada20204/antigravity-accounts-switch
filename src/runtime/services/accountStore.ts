import { ProfileSyncAdapter } from '../adapters/profileSyncAdapter';
import { showConfirm, showAlert } from '../ui/confirmDialog';
import { showProgress } from '../ui/progressOverlay';
import { t, getMaskEmails, maskEmail } from '../ui/i18n';

/** Schema returned by GET /api/accounts — mirrors agent-hub-accounts overview v3 */
interface DaemonQuotaBucket {
  id: string;
  remaining_fraction: number;
}
interface DaemonQuotaGroup {
  name: string;
  buckets: DaemonQuotaBucket[];
}
interface DaemonAccountEntry {
  account_id: string;
  is_active: boolean;
  plan?: string;
  credential_drift?: boolean;
  quota?: {
    issue?: string | null;
    user_tier?: { name: string };
    groups?: DaemonQuotaGroup[];
  };
}
interface DaemonAccountsResponse {
  accounts: DaemonAccountEntry[];
}

// agent-hub-accounts schema v3: `quota.groups` is an array of named groups
// (e.g. "Gemini Models", "Claude and GPT models"), each with a `buckets`
// array carrying a stable `id` per window (e.g. "gemini-weekly", "gemini-5h")
// instead of the old fixed {gemini: {weekly, five_hour}} keys — a bucket can
// be absent entirely for a given account (seen live: free-tier accounts have
// no "gemini-5h" bucket at all), so this returns null rather than 0 for "not
// present", same as the old optional-chained lookup it replaces.
function findQuotaBucket(groups: DaemonQuotaGroup[] | undefined, bucketId: string): number | null {
  for (const group of groups ?? []) {
    const bucket = group.buckets?.find(b => b.id === bucketId);
    if (bucket?.remaining_fraction != null) return bucket.remaining_fraction;
  }
  return null;
}

export interface SubscriptionAccount {
  id: string;
  name: string;
  // The exact text Antigravity's own Settings → Account page shows after
  // "Your Plan: " for whichever account was active when it was last observed
  // — see docs/decisions/2026-08-23-account-plan-tier.md. Not a closed Free/Pro/Ultra
  // union: there is no CLI field for this, so it can only ever be real text
  // actually seen in that DOM, or 'Unknown' before it's been seen once.
  plan: string;
  quotaPercent: number;
  color: string;
  isActive: boolean;
  tokenMask: string;
  issue?: string | null;
  geminiWeekly?: number | null;
  gemini5h?: number | null;
  threePWeekly?: number | null;
  threeP5h?: number | null;
}

export class AccountStore {
  private static STORAGE_KEY = 'ag_enhancer_accounts';
  private static CURRENT_LOGIN_KEY = 'ag_enhancer_current_login';
  private static CURRENT_LOGIN_AT_KEY = 'ag_enhancer_current_login_at';
  private static CURRENT_LOGIN_TTL_MS = 60_000;
  private static isSwitching = false;

  // Per-window port, set by cdpInjector.ts before this bundle runs — see
  // docs/decisions/2026-08-26-daemon-port-was-hardcoded.md.
  private static get DAEMON_URL(): string {
    return `http://127.0.0.1:${(window as any).__AG_DAEMON_PORT__ ?? 63820}`;
  }

  private static get DAEMON_HEADERS(): Record<string, string> {
    return { 'X-AG-Daemon-Token': String((window as any).__AG_DAEMON_TOKEN__ ?? '') };
  }

  // Fire-and-forget: ships logs to the daemon's log file (webview devtools
  // console isn't tailable after the fact).
  private static remoteLog(message: string, data?: unknown): void {
    try {
      fetch(`${this.DAEMON_URL}/api/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.DAEMON_HEADERS },
        body: JSON.stringify({ level: 'info', message, data })
      }).catch(() => {});
    } catch {
      // never let logging break the actual flow
    }
  }

  // Timestamped daemon-log marker for "this injected script instance came up
  // and started fetching" — diffed against [HUB_RESTART]/[CDP_INJECT] to see
  // real end-to-end switch latency. See docs/decisions/2026-08-22-switch-timing-instrumentation.md.
  public static logRuntimeBoot(): void {
    this.remoteLog('runtime booted, fetching accounts', { pageOrigin: window.location.origin });
  }

  // Unified authenticated JSON request helper to eliminate duplicate fetch boilerplate.
  private static async request<T = any>(
    endpoint: string,
    options?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown }
  ): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
    const method = options?.method ?? (options?.body !== undefined ? 'POST' : 'GET');
    const headers: Record<string, string> = { ...this.DAEMON_HEADERS, ...options?.headers };
    let reqBody: string | undefined;
    if (options?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      reqBody = JSON.stringify(options.body);
    }
    try {
      const res = await fetch(`${this.DAEMON_URL}${endpoint}`, { method, headers, body: reqBody });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, status: res.status, error: data?.error || `Daemon returned ${res.status}` };
      }
      return { ok: true, status: res.status, data };
    } catch (e: any) {
      this.remoteLog(`${endpoint} FAILED`, { errorName: e?.name, errorMessage: e?.message });
      return { ok: false, status: 0, error: e?.message || 'Could not reach the local accounts daemon.' };
    }
  }

  public static async fetchLiveAccounts(): Promise<SubscriptionAccount[]> {
    const res = await this.request<DaemonAccountsResponse>('/api/accounts');
    if (res.ok && res.data) {
      const data = res.data;
      const colors = ['#688e57', '#3b58cc', '#b5a999', '#a6334f', '#2e8b57', '#f6b26b'];
      const accounts: SubscriptionAccount[] = (data.accounts ?? []).map((acc, idx) => {
        const gemWeeklyFraction = findQuotaBucket(acc.quota?.groups, 'gemini-weekly');
        const gem5hFraction = findQuotaBucket(acc.quota?.groups, 'gemini-5h');
        const threePWeeklyFraction = findQuotaBucket(acc.quota?.groups, '3p-weekly');
        const threeP5hFraction = findQuotaBucket(acc.quota?.groups, '3p-5h');

        const gemWeekly = gemWeeklyFraction != null ? Math.round(gemWeeklyFraction * 100) : null;
        const gem5h = gem5hFraction != null ? Math.round(gem5hFraction * 100) : null;
        const threePWeekly = threePWeeklyFraction != null ? Math.round(threePWeeklyFraction * 100) : null;
        const threeP5h = threeP5hFraction != null ? Math.round(threeP5hFraction * 100) : null;

        const known = [gem5h, gemWeekly, threeP5h, threePWeekly].filter((v): v is number => v != null);
        const issue = acc.quota?.issue ?? null;
        const quota = known.length > 0 ? Math.min(...known) : (issue ? 0 : 100);

        return {
          id: acc.account_id,
          name: acc.account_id.split('@')[0],
          plan: acc.plan ?? 'Unknown',
          quotaPercent: quota,
          color: colors[idx % colors.length],
          isActive: Boolean(acc.is_active),
          tokenMask: '••••••••',
          issue: issue ?? (acc.credential_drift ? 'credential_drift' : null),
          geminiWeekly: gemWeekly,
          gemini5h: gem5h,
          threePWeekly: threePWeekly,
          threeP5h: threeP5h,
        };
      });

      if (accounts.length > 0) {
        this.saveAccounts(accounts);
        const active = accounts.find(a => a.isActive);
        if (active) ProfileSyncAdapter.syncBottomTrigger(active);
        window.dispatchEvent(new CustomEvent('ag-account-changed', { detail: { source: 'fetch' } }));
        return accounts;
      }
    } else {
      console.warn('[AccountStore] Daemon unavailable, falling back to cache:', res.error);
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

  public static rememberCurrentLogin(email: string | null): void {
    if (!email || localStorage.getItem(this.CURRENT_LOGIN_KEY) === email) return;
    localStorage.setItem(this.CURRENT_LOGIN_KEY, email);
    localStorage.setItem(this.CURRENT_LOGIN_AT_KEY, String(Date.now()));
    window.dispatchEvent(new CustomEvent('ag-account-changed', { detail: { source: 'identity' } }));
  }

  public static getRememberedCurrentLogin(): string | null {
    const email = localStorage.getItem(this.CURRENT_LOGIN_KEY)?.trim() ?? '';
    const observedAt = Number(localStorage.getItem(this.CURRENT_LOGIN_AT_KEY));
    if (!email || !Number.isFinite(observedAt) || Date.now() - observedAt > this.CURRENT_LOGIN_TTL_MS) return null;
    return email;
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
    if (this.isSwitching) {
      console.warn('[AccountStore] Switch already in progress, ignoring concurrent request');
      this.remoteLog('switchAccount BLOCKED: concurrent switch in progress', { id });
      return false;
    }
    this.isSwitching = true;
    try {
      return await this.doSwitch(id);
    } finally {
      this.isSwitching = false;
    }
  }

  private static async doSwitch(id: string): Promise<boolean> {
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
    const res = await this.request('/api/switch', { body: { accountId: id } });
    if (res.ok) {
      this.remoteLog('switchAccount daemon call succeeded', { id });
      await this.fetchLiveAccounts(); // re-read real state, don't trust the optimistic flip
      return true;
    }

    console.error('[AccountStore] Daemon switch call failed, rolling back:', res.error);
    this.remoteLog('switchAccount daemon call FAILED, rolling back', {
      id,
      error: res.error,
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

  // Shared by every UI entry point so confirmation wording can't drift between
  // them. Does not skip on cached isActive — see docs/decisions/account-switch-semantics.md.
  public static async confirmAndSwitch(id: string): Promise<boolean> {
    const isMasked = getMaskEmails();
    const displayId = maskEmail(id, isMasked);
    const proceed = await showConfirm(
      t().confirmSwitchMessage(displayId),
      {
        title: t().confirmSwitchTitle,
        okText: t().confirmSwitchOk,
        cancelText: t().cancel,
      }
    );
    if (!proceed) return false;

    const progress = showProgress(
      t().switchingTo(displayId),
      t().switchingDetail
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
      await showAlert(t().switchFailed, { title: t().switchFailedTitle, okText: t().switchFailedOk });
    }
    return ok;
  }

  // Opens a Terminal window where the interactive sign-in runs — `login` can't
  // run inside the daemon (see docs/decisions/historical-add-account-terminal-required.md). The sign-in and
  // the follow-up capture both happen in that window, so there's nothing left
  // to drive from here afterwards except a refresh.
  public static async triggerLogin(): Promise<{ ok: boolean; error?: string }> {
    return this.postJson('/api/login');
  }

  // --- Browser-based add-account (see docs/decisions/2026-08-23-add-account-native-browser-final.md) ---
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
    const res = await this.request<{ pending: boolean; backupAccountId?: string; justAdded?: string | null; signedOut?: boolean }>('/api/add-account/status');
    return res.ok && res.data ? res.data : { pending: false };
  }

  private static async postJson<T = any>(path: string, body?: unknown): Promise<{ ok: boolean; error?: string } & any> {
    const res = await this.request<T>(path, {
      method: 'POST',
      headers: { ...this.DAEMON_HEADERS },
      body,
    });
    if (!res.ok) return { ok: false, error: res.error };
    return typeof res.data === 'object' && res.data !== null ? { ok: true, ...res.data } : { ok: true };
  }

  // Reports who the Account panel DOM shows as signed in — see
  // docs/decisions/2026-08-23-never-bare-connect-call.md. noop:true means the daemon didn't
  // act on it (no flow in progress, or it's still the backed-up account).
  public static async reportAddedIdentity(accountId: string): Promise<{ ok: boolean; noop?: boolean; accountId?: string; isNewAccount?: boolean; error?: string }> {
    return this.postJson('/api/add-account/report-identity', { accountId });
  }

  // Dedup lives here rather than at the caller — settingsEnhancer.ts used to
  // compare against its own 20s-stale local account cache, which meant a
  // newly-observed label got re-POSTed on every 1.5s tick (~13x) until that
  // cache caught up. Keying off what this method itself last actually sent
  // is decoupled from that unrelated refresh cycle, so callers can just call
  // this every time a label is observed without tracking staleness
  // themselves.
  private static lastReportedPlan = new Map<string, string>();

  // Reports the "Your Plan: ..." label the Settings → Account page just
  // showed for whichever account is active right now — see
  // SemanticLocator.findAccountPlanLabel() and docs/decisions/2026-08-23-account-plan-tier.md.
  // Fire-and-forget: a failed report just means the plan stays
  // 'Unknown' or shows a stale value until the next successful observation,
  // not a broken flow.
  public static reportPlan(accountId: string, label: string): void {
    if (this.lastReportedPlan.get(accountId) === label) return;
    this.lastReportedPlan.set(accountId, label);
    void this.postJson('/api/report-plan', { accountId, label });
  }

  public static async triggerConnect(accountId?: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.postJson('/api/connect', { accountId });
    if (res.ok) await this.fetchLiveAccounts();
    return res;
  }

  // Returns the failure reason instead of swallowing it — the daemon refuses to
  // remove the signed-in account (409 ACCOUNT_ACTIVE), and silently doing
  // nothing would look identical to a successful removal in the UI.
  public static async removeAccount(id: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.postJson('/api/remove', { accountId: id });
    if (!res.ok) {
      this.remoteLog('removeAccount refused', { id, error: res.error });
      return res;
    }
    this.remoteLog('removeAccount succeeded', { id });
    await this.fetchLiveAccounts();
    return res;
  }

  // The file picker (native VS Code save dialog) runs entirely on the daemon
  // side — see docs/decisions/2026-08-27-export-import.md. `cancelled: true`
  // (user closed the dialog) is not an error, callers should treat it as a
  // silent no-op rather than showing an alert.
  public static async exportAccounts(): Promise<{ ok: boolean; cancelled?: boolean; accounts?: number; credentials?: number; error?: string }> {
    return this.postJson('/api/export');
  }

  public static async importAccounts(): Promise<{ ok: boolean; cancelled?: boolean; imported?: string[]; overwritten?: string[]; credentials?: number; error?: string }> {
    const result = await this.postJson('/api/import');
    if (result.ok && !result.cancelled) await this.fetchLiveAccounts();
    return result;
  }

  public static async refreshAllQuotas(): Promise<void> {
    await this.request('/api/quota-refresh', { method: 'POST' });
    await this.fetchLiveAccounts();
  }
}
