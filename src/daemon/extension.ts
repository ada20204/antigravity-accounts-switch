// Extension entrypoint — the daemon now lives inside the Antigravity
// extension host instead of a separately-launched process (LaunchAgent or a
// manually-started `npm run daemon`). VS Code's own activate/deactivate
// lifecycle is the entire process lifecycle manager: install/update/reload
// the extension IS restarting the daemon. See
// docs/decisions/2026-08-26-extension-host-daemon.md for why, and for the
// two things this design has to account for that a single global daemon
// never did — each window gets its own daemon on its own port, but CDP port
// 9222 and `pgrep -f "agy --hub"` both see every window, not just this one's
// (handled in cdpInjector.ts / hubRestart.ts, not here).
//
// Only activate()/deactivate() and server wiring (CORS, static files, port
// allocation, on-disk state persistence) live here — the actual /api/*
// business logic is routes.ts. See docs/ISSUES.md's (now resolved)
// "extension.ts 该拆了" entry for why this split happened.

import * as vscode from 'vscode';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startCdpInjectorLoop } from './cdpInjector';
import { startHubReaperLoop, setOwnWorkspacePaths } from './hubRestart';
import { log, LOG_FILE, configureLogger } from './logger';
import { readJsonBody, respondError, isAllowedOrigin } from './httpUtils';
import { loadJsonFile, saveJsonFile } from './jsonStore';
import { createApiRouter, PENDING_ADD_SCHEMA, type PendingAdd, type RouteState } from './routes';

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
const PENDING_ADD_FILE = path.join(os.tmpdir(), 'antigravity-accounts-switch-pending-add.json');
const LAST_ADDED_FILE = path.join(os.tmpdir(), 'antigravity-accounts-switch-last-added.json');

function loadPendingAdd(): PendingAdd | null {
  return loadJsonFile(PENDING_ADD_FILE, parsed => {
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

function loadLastAddedAccountId(): string | null {
  return loadJsonFile(LAST_ADDED_FILE, parsed => {
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
const PLAN_STORE_FILE = path.join(os.tmpdir(), 'antigravity-accounts-switch-plans-v1.json');
const KNOWN_PLANS_SCHEMA = 'antigravity-accounts-switch.known_plans.v1';

function loadKnownPlans(): Record<string, string> {
  return loadJsonFile(PLAN_STORE_FILE, parsed => {
    if (parsed?.schema === KNOWN_PLANS_SCHEMA && parsed.plans && typeof parsed.plans === 'object') return parsed.plans;
    return null;
  }) ?? {};
}

// Cross-process re-entrancy guard for /api/add-account/begin — a file lock,
// not an in-memory flag, since each window now runs its own daemon (see
// docs/decisions/2026-08-26-extension-host-daemon.md). Separate from
// `pendingAdd`: that isn't written until after several awaits, leaving a race
// window an in-memory-only guard couldn't close across processes.
const ADD_ACCOUNT_LOCK_FILE = path.join(os.tmpdir(), 'antigravity-accounts-switch-add-account.lock');
// Generous margin above begin()'s worst realistic runtime — reclaims the lock
// if a daemon died mid-flow without releasing it, so a crash can't wedge
// add-account shut forever.
const ADD_ACCOUNT_LOCK_STALE_MS = 60_000;

function acquireBeginLock(): boolean {
  try {
    const fd = fs.openSync(ADD_ACCOUNT_LOCK_FILE, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(fd);
    return true;
  } catch (e: any) {
    if (e?.code !== 'EEXIST') return false;
    try {
      const age = Date.now() - fs.statSync(ADD_ACCOUNT_LOCK_FILE).mtimeMs;
      if (age < ADD_ACCOUNT_LOCK_STALE_MS) return false;
      fs.rmSync(ADD_ACCOUNT_LOCK_FILE, { force: true });
      return acquireBeginLock();
    } catch {
      return false;
    }
  }
}

function releaseBeginLock(): void {
  try {
    fs.rmSync(ADD_ACCOUNT_LOCK_FILE, { force: true });
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

  setOwnWorkspacePaths((vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath));

  // Tried wiring setWindowReloadFn() here; reverted as unsafe — see
  // docs/decisions/2026-08-26-extension-host-restart-experiment.md.

  const state: RouteState = {
    pendingAdd: loadPendingAdd(),
    lastAddedAccountId: loadLastAddedAccountId(),
    knownPlans: loadKnownPlans(),
    port: 0, // set once listenOnFreePort() resolves below
  };
  if (state.pendingAdd) log('ADD_ACCOUNT', 'resumed pending sign-in from previous daemon run', state.pendingAdd);

  const handleApiRequest = createApiRouter(state, {
    setPendingAdd(value) {
      state.pendingAdd = value ? { schema: PENDING_ADD_SCHEMA, ...value } : null;
      saveJsonFile(PENDING_ADD_FILE, state.pendingAdd, 'ADD_ACCOUNT', 'pending state');
    },
    setLastAddedAccountId(value) {
      state.lastAddedAccountId = value;
      saveJsonFile(LAST_ADDED_FILE, value ? { schema: LAST_ADDED_SCHEMA, accountId: value } : null, 'ADD_ACCOUNT', 'last-added notification');
    },
    saveKnownPlans() {
      saveJsonFile(PLAN_STORE_FILE, { schema: KNOWN_PLANS_SCHEMA, plans: state.knownPlans }, 'PLAN', 'known plans');
    },
    acquireBeginLock,
    releaseBeginLock,
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
      await handleApiRequest(url, req, res);
    } catch (err: any) {
      respondError(res, 500, err.message);
    }
  });

  state.port = await listenOnFreePort(server, PORT_RANGE_START, PORT_RANGE_END);
  log('BOOT', `Listening on http://127.0.0.1:${state.port}`);
  context.subscriptions.push({ dispose: () => server.close() });

  const stopInjector = startCdpInjectorLoop(state.port);
  const stopReaper = startHubReaperLoop();
  context.subscriptions.push({ dispose: stopInjector }, { dispose: stopReaper });
}

export function deactivate(): void {
  // Everything meaningful is registered on context.subscriptions above, and
  // VS Code disposes those automatically on deactivate — see
  // docs/decisions/2026-08-26-extension-host-daemon.md (mirrors sync-mcp's
  // sidecar, whose deactivate() is equally trivial).
}
