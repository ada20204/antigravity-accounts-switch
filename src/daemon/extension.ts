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

import * as vscode from 'vscode';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { startCdpInjectorLoop } from './cdpInjector';
import { restartAntigravityHub, startHubReaperLoop, setOwnWorkspacePaths } from './hubRestart';
import { log, LOG_FILE, configureLogger } from './logger';
import { runCli, runCliJson, isKeychainActiveAvailable, detachActiveKeychainLogin, AGENT_HUB_DIST } from './cliRunner';
import { readJsonBody, respondError, isAllowedOrigin } from './httpUtils';
import { loadJsonFile, saveJsonFile } from './jsonStore';

const execAsync = promisify(exec);

// This window's own daemon port — allocated in activate(), not a fixed
// constant any more (a second window's extension host would hit EADDRINUSE
// on a fixed port; see docs/decisions/2026-08-26-extension-host-daemon.md).
const PORT_RANGE_START = 63820;
const PORT_RANGE_END = 63829;

// Resolved from the module's own location via CommonJS's __dirname, not
// process.cwd() — mirrors how tsc lays out out/daemon/extension.js relative
// to dist/ at the repo root (same depth daemon.ts used to resolve from
// src/daemon/daemon.ts). This extension is compiled to CommonJS specifically
// (see tsconfig.extension.json) because the VS Code extension host loads
// extensions via require(), which cannot load an ES module — the rest of
// this project stays ESM (package.json's "type": "module"), only the
// compiled output under out/ is CommonJS (out/package.json overrides the
// module type for that subtree). __dirname is CommonJS's native equivalent
// of import.meta.url, which isn't usable here for the same reason.
const DIST_DIR = path.join(__dirname, '..', '..', 'dist');
const STATIC_CONTENT_TYPES: Record<string, string> = {
  '/runtime.js': 'text/javascript',
  '/style.css': 'text/css',
};

// Saved credential profiles, keyed by file name. Small JSON files, and only
// read around a capture, so holding them in memory briefly is cheap.
const CREDENTIALS_DIR = path.join(os.homedir(), '.agent-hub', 'plugins', 'accounts', 'state', 'credentials');

function profileFileFor(accountId: string): string {
  // agent-hub-accounts percent-encodes the address for the file name.
  return path.join(CREDENTIALS_DIR, `${encodeURIComponent(accountId)}.json`);
}

// O_NOFOLLOW on both the snapshot read here and the restore write below —
// these are the actual OAuth credential files, a higher-value target for a
// planted-symlink attack than the plain bookkeeping state jsonStore.ts
// protects, so it would be backwards to leave these two functions unguarded.
function readCredentialFile(filePath: string): Buffer {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function snapshotProfiles(): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  try {
    for (const name of fs.readdirSync(CREDENTIALS_DIR)) {
      if (!name.endsWith('.json')) continue;
      try {
        snapshot.set(name, readCredentialFile(path.join(CREDENTIALS_DIR, name)));
      } catch {
        // a symlink or otherwise-unreadable entry just doesn't get backed up —
        // restoreProfile() already treats "no snapshot for this account" as a
        // no-op, not a hard failure, so this degrades safely.
      }
    }
  } catch {
    // no directory yet — nothing to protect
  }
  return snapshot;
}

// Returns true only if the file actually changed and was put back, so callers
// can tell "this capture overwrote something" from "this capture was a no-op".
function restoreProfile(accountId: string, snapshot: Map<string, Buffer>): boolean {
  const file = profileFileFor(accountId);
  const previous = snapshot.get(path.basename(file));
  if (!previous) return false;
  try {
    if (readCredentialFile(file).equals(previous)) return false;
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeSync(fd, previous);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return true;
  } catch (e: any) {
    log('ADD_ACCOUNT', 'could not revert profile', accountId, e.message);
    return false;
  }
}

// Which saved account the live credential actually belongs to, or null if it
// belongs to none of them. `--verify` byte-compares the Keychain against every
// saved profile; plain `route`/`current` answer from cache and have been seen
// naming an account as active while the Keychain held a different one. This is
// the single chokepoint every "is this account currently active" decision in
// this file should go through — a cached-route shortcut here is exactly what
// destroyed an account once already (see docs/decisions/2026-08-23-never-bare-connect-call.md).
//
// `route` was `current`'s predecessor in agent-hub-accounts and is now a
// deprecated cache-only alias that no longer accepts `--verify` at all (a
// live upstream change, not something this project did) — `current --verify`
// is the direct replacement, and its schema renamed the `active` field to
// `is_active`.
async function resolveActiveAccountId(): Promise<string | null> {
  try {
    const verified = await runCliJson(['current', '--verify', '--json']);
    return (verified.accounts || []).find((a: any) => a.is_active)?.account_id ?? null;
  } catch {
    return null;
  }
}

// What the running hub actually authenticates with. NOT the Keychain: a hub
// started with no Keychain access at all (an SSH session, verified: read
// returns exit 36) still comes up fully authenticated, because it reads this
// file. The Keychain slot is what `agy` the CLI and agent-hub-accounts use.
// Signing the hub out therefore means moving this aside, not just detaching
// the Keychain entry.
const HUB_TOKEN_FILE = path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token');

// --- Add-account flow state ---
//
// Survives the webview reload that the sign-out step triggers, which is why it
// lives here rather than in page state — and persisted to disk, because it also
// has to survive this daemon restarting. That is not hypothetical: a restart
// mid-flow drops the flag, the banner disappears, and a user who is currently
// signed out has no button left to finish or cancel with.
//
// lastAddedAccountId is persisted the same way for the same reason: it used to
// be in-memory only ("a one-shot notification, not state worth persisting"),
// but a daemon restart landing in the gap between report-identity setting it
// and the frontend's next status poll reading it meant the switch itself went
// through (durable via the CLI) while the "Added X" confirmation silently
// never fired — no error, just a flow that completes without ever telling the
// user it succeeded. Both halves of this flow's state now follow the same
// persist-to-disk rule instead of that being a per-field judgment call.
//
// knownAccountIds is the whole point of distinguishing "a new account signed
// in" from "the active credential changed". Comparing against backupAccountId
// alone is not enough: switching to any OTHER already-saved account also
// changes it, and would be announced as a new account that was in the list all
// along.
//
// These three stores are deliberately still shared across every window's
// daemon (one os.tmpdir() path, not per-window) rather than scoped by port —
// see jsonStore.ts's header comment for why: they track one shared underlying
// reality (the Keychain's single active slot; per-account plan labels), not a
// per-window one.
//
// loadJsonFile/saveJsonFile (atomic temp+rename write, symlink-safe — see
// jsonStore.ts) are shared by all three persisted stores below (pendingAdd,
// lastAddedAccountId, knownPlans); each used to hand-roll its own "read JSON
// from os.tmpdir(), tolerate missing/corrupt file, write-or-rm" pair
// independently. `validate` carries whatever back-compat/shape-checking each
// store still needs.
// Schema tags on every persisted shape below — adapted from agent-hub-
// accounts' src/accounts/registry.ts, which tags each on-disk record with a
// `schema` string and migrates or rejects by that tag rather than guessing
// from whatever fields happen to be present. Only one version of each exists
// so far, so this doesn't gate anything strictly yet; it exists so the next
// real format change has an explicit marker to key a migration off instead of
// another ad hoc "field X might be missing" check layered on top of the last
// one (which is exactly how knownAccountIds' fallback below came to exist).
const PENDING_ADD_SCHEMA = 'antigravity-accounts-enhancer.pending_add.v1';
interface PendingAdd {
  schema: typeof PENDING_ADD_SCHEMA;
  backupAccountId: string;
  startedAt: number;
  knownAccountIds: string[];
}
const PENDING_ADD_FILE = path.join(os.tmpdir(), 'antigravity-accounts-enhancer-pending-add.json');
const LAST_ADDED_FILE = path.join(os.tmpdir(), 'antigravity-accounts-enhancer-last-added.json');

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

const LAST_ADDED_SCHEMA = 'antigravity-accounts-enhancer.last_added.v1';

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
// Filename carries the version, not just the content: the pre-schema shape
// was a bare {accountId: label} map, and this wrapped {schema, plans} shape
// isn't just an added field on top of that (like PendingAdd/LastAddedAccountId
// above) — it's a structural change, an older daemon's loadKnownPlans (which
// only ever checked "is this an object") would happily treat the whole
// {schema, plans} wrapper AS the plans map itself. Writing the new shape to a
// brand new filename means an older binary reading the OLD filename never
// sees it, and there's no legacy shape to migrate from under the new name —
// the one-time cost is that plan data observed before this change doesn't
// carry forward (it gets passively re-observed next time Settings is open).
const PLAN_STORE_FILE = path.join(os.tmpdir(), 'antigravity-accounts-enhancer-plans-v1.json');
const KNOWN_PLANS_SCHEMA = 'antigravity-accounts-enhancer.known_plans.v1';

function loadKnownPlans(): Record<string, string> {
  return loadJsonFile(PLAN_STORE_FILE, parsed => {
    if (parsed?.schema === KNOWN_PLANS_SCHEMA && parsed.plans && typeof parsed.plans === 'object') return parsed.plans;
    return null;
  }) ?? {};
}

// Cross-process re-entrancy guard for /api/add-account/begin. Used to be a
// plain in-memory boolean, which was enough when there was exactly one daemon
// process on the whole machine — the extension-host migration
// (docs/decisions/2026-08-26-extension-host-daemon.md) means each window now
// runs its own daemon, so an in-memory flag in window A's process is invisible
// to window B's. A lock file closes that gap. It's separate from `pendingAdd`
// on purpose: pendingAdd isn't written until after several awaits (a --verify
// call, an optional connect, a full hub restart), so two begin() calls racing
// within that window — now possibly from two different windows — could both
// see pendingAdd as null and both proceed, the second silently overwriting the
// first's backupAccountId so a later Cancel restores the wrong account.
const ADD_ACCOUNT_LOCK_FILE = path.join(os.tmpdir(), 'antigravity-accounts-enhancer-add-account.lock');
// This window's own begin() normally clears well inside this — generous
// margin above the same worst-case restart timing WINDOW_RELOAD_GRACE_MS in
// hubRestart.ts already budgets for. Only matters if a daemon process died
// mid-flow without reaching the `finally` release below; without a staleness
// check a crash would wedge add-account shut on every window forever, which
// is worse than the narrow race this lock exists to close.
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

// There used to be a daemon-side poller here that auto-captured a new sign-in
// by calling bare `connect` (no id) every 2s and comparing the guessed id
// against knownAccountIds, reverting if it landed on one. That guess is
// `recentAntigravityEmail()` scanning `~/.gemini/antigravity-cli/log/` — the
// standalone `agy` CLI's log directory. This hub runs with
// `--app_data_dir=antigravity` and writes to the DIFFERENT `~/.gemini/
// antigravity/log/`, which never even contains the `email=` pattern the
// scanner looks for. So the guess isn't merely stale, it is structurally
// incapable of ever reflecting a sign-in performed through this hub: it stays
// frozen at whatever the CLI log last held, from some unrelated terminal
// session, forever. The revert-if-known guard only protected already-saved
// accounts; a stale guess that happened to name an account that had since
// been *removed* sailed straight through and got treated as a legitimate new
// account — which is exactly how a real user's real sign-in got filed under a
// dead account's name and destroyed it (see docs/decisions/2026-08-23-account-corruption-guessing-broken.md).
//
// Replaced with POST /api/add-account/report-identity: the frontend reads the
// signed-in email directly out of Antigravity's own native Account panel DOM
// (SemanticLocator.findAccountPanelEmail()) and reports it explicitly. The id
// is then never guessed — the whole class of misattribution is gone, not just
// guarded against.

// Manual, fully interactive fallback for adding an account — the primary path
// is the in-editor flow (/api/add-account/begin et al.), this exists only
// because `login` categorically cannot run any other way (see the comment at
// the /api/login handler below). No dynamic account id is interpolated here —
// every step runs `connect`/`login` bare — so this plain shell string carries
// none of the injection risk the execFile-based JSON endpoints had to be
// fixed for.
function buildLoginTerminalScript(port: number): string {
  const cli = JSON.stringify(path.join(AGENT_HUB_DIST, 'cli.js'));
  return [
    '#!/bin/bash',
    'set -o pipefail',
    'echo "=== Add a new Antigravity account ==="',
    'echo',
    'echo "Step 1/3: re-saving your current account..."',
    'echo "(Antigravity refreshes its token in the background, so the saved copy"',
    'echo " drifts out of sync. Sign-in refuses to start until it matches again.)"',
    'echo',
    `node ${cli} connect`,
    'if [ $? -ne 0 ]; then',
    '  echo',
    '  echo "Could not re-save the current account, so sign-in was not started."',
    '  echo "Nothing was changed."',
    '  echo "Press Return to close this window."',
    '  read -r _',
    '  exit 1',
    'fi',
    'echo',
    'echo "Step 2/3: sign in with the NEW Google account..."',
    'echo',
    `node ${cli} login`,
    'if [ $? -ne 0 ]; then',
    '  echo',
    '  echo "Sign-in did not complete. Your previous account was restored."',
    '  echo "Press Return to close this window."',
    '  read -r _',
    '  exit 1',
    'fi',
    'echo',
    'echo "Step 3/3: saving the new account..."',
    `node ${cli} connect`,
    'if [ $? -eq 0 ]; then',
    '  echo',
    '  echo "Applying the new account to the running Antigravity session..."',
    // Without this the sign-in leaves the new account active in the
    // Keychain while the running hub keeps serving the old one.
    `  curl -s -X POST http://127.0.0.1:${port}/api/hub-restart >/dev/null 2>&1 || echo "  (could not reach the accounts daemon — restart VS Code to apply)"`,
    '  echo',
    '  echo "Done. The new account is now available in Antigravity."',
    '  echo',
    `  node ${cli} list`,
    'else',
    '  echo',
    '  echo "Sign-in worked but saving it failed. Run: agent-hub-accounts connect"',
    'fi',
    'echo',
    'echo "Press Return to close this window."',
    'read -r _',
  ].join('\n');
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
  const outputChannel = vscode.window.createOutputChannel('Antigravity Accounts');
  context.subscriptions.push(outputChannel);
  const verboseLogging = vscode.workspace.getConfiguration('antigravityAccountsEnhancer').get<boolean>('verboseLogging', false);
  configureLogger(outputChannel, verboseLogging);

  setOwnWorkspacePaths((vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath));

  // Tried wiring setWindowReloadFn() here to workbench.action.restartExtensionHost
  // as a cheaper alternative to the full CDP window reload for begin()'s
  // 'window' reloadStrategy — reverted after a live test: the extension host
  // teardown that command triggers happens fast enough to kill this very
  // process between the reload call returning and setPendingAdd() running a
  // few lines below, so the backup-account record never got written and the
  // user was left signed out with no recorded way back. See
  // docs/decisions/2026-08-26-extension-host-restart-experiment.md for the
  // full account — negative result, not just unverified. windowReloadFn stays
  // at hubRestart.ts's default (the proven CDP full window reload).

  let pendingAdd: PendingAdd | null = loadPendingAdd();
  if (pendingAdd) log('ADD_ACCOUNT', 'resumed pending sign-in from previous daemon run', pendingAdd);
  let lastAddedAccountId: string | null = loadLastAddedAccountId();
  const knownPlans: Record<string, string> = loadKnownPlans();

  function setPendingAdd(value: Omit<PendingAdd, 'schema'> | null): void {
    pendingAdd = value ? { schema: PENDING_ADD_SCHEMA, ...value } : null;
    saveJsonFile(PENDING_ADD_FILE, pendingAdd, 'ADD_ACCOUNT', 'pending state');
  }

  function setLastAddedAccountId(value: string | null): void {
    lastAddedAccountId = value;
    saveJsonFile(LAST_ADDED_FILE, value ? { schema: LAST_ADDED_SCHEMA, accountId: value } : null, 'ADD_ACCOUNT', 'last-added notification');
  }

  function saveKnownPlans(): void {
    saveJsonFile(PLAN_STORE_FILE, { schema: KNOWN_PLANS_SCHEMA, plans: knownPlans }, 'PLAN', 'known plans');
  }

  log('BOOT', `Daemon activating, log file at ${LOG_FILE}`);

  // Declared (not `const`) and assigned its real value only after
  // listenOnFreePort() resolves below — but initialized here, before the
  // request handler closure that reads it is created, so that closure never
  // hits the temporal-dead-zone case of reading a `const` before its
  // initializer has run. No request can actually be routed before
  // server.listen() succeeds, so by the time this closure runs, the
  // reassignment below has always already happened.
  let port = 0;

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

    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

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
      if (url.pathname === '/api/accounts' && req.method === 'GET') {
        // `route --json` is agent-hub-accounts' now-deprecated cache-only alias
        // (a live upstream change): it still runs, but returns a different
        // schema (`agent_hub.account_quota_batch.v2`, a `results` array with no
        // `active`/`accounts` fields at all) — silently parsed here as "zero
        // accounts" before this fix, since `parsed.accounts` was just
        // `undefined`. `list --json` (`agent_hub.account_list.v3`) is the
        // current replacement; runtime/services/accountStore.ts's parsing was
        // updated to match its shape in the same change.
        const stdout = await runCli(['list', '--json']);
        const parsed = JSON.parse(stdout);
        for (const acc of parsed.accounts ?? []) {
          // Prefer our own DOM-observed value (persists across whichever
          // account was actually visible in Settings), but the CLI now reports
          // a tier itself — fall back to it instead of 'Unknown' for an
          // account we've never had open in Settings.
          acc.plan = knownPlans[acc.account_id] ?? acc.quota?.user_tier?.name ?? null;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(parsed));
        return;
      }

      // Frontend-reported only — see the comment on knownPlans above for why
      // this can't come from the CLI. Trusts the caller the same way
      // report-identity does: it's reporting what its own Account panel DOM
      // just showed for whichever account is active right now, not guessing
      // someone else's.
      if (url.pathname === '/api/report-plan' && req.method === 'POST') {
        const { accountId, label } = await readJsonBody(req);
        if (!accountId || !label) {
          respondError(res, 400, 'Missing accountId or label');
          return;
        }
        if (knownPlans[accountId] !== label) {
          knownPlans[accountId] = label;
          saveKnownPlans();
          log('PLAN', 'observed', accountId, '→', label);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === '/api/switch' && req.method === 'POST') {
        try {
          const { accountId } = await readJsonBody(req);
          if (!accountId) throw new Error('Missing accountId');
          log('SWITCH', 'requested', accountId);

          const tSwitchStart = Date.now();
          const stdout = await runCli(['switch', accountId, '--json']);
          const cliMs = Date.now() - tSwitchStart;
          // Not the raw CLI JSON — reaching this line without throwing already
          // means it succeeded, and TIMING right below covers the outcome in
          // structured form. A 300-char raw dump here was pure duplication.
          log('SWITCH', 'cli succeeded', accountId);

          // Respond before restarting the hub — restarting reloads the calling
          // page itself; responding after would race the reload. See
          // docs/decisions/superseded-hub-restart-window-reload.md.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(stdout);

          const hubRestart = await restartAntigravityHub();
          // .detail is already the purpose-built human summary (strategy +
          // pid/port + reload outcome) — the raw object's other fields are
          // either restated by TIMING right below (numeric breakdown) or, on
          // failure, would surface via the catch block instead.
          log('SWITCH', 'hub restart result:', hubRestart.detail);
          log('TIMING', 'switch', accountId, {
            strategy: hubRestart.strategy,
            cliMs,
            hubStopMs: hubRestart.timingMs.stopHub,
            hubHealthyMs: hubRestart.timingMs.hubHealthy,
            reloadMs: hubRestart.timingMs.reload,
            hubRestartTotalMs: hubRestart.timingMs.total,
            grandTotalMs: cliMs + hubRestart.timingMs.total,
          });
        } catch (e: any) {
          log('SWITCH', 'FAILED', e.message);
          respondError(res, 500, e.message);
        }
        return;
      }

      // Opens a real Terminal window instead of running the CLI here. `login`
      // hard-refuses to run any other way: it rejects --json outright, requires
      // process.stdin/stdout to be TTYs, and then hands the terminal to the
      // interactive `agy` sign-in UI via spawnSync(stdio:'inherit'). A daemon
      // exec() has no TTY, so the old in-process call could only ever fail.
      if (url.pathname === '/api/login' && req.method === 'POST') {
        // Step 1 is not optional: `login` refuses to start unless the CURRENT
        // login is already saved byte-for-byte (openAntigravityLogin checks
        // keychain.profileMatchesActive before detaching it, so a cancelled
        // sign-in can always be rolled back). The running hub rewrites that
        // Keychain slot on its own token-refresh cycle, so the saved copy drifts
        // out of match within minutes of normal use — meaning login fails with
        // "current agy login is not safely saved" far more often than not.
        // Re-capturing first is exactly what that error tells you to do.
        //
        // No dynamic account id is interpolated into this script — every step
        // runs `connect`/`login` bare — so unlike the JSON API handlers above it
        // never needed the execFile-based injection fix; a plain shell string is
        // fine here.
        const scriptPath = path.join(os.tmpdir(), `ag-enhancer-login-${Date.now()}.sh`);
        fs.writeFileSync(scriptPath, buildLoginTerminalScript(port), { mode: 0o700 });

        // Two separate -e args so the window is focused as well as opened.
        await execAsync(
          `osascript -e 'tell application "Terminal" to do script "bash ${scriptPath}"' ` +
          `-e 'tell application "Terminal" to activate'`
        );
        log('LOGIN', 'opened Terminal for interactive sign-in', scriptPath);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'terminal_opened', script: scriptPath }));
        return;
      }

      if (url.pathname === '/api/connect' && req.method === 'POST') {
        try {
          const { accountId } = await readJsonBody(req);

          // Guarded the same way as begin(): without an explicit id, `connect`
          // names the account from recent agy logs and files the live
          // credential under whatever it finds. Calling this endpoint with no
          // id destroyed a working account's saved credential once already —
          // it captured the account that had just been switched AWAY from, and
          // overwrote that account's profile with the new one's token.
          const targetId = accountId || await resolveActiveAccountId();
          if (!targetId) {
            respondError(
              res, 409,
              'The current login does not match any saved account, so it cannot be captured without an explicit accountId.',
              'ACCOUNT_UNIDENTIFIED'
            );
            return;
          }

          const stdout = await runCli(['connect', targetId, '--json']);
          log('CONNECT', 'captured', targetId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(stdout);
        } catch (e: any) {
          respondError(res, 500, e.message);
        }
        return;
      }

      if (url.pathname === '/api/remove' && req.method === 'POST') {
        try {
          const { accountId } = await readJsonBody(req);
          if (!accountId) throw new Error('Missing accountId');

          // Removing the account that's currently signed in would delete the
          // stored credential out from under the running hub, leaving a live
          // session whose account no longer exists in the registry. Goes through
          // the same --verify chokepoint as begin()/connect() — a plain cached
          // `route` read here is exactly the bug class that already destroyed an
          // account (see docs/decisions/credential-drift-explained.md): the hub rotates its OAuth token into
          // the shared Keychain slot on its own schedule, so cached "active" can
          // report the OLD account while the Keychain already holds a different
          // one's live credential.
          const activeId = await resolveActiveAccountId();
          if (activeId && activeId === accountId) {
            log('REMOVE', 'refused: account is currently active', accountId);
            respondError(res, 409, 'Cannot remove the account that is currently signed in. Switch to another account first.', 'ACCOUNT_ACTIVE');
            return;
          }

          log('REMOVE', 'requested', accountId);
          const stdout = await runCli(['remove', accountId, '--confirm', accountId, '--json']);
          log('REMOVE', 'succeeded', accountId, stdout.slice(0, 200));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(stdout);
        } catch (e: any) {
          log('REMOVE', 'FAILED', e.message);
          respondError(res, 500, e.message);
        }
        return;
      }

      // --- Browser-based add-account, replacing the Terminal + agy TUI flow ---
      //
      // Mirrors what Antigravity does natively: with no credential in the
      // Keychain the hub serves its sign-in page, and clicking it makes the hub
      // print ANTIGRAVITY_OPEN_URL, which the extension opens in the browser. We
      // never touch that part — we only take the credential away and put the new
      // one back, so the sign-in itself stays entirely native.
      //
      // Safety: detach is `security delete-generic-password`, purely local — no
      // OAuth revoke, and agent-hub-accounts' own saved copy of the credential is
      // untouched, so `switch <backup>` always restores it. begin() refuses to
      // run unless that backup was just proven to exist.
      if (url.pathname === '/api/add-account/begin' && req.method === 'POST') {
        if (pendingAdd || !acquireBeginLock()) {
          respondError(res, 409, 'An account sign-in is already in progress.');
          return;
        }
        try {
          // Capture first: this both refreshes a drifted credential and proves we
          // can get back. Everything after this point is reversible.
          // `--verify` byte-compares the live Keychain against every saved
          // profile, so the account it marks active is the one the credential
          // provably belongs to. Plain `route`/`current` answer from cache and
          // have been seen naming an account active while the Keychain held a
          // different credential entirely.
          //
          // Two calls, not one: `route --verify` used to return both the full
          // roster and the verified-active flag together, but `route` is now a
          // deprecated cache-only alias that doesn't accept `--verify` at all
          // (a live upstream agent-hub-accounts change). `list --json` is the
          // roster; `current --verify --json` is the verified-active check —
          // it only ever returns the currently-active account(s), not the
          // roster, which is why this needs both instead of one.
          const roster = await runCliJson(['list', '--json']);
          const knownAccountIds: string[] = (roster.accounts || []).map((a: any) => a.account_id);
          const verifiedCurrent = await runCliJson(['current', '--verify', '--json']);
          const exactMatch: string | undefined = (verifiedCurrent.accounts || []).find((a: any) => a.is_active)?.account_id;

          if (knownAccountIds.length === 0) {
            throw new Error('There are no saved accounts to fall back to, so signing out would leave you with no way back.');
          }

          // Refreshing the backup is an optimisation, not a precondition. The
          // byte-exact match it needs decays on its own: the running hub rotates
          // its OAuth token every so often and writes it back to the same
          // Keychain slot, after which nothing matches and this capture is
          // impossible — requiring it here blocked the whole flow within minutes
          // of ordinary use.
          //
          // Skipping it is safe because the restore path never uses the live
          // credential anyway: `cancel` runs `switch <id>`, which activates the
          // saved profile. A slightly older saved token still works.
          if (exactMatch) {
            await runCli(['connect', exactMatch, '--json']);
            log('ADD_ACCOUNT', 'refreshed backup for', exactMatch);
          } else {
            log('ADD_ACCOUNT', 'live credential matches no saved profile (token likely rotated); keeping existing backup');
          }

          // Who to restore on cancel. With no exact match, fall back to whichever
          // account was last activated — but only if it actually has a saved
          // profile to restore from. Never used to attribute a *write*; that is
          // the mistake that destroyed an account (see docs/decisions/2026-08-23-never-bare-connect-call.md).
          let backupAccountId: string;
          if (exactMatch) {
            backupAccountId = exactMatch;
          } else {
            const current = await runCliJson(['current', '--json']);
            const lastActivated: string | undefined = (current.accounts || [])[0]?.account_id;
            backupAccountId = lastActivated && knownAccountIds.includes(lastActivated)
              ? lastActivated
              : knownAccountIds[0];
          }
          log('ADD_ACCOUNT', 'will restore to', backupAccountId, `known=${knownAccountIds.length}`);

          const restart = await restartAntigravityHub(async () => {
            // Runs only once the hub has exited — see restartAntigravityHub.
            // Doing this while the hub is still alive lets the dying hub write
            // its session straight back, which is exactly how the first version
            // failed: the user was never signed out and the flow just
            // re-captured the account they already had.
            //
            // Both stores have to go: clearing the Keychain alone leaves the hub
            // authenticated from its own cached session file, and clearing the
            // file alone leaves the Keychain for it to re-read at startup.
            if (fs.existsSync(HUB_TOKEN_FILE)) {
              fs.rmSync(HUB_TOKEN_FILE);
              log('ADD_ACCOUNT', 'cleared cached hub session');
            }
            await detachActiveKeychainLogin();
            log('ADD_ACCOUNT', 'detached active login (local only, not revoked)');
          }, { reloadStrategy: 'window' });

          // .detail over the raw object — same reasoning as /api/switch above;
          // onStoppedError/reloadFailed, if set, surface via the throw below
          // and its 'begin FAILED' log line instead.
          log('ADD_ACCOUNT', 'hub restarted into signed-out state:', restart.detail);

          if (restart.onStoppedError || restart.reloadFailed) {
            // The hub is alive again (restartAntigravityHub never leaves it
            // dead over this), but either the credential-clearing step may not
            // have run (onStoppedError — e.g. a restart was already in flight
            // and this one's onStopped never fired) or the VS Code window
            // reload failed (reloadFailed — the native sign-in page this flow
            // depends on never gets a chance to render). Either way, reporting
            // success here would be exactly the kind of false "nothing changed"
            // this is meant to avoid in the other direction. Do not set
            // pendingAdd: there is nothing to cancel back from if the user was
            // never actually signed out, or never shown a way to sign in.
            const reason = restart.onStoppedError ?? 'the VS Code window failed to reload';
            throw new Error(
              `Hub restarted, but clearing the current login may have failed (${reason}). ` +
              `Check whether Antigravity is actually signed out before trying again.`
            );
          }

          setPendingAdd({ backupAccountId, startedAt: Date.now(), knownAccountIds });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, backupAccountId }));
        } catch (e: any) {
          log('ADD_ACCOUNT', 'begin FAILED', e.message);
          respondError(res, 500, e.message);
        } finally {
          releaseBeginLock();
        }
        return;
      }

      // Manual curl fallback only — no UI calls this. The normal flow is
      // POST /api/add-account/report-identity, driven by the frontend reading the
      // real email out of Antigravity's own Account panel DOM. This exists for
      // forcing the flow closed by hand if that ever misbehaves.
      if (url.pathname === '/api/add-account/finish' && req.method === 'POST') {
        try {
          if (!pendingAdd) throw new Error('No account sign-in is in progress.');
          const { accountId: explicitId } = await readJsonBody(req);

          let targetId: string;
          if (explicitId) {
            // Trustworthy: the caller is asserting a specific id, same as any
            // other explicit connect() call — no guessing involved.
            targetId = explicitId;
          } else {
            // Best-effort guess via agy's own log scan. Known to be unreliable
            // for genuinely new accounts in this environment — see the removed
            // watchForNewSignIn() comment above for why — so pass an explicit
            // accountId in the request body instead whenever the real email is
            // known (e.g. from the Account panel).
            const before = snapshotProfiles();
            let captured;
            try {
              captured = await runCliJson(['connect', '--json']);
            } catch {
              throw new Error('No signed-in account found yet. Finish signing in with Google first, or click Cancel to restore your previous account.');
            }
            if (pendingAdd.knownAccountIds.includes(captured.account_id)) {
              if (restoreProfile(captured.account_id, before)) {
                log('ADD_ACCOUNT', 'guessed capture landed on a known account; reverted its profile', captured.account_id);
              }
              throw new Error(
                `Could not determine who signed in (guessed ${captured.account_id}, which already exists — nothing was changed). ` +
                `Pass the real email as accountId, or click Cancel to restore your previous account.`
              );
            }
            targetId = captured.account_id;
          }

          const captured = await runCliJson(['connect', targetId, '--json']);
          log('ADD_ACCOUNT', 'captured account', captured.account_id);

          // Signing back in as the same account is not a failure — the state is
          // consistent and the account is saved — but it did not add anything,
          // and silently reporting success would be a lie.
          const isNewAccount = captured.account_id !== pendingAdd.backupAccountId;
          if (!isNewAccount) {
            log('ADD_ACCOUNT', 'captured account is the same one signed out of; nothing added', captured.account_id);
          }

          setPendingAdd(null);
          const restart = await restartAntigravityHub();
          log('ADD_ACCOUNT', 'hub restarted onto captured account:', restart.detail);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, accountId: captured.account_id, isNewAccount }));
        } catch (e: any) {
          log('ADD_ACCOUNT', 'finish FAILED', e.message);
          respondError(res, 500, e.message);
        }
        return;
      }

      // The normal completion path. Called by the frontend once it reads the
      // signed-in email straight out of Antigravity's own Account panel DOM
      // (SemanticLocator.findAccountPanelEmail(), settings-standalone only) — the
      // id is never guessed, so this class of misattribution bug cannot recur.
      if (url.pathname === '/api/add-account/report-identity' && req.method === 'POST') {
        try {
          if (!pendingAdd) {
            // Not an error: the frontend polls independently of pending state
            // and may report a stale read from just after the flow ended.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, noop: true, reason: 'no add-account flow in progress' }));
            return;
          }

          const { accountId } = await readJsonBody(req);
          if (!accountId) throw new Error('Missing accountId');

          // The backup account showing back up is not a completed sign-in —
          // the hub can rewrite that Keychain slot on its own, and the Account
          // panel can still be rendering the pre-sign-out state for a moment
          // right after the reload. Keep waiting either way.
          if (accountId === pendingAdd.backupAccountId) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, noop: true, reason: 'still the backed-up account' }));
            return;
          }

          const captured = await runCliJson(['connect', accountId, '--json']);
          const isNewAccount = !pendingAdd.knownAccountIds.includes(captured.account_id);
          log('ADD_ACCOUNT', 'identity reported from Account panel, captured', captured.account_id, `isNew=${isNewAccount}`);

          if (isNewAccount) setLastAddedAccountId(captured.account_id);
          setPendingAdd(null);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, accountId: captured.account_id, isNewAccount }));
        } catch (e: any) {
          log('ADD_ACCOUNT', 'report-identity FAILED', e.message);
          respondError(res, 500, e.message);
        }
        return;
      }

      if (url.pathname === '/api/add-account/cancel' && req.method === 'POST') {
        try {
          if (!pendingAdd) throw new Error('No account sign-in is in progress.');
          const { backupAccountId } = pendingAdd;

          // Nothing to put back by hand: `switch` rewrites the Keychain slot from
          // the saved credential profile, and the hub rebuilds its cached session
          // from that on the restart below. That is the same path every ordinary
          // account switch takes, so it is exercised constantly.
          await runCli(['switch', backupAccountId, '--json']);
          log('ADD_ACCOUNT', 'restored backup account', backupAccountId);
          setPendingAdd(null);
          await restartAntigravityHub();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, restored: backupAccountId }));
        } catch (e: any) {
          log('ADD_ACCOUNT', 'cancel FAILED', e.message);
          respondError(res, 500, e.message);
        }
        return;
      }

      // Kept on the daemon, not in the page: begin() reloads the webview, which
      // destroys any in-page record that a sign-in is underway.
      if (url.pathname === '/api/add-account/status' && req.method === 'GET') {
        const justAdded = lastAddedAccountId;
        setLastAddedAccountId(null);
        // signedOut drives the rescue banner: when signed out there is no profile
        // avatar in the corner, so the badge and popup that normally open the
        // account list never render — without this the editor offers no way back
        // to a saved account at all.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          pending: !!pendingAdd,
          ...(pendingAdd ?? {}),
          justAdded,
          signedOut: !(await isKeychainActiveAvailable()),
        }));
        return;
      }

      // Called by the sign-in script once it has captured the new account. The
      // sign-in leaves the NEW account as the active Keychain login, but the
      // running hub still holds the old credential in memory — the same
      // "switched, but the chat is still on the old account" failure the switch
      // path already had to solve. Nothing else triggers a restart here because
      // the script runs detached in Terminal, so it reports back itself.
      if (url.pathname === '/api/hub-restart' && req.method === 'POST') {
        log('HUB_RESTART', 'requested by sign-in script');
        const result = await restartAntigravityHub();
        log('HUB_RESTART', 'sign-in restart result:', result.detail);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (url.pathname === '/api/quota-refresh' && req.method === 'POST') {
        const stdout = await runCli(['quota', '--all', '--json']);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(stdout);
        return;
      }

      respondError(res, 404, 'Not Found');
    } catch (err: any) {
      respondError(res, 500, err.message);
    }
  });

  port = await listenOnFreePort(server, PORT_RANGE_START, PORT_RANGE_END);
  log('BOOT', `Listening on http://127.0.0.1:${port}`);
  context.subscriptions.push({ dispose: () => server.close() });

  const stopInjector = startCdpInjectorLoop(port);
  const stopReaper = startHubReaperLoop();
  context.subscriptions.push({ dispose: stopInjector }, { dispose: stopReaper });
}

export function deactivate(): void {
  // Everything meaningful is registered on context.subscriptions above, and
  // VS Code disposes those automatically on deactivate — see
  // docs/decisions/2026-08-26-extension-host-daemon.md (mirrors sync-mcp's
  // sidecar, whose deactivate() is equally trivial).
}
