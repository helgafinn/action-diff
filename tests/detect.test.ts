import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { detectBumps } from '../src/detect.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'action-diff test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'action-diff test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, env: GIT_ENV, stdio: 'pipe' });
}

/** A repository with one workflow committed twice, so a bump exists to detect. */
function repositoryWith(before: string, after: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(resolve(tmpdir(), 'action-diff-'));
  git(root, ['init', '--initial-branch=main']);
  mkdirSync(resolve(root, '.github/workflows'), { recursive: true });

  writeFileSync(resolve(root, '.github/workflows/ci.yml'), before, 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'before']);

  writeFileSync(resolve(root, '.github/workflows/ci.yml'), after, 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'after']);

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function workflow(uses: string): string {
  return `name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${uses}\n`;
}

test('detects a pinned action bump between two commits', async (context) => {
  const repo = repositoryWith(
    workflow(`actions/checkout@${OLD} # v4.2.1`),
    workflow(`actions/checkout@${NEW} # v4.2.2`),
  );
  context.after(repo.cleanup);

  const bumps = await detectBumps({ root: repo.root }, 'HEAD~1', 'HEAD');
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0]?.action, 'actions/checkout');
  assert.equal(bumps[0]?.before.ref, OLD);
  assert.equal(bumps[0]?.after.ref, NEW);
  assert.equal(bumps[0]?.after.versionComment, 'v4.2.2');
  assert.deepEqual(bumps[0]?.workflows, ['.github/workflows/ci.yml']);
});

// Only changed revisions are bumps. An added or removed step is already visible
// in the pull request diff and hides no upstream change.
test('ignores unchanged, added, and removed references', async (context) => {
  const repo = repositoryWith(
    workflow(`actions/checkout@${OLD}`),
    `${workflow(`actions/checkout@${OLD}`)}      - uses: actions/setup-node@${OTHER}\n`,
  );
  context.after(repo.cleanup);

  assert.deepEqual(await detectBumps({ root: repo.root }, 'HEAD~1', 'HEAD'), []);
});

test('restricts detection to requested workflow paths', async (context) => {
  const repo = repositoryWith(
    workflow(`actions/checkout@${OLD}`),
    workflow(`actions/checkout@${NEW}`),
  );
  context.after(repo.cleanup);

  const matched = await detectBumps({ root: repo.root }, 'HEAD~1', 'HEAD', [
    '.github/workflows/ci.yml',
  ]);
  assert.equal(matched.length, 1);

  const missed = await detectBumps({ root: repo.root }, 'HEAD~1', 'HEAD', [
    '.github/workflows/other.yml',
  ]);
  assert.deepEqual(missed, []);
});

// A tag-to-SHA migration is a real bump worth reviewing: the code being run can
// change even though the intent was only to harden the pin.
test('treats a move from tag to sha as a bump', async (context) => {
  const repo = repositoryWith(
    workflow('actions/checkout@v4'),
    workflow(`actions/checkout@${NEW} # v4`),
  );
  context.after(repo.cleanup);

  const bumps = await detectBumps({ root: repo.root }, 'HEAD~1', 'HEAD');
  assert.equal(bumps[0]?.before.ref, 'v4');
  assert.equal(bumps[0]?.after.ref, NEW);
});

// Regression: found by running action-diff on its own pin-hardening commit.
//
// Replacing `@v5` with the commit `v5` already points at is a reference change
// with no code change. detectBumps compares reference strings, so it correctly
// sees a difference — but the review that follows must explain that both sides
// resolve to one commit rather than presenting an empty finding list, which
// reads as "we looked and found nothing" instead of "there was nothing there".
test('a tag replaced by its own commit is still detected as a reference change', async (context) => {
  const repo = repositoryWith(
    workflow('actions/checkout@v5'),
    workflow(`actions/checkout@${NEW} # v5`),
  );
  context.after(repo.cleanup);

  const bumps = await detectBumps({ root: repo.root }, 'HEAD~1', 'HEAD');
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0]?.before.ref, 'v5');
  assert.equal(bumps[0]?.after.ref, NEW);
  assert.equal(bumps[0]?.after.versionComment, 'v5');
});
