// The /api/* business logic, split out of extension.ts — see docs/ISSUES.md's
// (now resolved) "extension.ts 该拆了" entry. extension.ts keeps activate()/
// deactivate() and server wiring (CORS, static files, port allocation); this
// file owns everything under /api/* except /api/log (trivial, stayed put).
//
// vscode-free by design (nothing here imports 'vscode') — every handler only
// needs accountService/keychain/registry/restartAntigravityHub/log, none of
// which touch the extension host APIs.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { IncomingMessage, ServerResponse } from 'http';
import { restartAntigravityHub } from './hubRestart';
import { log } from './logger';
import { accountService, registry, keychain, withFileLock, paths as accountPaths } from './accounts';
import { readJsonBody, respondError } from './httpUtils';
import { createAddAccountRouter } from './addAccountRoutes';
import { executeAccountSwitch } from './switchService';

const execAsync = promisify(exec);

export const PENDING_ADD_SCHEMA = 'antigravity-accounts-switch.pending_add.v1';
export interface PendingAdd {
  schema: typeof PENDING_ADD_SCHEMA;
  backupAccountId: string;
  startedAt: number;
  knownAccountIds: string[];
}

// Mutated in place by extension.ts (each setter both updates these fields and
// persists to disk) — routes read the live value through this same object
// reference, never a stale snapshot from when the router was created.
export interface RouteState {
  pendingAdd: PendingAdd | null;
  lastAddedAccountId: string | null;
  knownPlans: Record<string, string>;
  port: number;
  daemonToken: string;
}

export interface RouteActions {
  setPendingAdd(value: Omit<PendingAdd, 'schema'> | null): void;
  setLastAddedAccountId(value: string | null): void;
  saveKnownPlans(): void;
  acquireBeginLock(): boolean;
  releaseBeginLock(): void;
  openTerminal(name: string, command: string): Promise<void>;
}

// Which saved account the live credential actually belongs to, or null if it
// belongs to none of them. `verifiedOverview` byte-compares the Keychain
// against every saved profile; the plain (cached) overview has been seen
// naming an account as active while the Keychain held a different one. This is
// the single chokepoint every "is this account currently active" decision in
// this file should go through — a cached shortcut here is exactly what
// destroyed an account once already (see docs/decisions/2026-08-23-never-bare-connect-call.md).
async function resolveActiveAccountId(): Promise<string | null> {
  try {
    const verified = accountService.verifiedOverview('antigravity-cli');
    return verified.accounts.find(a => a.is_active)?.account_id ?? null;
  } catch {
    return null;
  }
}

// Manual, fully interactive fallback for adding an account — the primary path
// is the in-editor flow (/api/add-account/begin et al.), this exists only
// because `login` categorically cannot run any other way (see the comment at
// the /api/login handler below). No dynamic account id is interpolated here —
// every step runs `connect`/`login` bare — so this plain shell string carries
// none of the injection risk the execFile-based JSON endpoints had to be
// fixed for.
function buildLoginTerminalScript(port: number, daemonToken: string): string {
  const cli = JSON.stringify(path.join(__dirname, 'accounts', 'loginCli.js'));
  return [
    '#!/bin/bash',
    'set -o pipefail',
    'trap \'rm -f "$0"\' EXIT',
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
    // Bare `connect` can no longer guess the new account's email (that
    // guesser was verified structurally broken for this project's hub setup
    // — see docs/decisions/2026-08-23-account-corruption-guessing-broken.md
    // and docs/decisions/2026-08-26-vendor-agent-hub-accounts.md), so this
    // step needs the email explicitly instead of silently mis-saving it.
    'echo "Enter the Google account email you just signed in with:"',
    'read -r NEW_EMAIL',
    'if [ -z "$NEW_EMAIL" ]; then',
    '  echo',
    '  echo "No email entered — nothing was saved. Re-run this script, or use the"',
    '  echo "in-app Add new account flow instead (it reads the email automatically)."',
    'else',
    `  node ${cli} connect "\$NEW_EMAIL"`,
    '  if [ $? -eq 0 ]; then',
    '    echo',
    '    echo "Applying the new account to the running Antigravity session..."',
    // Without this the sign-in leaves the new account active in the
    // Keychain while the running hub keeps serving the old one.
    `    curl -s -X POST -H 'X-AG-Daemon-Token: ${daemonToken}' http://127.0.0.1:${port}/api/hub-restart >/dev/null 2>&1 || echo "    (could not reach the accounts daemon — restart VS Code to apply)"`,
    '    echo',
    '    echo "Done. The new account is now available in Antigravity."',
    '    echo',
    `    node ${cli} list`,
    '  else',
    '    echo',
    '    echo "Sign-in worked but saving it failed. Re-run this script, or use the"',
    '    echo "in-app Add new account flow instead."',
    '  fi',
    'fi',
    'echo',
    'echo "Press Return to close this window."',
    'read -r _',
  ].join('\n');
}

export function createApiRouter(state: RouteState, actions: RouteActions) {
  const handleAddAccountRequest = createAddAccountRouter(state, actions);

  return async function handleApiRequest(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (url.pathname === '/api/accounts' && req.method === 'GET') {
      const parsed: any = accountService.overview('');
      for (const acc of parsed.accounts ?? []) {
        // Prefer our own DOM-observed value (persists across whichever
        // account was actually visible in Settings), but the CLI now reports
        // a tier itself — fall back to it instead of 'Unknown' for an
        // account we've never had open in Settings.
        acc.plan = state.knownPlans[acc.account_id] ?? acc.quota?.user_tier?.name ?? null;
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
      // Both fields end up rendered as raw HTML by the injected popup/card
      // and accountId is used as an object key — reject non-strings outright
      // (blocks __proto__-style prototype pollution) and cap length rather
      // than trusting the frontend's own shape. See
      // docs/decisions/2026-08-26-unescaped-account-fields-in-innerhtml.md.
      if (typeof accountId !== 'string' || typeof label !== 'string'
          || !accountId || !label || label.length > 64
          || ['__proto__', 'prototype', 'constructor'].includes(accountId)) {
        respondError(res, 400, 'Missing or invalid accountId/label');
        return;
      }
      if (!accountService.overview('antigravity-cli').accounts.some(a => a.account_id === accountId)) {
        respondError(res, 400, 'Unknown accountId');
        return;
      }
      if (state.knownPlans[accountId] !== label) {
        state.knownPlans[accountId] = label;
        actions.saveKnownPlans();
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

        void executeAccountSwitch(accountId, {
          source: 'api',
          onSwitched(output) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(output));
          },
        }).catch((err) => {
          if (!res.headersSent) respondError(res, 500, err?.message ?? String(err));
        });
        return;
      } catch (e: any) {
        log('SWITCH', 'FAILED', e.message);
        respondError(res, 500, e.message);
        return;
      }
    }

    // Opens a real Terminal window — `login` hard-refuses to run any other
    // way (no --json, requires a TTY). See
    // docs/decisions/historical-add-account-terminal-required.md.
    if (url.pathname === '/api/login' && req.method === 'POST') {
      // Symlink-safe creation via O_CREAT|O_EXCL|O_NOFOLLOW — same pattern
      // as jsonStore.ts's saveJsonFile(). Date.now() + pid makes the name
      // unique enough that O_EXCL's "file already exists" rejection is a
      // safety signal (a race or a symlink), not a normal collision.
      const scriptPath = path.join(os.tmpdir(), `ag-switch-login-${process.pid}-${Date.now()}.sh`);
      const scriptContent = buildLoginTerminalScript(state.port, state.daemonToken);
      const fd = fs.openSync(
        scriptPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o700
      );
      try {
        fs.writeFileSync(fd, scriptContent);
      } finally {
        fs.closeSync(fd);
      }

      // Cross-platform: run inside VS Code's integrated terminal instead of
      // shelling out to macOS-specific osascript / Terminal.app.
      const runCommand = `bash "${scriptPath}"`;
      await actions.openTerminal('Antigravity Account Sign-in', runCommand);
      log('LOGIN', 'opened VS Code terminal for interactive sign-in', scriptPath);

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

        const captured = withFileLock(accountPaths.switchLockPath, () => accountService.capture(targetId, targetId, true));
        log('CONNECT', 'captured', targetId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(captured));
      } catch (e: any) {
        respondError(res, 500, e.message);
      }
      return;
    }

    if (url.pathname === '/api/remove' && req.method === 'POST') {
      try {
        const { accountId } = await readJsonBody(req);
        if (!accountId) throw new Error('Missing accountId');

        // Goes through the same --verify chokepoint as begin()/connect(), not
        // a cached read — see docs/decisions/credential-drift-explained.md.
        const activeId = await resolveActiveAccountId();
        if (activeId && activeId === accountId) {
          log('REMOVE', 'refused: account is currently active', accountId);
          respondError(res, 409, 'Cannot remove the account that is currently signed in. Switch to another account first.', 'ACCOUNT_ACTIVE');
          return;
        }

        log('REMOVE', 'requested', accountId);
        let credentialRemoved = false;
        const mutation = withFileLock(accountPaths.switchLockPath, () => registry.remove(accountId, accountId, false, (profile) => {
          credentialRemoved = profile.auth_kind === 'oauth-subscription' && profile.credential_source === 'agy-profile'
            ? keychain.remove(accountId)
            : false;
        }));
        const output = {
          schema: 'agent_hub.account_mutation.v2', action: 'remove',
          generation: mutation.generation, profile: mutation.result.profile,
          removed: true, cleared_default: mutation.result.cleared_default, credential_removed: credentialRemoved,
        };
        log('REMOVE', 'succeeded', accountId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(output));
      } catch (e: any) {
        log('REMOVE', 'FAILED', e.message);
        respondError(res, 500, e.message);
      }
      return;
    }

    if (url.pathname.startsWith('/api/add-account/') && await handleAddAccountRequest(url, req, res)) {
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
      // Cache-only, same as before vendoring — a real refresh needs an
      // isolated hub per account, out of scope here. See
      // docs/decisions/2026-08-26-vendor-agent-hub-accounts.md.
      const output = accountService.quotaBatchSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(output));
      return;
    }

    respondError(res, 404, 'Not Found');
  };
}
