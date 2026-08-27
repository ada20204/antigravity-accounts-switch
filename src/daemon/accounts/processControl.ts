// Vendored from agent-hub-accounts (MIT), verbatim except import paths and
// dropping runAntigravity() (isolated-hub only, not used here) — see
// THIRD_PARTY_NOTICES.md and docs/decisions/2026-08-26-vendor-agent-hub-accounts.md.

import { spawnSync } from 'child_process';
import { AccountStateError } from './support/files';
import type { KeychainPort } from './keychain';
import type { LiveStore } from './live';

export function openAntigravityLogin(json: boolean, live: LiveStore, keychain: KeychainPort): number {
  if (json) throw new AccountStateError('login is interactive and does not support --json', 'ACCOUNT_INPUT');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new AccountStateError('login requires an interactive terminal', 'ACCOUNT_INPUT');
  }
  const current = live.current('antigravity-cli');
  if (!current || !keychain.profileMatchesActive(current.account_id)) {
    throw new AccountStateError('current agy login is not safely saved; run connect first', 'ACCOUNT_LOGIN_NOT_SAVED');
  }
  keychain.detachActive();
  console.error(`Current login preserved as ${current.account_id}. Opening official agy for Google sign-in.`);
  const result = spawnSync(process.env.AGY_BIN || 'agy', [], { stdio: 'inherit', shell: false, windowsHide: true });
  if (!keychain.activeAvailable()) {
    keychain.activate(current.account_id);
    throw new AccountStateError('new agy login was not completed; the previous login was restored', 'ACCOUNT_LOGIN_INCOMPLETE');
  }
  if (result.error) {
    keychain.activate(current.account_id);
    throw new AccountStateError('official agy login failed; the previous login was restored', 'ACCOUNT_LOGIN_UNAVAILABLE');
  }
  console.error('New agy login is active. Run connect [email] to save it.');
  return result.status ?? 1;
}
