// Vendored/adapted from agent-hub-accounts (MIT) — see THIRD_PARTY_NOTICES.md
// and docs/decisions/2026-08-26-vendor-agent-hub-accounts.md. Read/write paths
// harden the upstream lstat-check-then-act symlink guard to O_NOFOLLOW at the
// actual syscall — see that doc's "为什么没有原样照搬" section.

import fs from 'fs';
import path from 'path';

export class AccountStateError extends Error {
  code: string;

  constructor(message: string, code = 'ACCOUNT_STATE') {
    super(message);
    this.code = code;
  }
}

function isSymlinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ELOOP' || code === 'EMLINK';
}

function ensureParentDirectory(filePath: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) {
    throw new AccountStateError('account state directory is invalid');
  }
  fs.chmodSync(directory, 0o700);
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockOwnerAlive(lockPath: string): boolean {
  let owner: number;
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      owner = Number(fs.readFileSync(fd, 'utf8').trim());
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if (isSymlinkError(error)) return false;
    throw error;
  }
  if (!Number.isInteger(owner) || owner < 1) return false;
  try {
    process.kill(owner, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function tryAcquireFileLock(filePath: string): (() => void) | null {
  ensureParentDirectory(filePath);
  const lockPath = `${filePath}.lock`;
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, String(process.pid));
    } finally {
      fs.closeSync(fd);
    }
    return () => {
      try { fs.unlinkSync(lockPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink()) throw new AccountStateError('account state lock must not use symbolic links');
    if (Date.now() - stat.mtimeMs > 30_000 && !lockOwnerAlive(lockPath)) {
      try { fs.unlinkSync(lockPath); } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      }
    }
    return null;
  }
}

export function withFileLock<T>(filePath: string, operation: () => T): T {
  const deadline = Date.now() + 5_000;
  let release: (() => void) | null = null;
  while (!(release = tryAcquireFileLock(filePath))) {
    if (Date.now() >= deadline) throw new AccountStateError('timed out waiting for account state lock', 'ACCOUNT_LOCK');
    sleep(25);
  }
  try {
    return operation();
  } finally {
    release();
  }
}

export function readJson<T>(filePath: string, empty: () => T, validate: (value: unknown) => T): T {
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    if (isSymlinkError(error)) throw new AccountStateError('account state path must not use symbolic links');
    throw error;
  }
  try {
    const raw = fs.readFileSync(fd, 'utf8');
    try {
      return validate(JSON.parse(raw) as unknown);
    } catch (error) {
      if (error instanceof AccountStateError) throw error;
      throw new AccountStateError('account state is unreadable or invalid');
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function writeJson<T>(filePath: string, value: T): void {
  ensureParentDirectory(filePath);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  // rename() replaces whatever is at filePath (symlink or not) rather than
  // following it, so this step needs no separate symlink guard.
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}
