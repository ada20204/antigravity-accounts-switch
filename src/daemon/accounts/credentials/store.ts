import { timingSafeEqual } from "node:crypto";
import {
  createActiveCredentialDriver,
  type ActiveCredentialDriver,
  type ActiveCredentialStatus,
} from "./active";
import {
  CredentialRepository,
  type CredentialUpdate,
  type StoredCredentialV3,
} from "./credentials";

export { decodeStandaloneToken } from "./credentials";
export type { CredentialUpdate, StoredCredentialV3 } from "./credentials";

export interface CredentialPort {
  activeDriverStatus(): ActiveCredentialStatus;
  activeAvailable(): boolean;
  hasStoredProfile(accountId: string): boolean;
  canActivateProfile(accountId: string): boolean;
  profileMatchesActive(accountId: string): boolean;
  capture(accountId: string, resetIsolated?: boolean): void;
  activate(accountId: string): void;
  detachActive(): void;
  remove(accountId: string): boolean;
  standaloneToken(accountId: string): string;
  reconcileStandaloneToken(accountId: string, expectedToken: string, nextToken: string): CredentialUpdate;
  isolatedCredentialConflictCount(accountId: string): number;
  exportProfile(accountId: string): StoredCredentialV3 | null;
  importProfile(accountId: string, profile: unknown): void;
}

export class CredentialStore implements CredentialPort {
  constructor(
    private readonly repository: CredentialRepository,
    private readonly active: ActiveCredentialDriver = createActiveCredentialDriver(),
  ) {}

  static create(profilesDir: string): CredentialStore {
    return new CredentialStore(new CredentialRepository(profilesDir));
  }

  activeDriverStatus(): ActiveCredentialStatus {
    return this.active.status();
  }

  activeAvailable(): boolean {
    return this.active.status().available && this.active.hasCredential();
  }

  hasStoredProfile(accountId: string): boolean {
    return this.repository.has(accountId);
  }

  canActivateProfile(accountId: string): boolean {
    const status = this.active.status();
    return status.available && this.repository.hasFormat(accountId, status.format);
  }

  profileMatchesActive(accountId: string): boolean {
    if (!this.canActivateProfile(accountId) || !this.active.hasCredential()) return false;
    const active = Buffer.from(this.active.read());
    const status = this.active.status();
    const profile = Buffer.from(status.format === "standalone-token"
      ? this.repository.standaloneToken(accountId)
      : this.repository.activeSecret(accountId));
    return active.length === profile.length && timingSafeEqual(active, profile);
  }

  capture(accountId: string, resetIsolated = false): void {
    const status = this.active.status();
    if (status.format === "standalone-token") this.repository.captureStandalone(accountId, this.active.read());
    else this.repository.capture(accountId, this.active.read(), resetIsolated);
  }

  activate(accountId: string): void {
    const status = this.active.status();
    this.active.write(status.format === "standalone-token"
      ? this.repository.standaloneToken(accountId)
      : this.repository.activeSecret(accountId));
  }

  detachActive(): void {
    this.active.remove();
  }

  remove(accountId: string): boolean {
    return this.repository.remove(accountId);
  }

  standaloneToken(accountId: string): string {
    return this.repository.standaloneToken(accountId);
  }

  reconcileStandaloneToken(accountId: string, expectedToken: string, nextToken: string): CredentialUpdate {
    return this.repository.reconcile(accountId, expectedToken, nextToken);
  }

  isolatedCredentialConflictCount(accountId: string): number {
    return this.repository.conflictCount(accountId);
  }

  exportProfile(accountId: string): StoredCredentialV3 | null {
    return this.repository.export(accountId);
  }

  importProfile(accountId: string, profile: unknown): void {
    this.repository.import(accountId, profile);
  }
}
