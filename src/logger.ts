import fs from 'fs';
import os from 'os';
import path from 'path';

// Single persistent log file, independent of however the process was launched
// (nohup redirect, launchd, plain terminal) — always readable at a fixed path.
export const LOG_FILE = path.join(os.tmpdir(), 'antigravity-accounts-enhancer.log');

export function log(tag: string, ...parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${tag}] ` + parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // best-effort logging only
  }
}
