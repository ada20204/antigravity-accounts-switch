import { CredentialStore, type CredentialPort } from './credentials/store';
import { LiveStore } from './live';
import { AccountRegistry } from './registry';
import { QuotaCache } from './quota';
import { AntigravityAccountService } from './manager';
import { paths } from './paths';

export { paths };
export { withFileLock, AccountStateError } from './support/files';
export { exportAccounts, importAccounts } from './transfer';
export { CredentialStore, type CredentialPort };
export const registry = new AccountRegistry(paths.registryPath);
export const live = new LiveStore(paths.livePath);
export const quota = new QuotaCache(paths.quotaPath);
export const keychain: CredentialPort = CredentialStore.create(paths.credentialsDir);
export const accountService = new AntigravityAccountService(registry, live, quota, keychain);

