// Adapted from agent-hub-accounts' cli/options.ts settings() — same default
// formula (env-overridable), trimmed to the fields this extension uses. Must
// stay byte-identical to upstream's formula: this is what makes an existing
// install's saved accounts keep working with zero migration, and what keeps
// a machine that still has agent-hub-accounts installed separately
// interoperable. See docs/decisions/2026-08-26-vendor-agent-hub-accounts.md.

import os from 'os';
import path from 'path';

const agentHubHome = path.resolve(process.env.AGENT_HUB_HOME || path.join(os.homedir(), '.agent-hub'));
const pluginRoot = path.join(agentHubHome, 'plugins', 'accounts');
const registryPath = process.env.AGENT_HUB_ACCOUNTS_STATE || path.join(pluginRoot, 'state', 'registry.json');
const stateRoot = path.dirname(registryPath);

export const paths = {
  registryPath,
  livePath: path.join(stateRoot, 'live.json'),
  quotaPath: path.join(stateRoot, 'quota.json'),
  credentialsDir: path.join(stateRoot, 'credentials'),
  switchLockPath: path.join(stateRoot, 'keychain-switch'),
};
