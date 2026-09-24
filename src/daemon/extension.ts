// Extension entrypoint — the daemon lives inside the Antigravity extension
// host, not a separately-launched process. See
// docs/decisions/2026-08-26-extension-host-daemon.md for why, and for the
// per-window port/hub-scoping this design has to account for.
//
// Only activate()/deactivate() and server wiring live here — /api/* business
// logic is routes.ts. See docs/decisions/2026-08-27-split-extension-ts-routes.md.

import * as vscode from 'vscode';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { startCdpInjectorLoop } from './cdpInjector';
import { startHubReaperLoop, setOwnWorkspacePaths } from './hubRestart';
import { log, LOG_FILE, configureLogger, showOutputChannel } from './logger';
import { readJsonBody, respondError, isAllowedOrigin, requiresDaemonToken, DAEMON_TOKEN_HEADER, DAEMON_CORS_ALLOWED_HEADERS } from './httpUtils';
import { loadJsonFile, saveJsonFile } from './jsonStore';
import { createApiRouter, PENDING_ADD_SCHEMA, type PendingAdd, type RouteState } from './routes';
import { createTransferRouter } from './transferRoutes';
import { createStatusBarManager } from './statusBar';
import { keychain } from './accounts';
import { patchOfficialExtensionTimeout } from './patcher/officialPatcher';

// This window's own daemon port — allocated in activate(), not a fixed
// constant any more (a second window's extension host would hit EADDRINUSE
// on a fixed port; see docs/decisions/2026-08-26-extension-host-daemon.md).
const PORT_RANGE_START = 63820;
const PORT_RANGE_END = 63829;

// __dirname (CommonJS), not import.meta.url — this file compiles to
// CommonJS (tsconfig.extension.json) since the extension host loads it via
// require(). See docs/decisions/2026-08-26-extension-host-daemon.md.
const DIST_DIR = path.join(__dirname, '..', '..', 'dist');
const STATIC_CONTENT_TYPES: Record<string, string> = {
  '/runtime.js': 'text/javascript',
  '/style.css': 'text/css',
};

// --- Add-account flow state ---
// Persisted to disk (not in-memory) so a daemon restart mid-flow can't drop
// it; knownAccountIds distinguishes a genuinely new sign-in from switching to
// an already-saved account. See docs/decisions/add-account-state-persistence.md.
interface StoragePaths {
  pendingAddFile: string;
  lastAddedFile: string;
  planStoreFile: string;
  addAccountLockFile: string;
}

function resolveStoragePaths(storageDir: string): StoragePaths {
  try {
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  } catch {
    // best-effort
  }
  const resolved: StoragePaths = {
    pendingAddFile: path.join(storageDir, 'antigravity-accounts-switch-pending-add.json'),
    lastAddedFile: path.join(storageDir, 'antigravity-accounts-switch-last-added.json'),
    planStoreFile: path.join(storageDir, 'antigravity-accounts-switch-plans-v1.json'),
    addAccountLockFile: path.join(storageDir, 'antigravity-accounts-switch-add-account.lock'),
  };

  // Seamless one-time migration from legacy /tmp to persistent storage
  const legacyPairs = [
    [path.join(os.tmpdir(), 'antigravity-accounts-switch-pending-add.json'), resolved.pendingAddFile],
    [path.join(os.tmpdir(), 'antigravity-accounts-switch-last-added.json'), resolved.lastAddedFile],
    [path.join(os.tmpdir(), 'antigravity-accounts-switch-plans-v1.json'), resolved.planStoreFile],
  ];
  for (const [legacy, dest] of legacyPairs) {
    if (!fs.existsSync(dest) && fs.existsSync(legacy)) {
      try { fs.copyFileSync(legacy, dest); } catch { /* ignore */ }
    }
  }
  return resolved;
}

function loadPendingAdd(file: string): PendingAdd | null {
  return loadJsonFile(file, parsed => {
    if (!parsed?.backupAccountId) return null;
    // A tagged schema this code doesn't recognize (e.g. a future v2 written
    // by a newer daemon) is a real "don't guess" case, same spirit as the
    // never-attribute-a-write rule elsewhere in this file — only a file with
    // no tag at all (predates this field) gets the legacy fallback below.
    if (parsed.schema !== undefined && parsed.schema !== PENDING_ADD_SCHEMA) return null;
    // knownAccountIds (and, before this, the schema tag itself) were added
    // later; a file from an older daemon has neither, so both get the same
    // one-time fallback rather than two separate migration checks for what
    // is really one "predates this shape" case.
    return {
      schema: PENDING_ADD_SCHEMA,
      backupAccountId: parsed.backupAccountId,
      startedAt: parsed.startedAt,
      knownAccountIds: parsed.knownAccountIds ?? [parsed.backupAccountId],
    };
  });
}

const LAST_ADDED_SCHEMA = 'antigravity-accounts-switch.last_added.v1';

function loadLastAddedAccountId(file: string): string | null {
  return loadJsonFile(file, parsed => {
    if (typeof parsed?.accountId !== 'string') return null;
    if (parsed.schema !== undefined && parsed.schema !== LAST_ADDED_SCHEMA) return null;
    return parsed.accountId;
  });
}

// Plan/tier ("Your Plan: ...") only exists in Antigravity's own Settings →
// Account page, and only for whichever account is CURRENTLY active — there is
// no CLI field for it (checked `route --json`: no plan/tier/subscription key
// anywhere in the schema). Same shape as the identity problem this project
// already solved once: read it from the real DOM instead of guessing, and
// persist it here so a later /api/accounts response can still show the plan
// for an account that isn't the active one right now. See
// docs/decisions/2026-08-23-account-plan-tier.md.
// Filename (not just content) carries the version — a structural shape
// change, not an additive one; see docs/decisions/2026-08-25-review-14-findings-fixed.md.
const KNOWN_PLANS_SCHEMA = 'antigravity-accounts-switch.known_plans.v1';

function loadKnownPlans(file: string): Record<string, string> {
  return loadJsonFile(file, parsed => {
    if (parsed?.schema === KNOWN_PLANS_SCHEMA && parsed.plans && typeof parsed.plans === 'object') return parsed.plans;
    return null;
  }) ?? {};
}

// Cross-process re-entrancy guard for /api/add-account/begin — a file lock,
// not an in-memory flag, since each window now runs its own daemon (see
// docs/decisions/2026-08-26-extension-host-daemon.md). Separate from
// `pendingAdd`: that isn't written until after several awaits, leaving a race
// window an in-memory-only guard couldn't close across processes.
// Generous margin above begin()'s worst realistic runtime — reclaims the lock
// if a daemon died mid-flow without releasing it, so a crash can't wedge
// add-account shut forever.
const ADD_ACCOUNT_LOCK_STALE_MS = 60_000;

function acquireBeginLock(lockFile: string): boolean {
  try {
    const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(fd);
    return true;
  } catch (e: any) {
    if (e?.code !== 'EEXIST') return false;
    try {
      const age = Date.now() - fs.statSync(lockFile).mtimeMs;
      if (age < ADD_ACCOUNT_LOCK_STALE_MS) return false;
      fs.rmSync(lockFile, { force: true });
      return acquireBeginLock(lockFile);
    } catch {
      return false;
    }
  }
}

function releaseBeginLock(lockFile: string): void {
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {
    // best-effort
  }
}

// Tries PORT_RANGE_START upward until one binds — a second window's extension
// host would EADDRINUSE on a fixed port, since each window runs its own copy
// of this daemon. Attempts the real listen() directly rather than a
// probe-then-listen check, which would leave a TOCTOU window between the two.
function listenOnFreePort(server: http.Server, startPort: number, endPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = startPort;
    const tryPort = () => {
      const onError = (err: any) => {
        server.removeListener('listening', onListening);
        if (err?.code === 'EADDRINUSE' && port < endPort) {
          port++;
          tryPort();
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    tryPort();
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Antigravity Accounts Switch');
  context.subscriptions.push(outputChannel);
  const verboseLogging = vscode.workspace.getConfiguration('antigravityAccountsSwitch').get<boolean>('verboseLogging', false);
  configureLogger(outputChannel, verboseLogging);

  try {
    keychain.syncActiveTokens();
  } catch (err: any) {
    log('BOOT', 'token sync skipped or failed', err?.message ?? String(err));
  }

  try {
    patchOfficialExtensionTimeout();
  } catch (err: any) {
    log('BOOT', 'official extension patch skipped or failed', err?.message ?? String(err));
  }

  setOwnWorkspacePaths((vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath));

  // Tried wiring setWindowReloadFn() here; reverted as unsafe — see
  // docs/decisions/2026-08-26-extension-host-restart-experiment.md.

  const storageDir = context.globalStorageUri?.fsPath || path.join(os.tmpdir(), 'antigravity-accounts-switch');
  const storagePaths = resolveStoragePaths(storageDir);

  const daemonToken = crypto.randomBytes(32).toString('hex');
  const state: RouteState = {
    pendingAdd: loadPendingAdd(storagePaths.pendingAddFile),
    lastAddedAccountId: loadLastAddedAccountId(storagePaths.lastAddedFile),
    knownPlans: loadKnownPlans(storagePaths.planStoreFile),
    port: 0, // set once listenOnFreePort() resolves below
    daemonToken,
  };
  if (state.pendingAdd) log('ADD_ACCOUNT', 'resumed pending sign-in from previous daemon run', state.pendingAdd);

  let statusBarManager: ReturnType<typeof createStatusBarManager> | null = null;

  const handleApiRequest = createApiRouter(state, {
    setPendingAdd(value) {
      state.pendingAdd = value ? { schema: PENDING_ADD_SCHEMA, ...value } : null;
      saveJsonFile(storagePaths.pendingAddFile, state.pendingAdd, 'ADD_ACCOUNT', 'pending state');
      statusBarManager?.updateStatusBar();
    },
    setLastAddedAccountId(value) {
      state.lastAddedAccountId = value;
      saveJsonFile(storagePaths.lastAddedFile, value ? { schema: LAST_ADDED_SCHEMA, accountId: value } : null, 'ADD_ACCOUNT', 'last-added notification');
      statusBarManager?.updateStatusBar();
    },
    saveKnownPlans() {
      saveJsonFile(storagePaths.planStoreFile, { schema: KNOWN_PLANS_SCHEMA, plans: state.knownPlans }, 'PLAN', 'known plans');
      statusBarManager?.updateStatusBar();
    },
    acquireBeginLock: () => acquireBeginLock(storagePaths.addAccountLockFile),
    releaseBeginLock: () => releaseBeginLock(storagePaths.addAccountLockFile),
    openTerminal(name: string, command: string) {
      const terminal = vscode.window.createTerminal({ name });
      terminal.show(false);
      terminal.sendText(command);
      return Promise.resolve();
    },
  });

  // The file picker is the one piece of /api/export|import that has to run
  // in the extension host — routes/transferRoutes stay vscode-free like the
  // rest of the daemon. See docs/decisions/2026-08-27-export-import.md.
  const handleTransferRequest = createTransferRouter({
    async pickSaveFile() {
      const defaultName = `antigravity-accounts-${new Date().toISOString().slice(0, 10)}.json`;
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultName)),
        filters: { 'Account bundle': ['json'] },
        saveLabel: 'Export accounts',
      });
      return uri?.fsPath;
    },
    async pickOpenFile() {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Account bundle': ['json'] },
        openLabel: 'Import accounts',
      });
      return uris?.[0]?.fsPath;
    },
  });

  log('BOOT', `Daemon activating, log file at ${LOG_FILE}`);

  // HTTP Server for Webview bridge
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = isAllowedOrigin(origin);

    // Rejects outright rather than just reflecting the header — see
    // isAllowedOrigin() in httpUtils.ts and docs/decisions/cors-allowlist-policy.md.
    if (origin && !allowed) {
      log('REQ', req.method, req.url, `origin=${origin}`, 'REJECTED (origin not in allow-list)');
      respondError(res, 403, 'Origin not allowed');
      return;
    }

    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin!);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', DAEMON_CORS_ALLOWED_HEADERS);

    if (requiresDaemonToken(req.method, req.url) && req.headers[DAEMON_TOKEN_HEADER] !== daemonToken) {
      log('REQ', req.method, req.url, `origin=${origin ?? '(none)'}`, 'REJECTED (daemon token)');
      respondError(res, 401, 'Daemon authentication required');
      return;
    }

    log('REQ', req.method, req.url, `origin=${origin ?? '(none)'}`, `corsAllowed=${allowed}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${state.port}`);

    // Serves the built runtime bundle (npm run build:runtime) so the injected
    // loader has no external dependency — see cdpInjector.ts's loaderSrc and
    // docs/decisions/2026-08-26-extension-host-daemon.md.
    const staticContentType = STATIC_CONTENT_TYPES[url.pathname];
    if (staticContentType && req.method === 'GET') {
      try {
        const body = fs.readFileSync(path.join(DIST_DIR, url.pathname));
        res.writeHead(200, { 'Content-Type': staticContentType });
        res.end(body);
      } catch {
        respondError(res, 404, `${url.pathname} not built — run npm run build:runtime`);
      }
      return;
    }

    if (url.pathname === '/api/log' && req.method === 'POST') {
      try {
        const parsed = await readJsonBody(req);
        log('FRONTEND', parsed.level || 'info', parsed.message, parsed.data ?? '');
      } catch {
        log('FRONTEND', 'unparseable body');
      }
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (url.pathname === '/api/export' || url.pathname === '/api/import') {
        await handleTransferRequest(url, req, res);
        return;
      }
      await handleApiRequest(url, req, res);
      if (url.pathname === '/api/switch') {
        statusBarManager?.updateStatusBar();
      }
    } catch (err: any) {
      respondError(res, 500, err.message);
    }
  });

  state.port = await listenOnFreePort(server, PORT_RANGE_START, PORT_RANGE_END);
  log('BOOT', `🚀 Antigravity Accounts Switch v1.2.0 initialized [PID: ${process.pid}]`);
  log('BOOT', `   • Platform: ${process.platform} (${os.release()})`);
  log('BOOT', `   • Bridge Server: http://127.0.0.1:${state.port}`);
  log('BOOT', `   • Log File: ${LOG_FILE}`);
  log('BOOT', `   • Verbose Logging: ${verboseLogging ? 'enabled' : 'disabled'}`);
  context.subscriptions.push({ dispose: () => server.close() });

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityAccountsSwitch.openLogFile', async () => {
      if (!fs.existsSync(LOG_FILE)) {
        vscode.window.showInformationMessage('暂无日志文件生成');
        return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(LOG_FILE));
      await vscode.window.showTextDocument(doc);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityAccountsSwitch.showOutput', () => {
      showOutputChannel(false);
    })
  );

  statusBarManager = createStatusBarManager(context, state);
  context.subscriptions.push({ dispose: () => statusBarManager?.dispose() });

  const stopInjector = startCdpInjectorLoop(state.port, daemonToken);
  const stopReaper = startHubReaperLoop();
  context.subscriptions.push({ dispose: stopInjector }, { dispose: stopReaper });
}

export function deactivate(): void {
  // Everything meaningful is registered on context.subscriptions above, and
  // VS Code disposes those automatically on deactivate — see
  // docs/decisions/2026-08-26-extension-host-daemon.md (mirrors sync-mcp's
  // sidecar, whose deactivate() is equally trivial).
}
