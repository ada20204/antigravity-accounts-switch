import fs from "node:fs";
import path from "node:path";
import { AccountStateError, readJson, withFileLock, writeJson } from "../support/files";
import { accountId } from "../identifiers";

export interface StoredCredentialV3 {
  schema: "agent_hub.antigravity_credential.v3";
  account_id: string;
  active_secret_base64: string | null;
  isolated_secret_base64: string;
  isolated_conflicts_base64: string[];
}

export type CredentialUpdate = "unchanged" | "equivalent" | "updated" | "conflict";

function unavailable(message: string): AccountStateError {
  return new AccountStateError(message, "ACCOUNT_KEYCHAIN_UNAVAILABLE");
}

function refreshToken(token: string): string {
  const parsed = JSON.parse(token) as { refresh_token?: string; token?: { refresh_token?: string } };
  return parsed.refresh_token || parsed.token?.refresh_token || "";
}

export function decodeStandaloneToken(secret: string): string {
  const separator = secret.indexOf(":");
  if (separator < 1) throw unavailable("saved Antigravity account profile has an unsupported credential envelope");
  let token: string;
  try {
    token = Buffer.from(secret.slice(separator + 1), "base64").toString("utf8");
    const parsed = JSON.parse(token) as { refresh_token?: unknown; token?: { refresh_token?: unknown } };
    if (!parsed.refresh_token && !parsed.token?.refresh_token) throw new Error("refresh token missing");
  } catch {
    throw unavailable("saved Antigravity account profile has an unsupported standalone token");
  }
  if (!token || /\0/.test(token)) throw unavailable("saved Antigravity account profile has an unsupported standalone token");
  return token;
}

function decodeSecret(encoded: string, message: string): string {
  const secret = Buffer.from(encoded, "base64").toString("utf8");
  if (!secret || /[\r\n\0]/.test(secret)) throw unavailable(message);
  return secret;
}

function validBase64(value: string): boolean {
  return Boolean(value) && Buffer.from(value, "base64").toString("base64") === value;
}

export class CredentialRepository {
  constructor(private readonly profilesDir: string) {}

  private profilePath(accountIdInput: string): string {
    const normalized = accountId(accountIdInput);
    return path.join(this.profilesDir, `${encodeURIComponent(normalized)}.json`);
  }

  private readProfile(accountIdInput: string): StoredCredentialV3 | null {
    const normalized = accountId(accountIdInput);
    return readJson<StoredCredentialV3 | null>(
      this.profilePath(normalized),
      () => null,
      (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable("saved Antigravity account profile is invalid");
        const stored = value as Record<string, unknown>;
        if (stored.account_id !== normalized) throw unavailable("saved Antigravity account profile is invalid");
        if (stored.schema === "agent_hub.antigravity_credential.v1") {
          const encoded = String(stored.secret_base64 ?? "");
          if (!validBase64(encoded)) throw unavailable("saved Antigravity account profile is invalid");
          return {
            schema: "agent_hub.antigravity_credential.v3",
            account_id: normalized,
            active_secret_base64: encoded,
            isolated_secret_base64: encoded,
            isolated_conflicts_base64: [],
          };
        }
        const active = stored.active_secret_base64 === null ? null : String(stored.active_secret_base64 ?? "");
        const isolated = String(stored.isolated_secret_base64 ?? "");
        const conflicts = stored.isolated_conflicts_base64;
        if (!["agent_hub.antigravity_credential.v2", "agent_hub.antigravity_credential.v3"].includes(String(stored.schema))
            || active !== null && !validBase64(active) || !validBase64(isolated)
            || !Array.isArray(conflicts) || conflicts.length > 4
            || !conflicts.every((item) => typeof item === "string" && validBase64(item))) {
          throw unavailable("saved Antigravity account profile is invalid");
        }
        return {
          schema: "agent_hub.antigravity_credential.v3",
          account_id: normalized,
          active_secret_base64: active,
          isolated_secret_base64: isolated,
          isolated_conflicts_base64: [...conflicts],
        };
      },
    );
  }

  private writeProfile(profile: StoredCredentialV3): void {
    writeJson(this.profilePath(profile.account_id), profile);
  }

  has(accountIdInput: string): boolean {
    return this.readProfile(accountIdInput) !== null;
  }

  activeSecret(accountIdInput: string): string {
    const profile = this.readProfile(accountIdInput);
    if (!profile) throw unavailable("saved Antigravity account profile was not found; run agent-hub-accounts connect first");
    if (!profile.active_secret_base64) throw unavailable("saved account does not contain a credential envelope for this platform");
    return decodeSecret(profile.active_secret_base64, "saved Antigravity account profile is invalid");
  }

  hasFormat(accountIdInput: string, format: "credential-envelope" | "standalone-token"): boolean {
    const profile = this.readProfile(accountIdInput);
    return Boolean(profile && (format === "standalone-token" || profile.active_secret_base64));
  }

  capture(accountIdInput: string, secret: string, resetIsolated = false): void {
    const normalized = accountId(accountIdInput);
    if (!secret || /[\r\n\0]/.test(secret)) throw unavailable("active Antigravity credential is invalid");
    const encoded = Buffer.from(secret, "utf8").toString("base64");
    const existing = this.readProfile(normalized);
    this.writeProfile({
      schema: "agent_hub.antigravity_credential.v3",
      account_id: normalized,
      active_secret_base64: encoded,
      isolated_secret_base64: !existing || resetIsolated ? encoded : existing.isolated_secret_base64,
      isolated_conflicts_base64: !existing || resetIsolated ? [] : existing.isolated_conflicts_base64,
    });
  }

  captureStandalone(accountIdInput: string, token: string): void {
    const normalized = accountId(accountIdInput);
    const isolatedSecret = `token:${Buffer.from(token, "utf8").toString("base64")}`;
    decodeStandaloneToken(isolatedSecret);
    const existing = this.readProfile(normalized);
    this.writeProfile({
      schema: "agent_hub.antigravity_credential.v3",
      account_id: normalized,
      active_secret_base64: existing?.active_secret_base64 ?? null,
      isolated_secret_base64: Buffer.from(isolatedSecret, "utf8").toString("base64"),
      isolated_conflicts_base64: [],
    });
  }

  remove(accountIdInput: string): boolean {
    const normalized = accountId(accountIdInput);
    if (!this.readProfile(normalized)) return false;
    fs.unlinkSync(this.profilePath(normalized));
    return true;
  }

  standaloneToken(accountIdInput: string): string {
    const profile = this.readProfile(accountIdInput);
    if (!profile) throw unavailable("saved Antigravity account profile was not found; run agent-hub-accounts connect first");
    return decodeStandaloneToken(decodeSecret(profile.isolated_secret_base64, "saved Antigravity account profile is invalid"));
  }

  conflictCount(accountIdInput: string): number {
    return this.readProfile(accountIdInput)?.isolated_conflicts_base64.length ?? 0;
  }

  export(accountIdInput: string): StoredCredentialV3 | null {
    const profile = this.readProfile(accountIdInput);
    return profile ? structuredClone(profile) : null;
  }

  import(accountIdInput: string, value: unknown): void {
    const normalized = accountId(accountIdInput);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable("imported Antigravity account profile is invalid");
    const input = value as Record<string, unknown>;
    const profile: StoredCredentialV3 = {
      schema: "agent_hub.antigravity_credential.v3",
      account_id: String(input.account_id),
      active_secret_base64: input.active_secret_base64 === null ? null : String(input.active_secret_base64 ?? ""),
      isolated_secret_base64: String(input.isolated_secret_base64 ?? ""),
      isolated_conflicts_base64: Array.isArray(input.isolated_conflicts_base64)
        ? input.isolated_conflicts_base64.map(String) : [],
    };
    if (!["agent_hub.antigravity_credential.v2", "agent_hub.antigravity_credential.v3"].includes(String(input.schema)) || profile.account_id !== normalized
        || profile.isolated_conflicts_base64.length > 4
        || profile.active_secret_base64 !== null && !validBase64(profile.active_secret_base64)
        || ![profile.isolated_secret_base64, ...profile.isolated_conflicts_base64].every(validBase64)) {
      throw unavailable("imported Antigravity account profile is invalid");
    }
    if (profile.active_secret_base64) decodeSecret(profile.active_secret_base64, "imported Antigravity account profile is invalid");
    decodeStandaloneToken(decodeSecret(profile.isolated_secret_base64, "imported Antigravity account profile is invalid"));
    this.writeProfile(profile);
  }

  reconcile(accountIdInput: string, expectedToken: string, nextToken: string): CredentialUpdate {
    const normalized = accountId(accountIdInput);
    decodeStandaloneToken(`token:${Buffer.from(nextToken, "utf8").toString("base64")}`);
    if (expectedToken === nextToken) return "unchanged";
    if (refreshToken(expectedToken) === refreshToken(nextToken)) {
      // Access token changed but refresh token is the same — persist the
      // refreshed token so subsequent workers avoid redundant refreshes.
      return withFileLock(this.profilePath(normalized), () => {
        const profile = this.readProfile(normalized);
        if (!profile) return "equivalent";
        const currentSecret = decodeSecret(profile.isolated_secret_base64, "saved Antigravity account profile is invalid");
        const currentToken = decodeStandaloneToken(currentSecret);
        // Only update if the on-disk token still matches what we expected.
        if (currentToken !== expectedToken && currentToken !== nextToken) return "equivalent";
        if (currentToken === nextToken) return "equivalent";
        const separator = currentSecret.indexOf(":");
        const nextSecret = `${currentSecret.slice(0, separator + 1)}${Buffer.from(nextToken, "utf8").toString("base64")}`;
        profile.isolated_secret_base64 = Buffer.from(nextSecret, "utf8").toString("base64");
        this.writeProfile(profile);
        return "equivalent";
      });
    }
    return withFileLock(this.profilePath(normalized), () => {
      const profile = this.readProfile(normalized);
      if (!profile) throw unavailable("saved Antigravity account profile was not found; run agent-hub-accounts connect first");
      const currentSecret = decodeSecret(profile.isolated_secret_base64, "saved Antigravity account profile is invalid");
      const currentToken = decodeStandaloneToken(currentSecret);
      if (currentToken === nextToken) return "updated";
      if (refreshToken(currentToken) === refreshToken(nextToken)) return "equivalent";
      const separator = currentSecret.indexOf(":");
      const nextSecret = `${currentSecret.slice(0, separator + 1)}${Buffer.from(nextToken, "utf8").toString("base64")}`;
      const encodedNext = Buffer.from(nextSecret, "utf8").toString("base64");
      if (currentToken !== expectedToken) {
        if (!profile.isolated_conflicts_base64.includes(encodedNext)) {
          profile.isolated_conflicts_base64 = [...profile.isolated_conflicts_base64, encodedNext].slice(-4);
          this.writeProfile(profile);
        }
        return "conflict";
      }
      profile.isolated_secret_base64 = encodedNext;
      profile.isolated_conflicts_base64 = [];
      this.writeProfile(profile);
      return "updated";
    });
  }
}
