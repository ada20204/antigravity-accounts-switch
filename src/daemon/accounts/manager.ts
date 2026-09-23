import { AccountStateError } from "./support/files";
import type { CredentialPort } from "./credentials/store";
import { LiveStore } from "./live";
import { AccountRegistry } from "./registry";
import { quotaKey, QuotaCache } from "./quota";

export class AntigravityAccountService {
  constructor(
    readonly registry: AccountRegistry,
    readonly live: LiveStore,
    readonly quota: QuotaCache,
    readonly keychain?: CredentialPort,
  ) {}

  /**
   * Activates the given account in the platform credential store and updates
   * the registry default and live session state.
   *
   * **Known limitation**: if `activate` succeeds but a subsequent step fails
   * (e.g. registry generation drift), the Keychain remains on the new account.
   * Callers that need atomic switch-and-restore (like `run` and `resume`)
   * should wrap the call in their own try/finally to restore the original account.
   */
  switchAccount(accountId: string) {
    if (!this.keychain) throw new AccountStateError("Antigravity Keychain driver is unavailable", "ACCOUNT_KEYCHAIN_UNAVAILABLE");
    const prepared = this.registry.prepare(accountId);
    if (prepared.profile.provider !== "antigravity-cli" || prepared.profile.credential_source !== "agy-profile") {
      throw new AccountStateError("account switch requires an Antigravity shared-live profile", "ACCOUNT_INPUT");
    }
    if (this.keychain.hasStoredProfile(accountId) && !this.keychain.canActivateProfile(accountId)) {
      const activeDriver = this.keychain.activeDriverStatus();
      throw new AccountStateError(
        `shared-live account switching requires an available ${activeDriver.driver} driver${activeDriver.reason ? `: ${activeDriver.reason}` : ""}; use quota or exec with the stored account instead`,
        "ACCOUNT_KEYCHAIN_UNAVAILABLE",
      );
    }
    this.keychain.activate(accountId);
    if (!this.keychain.profileMatchesActive(accountId)) {
      throw new AccountStateError("agy active credential does not match the saved account", "ACCOUNT_SWITCH_UNVERIFIED");
    }
    const current = this.registry.prepare(accountId);
    if (current.registry_generation !== prepared.registry_generation || current.profile_generation !== prepared.profile_generation) {
      throw new AccountStateError("accounts registry generation changed during switch", "ACCOUNT_GENERATION_CHANGED");
    }
    const live = this.live.observe(prepared.profile, { auth_status: "authenticated", binding: "operator-bound", source: "owner-only-file" });
    const selected = this.registry.use(accountId);
    return {
      schema: "agent_hub.account_switch.v2",
      status: "switched",
      provider: prepared.profile.provider,
      account_id: accountId,
      binding: "operator-bound",
      identity_verified: false,
      live_generation: live.generation,
      default_generation: selected.generation,
      quota: { cache_status: "not_queried", observed_at: null, expires_at: null },
      external_state_changed: true,
    };
  }

  overview(provider = "") {
    return this.buildOverview(provider, false);
  }

  verifiedOverview(provider = "") {
    return this.buildOverview(provider, true);
  }

  private buildOverview(provider: string, verifyActive: boolean) {
    const registryState = this.registry.snapshot(provider);
    const defaults = new Map(Object.entries(registryState.defaults));
    const liveState = this.live.snapshot();
    const quotaState = this.quota.snapshot();
    return {
      schema: "agent_hub.accounts_overview.v3",
      registry_generation: registryState.generation,
      live_generation: liveState.generation,
      quota_generation: quotaState.generation,
      accounts: registryState.profiles.map((profile) => {
        const session = liveState.sessions[profile.provider] ?? null;
        const cachedLive = session?.account_id === profile.account_id && session.profile_generation === profile.generation;
        const credentialStored = Boolean(this.keychain?.hasStoredProfile(profile.account_id));
        const canActivate = Boolean(this.keychain?.canActivateProfile(profile.account_id));
        const isActive = verifyActive
          ? canActivate && Boolean(this.keychain?.profileMatchesActive(profile.account_id))
          : Boolean(cachedLive && canActivate);
        const credentialDrift = Boolean(verifyActive && cachedLive && canActivate && !isActive);
        const login = liveState.login_operations[profile.account_id] ?? null;
        const cached = this.quota.getFromSnapshot(quotaState, quotaKey(profile.provider, profile.account_id, profile.generation));
        const credentialConflicts = this.keychain?.isolatedCredentialConflictCount(profile.account_id) ?? 0;
        return {
          account_id: profile.account_id,
          provider: profile.provider,
          auth_kind: profile.auth_kind,
          credential_source: profile.credential_source,
          execution_modes: profile.execution_modes,
          enabled: profile.enabled,
          credential_stored: credentialStored,
          can_activate: canActivate,
          is_default: defaults.get(profile.provider) === profile.account_id,
          is_active: isActive,
          active_verification: verifyActive ? "verified" as const : isActive ? "cached" as const : "not_checked" as const,
          credential_drift: credentialDrift,
          credential_conflicts: credentialConflicts,
          auth: { status: isActive && cachedLive ? session.auth_status : "unknown", binding: isActive && cachedLive ? session.binding : "unbound", observed_at: isActive && cachedLive ? session.observed_at : null },
          login: login ? { state: login.state, reason_code: login.reason_code, updated_at: login.updated_at } : null,
          quota: {
            status: cached.issue ? "unavailable" : cached.snapshot ? cached.cache_status : "unknown",
            observed_at: cached.issue?.observed_at ?? cached.snapshot?.observed_at ?? null,
            expires_at: cached.snapshot?.expires_at ?? null,
            issue: cached.issue?.code ?? null,
            user_tier: cached.snapshot?.user_tier ?? null,
            groups: cached.snapshot?.groups ?? [],
          },
        };
      }),
    };
  }

  quotaBatchSnapshot(source: "plugin-cache" | "isolated-hub" | "native-cli" = "plugin-cache", refreshed = false) {
    const registryState = this.registry.snapshot("antigravity-cli");
    const quotaState = this.quota.snapshot();
    const preferred = registryState.defaults["antigravity-cli"] ?? "";
    const profiles = registryState.profiles.filter((profile) => profile.enabled).sort((left, right) => {
      if (left.account_id === preferred) return -1;
      if (right.account_id === preferred) return 1;
      return left.account_id.localeCompare(right.account_id, undefined, { sensitivity: "base" });
    });
    return {
      schema: "agent_hub.account_quota_batch.v2" as const,
      provider: "antigravity-cli" as const,
      source,
      refreshed,
      registry_generation: registryState.generation,
      quota_generation: quotaState.generation,
      concurrency: 0,
      startup_serialized: false,
      results: profiles.map((profile) => {
        const credentialStored = Boolean(this.keychain?.hasStoredProfile(profile.account_id));
        const cached = this.quota.getFromSnapshot(quotaState, quotaKey(profile.provider, profile.account_id, profile.generation));
        const issue = credentialStored ? cached.issue?.code ?? null : "credential_missing" as const;
        return {
          account_id: profile.account_id,
          enabled: profile.enabled,
          credential_state: credentialStored ? "stored" as const : "missing" as const,
          cache_status: issue ? cached.snapshot ? "stale" as const : "missing" as const : cached.cache_status,
          snapshot: cached.snapshot,
          issue,
          identity_verified: false,
          credential_update: "unmanaged" as const,
        };
      }),
    };
  }

  capture(accountId: string, confirm: string, createProfile = false) {
    if (!accountId || confirm !== accountId) throw new AccountStateError("capture requires the exact account ID through --confirm", "ACCOUNT_INPUT");
    if (createProfile) this.registry.ensureSharedLive(accountId);
    const prepared = this.registry.prepare(accountId);
    if (prepared.profile.auth_kind !== "oauth-subscription" || prepared.profile.credential_source !== "agy-profile") {
      throw new AccountStateError("capture requires an OAuth shared-live account profile", "ACCOUNT_INPUT");
    }
    if (!this.keychain) throw new AccountStateError("Antigravity Keychain driver is unavailable", "ACCOUNT_KEYCHAIN_UNAVAILABLE");
    this.keychain.capture(accountId, true);
    const current = this.registry.prepare(accountId);
    if (current.registry_generation !== prepared.registry_generation || current.profile_generation !== prepared.profile_generation) {
      throw new AccountStateError("accounts registry generation changed during capture", "ACCOUNT_GENERATION_CHANGED");
    }
    const live = this.live.observe(prepared.profile, { auth_status: "authenticated", binding: "operator-bound", source: "official-cli" });
    const login = this.live.completeLogin(prepared.profile);
    return {
      schema: "agent_hub.account_capture.v2",
      status: "captured",
      provider: prepared.profile.provider,
      account_id: accountId,
      binding: "operator-bound",
      identity_verified: false,
      live_generation: login.generation,
      live: live.result,
      login: login.result,
      quota: { cache_status: "not_queried", observed_at: null, expires_at: null },
    };
  }

}
