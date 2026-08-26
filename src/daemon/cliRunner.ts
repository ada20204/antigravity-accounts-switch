// Runs agent-hub-accounts CLI subcommands via execFile (argv array, no shell
// parsing — accountId comes from untrusted request bodies/DOM scraping) — see
// docs/decisions/2026-08-23-first-code-review-17-findings.md.

import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

// Overridable so this doesn't stay hardcoded to one machine/account — see
// docs/decisions/2026-08-23-first-code-review-17-findings.md. Falls back to the layout this project's own README
// assumes (sibling checkout under ~/work), which is what every environment
// this has actually run in used so far.
export const AGENT_HUB_DIST =
  process.env.AGENT_HUB_ACCOUNTS_DIST || path.join(os.homedir(), 'work', 'agent-hub-accounts', 'dist');
const AGENT_HUB_CLI = path.join(AGENT_HUB_DIST, 'cli.js');

export async function runCli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('node', [AGENT_HUB_CLI, ...args]);
  return stdout;
}

export async function runCliJson(args: string[]): Promise<any> {
  return JSON.parse(await runCli(args));
}

// Builds the `node -e '<snippet>'` preamble shared by every place that reaches
// into agent-hub-accounts' own MacKeychain directly (activeAvailable(),
// detachActive()) instead of going through a CLI subcommand. Both call sites
// used to paste this same two-line require() block themselves — if
// agent-hub-accounts' internal module layout ever changes, there was nothing
// tying the two copies together.
function keychainSnippet(finalStatement: string): string {
  return [
    `const { settings } = require(${JSON.stringify(path.join(AGENT_HUB_DIST, 'cli/options.js'))});`,
    // Path moved during agent-hub-accounts' own refactor — see
    // docs/decisions/2026-08-26-cliRunner-stale-keychain-path.md.
    `const { MacKeychain } = require(${JSON.stringify(path.join(AGENT_HUB_DIST, 'accounts/keychain.js'))});`,
    'const keychain = new MacKeychain(settings().credentialsDir);',
    finalStatement,
  ].join('');
}

// No `-w`, so this reads nothing secret and never prompts. On error, assume
// available rather than propagating — "can't tell, don't cry wolf"; see
// docs/decisions/2026-08-23-review-b9ad69f-followup-10-findings.md.
export async function isKeychainActiveAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('node', ['-e', keychainSnippet('process.stdout.write(String(keychain.activeAvailable()));')]);
    return stdout.trim() === 'true';
  } catch {
    return true;
  }
}

// `security delete-generic-password` — purely local, no OAuth revoke. See
// docs/decisions/2026-08-23-add-account-native-browser-final.md.
export async function detachActiveKeychainLogin(): Promise<void> {
  await execFileAsync('node', ['-e', keychainSnippet('keychain.detachActive();')]);
}
