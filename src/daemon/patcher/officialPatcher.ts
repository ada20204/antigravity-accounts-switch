import fs from 'fs';
import path from 'path';
import os from 'os';
import { log } from '../logger';

export interface PatchResult {
  attempted: boolean;
  patched: boolean;
  targetPath?: string;
  reason?: string;
}

const OFFICIAL_EXT_PREFIX = 'google.google-antigravity-';
const TARGET_PATTERN = /async\s+waitForServerReady\s*\(\s*url\s*,\s*timeoutMs\s*=\s*15000\s*\)/g;
const REPLACEMENT = 'async waitForServerReady(url, timeoutMs = 60000)';

export function patchOfficialExtensionTimeout(customExtensionsDir?: string): PatchResult {
  try {
    const extensionsDir = customExtensionsDir
      || process.env.VSCODE_EXTENSIONS
      || path.join(os.homedir(), '.vscode', 'extensions');

    if (!fs.existsSync(extensionsDir)) {
      return { attempted: false, patched: false, reason: 'extensions directory not found' };
    }

    const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
    const officialDirs = entries
      .filter(e => e.isDirectory() && e.name.startsWith(OFFICIAL_EXT_PREFIX))
      .map(e => path.join(extensionsDir, e.name));

    if (officialDirs.length === 0) {
      return { attempted: false, patched: false, reason: 'no official antigravity extension directory found' };
    }

    let patchedAny = false;
    for (const dir of officialDirs) {
      const extJs = path.join(dir, 'extension.js');
      if (!fs.existsSync(extJs)) continue;

      let content: string;
      try {
        content = fs.readFileSync(extJs, 'utf8');
      } catch (err: any) {
        log('PATCHER', `Failed to read ${extJs}`, err?.message ?? String(err));
        continue;
      }

      if (TARGET_PATTERN.test(content)) {
        TARGET_PATTERN.lastIndex = 0;
        const backupPath = `${extJs}.bak`;
        if (!fs.existsSync(backupPath)) {
          try {
            fs.copyFileSync(extJs, backupPath);
          } catch {
            // best-effort backup
          }
        }
        const updated = content.replace(TARGET_PATTERN, REPLACEMENT);
        fs.writeFileSync(extJs, updated, 'utf8');
        log('PATCHER', `Patched official extension waitForServerReady timeout to 60000ms at ${extJs}`);
        patchedAny = true;
      }
    }

    return { attempted: true, patched: patchedAny };
  } catch (err: any) {
    log('PATCHER', 'Official extension patcher error', err?.message ?? String(err));
    return { attempted: true, patched: false, reason: err?.message ?? String(err) };
  }
}
