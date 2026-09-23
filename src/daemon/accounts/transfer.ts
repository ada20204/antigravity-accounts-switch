import { AccountStateError, readJson, writeJson } from "./support/files";
import type { CredentialPort, StoredCredentialV3 } from "./credentials/store";
import type { ProfileView } from "./registry";
import { AccountRegistry } from "./registry";
import { accountId } from "./identifiers";

export interface AccountBundle {
  schema: "agent_hub.account_bundle.v1";
  created_at: string;
  profiles: ProfileView[];
  defaults: Record<string, string>;
  credentials: Record<string, StoredCredentialV3 | null>;
}

function inputError(message: string): AccountStateError {
  return new AccountStateError(message, "ACCOUNT_INPUT");
}

export function parseBundle(value: unknown): AccountBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw inputError("account bundle is invalid");
  const input = value as Record<string, unknown>;
  if (input.schema !== "agent_hub.account_bundle.v1" || !Array.isArray(input.profiles)
      || !input.defaults || typeof input.defaults !== "object" || Array.isArray(input.defaults)
      || !input.credentials || typeof input.credentials !== "object" || Array.isArray(input.credentials)) {
    throw inputError("account bundle is invalid or unsupported");
  }
  return input as unknown as AccountBundle;
}

export function createAccountBundle(input: {
  registry: AccountRegistry;
  keychain: CredentialPort;
  accountIds?: string[];
  clock?: () => string;
}): AccountBundle {
  const snapshot = input.registry.snapshot();
  let profiles = snapshot.profiles;
  if (input.accountIds && input.accountIds.length > 0) {
    const filterSet = new Set(input.accountIds.map((id) => accountId(id)));
    profiles = profiles.filter((p) => filterSet.has(p.account_id));
  }
  const profileIdSet = new Set(profiles.map((p) => p.account_id));
  const credentials: Record<string, StoredCredentialV3 | null> = {};
  for (const profile of profiles) {
    credentials[profile.account_id] = input.keychain.exportProfile(profile.account_id);
  }
  const defaults: Record<string, string> = {};
  for (const [provider, currentId] of Object.entries(snapshot.defaults)) {
    if (profileIdSet.has(currentId)) {
      defaults[provider] = currentId;
    }
  }
  return {
    schema: "agent_hub.account_bundle.v1",
    created_at: (input.clock ?? (() => new Date().toISOString()))(),
    profiles,
    defaults,
    credentials,
  };
}

export function applyAccountBundle(input: {
  bundle: AccountBundle;
  registry: AccountRegistry;
  keychain: CredentialPort;
}): { imported: string[]; overwritten: string[]; credentials: number; defaults_applied: string[] } {
  const bundle = input.bundle;
  const normalizedIds = bundle.profiles.map((profile) => accountId(profile.account_id));
  const profileIds = new Set(normalizedIds);
  const credentialIds = Object.keys(bundle.credentials);
  if (profileIds.size !== bundle.profiles.length
      || bundle.profiles.some((profile, index) => profile.account_id !== normalizedIds[index])
      || credentialIds.length !== profileIds.size
      || credentialIds.some((credentialAccountId) => !profileIds.has(credentialAccountId))) {
    throw inputError("account bundle profiles and credentials do not match");
  }
  const previous = new Map<string, StoredCredentialV3 | null>();
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
      imported: mutation.result.imported,
      overwritten: mutation.result.overwritten,
      credentials: credentialCount,
      defaults_applied: mutation.result.defaults_applied,
    };
  } catch (error) {
    for (const [accId, credential] of previous) {
      if (credential) input.keychain.importProfile(accId, credential);
      else input.keychain.remove(accId);
    }
    throw error;
  }
}

export function exportAccounts(input: {
  filePath: string; registry: AccountRegistry; keychain: CredentialPort; clock?: () => string;
}): { schema: "agent_hub.account_export_result.v1"; file: string; accounts: number; credentials: number } {
  const bundle = createAccountBundle(input);
  writeJson(input.filePath, bundle);
  return {
    schema: "agent_hub.account_export_result.v1", file: input.filePath,
    accounts: bundle.profiles.length, credentials: Object.values(bundle.credentials).filter(Boolean).length,
  };
}

export function importAccounts(input: {
  filePath: string; registry: AccountRegistry; keychain: CredentialPort;
}): {
  schema: "agent_hub.account_import_result.v1"; file: string;
  imported: string[]; overwritten: string[]; credentials: number; defaults_applied: string[];
} {
  const bundle = readJson(input.filePath, () => { throw inputError("account bundle was not found"); }, parseBundle);
  const result = applyAccountBundle({ bundle, registry: input.registry, keychain: input.keychain });
  return {
    schema: "agent_hub.account_import_result.v1", file: input.filePath, ...result,
  };
}
