// Vendored from agent-hub-accounts (MIT), verbatim except import paths — see
// THIRD_PARTY_NOTICES.md and docs/decisions/2026-08-26-vendor-agent-hub-accounts.md.
// Wired into the daemon in docs/decisions/2026-08-27-export-import.md.

import { AccountStateError, readJson, writeJson } from './support/files';
import type { StoredCredentialV2 } from './keychain';
import type { KeychainPort } from './keychain';
import type { ProfileView } from './registry';
import { AccountRegistry } from './registry';
import { accountId } from './identifiers';

interface AccountBundle {
  schema: 'agent_hub.account_bundle.v1';
  created_at: string;
  profiles: ProfileView[];
  defaults: Record<string, string>;
  credentials: Record<string, StoredCredentialV2 | null>;
}

function inputError(message: string): AccountStateError {
  return new AccountStateError(message, 'ACCOUNT_INPUT');
}

function parseBundle(value: unknown): AccountBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inputError('account bundle is invalid');
  const input = value as Record<string, unknown>;
  if (input.schema !== 'agent_hub.account_bundle.v1' || !Array.isArray(input.profiles)
      || !input.defaults || typeof input.defaults !== 'object' || Array.isArray(input.defaults)
      || !input.credentials || typeof input.credentials !== 'object' || Array.isArray(input.credentials)) {
    throw inputError('account bundle is invalid or unsupported');
  }
  return input as unknown as AccountBundle;
}

export function exportAccounts(input: {
  filePath: string; registry: AccountRegistry; keychain: KeychainPort; clock?: () => string;
}): { schema: 'agent_hub.account_export_result.v1'; file: string; accounts: number; credentials: number } {
  const snapshot = input.registry.snapshot();
  const credentials: Record<string, StoredCredentialV2 | null> = {};
  for (const profile of snapshot.profiles) credentials[profile.account_id] = input.keychain.exportProfile(profile.account_id);
  const bundle: AccountBundle = {
    schema: 'agent_hub.account_bundle.v1',
    created_at: (input.clock ?? (() => new Date().toISOString()))(),
    profiles: snapshot.profiles,
    defaults: snapshot.defaults,
    credentials,
  };
  writeJson(input.filePath, bundle);
  return {
    schema: 'agent_hub.account_export_result.v1', file: input.filePath,
    accounts: bundle.profiles.length, credentials: Object.values(credentials).filter(Boolean).length,
  };
}

export function importAccounts(input: {
  filePath: string; registry: AccountRegistry; keychain: KeychainPort;
}): {
  schema: 'agent_hub.account_import_result.v1'; file: string;
  imported: string[]; overwritten: string[]; credentials: number; defaults_applied: string[];
} {
  const bundle = readJson(input.filePath, () => { throw inputError('account bundle was not found'); }, parseBundle);
  const normalizedIds = bundle.profiles.map((profile) => accountId(profile.account_id));
  const profileIds = new Set(normalizedIds);
  const credentialIds = Object.keys(bundle.credentials);
  if (profileIds.size !== bundle.profiles.length
      || bundle.profiles.some((profile, index) => profile.account_id !== normalizedIds[index])
      || credentialIds.length !== profileIds.size
      || credentialIds.some((credentialAccountId) => !profileIds.has(credentialAccountId))) {
    throw inputError('account bundle profiles and credentials do not match');
  }
  const previous = new Map<string, StoredCredentialV2 | null>();
  let credentialCount = 0;
  try {
    for (const profile of bundle.profiles) {
      previous.set(profile.account_id, input.keychain.exportProfile(profile.account_id));
      const credential = bundle.credentials[profile.account_id] ?? null;
      if (credential) {
        input.keychain.importProfile(profile.account_id, credential);
        credentialCount += 1;
      } else {
        input.keychain.remove(profile.account_id);
      }
    }
    const mutation = input.registry.importProfiles({ profiles: bundle.profiles, defaults: bundle.defaults });
    return {
      schema: 'agent_hub.account_import_result.v1', file: input.filePath,
      imported: mutation.result.imported, overwritten: mutation.result.overwritten,
      credentials: credentialCount, defaults_applied: mutation.result.defaults_applied,
    };
  } catch (error) {
    for (const [accountId, credential] of previous) {
      if (credential) input.keychain.importProfile(accountId, credential);
      else input.keychain.remove(accountId);
    }
    throw error;
  }
}
