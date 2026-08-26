// Runs agent-hub-accounts CLI subcommands without a shell.
//
// The old call sites built a shell command string with accountId interpolated
// directly (`node ${CLI} switch "${accountId}" --json`) — with no escaping, any
// accountId containing a `"` breaks out of the quoted argument and is
// interpreted as shell syntax. accountId comes from request bodies and from
// DOM-scraped Account panel text, both outside our control. execFile bypasses
// the shell entirely (args are passed as an argv array to exec(2), never
// concatenated into a string a shell parses), so this class of injection is
// structurally impossible here regardless of what accountId contains.
//
// Also collapses the execAsync(...) + JSON.parse(stdout) pattern that used to
// be hand-rolled at every call site (~14 times) into one place.

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
    // agent-hub-accounts moved this module to dist/accounts/keychain.js during
    // its own refactor (documented in its docs/explanation/integrations.md as
    // a known drift point) — the old dist/keychain.js path silently no longer
    // exists, which made isKeychainActiveAvailable() always fall into its
    // "assume available" catch (masking real sign-out state) and
    // detachActiveKeychainLogin() throw on every call (breaking the whole
    // add-account flow at the begin() step). This is still the same kind of
    // internal-module reach-in agent-hub-accounts' own docs flag as not a
    // stable contract — worth replacing with a public CLI command if one
    // covers this later — but for now this is the fix that makes it work.
    `const { MacKeychain } = require(${JSON.stringify(path.join(AGENT_HUB_DIST, 'accounts/keychain.js'))});`,
    'const keychain = new MacKeychain(settings().credentialsDir);',
    finalStatement,
  ].join('');
}

// No `-w`, so this reads nothing secret and never prompts — just whether the
// shared Keychain slot exists at all.
//
// On error, assume available (true) rather than letting the exception
// propagate — the pre-refactor isSignedOut() this replaced had the same
// catch, with the same reasoning: "can't tell — don't cry wolf". A transient
// execFile hiccup here previously 500'd the whole /api/add-account/status
// response (used as `signedOut: !(await isKeychainActiveAvailable())`),
// dropping pending/justAdded for that poll mid-flow even though nothing
// about the add-account state actually changed.
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
