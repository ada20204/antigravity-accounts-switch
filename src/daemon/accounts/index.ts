// Process-lifetime singleton wiring — mirrors agent-hub-accounts' cli.ts
// building the same four objects per invocation; here they're built once and
// reused for the extension host's lifetime. See
// docs/decisions/2026-08-26-vendor-agent-hub-accounts.md.

import { MacKeychain } from './keychain';
import { LiveStore } from './live';
import { AccountRegistry } from './registry';
import { QuotaCache } from './quota';
import { AntigravityAccountService } from './manager';
import { paths } from './paths';

export { paths };
export { withFileLock, AccountStateError } from './support/files';
export { exportAccounts, importAccounts } from './transfer';
export const registry = new AccountRegistry(paths.registryPath);
export const live = new LiveStore(paths.livePath);
export const quota = new QuotaCache(paths.quotaPath);
export const keychain = new MacKeychain(paths.credentialsDir);
export const accountService = new AntigravityAccountService(registry, live, quota, keychain);
