// Vendored from agent-hub-accounts (MIT), verbatim except import paths — see
// THIRD_PARTY_NOTICES.md and docs/decisions/2026-08-26-vendor-agent-hub-accounts.md.

import { randomUUID } from 'crypto';
import { AccountStateError, readJson, withFileLock, writeJson } from './files';
import { accountId, providerId } from './identifiers';
import type { AccountProfile, AuthStatus, BindingStatus, LiveSession, LiveState, LoginOperation, LoginState } from './types';

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,95}$/;
const AUTH_STATUSES = new Set<AuthStatus>(['authenticated', 'unauthenticated', 'reauth_required', 'unknown']);
const BINDINGS = new Set<BindingStatus>(['verified', 'operator-bound', 'unbound']);
const LOGIN_STATES = new Set<LoginState>(['needs_user_action', 'blocked', 'completed', 'failed']);

function stateError(message: string): AccountStateError {
  return new AccountStateError(message);
}

function operationId(value: unknown): string {
  const normalized = String(value ?? '').trim();
  if (!OPERATION_ID_PATTERN.test(normalized)) throw stateError('login operation ID is invalid');
  return normalized;
}

function timestamp(value: unknown): string {
  const normalized = String(value ?? '');
  if (!Number.isFinite(Date.parse(normalized))) throw stateError('account live timestamp is invalid');
  return normalized;
}

function emptyState(): LiveState {
  return { schema: 'agent_hub.account_live.v2', generation: 0, sessions: {}, login_operations: {} };
}

function sessionFrom(value: unknown, providerKey: string): LiveSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw stateError('account live session is invalid');
  const raw = value as Record<string, unknown>;
  const provider = providerId(raw.provider);
  const normalizedAccountId = accountId(raw.account_id ?? raw.alias);
  const authStatus = String(raw.auth_status) as AuthStatus;
  const binding = String(raw.binding) as BindingStatus;
  const fingerprint = raw.fingerprint === null ? null : String(raw.fingerprint ?? '');
  if (provider !== providerKey || !AUTH_STATUSES.has(authStatus) || !BINDINGS.has(binding)
      || !Number.isInteger(raw.profile_generation) || Number(raw.profile_generation) < 1
      || (fingerprint && !/^sha256:[a-f0-9]{64}$/.test(fingerprint))) {
    throw stateError('account live session is invalid');
  }
  return {
    provider,
    account_id: normalizedAccountId,
    auth_status: authStatus,
    binding,
    identity_hint: raw.identity_hint ? String(raw.identity_hint).slice(0, 160) : null,
    fingerprint,
    source: String(raw.source ?? 'unknown').slice(0, 96),
    profile_generation: Number(raw.profile_generation),
    observed_at: timestamp(raw.observed_at),
  };
}

function operationFrom(value: unknown, accountKey: string): LoginOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw stateError('account login operation is invalid');
  const raw = value as Record<string, unknown>;
  const normalizedAccountId = accountId(raw.account_id ?? raw.alias);
  const state = String(raw.state) as LoginState;
  if (normalizedAccountId !== accountKey || !LOGIN_STATES.has(state) || !Number.isInteger(raw.profile_generation)
      || Number(raw.profile_generation) < 1) throw stateError('account login operation is invalid');
  return {
    operation_id: operationId(raw.operation_id),
    account_id: normalizedAccountId,
    provider: providerId(raw.provider),
    state,
    strategy: String(raw.strategy ?? 'unknown').slice(0, 96),
    reason_code: raw.reason_code ? String(raw.reason_code).slice(0, 96) : null,
    next_action: raw.next_action ? String(raw.next_action).slice(0, 512) : null,
    profile_generation: Number(raw.profile_generation),
    updated_at: timestamp(raw.updated_at),
  };
}

function parseState(value: unknown): LiveState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw stateError('account live state is invalid');
  const raw = value as Record<string, unknown>;
  if (!['agent_hub.account_live.v1', 'agent_hub.account_live.v2'].includes(String(raw.schema)) || !Number.isInteger(raw.generation)
      || Number(raw.generation) < 0 || !raw.sessions || typeof raw.sessions !== 'object' || Array.isArray(raw.sessions)
      || !raw.login_operations || typeof raw.login_operations !== 'object' || Array.isArray(raw.login_operations)) {
    throw stateError('account live state is invalid');
  }
  const sessions: Record<string, LiveSession> = {};
  for (const [provider, item] of Object.entries(raw.sessions as Record<string, unknown>)) sessions[provider] = sessionFrom(item, provider);
  const operations: Record<string, LoginOperation> = {};
  for (const [accountKey, item] of Object.entries(raw.login_operations as Record<string, unknown>)) operations[accountKey] = operationFrom(item, accountKey);
  return { schema: 'agent_hub.account_live.v2', generation: Number(raw.generation), sessions, login_operations: operations };
}

export class LiveStore {
  constructor(private readonly filePath: string, private readonly clock = () => new Date().toISOString()) {}

  private read(): LiveState {
    return readJson(this.filePath, emptyState, parseState);
  }

  private mutate<T>(operation: (state: LiveState) => T): { generation: number; result: T } {
    return withFileLock(this.filePath, () => {
      const state = this.read();
      const result = operation(state);
      state.generation += 1;
      writeJson(this.filePath, state);
      return { generation: state.generation, result };
    });
  }

  snapshot(): LiveState {
    return structuredClone(this.read());
  }

  current(provider: string): LiveSession | null {
    return structuredClone(this.read().sessions[providerId(provider)] ?? null);
  }

  latestLogin(accountIdInput: string): LoginOperation | null {
    return structuredClone(this.read().login_operations[accountId(accountIdInput)] ?? null);
  }

  observe(profile: AccountProfile, input: { auth_status: AuthStatus; binding: BindingStatus; source: string }): { generation: number; result: LiveSession } {
    if (!AUTH_STATUSES.has(input.auth_status) || !BINDINGS.has(input.binding)) throw stateError('account live observation is invalid');
    return this.mutate((state) => {
      const session: LiveSession = {
        provider: profile.provider,
        account_id: profile.account_id,
        auth_status: input.auth_status,
        binding: input.binding,
        identity_hint: null,
        fingerprint: null,
        source: input.source.slice(0, 96),
        profile_generation: profile.generation,
        observed_at: timestamp(this.clock()),
      };
      state.sessions[profile.provider] = session;
      return structuredClone(session);
    });
  }

  startLogin(profile: AccountProfile, input: Pick<LoginOperation, 'state' | 'strategy' | 'reason_code' | 'next_action'>): { generation: number; result: LoginOperation } {
    if (!LOGIN_STATES.has(input.state)) throw stateError('account login transition is invalid');
    return this.mutate((state) => {
      const operation: LoginOperation = {
        operation_id: `login-${randomUUID()}`,
        account_id: profile.account_id,
        provider: profile.provider,
        ...input,
        profile_generation: profile.generation,
        updated_at: timestamp(this.clock()),
      };
      state.login_operations[profile.account_id] = operation;
      return structuredClone(operation);
    });
  }

  completeLogin(profile: AccountProfile): { generation: number; result: LoginOperation } {
    return this.mutate((state) => {
      const previous = state.login_operations[profile.account_id];
      const operation: LoginOperation = {
        operation_id: previous?.operation_id ?? `login-${randomUUID()}`,
        account_id: profile.account_id,
        provider: profile.provider,
        state: 'completed',
        strategy: previous?.strategy ?? 'external-interactive',
        reason_code: null,
        next_action: null,
        profile_generation: profile.generation,
        updated_at: timestamp(this.clock()),
      };
      state.login_operations[profile.account_id] = operation;
      return structuredClone(operation);
    });
  }
}
