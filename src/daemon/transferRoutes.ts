// /api/export and /api/import — see docs/decisions/2026-08-27-export-import.md.
//
// vscode-free like routes.ts/addAccountRoutes.ts: the actual file picker
// (vscode.window.showSaveDialog/showOpenDialog) can only be called from the
// extension host, so extension.ts injects it as a callback rather than this
// file importing 'vscode' directly — keeps the "which files touch vscode"
// boundary in one place (extension.ts only).

import type { IncomingMessage, ServerResponse } from 'http';
import { log } from './logger';
import { registry, keychain, withFileLock, paths as accountPaths, exportAccounts, importAccounts } from './accounts';
import { respondError } from './httpUtils';

export interface TransferActions {
  // Returns an absolute file path, or undefined if the user cancelled the dialog.
  pickSaveFile(): Promise<string | undefined>;
  pickOpenFile(): Promise<string | undefined>;
}

export function createTransferRouter(actions: TransferActions) {
  return async function handleTransferRequest(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (url.pathname === '/api/export' && req.method === 'POST') {
      try {
        const filePath = await actions.pickSaveFile();
        if (!filePath) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, cancelled: true }));
          return true;
        }
        // Read-only against the Keychain (exportProfile() only reads the
        // saved backup files, never touches the active Keychain slot) — no
        // lock needed for the read side, but the CLI wraps this in the same
        // switchLockPath lock for consistency with every other multi-file
        // registry+keychain operation, so this does too.
        const result = withFileLock(accountPaths.switchLockPath, () => exportAccounts({ filePath, registry, keychain }));
        log('EXPORT', 'exported', result.accounts, 'accounts,', result.credentials, 'credentials, to', filePath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e: any) {
        log('EXPORT', 'FAILED', e.message);
        respondError(res, 500, e.message);
      }
      return true;
    }

    if (url.pathname === '/api/import' && req.method === 'POST') {
      try {
        const filePath = await actions.pickOpenFile();
        if (!filePath) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, cancelled: true }));
          return true;
        }
        // importAccounts() itself is transactional (rolls every keychain
        // write back on any failure) — see transfer.ts. This does NOT touch
        // the active Keychain slot, so it never signs anyone in/out and
        // never needs a hub restart, unlike switch/add-account.
        const result = withFileLock(accountPaths.switchLockPath, () => importAccounts({ filePath, registry, keychain }));
        log('IMPORT', 'imported', result.imported.length, 'overwritten', result.overwritten.length, 'from', filePath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e: any) {
        log('IMPORT', 'FAILED', e.message);
        respondError(res, 500, e.message);
      }
      return true;
    }

    return false;
  };
}
