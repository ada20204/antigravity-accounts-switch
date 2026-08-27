// Vendored from agent-hub-accounts (MIT), verbatim except import paths — see
// THIRD_PARTY_NOTICES.md and docs/decisions/2026-08-26-vendor-agent-hub-accounts.md.

import { timingSafeEqual } from 'crypto';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { AccountStateError, readJson, withFileLock, writeJson } from './support/files';
import { accountId } from './identifiers';

const ACTIVE_SERVICE = 'gemini';
const ACTIVE_ACCOUNT = 'antigravity';

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface StoredCredentialV2 {
  schema: 'agent_hub.antigravity_credential.v2';
  account_id: string;
  active_secret_base64: string;
  isolated_secret_base64: string;
  isolated_conflicts_base64: string[];
}

export type SecurityRunner = (args: string[]) => CommandResult;

export interface KeychainPort {
  activeAvailable(): boolean;
  hasProfile(accountId: string): boolean;
  profileMatchesActive(accountId: string): boolean;
  capture(accountId: string, resetIsolated?: boolean): void;
  activate(accountId: string): void;
  detachActive(): void;
  remove(accountId: string): boolean;
  standaloneToken(accountId: string): string;
  reconcileStandaloneToken(accountId: string, expectedToken: string, nextToken: string): CredentialUpdate;
  isolatedCredentialConflictCount(accountId: string): number;
  exportProfile(accountId: string): StoredCredentialV2 | null;
  importProfile(accountId: string, profile: unknown): void;
}

export type CredentialUpdate = 'unchanged' | 'equivalent' | 'updated' | 'conflict';

function refreshToken(token: string): string {
  const parsed = JSON.parse(token) as { refresh_token?: string; token?: { refresh_token?: string } };
  return parsed.refresh_token || parsed.token?.refresh_token || '';
}

export function decodeStandaloneToken(secret: string): string {
  const separator = secret.indexOf(':');
  if (separator < 1) throw unavailable('saved Antigravity account profile has an unsupported credential envelope');
  let token: string;
  try {
    token = Buffer.from(secret.slice(separator + 1), 'base64').toString('utf8');
    const parsed = JSON.parse(token) as { refresh_token?: unknown; token?: { refresh_token?: unknown } };
    if (!parsed.refresh_token && !parsed.token?.refresh_token) throw new Error('refresh token missing');
  } catch {
    throw unavailable('saved Antigravity account profile has an unsupported standalone token');
  }
  if (!token || /\0/.test(token)) throw unavailable('saved Antigravity account profile has an unsupported standalone token');
  return token;
}

function defaultRunner(args: string[]): CommandResult {
  const testCommand = process.env.NODE_ENV === 'test' ? process.env.AGENT_HUB_ACCOUNTS_TEST_SECURITY_BIN : '';
  const result = spawnSync(testCommand || '/usr/bin/security', args, {
    encoding: 'utf8',
    timeout: 10_000,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    error: result.error,
  };
}

function unavailable(message: string): AccountStateError {
  return new AccountStateError(message, 'ACCOUNT_KEYCHAIN_UNAVAILABLE');
}

function credentialPlatform(): NodeJS.Platform {
  if (process.env.NODE_ENV === 'test' && process.env.AGENT_HUB_ACCOUNTS_TEST_SECURITY_BIN) return 'darwin';
  return process.platform;
}

export class MacKeychain implements KeychainPort {
  constructor(
    private readonly profilesDir: string,
    private readonly run: SecurityRunner = defaultRunner,
    private readonly platform = credentialPlatform(),
  ) {}

  private requireMac(): void {
    if (this.platform !== 'darwin') throw unavailable('native Antigravity account profiles currently require macOS Keychain');
  }

  private exists(service: string, account: string): boolean {
    this.requireMac();
    const result = this.run(['find-generic-password', '-s', service, '-a', account]);
    return !result.error && result.status === 0;
  }

  private readActive(): string {
    this.requireMac();
    const result = this.run(['find-generic-password', '-s', ACTIVE_SERVICE, '-a', ACTIVE_ACCOUNT, '-w']);
    if (result.error || result.status !== 0) throw unavailable('no active agy login was found; complete agy login first');
    const secret = result.stdout.replace(/\r?\n$/, '');
    if (!secret || /[\r\n\0]/.test(secret)) throw unavailable('Antigravity Keychain profile has an unsupported secret format');
    return secret;
  }

  private writeActive(secret: string): void {
    const result = this.run([
      'add-generic-password', '-U',
      '-s', ACTIVE_SERVICE,
      '-a', ACTIVE_ACCOUNT,
      '-l', 'gemini',
      '-X', Buffer.from(secret, 'utf8').toString('hex'),
    ]);
    if (result.error || result.status !== 0) throw unavailable('failed to update the active Antigravity Keychain login');
  }

  private profilePath(accountIdInput: string): string {
    const normalized = accountId(accountIdInput);
    return path.join(this.profilesDir, `${encodeURIComponent(normalized)}.json`);
  }

  private readProfile(accountIdInput: string): StoredCredentialV2 | null {
    const normalized = accountId(accountIdInput);
    return readJson<StoredCredentialV2 | null>(
      this.profilePath(normalized),
      () => null,
      (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw unavailable('saved Antigravity account profile is invalid');
        }
        const stored = value as Record<string, unknown>;
        if (stored.account_id !== normalized) {
          throw unavailable('saved Antigravity account profile is invalid');
        }
        if (stored.schema === 'agent_hub.antigravity_credential.v1') {
          const encoded = String(stored.secret_base64 ?? '');
          if (!encoded || Buffer.from(encoded, 'base64').toString('base64') !== encoded) {
            throw unavailable('saved Antigravity account profile is invalid');
          }
          return {
            schema: 'agent_hub.antigravity_credential.v2',
            account_id: normalized,
            active_secret_base64: encoded,
            isolated_secret_base64: encoded,
            isolated_conflicts_base64: [],
          };
        }
        const active = String(stored.active_secret_base64 ?? '');
        const isolated = String(stored.isolated_secret_base64 ?? '');
        const conflicts = stored.isolated_conflicts_base64;
        if (stored.schema !== 'agent_hub.antigravity_credential.v2'
            || !active || Buffer.from(active, 'base64').toString('base64') !== active
            || !isolated || Buffer.from(isolated, 'base64').toString('base64') !== isolated
            || !Array.isArray(conflicts) || conflicts.length > 4
            || !conflicts.every((item) => typeof item === 'string' && Buffer.from(item, 'base64').toString('base64') === item)) {
          throw unavailable('saved Antigravity account profile is invalid');
        }
        return {
          schema: 'agent_hub.antigravity_credential.v2',
          account_id: normalized,
          active_secret_base64: active,
          isolated_secret_base64: isolated,
          isolated_conflicts_base64: [...conflicts],
        };
      },
    );
  }

  private profileSecret(accountIdInput: string): string {
    const profile = this.readProfile(accountIdInput);
    if (!profile) throw unavailable('saved Antigravity account profile was not found; run connect first');
    const secret = Buffer.from(profile.active_secret_base64, 'base64').toString('utf8');
    if (!secret || /[\r\n\0]/.test(secret)) throw unavailable('saved Antigravity account profile is invalid');
    return secret;
  }

  private isolatedSecret(accountIdInput: string): string {
    const profile = this.readProfile(accountIdInput);
    if (!profile) throw unavailable('saved Antigravity account profile was not found; run connect first');
    const secret = Buffer.from(profile.isolated_secret_base64, 'base64').toString('utf8');
    if (!secret || /[\r\n\0]/.test(secret)) throw unavailable('saved Antigravity account profile is invalid');
    return secret;
  }

  private writeProfile(profile: StoredCredentialV2): void {
    writeJson(this.profilePath(profile.account_id), profile);
  }

  activeAvailable(): boolean {
    return this.platform === 'darwin' && this.exists(ACTIVE_SERVICE, ACTIVE_ACCOUNT);
  }

  hasProfile(accountIdInput: string): boolean {
    return this.platform === 'darwin' && this.readProfile(accountIdInput) !== null;
  }

  profileMatchesActive(accountIdInput: string): boolean {
    if (this.platform !== 'darwin' || !this.activeAvailable() || !this.hasProfile(accountIdInput)) return false;
    const active = Buffer.from(this.readActive());
    const profile = Buffer.from(this.profileSecret(accountIdInput));
    return active.length === profile.length && timingSafeEqual(active, profile);
  }

  capture(accountIdInput: string, resetIsolated = false): void {
    const normalized = accountId(accountIdInput);
    const secret = this.readActive();
    const encoded = Buffer.from(secret, 'utf8').toString('base64');
    const existing = this.readProfile(normalized);
    this.writeProfile({
      schema: 'agent_hub.antigravity_credential.v2',
      account_id: normalized,
      active_secret_base64: encoded,
      isolated_secret_base64: !existing || resetIsolated ? encoded : existing.isolated_secret_base64,
      isolated_conflicts_base64: !existing || resetIsolated ? [] : existing.isolated_conflicts_base64,
    });
  }

  activate(accountIdInput: string): void {
    this.writeActive(this.profileSecret(accountIdInput));
  }

  detachActive(): void {
    this.requireMac();
    const result = this.run(['delete-generic-password', '-s', ACTIVE_SERVICE, '-a', ACTIVE_ACCOUNT]);
    if (result.error || result.status !== 0) throw unavailable('failed to detach the active Antigravity login');
  }

  remove(accountIdInput: string): boolean {
    const normalized = accountId(accountIdInput);
    if (!this.readProfile(normalized)) return false;
    fs.unlinkSync(this.profilePath(normalized));
    return true;
  }

  standaloneToken(accountIdInput: string): string {
    return decodeStandaloneToken(this.isolatedSecret(accountIdInput));
  }

  isolatedCredentialConflictCount(accountIdInput: string): number {
    const profile = this.readProfile(accountIdInput);
    return profile?.isolated_conflicts_base64.length ?? 0;
  }

  exportProfile(accountIdInput: string): StoredCredentialV2 | null {
    const profile = this.readProfile(accountIdInput);
    return profile ? structuredClone(profile) : null;
  }

  importProfile(accountIdInput: string, value: unknown): void {
    const normalized = accountId(accountIdInput);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw unavailable('imported Antigravity account profile is invalid');
    }
    const input = value as Record<string, unknown>;
    const profile: StoredCredentialV2 = {
      schema: String(input.schema) as StoredCredentialV2['schema'],
      account_id: String(input.account_id),
      active_secret_base64: String(input.active_secret_base64 ?? ''),
      isolated_secret_base64: String(input.isolated_secret_base64 ?? ''),
      isolated_conflicts_base64: Array.isArray(input.isolated_conflicts_base64)
        ? input.isolated_conflicts_base64.map(String) : [],
    };
    if (profile.schema !== 'agent_hub.antigravity_credential.v2' || profile.account_id !== normalized) {
      throw unavailable('imported Antigravity account profile is invalid');
    }
    for (const encoded of [profile.active_secret_base64, profile.isolated_secret_base64, ...profile.isolated_conflicts_base64]) {
      if (!encoded || Buffer.from(encoded, 'base64').toString('base64') !== encoded) {
        throw unavailable('imported Antigravity account profile is invalid');
      }
    }
    if (profile.isolated_conflicts_base64.length > 4) throw unavailable('imported Antigravity account profile is invalid');
    const active = Buffer.from(profile.active_secret_base64, 'base64').toString('utf8');
    const isolated = Buffer.from(profile.isolated_secret_base64, 'base64').toString('utf8');
    if (!active || /[\r\n\0]/.test(active)) throw unavailable('imported Antigravity account profile is invalid');
    decodeStandaloneToken(isolated);
    this.writeProfile(profile);
  }

  reconcileStandaloneToken(accountIdInput: string, expectedToken: string, nextToken: string): CredentialUpdate {
    const normalized = accountId(accountIdInput);
    decodeStandaloneToken(`token:${Buffer.from(nextToken, 'utf8').toString('base64')}`);
    if (expectedToken === nextToken) return 'unchanged';
    if (refreshToken(expectedToken) === refreshToken(nextToken)) return 'equivalent';
    return withFileLock(this.profilePath(normalized), () => {
      const profile = this.readProfile(normalized);
      if (!profile) throw unavailable('saved Antigravity account profile was not found; run connect first');
      const currentSecret = Buffer.from(profile.isolated_secret_base64, 'base64').toString('utf8');
      const currentToken = decodeStandaloneToken(currentSecret);
      if (currentToken === nextToken) return 'updated';
      if (refreshToken(currentToken) === refreshToken(nextToken)) return 'equivalent';
      const separator = currentSecret.indexOf(':');
      const nextSecret = `${currentSecret.slice(0, separator + 1)}${Buffer.from(nextToken, 'utf8').toString('base64')}`;
      const encodedNext = Buffer.from(nextSecret, 'utf8').toString('base64');
      if (currentToken !== expectedToken) {
        if (!profile.isolated_conflicts_base64.includes(encodedNext)) {
          profile.isolated_conflicts_base64 = [...profile.isolated_conflicts_base64, encodedNext].slice(-4);
          this.writeProfile(profile);
        }
        return 'conflict';
      }
      profile.isolated_secret_base64 = encodedNext;
      profile.isolated_conflicts_base64 = [];
      this.writeProfile(profile);
      return 'updated';
    });
  }
}
