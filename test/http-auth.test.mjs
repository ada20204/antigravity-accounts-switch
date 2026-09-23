import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { requiresDaemonToken, DAEMON_CORS_ALLOWED_HEADERS } = await import('../out/daemon/httpUtils.js');

test('CORS preflight is allowed before daemon token authentication', () => {
  assert.equal(requiresDaemonToken('OPTIONS', '/api/accounts'), false);
  assert.equal(requiresDaemonToken('GET', '/api/accounts'), true);
  assert.match(DAEMON_CORS_ALLOWED_HEADERS, /X-AG-Daemon-Token/);
});

test('all shared POST helpers carry the daemon token', () => {
  const source = fs.readFileSync(new URL('../src/runtime/services/accountStore.ts', import.meta.url), 'utf8');
  const postJson = source.match(/private static async postJson[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(postJson, /\.\.\.this\.DAEMON_HEADERS/u);
});

test('simplifyTier strictly whitelists tier outputs and rejects attribute escape payloads', async () => {
  const { simplifyTier } = await import('../out/daemon/switchService.js');
  assert.equal(simplifyTier('Antigravity Ultra 2.0'), 'Ultra');
  assert.equal(simplifyTier('Google AI Pro Plan'), 'Pro');
  assert.equal(simplifyTier('Antigravity Free Tier'), 'Free');
  assert.equal(simplifyTier('Unknown'), 'Free');
  assert.equal(simplifyTier(null), 'Free');
  assert.equal(simplifyTier('"><script>alert(1)</script>'), 'Free');
});

