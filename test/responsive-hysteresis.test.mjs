import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('styles.css does not contain oscillating @container agcard queries or dimension transitions', () => {
  const stylesPath = new URL('../src/runtime/ui/styles.css', import.meta.url);
  const content = fs.readFileSync(stylesPath, 'utf8');

  assert.equal(content.includes('@container agcard'), false, '@container agcard should be removed');
  assert.equal(content.includes('transition: padding'), false, 'transition: padding causes multi-frame resize loops');
  assert.equal(content.includes('container-type: inline-size'), false, 'container-type on card should be removed');
  assert.ok(content.includes('.ag-settings-custom-card.ag-compact'), 'compact class styles must remain');
});

test('responsive hysteresis thresholds prevent boundary flapping', () => {
  // Mock element with classList
  class MockElement {
    constructor() {
      this._classes = new Set();
    }
    classList = {
      contains: (cls) => this._classes.has(cls),
      add: (cls) => this._classes.add(cls),
      remove: (cls) => this._classes.delete(cls),
    };
  }

  // Simulate updateCompactMode logic
  const COMPACT_ENTER_WIDTH = 490;
  const COMPACT_EXIT_WIDTH = 530;

  function updateCompactMode(card, width) {
    if (width <= 0) return false;
    const wasCompact = card.classList.contains('ag-compact');
    if (wasCompact && width > COMPACT_EXIT_WIDTH) {
      card.classList.remove('ag-compact');
      return true;
    }
    if (!wasCompact && width < COMPACT_ENTER_WIDTH) {
      card.classList.add('ag-compact');
      return true;
    }
    return false;
  }

  const el = new MockElement();

  // 1. Initial wide view (600px) -> remains full
  updateCompactMode(el, 600);
  assert.equal(el.classList.contains('ag-compact'), false);

  // 2. Shrinks to 520px (buffer zone) -> remains full (does NOT flap to compact)
  updateCompactMode(el, 520);
  assert.equal(el.classList.contains('ag-compact'), false);

  // 3. Shrinks to 500px (buffer zone) -> still full
  updateCompactMode(el, 500);
  assert.equal(el.classList.contains('ag-compact'), false);

  // 4. Shrinks below enter threshold (480px < 490px) -> enters compact mode
  const changedToCompact = updateCompactMode(el, 480);
  assert.equal(changedToCompact, true);
  assert.equal(el.classList.contains('ag-compact'), true);

  // 5. Scrollbar disappears, width increases by 15px to 495px (in buffer zone) -> REMAINS COMPACT!
  const unchanged1 = updateCompactMode(el, 495);
  assert.equal(unchanged1, false);
  assert.equal(el.classList.contains('ag-compact'), true);

  // 6. User resizes window to 520px (the old critical boundary) -> REMAINS COMPACT! NO FLAPPING!
  const unchanged2 = updateCompactMode(el, 520);
  assert.equal(unchanged2, false);
  assert.equal(el.classList.contains('ag-compact'), true);

  // 7. Width exceeds exit threshold (535px > 530px) -> exits compact mode
  const changedToFull = updateCompactMode(el, 535);
  assert.equal(changedToFull, true);
  assert.equal(el.classList.contains('ag-compact'), false);

  // 8. Scrollbar appears, width drops by 15px to 520px -> REMAINS FULL! NO FLAPPING!
  const unchanged3 = updateCompactMode(el, 520);
  assert.equal(unchanged3, false);
  assert.equal(el.classList.contains('ag-compact'), false);

  // 9. Negative or zero width ignored safely
  assert.equal(updateCompactMode(el, 0), false);
  assert.equal(updateCompactMode(el, -50), false);
});
