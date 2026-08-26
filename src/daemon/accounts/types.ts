// Vendored from agent-hub-accounts (MIT), verbatim — see
// THIRD_PARTY_NOTICES.md and docs/decisions/2026-08-26-vendor-agent-hub-accounts.md.

export type AuthKind = 'oauth-subscription';
export type CredentialSource = 'agy-profile';
export type AuthStatus = 'authenticated' | 'unauthenticated' | 'reauth_required' | 'unknown';
export type BindingStatus = 'verified' | 'operator-bound' | 'unbound';
export type LoginState = 'needs_user_action' | 'blocked' | 'completed' | 'failed';

export interface AccountProfile {
  account_id: string;
  provider: string;
  auth_kind: AuthKind;
  credential_source: CredentialSource;
  enabled: boolean;
  generation: number;
  created_at: string;
  updated_at: string;
}

export interface RegistryState {
  schema: 'agent_hub.accounts.v4';
  generation: number;
  profiles: Record<string, AccountProfile>;
  defaults: Record<string, string>;
}

export interface LiveSession {
  provider: string;
  account_id: string;
  auth_status: AuthStatus;
  binding: BindingStatus;
  identity_hint: string | null;
  fingerprint: string | null;
  source: string;
  profile_generation: number;
  observed_at: string;
}

export interface LoginOperation {
  operation_id: string;
  account_id: string;
  provider: string;
  state: LoginState;
  strategy: string;
  reason_code: string | null;
  next_action: string | null;
  profile_generation: number;
  updated_at: string;
}

export interface LiveState {
  schema: 'agent_hub.account_live.v2';
  generation: number;
  sessions: Record<string, LiveSession>;
  login_operations: Record<string, LoginOperation>;
}

export interface QuotaBucket {
  id: string;
  name: string;
  description: string | null;
  window: string;
  remaining_fraction: number;
  reset_time: string;
}

export interface AntigravityUserTier {
  id: string;
  name: string;
  source: 'get-user-status';
  observed_at: string;
}

export interface QuotaSnapshot {
  schema: 'agent_hub.account_quota_snapshot.v2';
  provider: 'antigravity-cli';
  scope: 'shared-live-current-session' | 'isolated-account';
  account_id: string | null;
  attribution: 'unbound' | 'operator-bound' | 'verified';
  source: 'official-cli' | 'official-hub';
  status: 'available';
  observed_at: string;
  expires_at: string;
  user_tier: AntigravityUserTier | null;
  groups: Array<{ name: string; description: string | null; buckets: QuotaBucket[] }>;
}

export type QuotaIssueCode =
  | 'eligibility_failed'
  | 'location_unavailable'
  | 'session_invalid'
  | 'query_failed';

export interface QuotaIssue {
  code: QuotaIssueCode;
  observed_at: string;
}

export interface QuotaState {
  schema: 'agent_hub.account_quota_cache.v3';
  generation: number;
  snapshots: Record<string, QuotaSnapshot>;
  issues: Record<string, QuotaIssue>;
}
