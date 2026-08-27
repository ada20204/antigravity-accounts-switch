// Exercises the vendored account-management code (src/daemon/accounts/) end
// to end against synthetic data — never real credentials, never the real
// ~/.agent-hub directory. See docs/decisions/2026-08-26-vendor-agent-hub-accounts.md
// for why this exists: this project has two documented incidents of real
// account corruption from bugs in exactly this class of code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiledIndex = path.join(projectRoot, 'out', 'daemon', 'accounts', 'index.js');

test('vendored account lifecycle: capture, switch, remove — synthetic data only', () => {
  assert.ok(
    fs.existsSync(compiledIndex),
    `${compiledIndex} does not exist — run "npm run compile" before "npm test"`,
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-accounts-enhancer-test-'));
  const home = path.join(root, 'hub');
  const fakeSecurity = path.join(root, 'security.mjs');
  const fakeKeychainState = path.join(root, 'keychain.json');

  // Same fake-Keychain shape agent-hub-accounts' own test/plugin.test.mjs
  // uses: a JSON file keyed by "service\0account", driven by the real
  // find/add/delete-generic-password argv shape.
  fs.writeFileSync(fakeSecurity, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const key = option('-s') + '\\0' + option('-a');
const file = process.env.FAKE_KEYCHAIN_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (args[0] === 'find-generic-password') {
  if (!Object.hasOwn(state, key)) process.exit(44);
  if (args.includes('-w')) process.stdout.write(state[key] + '\\n');
  process.exit(0);
}
if (args[0] === 'add-generic-password') {
  state[key] = Buffer.from(option('-X'), 'hex').toString('utf8');
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  process.exit(0);
}
if (args[0] === 'delete-generic-password') {
  if (!Object.hasOwn(state, key)) process.exit(44);
  delete state[key];
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  process.exit(0);
}
process.exit(2);
`, { mode: 0o700 });
  fs.writeFileSync(fakeKeychainState, JSON.stringify({}), { mode: 0o600 });

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    AGENT_HUB_HOME: home,
    AGENT_HUB_ACCOUNTS_TEST_SECURITY_BIN: fakeSecurity,
    FAKE_KEYCHAIN_STATE: fakeKeychainState,
  };

  // Shaped like a real standalone-token envelope ("prefix:base64(JSON with
  // refresh_token)") — capture()/switchAccount() don't care about this shape
  // (they just move the string around), but importProfile() validates it via
  // decodeStandaloneToken(), so export/import needs realistic fixtures, not
  // an arbitrary string.
  function fakeSecret(name) {
    return `token:${Buffer.from(JSON.stringify({ refresh_token: `refresh-${name}` })).toString('base64')}`;
  }

  function harness(script, extraEnv = {}) {
    const scriptPath = path.join(root, `step-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
    fs.writeFileSync(scriptPath, script);
    const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env: { ...env, ...extraEnv } });
    assert.equal(result.status, 0, `harness script failed:\n${result.stderr}`);
    return JSON.parse(result.stdout.trim().split('\n').pop());
  }

  // 1. Sign in as accountA (write the active secret directly, same as a real
  // `agy login` would) and capture it.
  fs.writeFileSync(fakeKeychainState, JSON.stringify({ 'gemini\0antigravity': fakeSecret('a') }), { mode: 0o600 });
  const afterCaptureA = harness(`
    const { accountService } = require(${JSON.stringify(compiledIndex)});
    const result = accountService.capture('a@example.com', 'a@example.com', true);
    console.log(JSON.stringify(result));
  `);
  assert.equal(afterCaptureA.account_id, 'a@example.com');

  const overviewAfterA = harness(`
    const { accountService } = require(${JSON.stringify(compiledIndex)});
    console.log(JSON.stringify(accountService.verifiedOverview('antigravity-cli')));
  `);
  const a1 = overviewAfterA.accounts.find((x) => x.account_id === 'a@example.com');
  assert.equal(a1.is_active, true, 'accountA should be active right after capture');

  // 2. Sign in as accountB (different secret) and capture it too — accountA
  // must NOT still be reported active once the Keychain has moved on.
  fs.writeFileSync(fakeKeychainState, JSON.stringify({ 'gemini\0antigravity': fakeSecret('b') }), { mode: 0o600 });
  const afterCaptureB = harness(`
    const { accountService } = require(${JSON.stringify(compiledIndex)});
    const result = accountService.capture('b@example.com', 'b@example.com', true);
    console.log(JSON.stringify(result));
  `);
  assert.equal(afterCaptureB.account_id, 'b@example.com');

  const overviewAfterB = harness(`
    const { accountService } = require(${JSON.stringify(compiledIndex)});
    console.log(JSON.stringify(accountService.verifiedOverview('antigravity-cli')));
  `);
  const aAfterB = overviewAfterB.accounts.find((x) => x.account_id === 'a@example.com');
  const bAfterB = overviewAfterB.accounts.find((x) => x.account_id === 'b@example.com');
  assert.equal(aAfterB.is_active, false, 'accountA must not read as active once the Keychain moved to B');
  assert.equal(bAfterB.is_active, true);

  // 3. Switch back to accountA — this is the exact operation two real
  // incidents in this project's history were about getting wrong.
  const switchResult = harness(`
    const { accountService } = require(${JSON.stringify(compiledIndex)});
    const result = accountService.switchAccount('a@example.com');
    console.log(JSON.stringify(result));
  `);
  assert.equal(switchResult.status, 'switched');
  assert.equal(switchResult.account_id, 'a@example.com');

  const overviewAfterSwitch = harness(`
    const { accountService } = require(${JSON.stringify(compiledIndex)});
    console.log(JSON.stringify(accountService.verifiedOverview('antigravity-cli')));
  `);
  const aAfterSwitch = overviewAfterSwitch.accounts.find((x) => x.account_id === 'a@example.com');
  const bAfterSwitch = overviewAfterSwitch.accounts.find((x) => x.account_id === 'b@example.com');
  assert.equal(aAfterSwitch.is_active, true, 'accountA should be active again after switching back');
  assert.equal(bAfterSwitch.is_active, false);

  // 4. Remove accountB (not the active one) — must succeed and disappear.
  const removeResult = harness(`
    const { registry, keychain } = require(${JSON.stringify(compiledIndex)});
    let credentialRemoved = false;
    const mutation = registry.remove('b@example.com', 'b@example.com', false, (profile) => {
      credentialRemoved = keychain.remove('b@example.com');
    });
    console.log(JSON.stringify({ credentialRemoved, cleared_default: mutation.result.cleared_default }));
  `);
  assert.equal(removeResult.credentialRemoved, true);

  const overviewAfterRemove = harness(`
    const { accountService } = require(${JSON.stringify(compiledIndex)});
    console.log(JSON.stringify(accountService.verifiedOverview('antigravity-cli')));
  `);
  assert.equal(overviewAfterRemove.accounts.find((x) => x.account_id === 'b@example.com'), undefined);
  assert.ok(overviewAfterRemove.accounts.find((x) => x.account_id === 'a@example.com'), 'accountA must survive removing accountB');

  // 5. Export the current state (just accountA) and import it into a
  // completely separate, empty registry location — proves the bundle
  // actually carries a working credential rather than just metadata.
  const bundlePath = path.join(root, 'export-bundle.json');
  const exportResult = harness(`
    const { registry, keychain, exportAccounts } = require(${JSON.stringify(compiledIndex)});
    const result = exportAccounts({ filePath: ${JSON.stringify(bundlePath)}, registry, keychain });
    console.log(JSON.stringify(result));
  `);
  assert.equal(exportResult.accounts, 1);
  assert.equal(exportResult.credentials, 1);
  assert.ok(fs.existsSync(bundlePath));

  const home2Env = { AGENT_HUB_HOME: path.join(root, 'hub2') };
  const importResult = harness(`
    const { registry, keychain, importAccounts } = require(${JSON.stringify(compiledIndex)});
    const result = importAccounts({ filePath: ${JSON.stringify(bundlePath)}, registry, keychain });
    console.log(JSON.stringify(result));
  `, home2Env);
  assert.deepEqual(importResult.imported, ['a@example.com']);
  assert.equal(importResult.credentials, 1);

  const overviewInHome2 = harness(`
    const { accountService } = require(${JSON.stringify(compiledIndex)});
    console.log(JSON.stringify(accountService.verifiedOverview('antigravity-cli')));
  `, home2Env);
  const aInHome2 = overviewInHome2.accounts.find((x) => x.account_id === 'a@example.com');
  assert.ok(aInHome2, 'imported account must appear in the fresh registry');
  assert.equal(aInHome2.is_active, true, 'imported credential must verify as active — proves the bundle carried a real, working secret, not just metadata');

  fs.rmSync(root, { recursive: true, force: true });
});
