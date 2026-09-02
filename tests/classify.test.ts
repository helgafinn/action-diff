import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { classifyRevisions } from '../src/classify.js';
import { parseActionManifest } from '../src/manifest.js';
import type { ActionRevision, Finding } from '../src/types.js';

function revision(manifest: string, files: Record<string, string> = {}): ActionRevision {
  const parsed = parseActionManifest(manifest);
  return {
    ref: { slug: 'o/r', owner: 'o', repo: 'r', ref: 'x'.repeat(40), raw: 'o/r@x' },
    sha: 'x'.repeat(40),
    ...(parsed === undefined ? {} : { manifest: parsed }),
    files,
  };
}

function codes(findings: Finding[]): string[] {
  return findings.map((finding) => finding.code).sort();
}

function find(findings: Finding[], code: string): Finding | undefined {
  return findings.find((finding) => finding.code === code);
}

const NODE = 'runs:\n  using: node24\n  main: dist/index.js\n';

test('flags a change of execution model as critical', () => {
  const findings = classifyRevisions(
    revision(NODE),
    revision('runs:\n  using: docker\n  image: Dockerfile\n'),
  );
  const finding = find(findings, 'runtime.kind-changed');
  assert.equal(finding?.severity, 'critical');
});

// A node runtime bump is routine maintenance and must not cry wolf, otherwise
// reviewers learn to ignore the tool.
test('treats a runtime version bump as informational', () => {
  const findings = classifyRevisions(
    revision('runs:\n  using: node20\n  main: dist/index.js\n'),
    revision(NODE),
  );
  const finding = find(findings, 'runtime.version-changed');
  assert.equal(finding?.severity, 'info');
  assert.equal(find(findings, 'runtime.kind-changed'), undefined);
});

test('reports interface changes that break or silently alter callers', () => {
  const before = revision(`${NODE}inputs:\n  keep:\n    default: a\n  gone: {}\noutputs:\n  out: {}\n`);
  const after = revision(`${NODE}inputs:\n  keep:\n    default: b\n  fresh:\n    required: true\n`);
  const findings = classifyRevisions(before, after);

  assert.deepEqual(codes(findings), [
    'inputs.default-changed',
    'inputs.removed',
    'inputs.required-added',
    'outputs.removed',
  ]);
  assert.equal(find(findings, 'inputs.required-added')?.severity, 'high');
  assert.equal(find(findings, 'outputs.removed')?.severity, 'high');
});

test('flags an optional input becoming required', () => {
  const findings = classifyRevisions(
    revision(`${NODE}inputs:\n  a: {}\n`),
    revision(`${NODE}inputs:\n  a:\n    required: true\n`),
  );
  assert.equal(find(findings, 'inputs.now-required')?.severity, 'high');
});

test('does not report a new optional input as a risk', () => {
  const findings = classifyRevisions(
    revision(NODE),
    revision(`${NODE}inputs:\n  extra: {}\n`),
  );
  assert.equal(find(findings, 'inputs.added')?.severity, 'info');
});

test('detects newly reachable network hosts', () => {
  const findings = classifyRevisions(
    revision(NODE, { 'dist/index.js': 'fetch("https://api.github.com/x")' }),
    revision(NODE, { 'dist/index.js': 'fetch("https://api.github.com/x"); fetch("https://evil.example/y")' }),
  );
  const finding = find(findings, 'source.new-egress-host');
  assert.equal(finding?.severity, 'high');
  assert.deepEqual(finding?.after, ['evil.example']);
});

// GitHub's own endpoints are inherent to running an action, so reporting them
// would bury the one host that matters.
test('ignores hosts every action already talks to', () => {
  const findings = classifyRevisions(
    revision(NODE, { 'dist/index.js': 'const a = 1;' }),
    revision(NODE, { 'dist/index.js': 'const a = 1; fetch("https://api.github.com/z")' }),
  );
  assert.equal(find(findings, 'source.new-egress-host'), undefined);
});

test('detects newly introduced fetching, secrets, and dynamic execution', () => {
  const findings = classifyRevisions(
    revision(NODE, { 'entrypoint.sh': 'echo hello' }),
    revision(NODE, {
      'entrypoint.sh': 'echo hello\ncurl -s "$URL"\necho "${{ secrets.NPM_TOKEN }}"\neval "$PAYLOAD"',
    }),
  );
  assert.deepEqual(codes(findings), [
    'source.dynamic-execution-added',
    'source.network-command-added',
    'source.secret-reference-added',
  ]);
});

// The signal is "a capability appeared", so moving an existing line must stay
// quiet or every reformat becomes a security finding.
test('stays quiet when existing code only moves', () => {
  const findings = classifyRevisions(
    revision(NODE, { 'run.sh': 'curl https://example.com\necho done' }),
    revision(NODE, { 'run.sh': 'echo done\ncurl https://example.com' }),
  );
  assert.deepEqual(codes(findings), []);
});

test('reports added runtime dependencies but not dev dependencies', () => {
  const findings = classifyRevisions(
    revision(NODE, { 'package.json': '{"dependencies":{"a":"1"},"devDependencies":{"d":"1"}}' }),
    revision(NODE, {
      'package.json': '{"dependencies":{"a":"1","b":"2"},"devDependencies":{"d":"1","e":"9"}}',
    }),
  );
  const finding = find(findings, 'dependencies.added');
  assert.deepEqual(finding?.after, ['b']);
});

test('reports a new executable file', () => {
  const findings = classifyRevisions(
    revision(NODE),
    revision(NODE, { 'setup.sh': 'echo configuring' }),
  );
  assert.equal(find(findings, 'source.script-added')?.severity, 'medium');
});

// Losing the manifest means the interface can no longer be checked at all,
// which is a review problem rather than a clean result.
test('flags a new revision whose manifest cannot be read', () => {
  const after = revision(NODE);
  delete (after as { manifest?: unknown }).manifest;
  const findings = classifyRevisions(revision(NODE), after);
  assert.equal(find(findings, 'manifest.unreadable')?.severity, 'high');
});
