// Vendored/trimmed from agent-hub-accounts (MIT) — see THIRD_PARTY_NOTICES.md
// and docs/decisions/2026-08-26-vendor-agent-hub-accounts.md. Only the cache
// READ path is kept: nothing in this extension populates fresh quota data
// (that requires spawning an isolated hub per account, out of scope here —
// see the doc's quota-refresh note), so put()/fail() and the raw-response
// parsers upstream also has are dead code for this caller and were dropped.

import { readJson } from './support/files';
import type { QuotaIssue, QuotaSnapshot, QuotaState } from './types';
import { AccountStateError } from './support/files';

function emptyState(): QuotaState {
  return { schema: 'agent_hub.account_quota_cache.v3', generation: 0, snapshots: {}, issues: {} };
}

function cachedUserTier(value: unknown): QuotaSnapshot['user_tier'] {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new AccountStateError('quota cache snapshot is invalid');
  const raw = value as Record<string, unknown>;
  const id = String(raw.id ?? '').trim();
  const name = String(raw.name ?? '').trim();
  const observedAt = String(raw.observed_at ?? '');
  if (!id || !name || raw.source !== 'get-user-status' || !Number.isFinite(Date.parse(observedAt))) {
    throw new AccountStateError('quota cache snapshot is invalid');
  }
  return { id, name, source: 'get-user-status', observed_at: observedAt };
}

function parseState(value: unknown): QuotaState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccountStateError('quota cache is invalid');
  const raw = value as Record<string, unknown>;
  if (!['agent_hub.account_quota_cache.v1', 'agent_hub.account_quota_cache.v2', 'agent_hub.account_quota_cache.v3'].includes(String(raw.schema)) || !Number.isInteger(raw.generation)
      || Number(raw.generation) < 0 || !raw.snapshots || typeof raw.snapshots !== 'object' || Array.isArray(raw.snapshots)) {
    throw new AccountStateError('quota cache is invalid');
  }
  const snapshots: Record<string, QuotaSnapshot> = {};
  for (const [key, rawSnapshot] of Object.entries(raw.snapshots as Record<string, Record<string, unknown>>)) {
    if (!['agent_hub.account_quota_snapshot.v1', 'agent_hub.account_quota_snapshot.v2'].includes(String(rawSnapshot?.schema))) {
      throw new AccountStateError('quota cache snapshot is invalid');
    }
    snapshots[key] = {
      ...structuredClone(rawSnapshot),
      schema: 'agent_hub.account_quota_snapshot.v2',
      account_id: rawSnapshot.account_id === undefined ? String(rawSnapshot.account_alias ?? '') || null : rawSnapshot.account_id as string | null,
      user_tier: cachedUserTier(rawSnapshot.user_tier),
    } as QuotaSnapshot;
    delete (snapshots[key] as unknown as Record<string, unknown>).account_alias;
  }
  const issues: Record<string, QuotaIssue> = {};
  const rawIssues = raw.issues ?? {};
  if (!rawIssues || typeof rawIssues !== 'object' || Array.isArray(rawIssues)) throw new AccountStateError('quota cache issues are invalid');
  const allowedIssues = new Set(['eligibility_failed', 'location_unavailable', 'session_invalid', 'query_failed']);
  for (const [key, rawIssue] of Object.entries(rawIssues as Record<string, Record<string, unknown>>)) {
    const code = String(rawIssue?.code ?? '');
    const observedAt = String(rawIssue?.observed_at ?? '');
    if (!allowedIssues.has(code) || !Number.isFinite(Date.parse(observedAt))) throw new AccountStateError('quota cache issue is invalid');
    issues[key] = { code: code as QuotaIssue['code'], observed_at: observedAt };
  }
  return { schema: 'agent_hub.account_quota_cache.v3', generation: Number(raw.generation), snapshots, issues };
}

export function quotaKey(provider: string, accountId = '', generation = 0): string {
  return accountId ? `${provider}:${accountId}:${generation}` : `${provider}:unbound`;
}

export class QuotaCache {
  constructor(private readonly filePath: string, private readonly clock = () => new Date().toISOString()) {}

  get(key = quotaKey('antigravity-cli')): { generation: number; cache_status: 'missing' | 'fresh' | 'stale'; snapshot: QuotaSnapshot | null; issue: QuotaIssue | null } {
    return this.getFromSnapshot(this.snapshot(), key);
  }

  snapshot(): QuotaState {
    return structuredClone(readJson(this.filePath, emptyState, parseState));
  }

  getFromSnapshot(state: QuotaState, key = quotaKey('antigravity-cli')): { generation: number; cache_status: 'missing' | 'fresh' | 'stale'; snapshot: QuotaSnapshot | null; issue: QuotaIssue | null } {
    const snapshot = state.snapshots[key] ?? null;
    return {
      generation: state.generation,
      cache_status: !snapshot ? 'missing' : Date.parse(snapshot.expires_at) > Date.parse(this.clock()) ? 'fresh' : 'stale',
      snapshot: structuredClone(snapshot),
      issue: structuredClone(state.issues[key] ?? null),
    };
  }
}
