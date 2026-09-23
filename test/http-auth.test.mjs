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
