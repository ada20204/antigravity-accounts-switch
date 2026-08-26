// Structure limits enforced as tests instead of only a written convention —
// mirrors agent-hub-accounts' test/project-contract.test.mjs (its own repo
// carries no exceptions; this one starts with two, both already flagged in
// docs/decisions/, not silently ignored).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SRC_ROOT = path.join(ROOT, 'src');

const MAX_LINES = 500;
const MAX_FILES_PER_DIR = 12;

// Files already over MAX_LINES when this test was added, with the line count
// each had at that point. Per the user's project-structure methodology rule
// (~/.claude/methodology/rules/habits/project-structure.md — an external
// personal rule file, not part of this repo — "已有超限路径不做无目标历史
// 清算，再次修改时重新评审"): don't force-split an already-over-limit file
// just to make this test pass, re-evaluate the next time it's substantially
// changed. The recorded count is a ratchet, not a permanent bypass — the
// test still fails if either file grows past what it was here, so the limit
// keeps applying pressure on any *further* growth even while today's count
// is grandfathered in. Adding an entry (or bumping one's count) should be
// rare and deliberate, not a way to silence a new violation.
const LINE_LIMIT_EXCEPTIONS = new Map([
  // See docs/ISSUES.md — extension.ts is overdue for splitting, not just
  // another ratchet bump.
  ['src/daemon/extension.ts', 900],
  ['src/daemon/hubRestart.ts', 651],
]);

function relativePath(target) {
  return path.relative(ROOT, target).split(path.sep).join('/');
}

function listSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

// content.split('\n').length over-counts by one for a normally trailing-
// newline-terminated file ("a\nb\nc\n".split('\n') is ['a','b','c',''], length
// 4 for 3 real lines) — strip exactly one trailing newline first so the count
// matches what an editor's line gutter would show, and what `wc -l` reports.
function countLines(file) {
  const content = fs.readFileSync(file, 'utf8');
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  return trimmed === '' ? 0 : trimmed.split('\n').length;
}

test('source files stay below the line-count limit unless already flagged', () => {
  const overLimit = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const relative = relativePath(file);
    const lines = countLines(file);
    const baseline = LINE_LIMIT_EXCEPTIONS.get(relative);
    if (baseline === undefined) {
      if (lines > MAX_LINES) overLimit.push(`${relative} (${lines} lines, limit ${MAX_LINES})`);
    } else if (lines > baseline) {
      overLimit.push(`${relative} grew from its recorded baseline of ${baseline} to ${lines} lines`);
    }
  }
  assert.deepEqual(overLimit, [], `files over their limit:\n${overLimit.join('\n')}`);
});

test('source directories stay below the direct-file-count limit', () => {
  const overLimit = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const directFiles = entries.filter((e) => e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.css')));
    if (directFiles.length > MAX_FILES_PER_DIR) {
      overLimit.push(`${relativePath(dir)} (${directFiles.length} files)`);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  }
  walk(SRC_ROOT);
  assert.deepEqual(overLimit, [], `directories over ${MAX_FILES_PER_DIR} direct files:\n${overLimit.join('\n')}`);
});
