// Small-state JSON persistence for daemon.ts (pendingAdd, lastAddedAccountId,
// knownPlans) — adapted from agent-hub-accounts' src/support/files.ts
// (readJson/writeJson), with one deliberate simplification: no cross-process
// file lock. That project's callers are separate CLI process invocations that
// can genuinely race each other; this daemon is one long-lived Node process,
// and every mutation here is "update the in-memory value, then call
// saveJsonFile()" with no `await` in between — the single-threaded event loop
// already serializes that, so a lock would guard a race that cannot happen.
//
// What still matters even in a single process: a crash (SIGKILL, OOM) mid-
// write must never leave a truncated, unparseable file behind, and a symlink
// planted at one of these predictable names in the shared os.tmpdir() must
// never redirect a read or write somewhere unintended.
//
// Symlink safety is done with O_NOFOLLOW/O_EXCL open flags at the actual
// syscall, not a separate lstatSync check-then-act — a check-then-act pair
// leaves a race window where a symlink planted between the check and the
// real read/write is still followed; a flag on the open() call itself fails
// atomically instead.

import fs from 'fs';
import { log } from './logger';

export function loadJsonFile<T>(file: string, validate: (parsed: any) => T | null): T | null {
  try {
    // fs.readFileSync's `flag` option is typed string-only even though Node
    // accepts a numeric flag at runtime — fs.openSync's isn't, so the
    // O_NOFOLLOW open happens there instead.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let raw: string;
    try {
      raw = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return validate(JSON.parse(raw));
  } catch (e: any) {
    // ENOENT (nothing saved yet) is the normal, expected state on first
    // boot — anything else (corrupt JSON, EACCES, ELOOP from a symlink, a
    // throwing validate()) is worth a trace, unlike before this had none.
    if (e?.code !== 'ENOENT') log('JSON_STORE', `could not read ${file}`, e?.message ?? String(e));
    return null;
  }
}

// Writes via temp-file + rename so a crash mid-write can never leave a
// truncated file that fails to parse on next boot — rename is atomic at the
// filesystem level, so a reader always sees either the old complete content
// or the new complete content, never a partial one. It also never follows a
// symlink at `file`: POSIX rename() replaces whatever occupies the
// destination path outright rather than writing through it.
export function saveJsonFile(file: string, value: unknown, logTag: string, logContext: string): void {
  try {
    if (value !== null && value !== undefined) {
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(value));
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } else {
      // Deleting is safe even when `file` is a symlink: unlink (what rmSync
      // does here) removes the link itself, it never dereferences a symlink
      // to reach whatever it points at. There is nothing for a symlink guard
      // to protect against on this branch — gating it on one anyway (an
      // earlier version of this file did) meant a symlink could be created
      // but never cleared again, since every future delete attempt would
      // hit the same guard and give up.
      fs.rmSync(file, { force: true });
    }
  } catch (e: any) {
    log(logTag, `could not persist ${logContext}`, e.message);
  }
}
