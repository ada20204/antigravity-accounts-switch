// The /api/add-account/* handlers, split out of routes.ts — that file plus
// this one together were still one 593-line routes.ts, over the 500-line
// limit; this is the single largest cohesive chunk (begin/finish/report-
// identity/cancel/status), so it gets its own file. See docs/ISSUES.md's
// (now resolved) "extension.ts 该拆了" entry.

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { restartAntigravityHub } from './hubRestart';
import { log } from './logger';
import { accountService, keychain, withFileLock, paths as accountPaths } from './accounts';
import { readJsonBody, respondError } from './httpUtils';
import type { RouteState, RouteActions } from './routes';

// What the running hub actually authenticates with. NOT the Keychain: a hub
// started with no Keychain access at all (an SSH session, verified: read
// returns exit 36) still comes up fully authenticated, because it reads this
// file. The Keychain slot is what `agy` the CLI and agent-hub-accounts use.
// Signing the hub out therefore means moving this aside, not just detaching
// the Keychain entry.
const HUB_TOKEN_FILE = path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token');

// Returns true if the path was one of ours (handled or failed with a proper
// response either way), false if the caller should try other routers.
export function createAddAccountRouter(state: RouteState, actions: RouteActions) {
  return async function handleAddAccountRequest(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
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
      if (state.pendingAdd || !actions.acquireBeginLock()) {
        respondError(res, 409, 'An account sign-in is already in progress.');
        return true;
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
        const roster = accountService.overview('antigravity-cli');
        const knownAccountIds: string[] = roster.accounts.map(a => a.account_id);
        const verifiedCurrent = accountService.verifiedOverview('antigravity-cli');
        const exactMatch = verifiedCurrent.accounts.find(a => a.is_active)?.account_id;

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
          withFileLock(accountPaths.switchLockPath, () => accountService.capture(exactMatch, exactMatch, true));
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
          const current = accountService.overview('antigravity-cli').accounts.filter(a => a.is_active);
          const lastActivated: string | undefined = current[0]?.account_id;
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
          // force: true avoids the TOCTOU race of existsSync-then-rmSync
          // (another process may delete it between the check and the remove).
          fs.rmSync(HUB_TOKEN_FILE, { force: true });
          log('ADD_ACCOUNT', 'cleared cached hub session');
          keychain.detachActive();
          log('ADD_ACCOUNT', 'detached active login (local only, not revoked)');
        }, { reloadStrategy: 'window' });

        // .detail over the raw object — same reasoning as /api/switch above;
        // onStoppedError/reloadFailed, if set, surface via the throw below
        // and its 'begin FAILED' log line instead.
        log('ADD_ACCOUNT', 'hub restarted into signed-out state:', restart.detail);

        if (restart.onStoppedError || restart.reloadFailed) {
          // See HubRestartResult's onStoppedError/reloadFailed fields
          // (hubRestart.ts) for what each means. Not setting pendingAdd here
          // is deliberate: nothing to cancel back from if sign-out or the
          // sign-in page itself may not have actually happened.
          const reason = restart.onStoppedError ?? 'the VS Code window failed to reload';
          throw new Error(
            `Hub restarted, but clearing the current login may have failed (${reason}). ` +
            `Check whether Antigravity is actually signed out before trying again.`
          );
        }

        actions.setPendingAdd({ backupAccountId, startedAt: Date.now(), knownAccountIds });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, backupAccountId }));
      } catch (e: any) {
        log('ADD_ACCOUNT', 'begin FAILED', e.message);
        respondError(res, 500, e.message);
      } finally {
        actions.releaseBeginLock();
      }
      return true;
    }

    // Manual curl fallback only — no UI calls this. The normal flow is
    // POST /api/add-account/report-identity, driven by the frontend reading the
    // real email out of Antigravity's own Account panel DOM. This exists for
    // forcing the flow closed by hand if that ever misbehaves.
    if (url.pathname === '/api/add-account/finish' && req.method === 'POST') {
      try {
        if (!state.pendingAdd) throw new Error('No account sign-in is in progress.');
        const { accountId: explicitId } = await readJsonBody(req);

        // No guessing fallback — see
        // docs/decisions/2026-08-26-vendor-agent-hub-accounts.md. The old
        // fallback (agy log-scan) was already known-broken in this
        // environment (docs/decisions/2026-08-23-account-corruption-guessing-broken.md);
        // vendoring is not the place to reproduce it.
        if (!explicitId) {
          throw new Error(
            'An explicit accountId is required. Use POST /api/add-account/report-identity ' +
            'from the UI instead, or pass the real email as accountId here.'
          );
        }

        const captured = withFileLock(accountPaths.switchLockPath, () => accountService.capture(explicitId, explicitId, true));
        log('ADD_ACCOUNT', 'captured account', captured.account_id);

        // Signing back in as the same account is not a failure — the state is
        // consistent and the account is saved — but it did not add anything,
        // and silently reporting success would be a lie.
        const isNewAccount = captured.account_id !== state.pendingAdd.backupAccountId;
        if (!isNewAccount) {
          log('ADD_ACCOUNT', 'captured account is the same one signed out of; nothing added', captured.account_id);
        }

        actions.setPendingAdd(null);
        const restart = await restartAntigravityHub();
        log('ADD_ACCOUNT', 'hub restarted onto captured account:', restart.detail);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, accountId: captured.account_id, isNewAccount }));
      } catch (e: any) {
        log('ADD_ACCOUNT', 'finish FAILED', e.message);
        respondError(res, 500, e.message);
      }
      return true;
    }

    // The normal completion path. Called by the frontend once it reads the
    // signed-in email straight out of Antigravity's own Account panel DOM
    // (SemanticLocator.findAccountPanelEmail(), settings-standalone only) — the
    // id is never guessed, so this class of misattribution bug cannot recur.
    if (url.pathname === '/api/add-account/report-identity' && req.method === 'POST') {
      try {
        if (!state.pendingAdd) {
          // Not an error: the frontend polls independently of pending state
          // and may report a stale read from just after the flow ended.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, noop: true, reason: 'no add-account flow in progress' }));
          return true;
        }

        const { accountId } = await readJsonBody(req);
        if (!accountId) throw new Error('Missing accountId');

        // The backup account showing back up is not a completed sign-in —
        // the hub can rewrite that Keychain slot on its own, and the Account
        // panel can still be rendering the pre-sign-out state for a moment
        // right after the reload. Keep waiting either way.
        if (accountId === state.pendingAdd.backupAccountId) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, noop: true, reason: 'still the backed-up account' }));
          return true;
        }
        if (state.pendingAdd.knownAccountIds.includes(accountId)) {
          throw new Error('The reported account is already saved; refusing to overwrite its credential during add-account.');
        }

        const captured = withFileLock(accountPaths.switchLockPath, () => accountService.capture(accountId, accountId, true));
        const isNewAccount = !state.pendingAdd.knownAccountIds.includes(captured.account_id);
        log('ADD_ACCOUNT', 'identity reported from Account panel, captured', captured.account_id, `isNew=${isNewAccount}`);

        if (isNewAccount) actions.setLastAddedAccountId(captured.account_id);
        actions.setPendingAdd(null);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, accountId: captured.account_id, isNewAccount }));
      } catch (e: any) {
        log('ADD_ACCOUNT', 'report-identity FAILED', e.message);
        respondError(res, 500, e.message);
      }
      return true;
    }

    if (url.pathname === '/api/add-account/cancel' && req.method === 'POST') {
      try {
        if (!state.pendingAdd) throw new Error('No account sign-in is in progress.');
        const { backupAccountId } = state.pendingAdd;

        // Nothing to put back by hand: `switch` rewrites the Keychain slot from
        // the saved credential profile, and the hub rebuilds its cached session
        // from that on the restart below. That is the same path every ordinary
        // account switch takes, so it is exercised constantly.
        withFileLock(accountPaths.switchLockPath, () => accountService.switchAccount(backupAccountId));
        log('ADD_ACCOUNT', 'restored backup account', backupAccountId);
        actions.setPendingAdd(null);
        await restartAntigravityHub();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, restored: backupAccountId }));
      } catch (e: any) {
        log('ADD_ACCOUNT', 'cancel FAILED', e.message);
        respondError(res, 500, e.message);
      }
      return true;
    }

    // Kept on the daemon, not in the page: begin() reloads the webview, which
    // destroys any in-page record that a sign-in is underway.
    if (url.pathname === '/api/add-account/status' && req.method === 'GET') {
      const justAdded = state.lastAddedAccountId;
      actions.setLastAddedAccountId(null);
      // signedOut drives the rescue banner: when signed out there is no profile
      // avatar in the corner, so the badge and popup that normally open the
      // account list never render — without this the editor offers no way back
      // to a saved account at all.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        pending: !!state.pendingAdd,
        ...(state.pendingAdd ?? {}),
        justAdded,
        signedOut: !keychain.activeAvailable(),
      }));
      return true;
    }

    return false;
  };
}
