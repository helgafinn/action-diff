import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  actionIdentity,
  extractActionRefs,
  isAbbreviatedSha,
  isFullSha,
  normalizeVersionComment,
  parseActionRef,
} from '../src/refs.js';

const SHA = 'a'.repeat(40);

test('parses a published action reference with a subpath', () => {
  const ref = parseActionRef(`owner/repo/tools/scan@${SHA}`);
  assert.equal(ref?.slug, 'owner/repo');
  assert.equal(ref?.subpath, 'tools/scan');
  assert.equal(ref?.ref, SHA);
  assert.equal(actionIdentity(ref!), 'owner/repo/tools/scan');
});

test('omits subpath for a root action', () => {
  const ref = parseActionRef('actions/checkout@v5');
  assert.equal(ref?.subpath, undefined);
  assert.equal(actionIdentity(ref!), 'actions/checkout');
});

// Local and container references carry no upstream revision to review, and a
// local action's code already appears in the pull request diff.
test('ignores references with nothing upstream to review', () => {
  assert.equal(parseActionRef('./.github/actions/build'), undefined);
  assert.equal(parseActionRef('../shared/action'), undefined);
  assert.equal(parseActionRef('docker://alpine:3'), undefined);
  assert.equal(parseActionRef('owner/repo'), undefined);
  assert.equal(parseActionRef('owner/repo@'), undefined);
  assert.equal(parseActionRef('@v1'), undefined);
  assert.equal(parseActionRef(''), undefined);
});

test('distinguishes full from abbreviated commit shas', () => {
  assert.equal(isFullSha(SHA), true);
  assert.equal(isAbbreviatedSha(SHA), false);
  assert.equal(isFullSha('abc1234'), false);
  assert.equal(isAbbreviatedSha('abc1234'), true);
  assert.equal(isAbbreviatedSha('v4.2.2'), false);
});

test('reads the version a trailing comment claims', () => {
  assert.equal(normalizeVersionComment('# v4.2.2'), 'v4.2.2');
  assert.equal(normalizeVersionComment('v4.2.2'), 'v4.2.2');
  assert.equal(normalizeVersionComment('pin @v4.2.2'), 'v4.2.2');
  assert.equal(normalizeVersionComment('v1.2.3-beta.1'), 'v1.2.3-beta.1');
  assert.equal(normalizeVersionComment('3.1'), '3.1');
  assert.equal(normalizeVersionComment('immutable pin, do not edit'), undefined);
  assert.equal(normalizeVersionComment(undefined), undefined);
});

test('captures the Dependabot pin-with-version-comment shape', () => {
  const refs = extractActionRefs(`
jobs:
  build:
    steps:
      - uses: actions/checkout@${SHA} # v4.2.2
`);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.slug, 'actions/checkout');
  assert.equal(refs[0]?.ref, SHA);
  assert.equal(refs[0]?.versionComment, 'v4.2.2');
});

test('extracts quoted, unquoted, and reusable-workflow references', () => {
  const refs = extractActionRefs(`
jobs:
  a:
    uses: owner/wf/.github/workflows/build.yml@v2
    steps:
      - uses: 'actions/setup-node@v6'
      - uses: "actions/cache@v4"
      - uses: ./local
      - run: echo not-a-uses
`);
  const identities = refs.map((ref) => actionIdentity(ref));
  assert.deepEqual(identities, [
    'owner/wf/.github/workflows/build.yml',
    'actions/setup-node',
    'actions/cache',
  ]);
});

// A step named "uses" or prose mentioning uses must not be mistaken for a
// reference, and a comment on its own line must not attach to the previous one.
test('does not invent references from surrounding text', () => {
  // The `uses:` inside a `name:` value is prose, not a reference. The commented
  // line is deliberately excluded too: a disabled step is not a live pin, so a
  // finding about its version comment describes code that cannot run.
  const refs = extractActionRefs(`
      - name: this uses: something informal
        run: echo hi
      # uses: owner/repo@v1
`);
  assert.deepEqual(refs, []);
});

test('ignores a uses: line that is commented out', () => {
  // A disabled step is not a live pin. Reviewing its version comment produces a
  // finding about code that does not run.
  const source = [
    'steps:',
    '  # - name: Harden Runner',
    `  #   uses: step-security/harden-runner@${SHA} # v2.5.1`,
    '  #   with:',
    '  #     egress-policy: audit',
  ].join('\n');
  assert.deepEqual(extractActionRefs(source), []);
});

test('still finds a live reference alongside a commented-out one', () => {
  const source = [
    'steps:',
    `  #   uses: owner/disabled@${SHA} # v1`,
    `  - uses: owner/live@${SHA} # v2`,
  ].join('\n');
  const refs = extractActionRefs(source);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.slug, 'owner/live');
});

test('a trailing inline comment is still read as a version claim', () => {
  // Only a leading `#` disables a line. An inline trailing comment is the normal
  // way the version is recorded and must keep working.
  const refs = extractActionRefs(`  - uses: owner/repo@${SHA} # v4.2.2`);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.versionComment, 'v4.2.2');
});
