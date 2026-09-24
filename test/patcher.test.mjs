import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { patchOfficialExtensionTimeout } = await import('../out/daemon/patcher/officialPatcher.js');

test('patchOfficialExtensionTimeout patches 15000 timeout to 60000', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-patcher-test-'));
  try {
    const extDir = path.join(tmpDir, 'google.google-antigravity-1.4.0');
    fs.mkdirSync(extDir, { recursive: true });
    const extJs = path.join(extDir, 'extension.js');
    const dummyContent = `
    // Dummy official extension
    async waitForServerReady(url, timeoutMs = 15000) {
      return true;
    }
    `;
    fs.writeFileSync(extJs, dummyContent, 'utf8');

    const result = patchOfficialExtensionTimeout(tmpDir);
    assert.equal(result.attempted, true);
    assert.equal(result.patched, true);

    const patchedContent = fs.readFileSync(extJs, 'utf8');
    assert.match(patchedContent, /timeoutMs = 60000/);
    assert.ok(fs.existsSync(`${extJs}.bak`));

    // Second call should be idempotent
    const secondResult = patchOfficialExtensionTimeout(tmpDir);
    assert.equal(secondResult.attempted, true);
    assert.equal(secondResult.patched, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
