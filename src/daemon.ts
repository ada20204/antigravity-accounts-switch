import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { startCdpInjectorLoop } from './cdpInjector';
import { restartAntigravityHub, startHubReaperLoop } from './hubRestart';
import { log, LOG_FILE } from './logger';

const execAsync = promisify(exec);
const PORT = 63820;

const AGENT_HUB_DIST = '/Users/developer/work/agent-hub-accounts/dist';
const AGENT_HUB_CLI = `${AGENT_HUB_DIST}/cli.js`;

// Live "is anyone signed in" check. Deliberately not derived from `route`,
// which serves cached state and keeps reporting the last account as active
// long after the login is gone — observed reporting active while the Keychain
// slot did not exist at all. activeAvailable() only checks that the slot is
// there (no `-w`), so it reads nothing secret and never prompts.
const ACTIVE_AVAILABLE_SNIPPET = [
  `const { settings } = require("${AGENT_HUB_DIST}/cli/options.js");`,
  `const { MacKeychain } = require("${AGENT_HUB_DIST}/keychain.js");`,
  'process.stdout.write(String(new MacKeychain(settings().credentialsDir).activeAvailable()));',
].join('');

// Saved credential profiles, keyed by file name. Small JSON files, and only
// read around a capture, so holding them in memory briefly is cheap.
const CREDENTIALS_DIR = path.join(os.homedir(), '.agent-hub', 'plugins', 'accounts', 'state', 'credentials');

function profileFileFor(accountId: string): string {
  // agent-hub-accounts percent-encodes the address for the file name.
  return path.join(CREDENTIALS_DIR, `${encodeURIComponent(accountId)}.json`);
}

function snapshotProfiles(): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  try {
    for (const name of fs.readdirSync(CREDENTIALS_DIR)) {
      if (name.endsWith('.json')) snapshot.set(name, fs.readFileSync(path.join(CREDENTIALS_DIR, name)));
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
    if (fs.readFileSync(file).equals(previous)) return false;
    fs.writeFileSync(file, previous, { mode: 0o600 });
    return true;
  } catch (e: any) {
    log('ADD_ACCOUNT', 'could not revert profile', accountId, e.message);
    return false;
  }
}

// Which saved account the live credential actually belongs to, or null if it
// belongs to none of them. `--verify` byte-compares the Keychain against every
// saved profile; plain `route`/`current` answer from cache and have been seen
// naming an account as active while the Keychain held a different one.
async function resolveActiveAccountId(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`node ${AGENT_HUB_CLI} route --verify --json`);
    return (JSON.parse(stdout).accounts || []).find((a: any) => a.active)?.account_id ?? null;
  } catch {
    return null;
  }
}

async function isSignedOut(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`node -e '${ACTIVE_AVAILABLE_SNIPPET}'`);
    return stdout.trim() !== 'true';
  } catch {
    return false; // can't tell — don't cry wolf
  }
}

// Reuses agent-hub-accounts' own MacKeychain.detachActive() rather than
// reimplementing it here. Duplicating another project's Keychain service and
// account names in this repo would mean two places to keep in sync, and this
// way their error handling and any future changes come along for free.
const DETACH_ACTIVE_SNIPPET = [
  `const { settings } = require("${AGENT_HUB_DIST}/cli/options.js");`,
  `const { MacKeychain } = require("${AGENT_HUB_DIST}/keychain.js");`,
  'new MacKeychain(settings().credentialsDir).detachActive();',
].join('');

// What the running hub actually authenticates with. NOT the Keychain: a hub
// started with no Keychain access at all (an SSH session, verified: read
// returns exit 36) still comes up fully authenticated, because it reads this
// file. The Keychain slot is what `agy` the CLI and agent-hub-accounts use.
// Signing the hub out therefore means moving this aside, not just detaching
// the Keychain entry. Renamed in place so the restore is a same-directory
// rename with no cross-device copy.
const HUB_TOKEN_FILE = path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token');

// Survives the webview reload that the sign-out step triggers, which is why it
// lives here rather than in page state — and persisted to disk, because it also
// has to survive this daemon restarting. That is not hypothetical: a restart
// mid-flow drops the flag, the banner disappears, and a user who is currently
// signed out has no button left to finish or cancel with.
// knownAccountIds is the whole point of distinguishing "a new account signed
// in" from "the active credential changed". Comparing against backupAccountId
// alone is not enough: switching to any OTHER already-saved account also
// changes it, and would be announced as a new account that was in the list all
// along.
interface PendingAdd { backupAccountId: string; startedAt: number; knownAccountIds: string[] }
const PENDING_ADD_FILE = path.join(os.tmpdir(), 'antigravity-accounts-enhancer-pending-add.json');

function loadPendingAdd(): PendingAdd | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(PENDING_ADD_FILE, 'utf8'));
    if (!parsed?.backupAccountId) return null;
    // knownAccountIds was added later; a file written by an older daemon has
    // none, and an undefined array would throw the moment the watcher runs.
    return { ...parsed, knownAccountIds: parsed.knownAccountIds ?? [parsed.backupAccountId] };
  } catch {
    return null;
  }
}

function setPendingAdd(value: PendingAdd | null): void {
  pendingAdd = value;
  try {
    if (value) fs.writeFileSync(PENDING_ADD_FILE, JSON.stringify(value));
    else fs.rmSync(PENDING_ADD_FILE, { force: true });
  } catch (e: any) {
    log('ADD_ACCOUNT', 'could not persist pending state', e.message);
  }
}

let pendingAdd: PendingAdd | null = loadPendingAdd();
if (pendingAdd) log('ADD_ACCOUNT', 'resumed pending sign-in from previous daemon run', pendingAdd);

// Read once by the banner so it can confirm which account was added, then
// cleared — it is a one-shot notification, not state worth persisting.
let lastAddedAccountId: string | null = null;

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
// dead account's name and destroyed it (see docs/DECISIONS.md).
//
// Replaced with POST /api/add-account/report-identity: the frontend reads the
// signed-in email directly out of Antigravity's own native Account panel DOM
// (SemanticLocator.findAccountPanelEmail()) and reports it explicitly. The id
// is then never guessed — the whole class of misattribution is gone, not just
// guarded against.

log('BOOT', `Daemon starting, log file at ${LOG_FILE}`);

// Origin whitelist, not '*' — see docs/DECISIONS.md, "CORS 白名单策略".
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (origin.startsWith('vscode-webview://')) return true;
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return true;
  return false;
}

// HTTP Server for Webview bridge
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowed = isAllowedOrigin(origin);
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

  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/api/log' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        log('FRONTEND', parsed.level || 'info', parsed.message, parsed.data ?? '');
      } catch {
        log('FRONTEND', 'unparseable', body);
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }

  try {
    if (url.pathname === '/api/accounts' && req.method === 'GET') {
      const { stdout } = await execAsync(`node ${AGENT_HUB_CLI} route --json`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(stdout);
      return;
    }

    if (url.pathname === '/api/switch' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { accountId } = JSON.parse(body);
          if (!accountId) throw new Error('Missing accountId');
          log('SWITCH', 'requested', accountId);

          const tSwitchStart = Date.now();
          const { stdout } = await execAsync(`node ${AGENT_HUB_CLI} switch "${accountId}" --json`);
          const cliMs = Date.now() - tSwitchStart;
          log('SWITCH', 'cli succeeded', accountId, stdout.slice(0, 300));

          // Respond before restarting the hub — restarting reloads the calling
          // page itself; responding after would race the reload. See
          // docs/DECISIONS.md, "Hub 重启:为什么改成整窗口 reload".
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(stdout);

          const hubRestart = await restartAntigravityHub();
          log('SWITCH', 'hub restart result', hubRestart);
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
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
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
      const script = [
        '#!/bin/bash',
        'set -o pipefail',
        'echo "=== Add a new Antigravity account ==="',
        'echo',
        'echo "Step 1/3: re-saving your current account..."',
        'echo "(Antigravity refreshes its token in the background, so the saved copy"',
        'echo " drifts out of sync. Sign-in refuses to start until it matches again.)"',
        'echo',
        `node ${AGENT_HUB_CLI} connect`,
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
        `node ${AGENT_HUB_CLI} login`,
        'if [ $? -ne 0 ]; then',
        '  echo',
        '  echo "Sign-in did not complete. Your previous account was restored."',
        '  echo "Press Return to close this window."',
        '  read -r _',
        '  exit 1',
        'fi',
        'echo',
        'echo "Step 3/3: saving the new account..."',
        `node ${AGENT_HUB_CLI} connect`,
        'if [ $? -eq 0 ]; then',
        '  echo',
        '  echo "Applying the new account to the running Antigravity session..."',
        // Without this the sign-in leaves the new account active in the
        // Keychain while the running hub keeps serving the old one.
        `  curl -s -X POST http://127.0.0.1:${PORT}/api/hub-restart >/dev/null 2>&1 || echo "  (could not reach the accounts daemon — restart VS Code to apply)"`,
        '  echo',
        '  echo "Done. The new account is now available in Antigravity."',
        '  echo',
        `  node ${AGENT_HUB_CLI} list`,
        'else',
        '  echo',
        '  echo "Sign-in worked but saving it failed. Run: agent-hub-accounts connect"',
        'fi',
        'echo',
        'echo "Press Return to close this window."',
        'read -r _',
      ].join('\n');

      const scriptPath = path.join(os.tmpdir(), `ag-enhancer-login-${Date.now()}.sh`);
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });

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
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { accountId } = JSON.parse(body || '{}');

          // Guarded the same way as begin(): without an explicit id, `connect`
          // names the account from recent agy logs and files the live
          // credential under whatever it finds. Calling this endpoint with no
          // id destroyed a working account's saved credential once already —
          // it captured the account that had just been switched AWAY from, and
          // overwrote that account's profile with the new one's token.
          const targetId = accountId || await resolveActiveAccountId();
          if (!targetId) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'The current login does not match any saved account, so it cannot be captured without an explicit accountId.',
              code: 'ACCOUNT_UNIDENTIFIED',
            }));
            return;
          }

          const { stdout } = await execAsync(`node ${AGENT_HUB_CLI} connect "${targetId}" --json`);
          log('CONNECT', 'captured', targetId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(stdout);
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (url.pathname === '/api/remove' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { accountId } = JSON.parse(body);
          if (!accountId) throw new Error('Missing accountId');

          // Removing the account that's currently signed in would delete the
          // stored credential out from under the running hub, leaving a live
          // session whose account no longer exists in the registry. Make the
          // caller switch away first rather than landing in that state.
          const { stdout: routeOut } = await execAsync(`node ${AGENT_HUB_CLI} route --json`);
          const active = (JSON.parse(routeOut).accounts || []).find((a: any) => a.active);
          if (active && active.account_id === accountId) {
            log('REMOVE', 'refused: account is currently active', accountId);
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Cannot remove the account that is currently signed in. Switch to another account first.',
              code: 'ACCOUNT_ACTIVE',
            }));
            return;
          }

          log('REMOVE', 'requested', accountId);
          const { stdout } = await execAsync(`node ${AGENT_HUB_CLI} remove "${accountId}" --confirm "${accountId}" --json`);
          log('REMOVE', 'succeeded', accountId, stdout.slice(0, 200));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(stdout);
        } catch (e: any) {
          log('REMOVE', 'FAILED', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
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
      try {
        if (pendingAdd) throw new Error('An account sign-in is already in progress.');

        // Capture first: this both refreshes a drifted credential and proves we
        // can get back. Everything after this point is reversible.
        // `--verify` byte-compares the live Keychain against every saved
        // profile, so the account it marks active is the one the credential
        // provably belongs to. Plain `route`/`current` answer from cache and
        // have been seen naming an account active while the Keychain held a
        // different credential entirely.
        const { stdout: verifyOut } = await execAsync(`node ${AGENT_HUB_CLI} route --verify --json`);
        const verified = JSON.parse(verifyOut).accounts || [];
        const knownAccountIds: string[] = verified.map((a: any) => a.account_id);
        const exactMatch: string | undefined = verified.find((a: any) => a.active)?.account_id;

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
          await execAsync(`node ${AGENT_HUB_CLI} connect "${exactMatch}" --json`);
          log('ADD_ACCOUNT', 'refreshed backup for', exactMatch);
        } else {
          log('ADD_ACCOUNT', 'live credential matches no saved profile (token likely rotated); keeping existing backup');
        }

        // Who to restore on cancel. With no exact match, fall back to whichever
        // account was last activated — but only if it actually has a saved
        // profile to restore from. Never used to attribute a *write*; that is
        // the mistake that destroyed an account (see docs/DECISIONS.md).
        let backupAccountId: string;
        if (exactMatch) {
          backupAccountId = exactMatch;
        } else {
          const { stdout: currentOut } = await execAsync(`node ${AGENT_HUB_CLI} current --json`);
          const lastActivated: string | undefined = (JSON.parse(currentOut).accounts || [])[0]?.account_id;
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
          await execAsync(`node -e '${DETACH_ACTIVE_SNIPPET}'`);
          log('ADD_ACCOUNT', 'detached active login (local only, not revoked)');
        });

        setPendingAdd({ backupAccountId, startedAt: Date.now(), knownAccountIds });
        log('ADD_ACCOUNT', 'hub restarted into signed-out state', restart);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, backupAccountId }));
      } catch (e: any) {
        log('ADD_ACCOUNT', 'begin FAILED', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Manual curl fallback only — no UI calls this. The normal flow is
    // POST /api/add-account/report-identity, driven by the frontend reading the
    // real email out of Antigravity's own Account panel DOM. This exists for
    // forcing the flow closed by hand if that ever misbehaves.
    if (url.pathname === '/api/add-account/finish' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          if (!pendingAdd) throw new Error('No account sign-in is in progress.');
          const { accountId: explicitId } = JSON.parse(body || '{}');

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
              const { stdout } = await execAsync(`node ${AGENT_HUB_CLI} connect --json`);
              captured = JSON.parse(stdout);
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

          const { stdout: connectOut } = await execAsync(`node ${AGENT_HUB_CLI} connect "${targetId}" --json`);
          const captured = JSON.parse(connectOut);
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
          log('ADD_ACCOUNT', 'hub restarted onto captured account', restart);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, accountId: captured.account_id, isNewAccount }));
        } catch (e: any) {
          log('ADD_ACCOUNT', 'finish FAILED', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // The normal completion path. Called by the frontend once it reads the
    // signed-in email straight out of Antigravity's own Account panel DOM
    // (SemanticLocator.findAccountPanelEmail(), settings-standalone only) — the
    // id is never guessed, so this class of misattribution bug cannot recur.
    if (url.pathname === '/api/add-account/report-identity' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          if (!pendingAdd) {
            // Not an error: the frontend polls independently of pending state
            // and may report a stale read from just after the flow ended.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, noop: true, reason: 'no add-account flow in progress' }));
            return;
          }

          const { accountId } = JSON.parse(body || '{}');
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

          const { stdout } = await execAsync(`node ${AGENT_HUB_CLI} connect "${accountId}" --json`);
          const captured = JSON.parse(stdout);
          const isNewAccount = !pendingAdd.knownAccountIds.includes(captured.account_id);
          log('ADD_ACCOUNT', 'identity reported from Account panel, captured', captured.account_id, `isNew=${isNewAccount}`);

          if (isNewAccount) lastAddedAccountId = captured.account_id;
          setPendingAdd(null);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, accountId: captured.account_id, isNewAccount }));
        } catch (e: any) {
          log('ADD_ACCOUNT', 'report-identity FAILED', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
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
        await execAsync(`node ${AGENT_HUB_CLI} switch "${backupAccountId}" --json`);
        log('ADD_ACCOUNT', 'restored backup account', backupAccountId);
        setPendingAdd(null);
        await restartAntigravityHub();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, restored: backupAccountId }));
      } catch (e: any) {
        log('ADD_ACCOUNT', 'cancel FAILED', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Kept on the daemon, not in the page: begin() reloads the webview, which
    // destroys any in-page record that a sign-in is underway.
    if (url.pathname === '/api/add-account/status' && req.method === 'GET') {
      const justAdded = lastAddedAccountId;
      lastAddedAccountId = null;
      // signedOut drives the rescue banner: when signed out there is no profile
      // avatar in the corner, so the badge and popup that normally open the
      // account list never render — without this the editor offers no way back
      // to a saved account at all.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        pending: !!pendingAdd,
        ...(pendingAdd ?? {}),
        justAdded,
        signedOut: await isSignedOut(),
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
      log('HUB_RESTART', 'sign-in restart result', result);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (url.pathname === '/api/quota-refresh' && req.method === 'POST') {
      const { stdout } = await execAsync(`node ${AGENT_HUB_CLI} quota --all --json`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(stdout);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Accounts Daemon] Listening on http://127.0.0.1:${PORT}`);
});

startCdpInjectorLoop();
startHubReaperLoop();
