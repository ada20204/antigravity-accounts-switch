// Standalone entrypoint for the Terminal-based sign-in fallback script
// (buildLoginTerminalScript() in extension.ts) — run via plain `node`, not
// loaded by the extension host. Replaces shelling out to the separately-
// installed agent-hub-accounts CLI; only the 3 subcommands that script
// actually calls. See docs/decisions/2026-08-26-vendor-agent-hub-accounts.md.
//
// Bare `connect` (no email) here only re-saves an account whose live
// credential already byte-matches a saved profile — it does NOT fall back to
// a guessed/generated ID the way agent-hub-accounts' own bare `connect` does.
// That fallback was verified structurally broken for this project's hub-based
// setup (docs/decisions/2026-08-23-account-corruption-guessing-broken.md), so
// vendoring is not the place to reproduce it.

import { accountService, live, keychain } from './index';
import { openAntigravityLogin } from './processControl';

function resolveActiveAccountId(): string | null {
  const accounts = accountService.verifiedOverview('antigravity-cli').accounts;
  return accounts.find((a) => a.is_active)?.account_id ?? null;
}

function cmdConnect(explicitId?: string): void {
  const targetId = explicitId || resolveActiveAccountId();
  if (!targetId) {
    console.error('Could not tell which account is currently signed in, and no email was given.');
    console.error('Pass the real email: node loginCli.js connect you@example.com');
    console.error('Or use the in-app "Add new account" flow instead — it reads the signed-in email directly.');
    process.exitCode = 1;
    return;
  }
  const result = accountService.capture(targetId, targetId, true);
  console.log(`Saved ${result.account_id}.`);
}

function cmdLogin(): void {
  try {
    process.exitCode = openAntigravityLogin(false, live, keychain);
  } catch (e: any) {
    console.error(e.message || String(e));
    process.exitCode = 1;
  }
}

function cmdList(): void {
  const overview = accountService.verifiedOverview('antigravity-cli');
  for (const acc of overview.accounts) {
    console.log(`${acc.account_id}${acc.is_active ? ' (active)' : ''}`);
  }
}

const [, , sub, arg] = process.argv;
if (sub === 'connect') cmdConnect(arg);
else if (sub === 'login') cmdLogin();
else if (sub === 'list') cmdList();
else {
  console.error(`Unknown command: ${sub}`);
  process.exitCode = 2;
}
