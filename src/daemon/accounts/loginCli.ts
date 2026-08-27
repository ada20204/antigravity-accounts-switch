// Standalone entrypoint for the Terminal-based sign-in fallback script
// (buildLoginTerminalScript() in routes.ts) — run via plain `node`, not
// loaded by the extension host. Bare `connect` here deliberately does not
// guess like agent-hub-accounts' own does — see
// docs/decisions/2026-08-26-vendor-agent-hub-accounts.md.

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
