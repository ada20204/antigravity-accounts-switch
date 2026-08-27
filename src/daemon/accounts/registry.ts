// Vendored from agent-hub-accounts (MIT), verbatim except import paths — see
// THIRD_PARTY_NOTICES.md and docs/decisions/2026-08-26-vendor-agent-hub-accounts.md.

import { AccountStateError, readJson, withFileLock, writeJson } from './support/files';
import { accountId, providerId } from './identifiers';
import type { AccountProfile, RegistryState } from './types';

export interface ProfileView {
  schema: 'agent_hub.account_profile.v4';
  account_id: string;
  provider: 'antigravity-cli';
  auth_kind: 'oauth-subscription';
  credential_source: 'agy-profile';
  execution_modes: ['shared-cli', 'isolated-hub'];
  enabled: boolean;
  generation: number;
  created_at: string;
  updated_at: string;
}

function inputError(message: string): AccountStateError {
  return new AccountStateError(message, 'ACCOUNT_INPUT');
}

function timestamp(value: unknown): string {
  const normalized = String(value ?? '');
  if (!Number.isFinite(Date.parse(normalized))) throw new AccountStateError('account timestamp is invalid');
  return normalized;
}

function validateProfileContract(profile: Pick<AccountProfile, 'provider' | 'auth_kind' | 'credential_source'>): void {
  if (profile.provider !== 'antigravity-cli') throw inputError('account driver is unavailable for provider');
  if (profile.auth_kind !== 'oauth-subscription' || profile.credential_source !== 'agy-profile') {
    throw inputError('the Antigravity driver currently supports only captured agy OAuth profiles');
  }
}

function profileFrom(value: Record<string, unknown>, accountKey: string, schema: string): AccountProfile {
  if (schema === 'agent_hub.accounts.v1' && value.auth_mode !== 'current-login') {
    throw inputError('the Antigravity driver currently supports only captured agy OAuth profiles');
  }
  if (['agent_hub.accounts.v2', 'agent_hub.accounts.v3'].includes(schema)
      && (value.auth_kind !== 'oauth-subscription' || value.session_mode !== 'shared-live'
        || value.credential_handle || value.isolation_domain)) {
    throw inputError('the Antigravity driver currently supports only captured agy OAuth profiles');
  }
  const currentSchema = schema === 'agent_hub.accounts.v4';
  const profile: AccountProfile = {
    account_id: accountId(value.account_id ?? value.alias),
    provider: providerId(value.provider),
    auth_kind: currentSchema ? String(value.auth_kind) as AccountProfile['auth_kind'] : 'oauth-subscription',
    credential_source: currentSchema ? String(value.credential_source) as AccountProfile['credential_source'] : 'agy-profile',
    enabled: value.enabled as boolean,
    generation: Number(value.generation),
    created_at: timestamp(value.created_at),
    updated_at: timestamp(value.updated_at),
  };
  if (profile.account_id !== accountKey || typeof value.enabled !== 'boolean' || !Number.isInteger(profile.generation)
      || profile.generation < 1 || Date.parse(profile.updated_at) < Date.parse(profile.created_at)) {
    throw new AccountStateError('account profile is invalid');
  }
  validateProfileContract(profile);
  return profile;
}

function emptyRegistry(): RegistryState {
  return { schema: 'agent_hub.accounts.v4', generation: 0, profiles: {}, defaults: {} };
}

function parseRegistry(value: unknown): RegistryState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccountStateError('account registry is invalid');
  const input = value as Record<string, unknown>;
  const schema = String(input.schema ?? '');
  if (!['agent_hub.accounts.v1', 'agent_hub.accounts.v2', 'agent_hub.accounts.v3', 'agent_hub.accounts.v4'].includes(schema)) {
    throw new AccountStateError('account registry schema is unsupported');
  }
  if (!Number.isInteger(input.generation) || Number(input.generation) < 0 || !input.profiles || !input.defaults
      || typeof input.profiles !== 'object' || Array.isArray(input.profiles)
      || typeof input.defaults !== 'object' || Array.isArray(input.defaults)) {
    throw new AccountStateError('account registry is invalid');
  }
  const profiles: Record<string, AccountProfile> = {};
  for (const [accountKey, raw] of Object.entries(input.profiles as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AccountStateError('account profile is invalid');
    profiles[accountKey] = profileFrom(raw as Record<string, unknown>, accountKey, schema);
  }
  const defaults: Record<string, string> = {};
  for (const [provider, rawAccountId] of Object.entries(input.defaults as Record<string, unknown>)) {
    const normalizedProvider = providerId(provider);
    const normalizedAccountId = accountId(rawAccountId);
    if (!profiles[normalizedAccountId] || profiles[normalizedAccountId].provider !== normalizedProvider) throw new AccountStateError('account default is invalid');
    defaults[normalizedProvider] = normalizedAccountId;
  }
  return { schema: 'agent_hub.accounts.v4', generation: Number(input.generation), profiles, defaults };
}

function view(profile: AccountProfile): ProfileView {
  validateProfileContract(profile);
  return {
    schema: 'agent_hub.account_profile.v4',
    account_id: profile.account_id,
    provider: 'antigravity-cli',
    auth_kind: 'oauth-subscription',
    credential_source: 'agy-profile',
    execution_modes: ['shared-cli', 'isolated-hub'],
    enabled: profile.enabled,
    generation: profile.generation,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  };
}

export class AccountRegistry {
  constructor(private readonly filePath: string, private readonly clock = () => new Date().toISOString()) {}

  private read(): RegistryState {
    return readJson(this.filePath, emptyRegistry, parseRegistry);
  }

  private mutate<T>(operation: (state: RegistryState) => T): { generation: number; result: T } {
    return withFileLock(this.filePath, () => {
      const state = this.read();
      const result = operation(state);
      state.generation += 1;
      writeJson(this.filePath, state);
      return { generation: state.generation, result };
    });
  }

  add(input: { account_id: string; provider: string }): { generation: number; result: ProfileView } {
    const now = timestamp(this.clock());
    const profile: AccountProfile = {
      account_id: accountId(input.account_id),
      provider: providerId(input.provider),
      auth_kind: 'oauth-subscription',
      credential_source: 'agy-profile',
      enabled: true,
      generation: 1,
      created_at: now,
      updated_at: now,
    };
    validateProfileContract(profile);
    return this.mutate((state) => {
      if (state.profiles[profile.account_id]) throw inputError('account ID already exists');
      state.profiles[profile.account_id] = profile;
      return view(profile);
    });
  }

  ensureSharedLive(accountIdInput: string): { generation: number; result: ProfileView; created: boolean } {
    const normalizedAccountId = accountId(accountIdInput);
    const state = this.read();
    const existing = state.profiles[normalizedAccountId];
    if (existing) return { generation: state.generation, result: view(existing), created: false };
    const mutation = this.add({
      account_id: normalizedAccountId,
      provider: 'antigravity-cli',
    });
    return { ...mutation, created: true };
  }

  list(provider = ''): { generation: number; profiles: ProfileView[] } {
    const snapshot = this.snapshot(provider);
    return {
      generation: snapshot.generation,
      profiles: snapshot.profiles,
    };
  }

  snapshot(provider = ''): { generation: number; profiles: ProfileView[]; defaults: Record<string, string> } {
    const state = this.read();
    return {
      generation: state.generation,
      profiles: Object.values(state.profiles)
        .filter((profile) => !provider || profile.provider === provider)
        .sort((left, right) => left.account_id.localeCompare(right.account_id))
        .map(view),
      defaults: structuredClone(state.defaults),
    };
  }

  prepare(accountIdInput: string): { registry_generation: number; profile_generation: number; profile: AccountProfile } {
    const normalizedAccountId = accountId(accountIdInput);
    const state = this.read();
    const profile = state.profiles[normalizedAccountId];
    if (!profile) throw inputError('account ID not found');
    if (!profile.enabled) throw inputError('disabled account cannot be selected');
    validateProfileContract(profile);
    return { registry_generation: state.generation, profile_generation: profile.generation, profile: structuredClone(profile) };
  }

  show(accountIdInput: string): { generation: number; profile: ProfileView; is_default: boolean } {
    const normalizedAccountId = accountId(accountIdInput);
    const state = this.read();
    const profile = state.profiles[normalizedAccountId];
    if (!profile) throw inputError('account ID not found');
    return {
      generation: state.generation,
      profile: view(profile),
      is_default: state.defaults[profile.provider] === profile.account_id,
    };
  }

  use(accountIdInput: string): { generation: number; result: ProfileView } {
    const normalizedAccountId = accountId(accountIdInput);
    return this.mutate((state) => {
      const profile = state.profiles[normalizedAccountId];
      if (!profile || !profile.enabled) throw inputError('enabled account ID not found');
      validateProfileContract(profile);
      state.defaults[profile.provider] = normalizedAccountId;
      return view(profile);
    });
  }

  current(provider = ''): Array<{ provider: string; account_id: string | null; profile: ProfileView | null }> {
    const state = this.read();
    const providers = provider ? [provider] : Object.keys(state.defaults).sort();
    return providers.map((currentProvider) => {
      const currentAccountId = state.defaults[currentProvider] ?? null;
      return { provider: currentProvider, account_id: currentAccountId, profile: currentAccountId ? view(state.profiles[currentAccountId]) : null };
    });
  }

  setEnabled(accountIdInput: string, enabled: boolean): { generation: number; result: ProfileView } {
    const normalizedAccountId = accountId(accountIdInput);
    const now = timestamp(this.clock());
    return this.mutate((state) => {
      const profile = state.profiles[normalizedAccountId];
      if (!profile) throw inputError('account ID not found');
      profile.enabled = enabled;
      profile.generation += 1;
      profile.updated_at = now;
      return view(profile);
    });
  }

  importProfiles(input: { profiles: ProfileView[]; defaults: Record<string, string> }): {
    generation: number;
    result: { imported: string[]; overwritten: string[]; defaults_applied: string[] };
  } {
    const profiles = input.profiles.map((profile) => profileFrom(
      profile as unknown as Record<string, unknown>, accountId(profile.account_id), 'agent_hub.accounts.v4',
    ));
    return this.mutate((state) => {
      const imported: string[] = [];
      const overwritten: string[] = [];
      for (const profile of profiles) {
        if (state.profiles[profile.account_id]) overwritten.push(profile.account_id);
        else imported.push(profile.account_id);
        state.profiles[profile.account_id] = structuredClone(profile);
      }
      const defaultsApplied: string[] = [];
      for (const [providerInput, accountIdInput] of Object.entries(input.defaults)) {
        const provider = providerId(providerInput);
        const normalized = accountId(accountIdInput);
        const profile = state.profiles[normalized];
        if (!profile || profile.provider !== provider) continue;
        state.defaults[provider] = normalized;
        defaultsApplied.push(provider);
      }
      return { imported, overwritten, defaults_applied: defaultsApplied };
    });
  }

  remove(
    accountIdInput: string,
    confirm: string,
    clearDefault = false,
    beforeCommit: (profile: ProfileView) => void = () => undefined,
  ): { generation: number; result: { profile: ProfileView; cleared_default: boolean } } {
    const normalizedAccountId = accountId(accountIdInput);
    if (confirm !== normalizedAccountId) throw inputError('remove requires the exact account ID through --confirm');
    return this.mutate((state) => {
      const profile = state.profiles[normalizedAccountId];
      if (!profile) throw inputError('account ID not found');
      const isDefault = state.defaults[profile.provider] === normalizedAccountId;
      if (isDefault && !clearDefault) throw inputError('default account cannot be removed without --clear-default');
      const profileView = view(profile);
      beforeCommit(profileView);
      if (isDefault) delete state.defaults[profile.provider];
      delete state.profiles[normalizedAccountId];
      return { profile: profileView, cleared_default: isDefault };
    });
  }

  status(): { generation: number; profile_count: number; default_count: number } {
    const state = this.read();
    return {
      generation: state.generation,
      profile_count: Object.keys(state.profiles).length,
      default_count: Object.keys(state.defaults).length,
    };
  }
}
