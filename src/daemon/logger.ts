import fs from 'fs';
import os from 'os';
import path from 'path';

// Single persistent log file, independent of however the process was launched
// (nohup redirect, launchd, plain terminal, or now the extension host) —
// always readable at a fixed path.
export const LOG_FILE = path.join(os.tmpdir(), 'antigravity-accounts-switch.log');

// Every log call always goes to LOG_FILE in full. Whether it ALSO reaches the
// VS Code Output Channel is gated by tag — REQ and FRONTEND fire on every HTTP
// request/frontend event respectively (high volume, low value per line) and
// would drown the channel; everything else fires only on a real one-shot
// event and is exactly what someone watching Output wants to see. See
// docs/decisions/2026-08-26-extension-host-daemon.md.
const VERBOSE_TAGS = new Set(['REQ', 'FRONTEND']);

interface OutputChannelLike {
  appendLine(value: string): void;
}

let outputChannel: OutputChannelLike | undefined;
let verboseLogging = false;

// Called once from extension.ts's activate() with the real vscode.OutputChannel
// and the antigravityAccountsSwitch.verboseLogging setting.
export function configureLogger(channel: OutputChannelLike | undefined, verbose: boolean): void {
  outputChannel = channel;
  verboseLogging = verbose;
}

function isVerboseOnly(tag: string, parts: unknown[]): boolean {
  if (VERBOSE_TAGS.has(tag)) return true;
  // HUB_REAP's strike-progress line ("looks orphaned (1/2)") repeats every
  // reaper tick while a hub accumulates strikes — a diagnostic detail, not a
  // meaningful event. The two lines next to it that fire once when a hub
  // actually gets reaped are NOT gated (hubRestart.ts:423,450 — no "looks
  // orphaned" substring), and stay in the default-visible set.
  if (tag === 'HUB_REAP' && typeof parts[0] === 'string' && parts[0].includes('looks orphaned')) return true;
  return false;
}

export function log(tag: string, ...parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${tag}] ` + parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // best-effort logging only
  }
  if (outputChannel && (verboseLogging || !isVerboseOnly(tag, parts))) {
    outputChannel.appendLine(line);
  }
}
