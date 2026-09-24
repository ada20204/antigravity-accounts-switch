import assert from 'node:assert/strict';
import test from 'node:test';
import { maskEmail } from '../out/daemon/switchService.js';

test('maskEmail desensitizes full emails and usernames appropriately', () => {
  // Long emails (> 5 chars before @)
  assert.equal(maskEmail('alexander.taylor@example.com', true), 'ale***or@example.com');
  assert.equal(maskEmail('antigravity.developer@gmail.com', true), 'ant***er@gmail.com');
  assert.equal(maskEmail('community.tester@gmail.com', true), 'com***er@gmail.com');
  assert.equal(maskEmail('developer.user@domain.co.uk', true), 'dev***er@domain.co.uk');

  // Medium usernames (3 to 5 chars before @)
  assert.equal(maskEmail('john@gmail.com', true), 'j***n@gmail.com');
  assert.equal(maskEmail('alice@gmail.com', true), 'a***e@gmail.com');
  assert.equal(maskEmail('bob@gmail.com', true), 'b***b@gmail.com');

  // Short usernames (<= 2 chars before @)
  assert.equal(maskEmail('me@gmail.com', true), 'm***@gmail.com');
  assert.equal(maskEmail('a@gmail.com', true), 'a***@gmail.com');

  // Standalone usernames (without @)
  assert.equal(maskEmail('alexander.taylor', true), 'ale***or');
  assert.equal(maskEmail('john', true), 'j***n');
  assert.equal(maskEmail('me', true), 'm***');
  assert.equal(maskEmail('x', true), 'x***');

  // When masked = false, leaves original string untouched
  assert.equal(maskEmail('alexander.taylor@example.com', false), 'alexander.taylor@example.com');
  assert.equal(maskEmail('john', false), 'john');

  // Empty / null / undefined inputs
  assert.equal(maskEmail('', true), '');
  assert.equal(maskEmail(null, true), '');
  assert.equal(maskEmail(undefined, true), '');
});
