import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountStateError } from "../support/files";
import { decodeStandaloneToken } from "./credentials";

const SERVICE = "gemini";
const ACCOUNT = "antigravity";
const DEFAULT_AGY_TOKEN_PATH = path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
const DEFAULT_JETSKI_TOKEN_PATH = path.join(os.homedir(), ".gemini", "jetski-standalone-oauth-token");
const TEST_RUNTIME = process.env.NODE_ENV === "test" || process.argv.includes("--test") || process.execArgv.includes("--test");

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CredentialCommandRunner = (command: string, args: string[], input?: string) => CommandResult;

export interface ActiveCredentialStatus {
  platform: NodeJS.Platform;
  driver: "macos-keychain" | "linux-file-token" | "linux-secret-service" | "windows-credential-manager" | "unavailable";
  format: "credential-envelope" | "standalone-token";
  available: boolean;
  reason: string | null;
}

export interface ActiveCredentialDriver {
  status(): ActiveCredentialStatus;
  hasCredential(): boolean;
  read(): string;
  write(secret: string): void;
  remove(): void;
  syncActiveTokens?(): void;
}

function unavailable(message: string): AccountStateError {
  return new AccountStateError(message, "ACCOUNT_KEYCHAIN_UNAVAILABLE");
}

function validSecret(secret: string, label: string): string {
  const normalized = secret.replace(/\r?\n$/, "");
  if (!normalized || /[\r\n\0]/.test(normalized)) throw unavailable(`${label} has an unsupported secret format`);
  return normalized;
}

function defaultRunner(command: string, args: string[], input?: string): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    timeout: 10_000,
    shell: false,
    windowsHide: true,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error,
  };
}

export class MacCredentialDriver implements ActiveCredentialDriver {
  constructor(
    private readonly run: CredentialCommandRunner = defaultRunner,
    private readonly command = process.env.AGENT_HUB_ACCOUNTS_TEST_SECURITY_BIN || "/usr/bin/security",
    private readonly tokenPath: string | null = process.env.AGENT_HUB_ACCOUNTS_AGY_TOKEN_PATH
      || (TEST_RUNTIME ? null : DEFAULT_AGY_TOKEN_PATH),
    private readonly hubTokenPath: string | null = process.env.AGENT_HUB_ACCOUNTS_JETSKI_TOKEN_PATH
      || (TEST_RUNTIME ? null : DEFAULT_JETSKI_TOKEN_PATH),
  ) {}

  private standaloneToken(secret: string): string {
    if (secret.startsWith("token:")) {
      return decodeStandaloneToken(secret);
    }
    const prefix = "go-keyring-base64:";
    if (!secret.startsWith(prefix)) throw unavailable("Antigravity Keychain profile is not compatible with agy token storage");
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(secret.slice(prefix.length), "base64").toString("utf8"));
    } catch {
      throw unavailable("Antigravity Keychain profile is not compatible with agy token storage");
    }
    if (!decoded || typeof decoded !== "object" || !("token" in decoded) || !decoded.token || typeof decoded.token !== "object") {
      throw unavailable("Antigravity Keychain profile is not compatible with agy token storage");
    }
    const value = decoded as { auth_method?: unknown; token: object; id_token?: unknown };
    const token: Record<string, unknown> = {
      auth_method: typeof value.auth_method === "string" ? value.auth_method : "oauth",
      token: value.token,
    };
    if (typeof value.id_token === "string") token.id_token = value.id_token;
    return JSON.stringify(token);
  }

  private syncSingleTokenFile(filePath: string | null, tokenJson: string): void {
    if (!filePath) return;
    const parent = path.dirname(filePath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw unavailable("token directory is unsafe");
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) throw unavailable("token file is unsafe");
    const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, `${tokenJson}\n`, { mode: 0o600, flag: "wx" });
    try {
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, filePath);
      fs.chmodSync(filePath, 0o600);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  private syncTokenFile(secret: string): void {
    if (!this.tokenPath && !this.hubTokenPath) return;
    const tokenJson = this.standaloneToken(secret);
    this.syncSingleTokenFile(this.tokenPath, tokenJson);
    this.syncSingleTokenFile(this.hubTokenPath, tokenJson);
  }

  status(): ActiveCredentialStatus {
    return { platform: "darwin", driver: "macos-keychain", format: "credential-envelope", available: true, reason: null };
  }

  hasCredential(): boolean {
    const result = this.run(this.command, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
    return !result.error && result.status === 0;
  }

  read(): string {
    const result = this.run(this.command, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
    if (result.error || result.status !== 0) throw unavailable("no active agy login was found in macOS Keychain; complete agy login first");
    return validSecret(result.stdout, "Antigravity Keychain profile");
  }

  write(secret: string): void {
    const normalized = validSecret(secret, "Antigravity credential");
    const result = this.run(this.command, [
      "add-generic-password", "-U",
      "-s", SERVICE,
      "-a", ACCOUNT,
      "-l", "gemini",
      "-X", Buffer.from(normalized, "utf8").toString("hex"),
    ]);
    if (result.error || result.status !== 0) throw unavailable("failed to update the active Antigravity macOS Keychain login");
    this.syncTokenFile(normalized);
  }

  remove(): void {
    const result = this.run(this.command, ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
    if (result.error || result.status !== 0) throw unavailable("failed to detach the active Antigravity macOS Keychain login");
    for (const filePath of [this.tokenPath, this.hubTokenPath]) {
      if (filePath && fs.existsSync(filePath)) {
        if (fs.lstatSync(filePath).isSymbolicLink()) throw unavailable("token file is unsafe");
        fs.unlinkSync(filePath);
      }
    }
  }

  syncActiveTokens(): void {
    if (!this.hasCredential()) {
      if (this.hubTokenPath && fs.existsSync(this.hubTokenPath)) {
        try { fs.unlinkSync(this.hubTokenPath); } catch {}
      }
      return;
    }
    try {
      const secret = this.read();
      const tokenJson = this.standaloneToken(secret);
      const parsed = JSON.parse(tokenJson);
      const expiry = parsed?.token?.expiry;
      if (expiry && new Date(expiry).getTime() <= Date.now()) {
        if (this.hubTokenPath && fs.existsSync(this.hubTokenPath)) {
          try { fs.unlinkSync(this.hubTokenPath); } catch {}
        }
        return;
      }
      this.syncSingleTokenFile(this.tokenPath, tokenJson);
      this.syncSingleTokenFile(this.hubTokenPath, tokenJson);
    } catch {
      // Best-effort
    }
  }
}

export class LinuxSecretServiceDriver implements ActiveCredentialDriver {
  private detectedStatus: ActiveCredentialStatus | null = null;

  constructor(
    private readonly run: CredentialCommandRunner = defaultRunner,
    private readonly command = process.env.AGENT_HUB_ACCOUNTS_SECRET_TOOL_BIN
      || process.env.AGENT_HUB_ACCOUNTS_TEST_SECRET_TOOL_BIN
      || "secret-tool",
    private readonly sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS || "",
    private readonly inspect: CredentialCommandRunner = defaultRunner,
    private readonly busctlCommand = process.env.AGENT_HUB_ACCOUNTS_BUSCTL_BIN || "busctl",
  ) {}

  status(): ActiveCredentialStatus {
    if (this.detectedStatus) return this.detectedStatus;
    if (!this.sessionBus) {
      this.detectedStatus = { platform: "linux", driver: "linux-secret-service", format: "credential-envelope", available: false, reason: "DBUS_SESSION_BUS_ADDRESS is unavailable" };
      return this.detectedStatus;
    }
    const result = this.run(this.command, []);
    if (result.error || result.status === null || !/secret-tool (?:store|lookup)/.test(`${result.stdout}\n${result.stderr}`)) {
      this.detectedStatus = { platform: "linux", driver: "linux-secret-service", format: "credential-envelope", available: false, reason: "secret-tool is unavailable" };
      return this.detectedStatus;
    }
    const alias = this.inspect(this.busctlCommand, [
      "--user", "call",
      "org.freedesktop.secrets",
      "/org/freedesktop/secrets",
      "org.freedesktop.Secret.Service",
      "ReadAlias", "s", "login",
    ]);
    if (!alias.error && alias.status === 0 && /^o\s+["']?\/["']?\s*$/.test(alias.stdout.trim())) {
      this.detectedStatus = {
        platform: "linux",
        driver: "linux-secret-service",
        format: "credential-envelope",
        available: false,
        reason: "Secret Service login collection is unavailable",
      };
      return this.detectedStatus;
    }
    this.detectedStatus = { platform: "linux", driver: "linux-secret-service", format: "credential-envelope", available: true, reason: null };
    return this.detectedStatus;
  }

  private fail(result: CommandResult, action: string): never {
    const detail = `${result.stdout}\n${result.stderr}`;
    if (/collection\/login|login collection|Object does not exist at path/i.test(detail)) {
      this.detectedStatus = {
        platform: "linux",
        driver: "linux-secret-service",
        format: "credential-envelope",
        available: false,
        reason: "Secret Service login collection is unavailable",
      };
      throw unavailable("Linux Secret Service login collection is unavailable; initialize and unlock it before shared-live switching");
    }
    throw unavailable(`failed to ${action} the active Antigravity Linux Secret Service login`);
  }

  private requireAvailable(): void {
    const current = this.status();
    if (!current.available) throw unavailable(`Linux Secret Service is unavailable: ${current.reason}`);
  }

  hasCredential(): boolean {
    if (!this.status().available) return false;
    const result = this.run(this.command, ["lookup", "service", SERVICE, "username", ACCOUNT]);
    if (/collection\/login|login collection|Object does not exist at path/i.test(`${result.stdout}\n${result.stderr}`)) {
      this.detectedStatus = {
        platform: "linux",
        driver: "linux-secret-service",
        format: "credential-envelope",
        available: false,
        reason: "Secret Service login collection is unavailable",
      };
    }
    return !result.error && result.status === 0 && Boolean(result.stdout.replace(/\r?\n$/, ""));
  }

  read(): string {
    this.requireAvailable();
    const result = this.run(this.command, ["lookup", "service", SERVICE, "username", ACCOUNT]);
    if (result.error || result.status !== 0) {
      if (/collection\/login|login collection|Object does not exist at path/i.test(`${result.stdout}\n${result.stderr}`)) {
        this.fail(result, "read");
      }
      throw unavailable("no active agy login was found in Linux Secret Service; complete agy login first");
    }
    return validSecret(result.stdout, "Antigravity Secret Service profile");
  }

  write(secret: string): void {
    this.requireAvailable();
    const result = this.run(this.command, [
      "store", "--label", "Password for 'antigravity' on 'gemini'",
      "service", SERVICE,
      "username", ACCOUNT,
    ], validSecret(secret, "Antigravity credential"));
    if (result.error || result.status !== 0) {
      this.fail(result, "update");
    }
  }

  remove(): void {
    this.requireAvailable();
    const result = this.run(this.command, ["clear", "service", SERVICE, "username", ACCOUNT]);
    if (result.error || result.status !== 0) {
      this.fail(result, "detach");
    }
  }
}

export class LinuxFileCredentialDriver implements ActiveCredentialDriver {
  constructor(
    private readonly tokenPath = process.env.AGENT_HUB_ACCOUNTS_AGY_TOKEN_PATH
      || path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    private readonly hubTokenPath: string | null = process.env.AGENT_HUB_ACCOUNTS_JETSKI_TOKEN_PATH
      || (TEST_RUNTIME ? null : DEFAULT_JETSKI_TOKEN_PATH),
  ) {}

  status(): ActiveCredentialStatus {
    const parent = path.dirname(this.tokenPath);
    try {
      if (fs.existsSync(parent)) {
        const stat = fs.lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          return { platform: "linux", driver: "linux-file-token", format: "standalone-token", available: false, reason: "agy token directory is unsafe" };
        }
      }
      if (fs.existsSync(this.tokenPath)) this.checkedTokenFile(this.tokenPath);
      return { platform: "linux", driver: "linux-file-token", format: "standalone-token", available: true, reason: null };
    } catch (error) {
      return {
        platform: "linux",
        driver: "linux-file-token",
        format: "standalone-token",
        available: false,
        reason: error instanceof Error ? error.message : "agy token file is unavailable",
      };
    }
  }

  private checkedTokenFile(target = this.tokenPath): fs.Stats {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      throw unavailable("agy token file is invalid");
    }
    return stat;
  }

  private requireAvailable(): void {
    const current = this.status();
    if (!current.available) throw unavailable(`agy file token storage is unavailable: ${current.reason}`);
  }

  hasCredential(): boolean {
    return this.status().available && fs.existsSync(this.tokenPath) && this.checkedTokenFile().size > 0;
  }

  read(): string {
    this.requireAvailable();
    if (!this.hasCredential()) throw unavailable("no active agy login was found in the file token store; complete agy login first");
    return validSecret(fs.readFileSync(this.tokenPath, "utf8"), "Antigravity standalone token");
  }

  write(secret: string): void {
    this.requireAvailable();
    const token = validSecret(secret, "Antigravity standalone token");
    for (const p of [this.tokenPath, this.hubTokenPath]) {
      if (!p) continue;
      const parent = path.dirname(p);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      const temporary = `${p}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporary, token, { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, p);
        fs.chmodSync(p, 0o600);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
  }

  remove(): void {
    this.requireAvailable();
    for (const p of [this.tokenPath, this.hubTokenPath]) {
      if (p && fs.existsSync(p)) {
        this.checkedTokenFile(p);
        fs.unlinkSync(p);
      }
    }
  }

  syncActiveTokens(): void {
    if (!this.hasCredential()) {
      if (this.hubTokenPath && fs.existsSync(this.hubTokenPath)) {
        try { fs.unlinkSync(this.hubTokenPath); } catch {}
      }
      return;
    }
    try {
      const secret = this.read();
      this.write(secret);
    } catch {
      // Best-effort
    }
  }
}

class UnsupportedCredentialDriver implements ActiveCredentialDriver {
  constructor(private readonly platform: NodeJS.Platform) {}

  status(): ActiveCredentialStatus {
    const driver = this.platform === "win32" ? "windows-credential-manager" : "unavailable";
    const reason = this.platform === "win32" ? "Windows Credential Manager driver is not implemented" : `platform ${this.platform} is unsupported`;
    return { platform: this.platform, driver, format: "credential-envelope", available: false, reason };
  }

  hasCredential(): boolean {
    return false;
  }

  read(): string {
    throw unavailable(this.status().reason || "active credential driver is unavailable");
  }

  write(_secret: string): void {
    throw unavailable(this.status().reason || "active credential driver is unavailable");
  }

  remove(): void {
    throw unavailable(this.status().reason || "active credential driver is unavailable");
  }
}

function activePlatform(): NodeJS.Platform {
  if (process.env.NODE_ENV === "test" && process.env.AGENT_HUB_ACCOUNTS_TEST_SECURITY_BIN) return "darwin";
  if (process.env.NODE_ENV === "test" && process.env.AGENT_HUB_ACCOUNTS_TEST_SECRET_TOOL_BIN) return "linux";
  return process.platform;
}

export function createActiveCredentialDriver(platform = activePlatform()): ActiveCredentialDriver {
  if (platform === "darwin") return new MacCredentialDriver();
  if (platform === "linux") {
    if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.AGENT_HUB_ACCOUNTS_LINUX_FILE_TOKEN === "1") {
      return new LinuxFileCredentialDriver();
    }
    const secretService = new LinuxSecretServiceDriver();
    return secretService.status().available ? secretService : new LinuxFileCredentialDriver();
  }
  return new UnsupportedCredentialDriver(platform);
}
