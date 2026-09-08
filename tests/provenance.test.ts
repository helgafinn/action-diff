import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { GitHubClient, TreeEntry } from '../src/github.js';
import { provenanceFindings, verifyProvenance } from '../src/provenance.js';
import { parseActionRef } from '../src/refs.js';
import type { ActionRef, Finding } from '../src/types.js';

const PINNED = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

interface FakeState {
  refsContaining?: Record<string, string[]>;
  tagTargets?: Record<string, string>;
  defaultBranch?: string;
  ancestors?: string[];
  failResolve?: boolean;
}

function fakeClient(state: FakeState): GitHubClient {
  return {
    async resolveCommit(_slug: string, ref: string): Promise<string> {
      if (state.failResolve === true) throw new Error('network unreachable');
      const target = state.tagTargets?.[ref];
      if (target !== undefined) return target;
      if (/^[0-9a-f]{40}$/u.test(ref)) return ref;
      throw new Error(`unknown ref ${ref}`);
    },
    async listTree(): Promise<TreeEntry[]> {
      return [];
    },
    async readFile(): Promise<string | undefined> {
      return undefined;
    },
    async refsContaining(_slug: string, sha: string): Promise<string[]> {
      return state.refsContaining?.[sha] ?? [];
    },
    async defaultBranch(): Promise<string> {
      return state.defaultBranch ?? 'main';
    },
    async isAncestor(_slug: string, ancestor: string): Promise<boolean> {
      return (state.ancestors ?? []).includes(ancestor);
    },
  };
}

function ref(raw: string): ActionRef {
  const parsed = parseActionRef(raw.split('#')[0]!.trim(), raw.includes('#') ? raw.split('#')[1] : undefined);
  assert.ok(parsed !== undefined, `could not parse ${raw}`);
  return parsed;
}

function codes(findings: Finding[]): string[] {
  return findings.map((finding) => finding.code).sort();
}

test('accepts a commit that a tag contains', async () => {
  const client = fakeClient({ refsContaining: { [PINNED]: ['tag:v4.2.2'] } });
  const provenance = await verifyProvenance(client, ref(`actions/checkout@${PINNED}`));

  assert.equal(provenance.sha, PINNED);
  assert.deepEqual(provenance.reachableFrom, ['tag:v4.2.2']);
  assert.deepEqual(codes(provenanceFindings(ref(`actions/checkout@${PINNED}`), provenance)), []);
});

// This is the tj-actions shape: nothing upstream publishes the commit, which is
// what a rewritten tag leaves behind.
test('flags a commit that no tag, branch, or default-branch history contains', async () => {
  const client = fakeClient({});
  const target = ref(`actions/checkout@${PINNED}`);
  const provenance = await verifyProvenance(client, target);

  const findings = provenanceFindings(target, provenance);
  const finding = findings.find((entry) => entry.code === 'provenance.unpublished-commit');
  assert.equal(finding?.severity, 'critical');
});

test('accepts a commit reachable from the default branch even without a tag', async () => {
  const client = fakeClient({ ancestors: [PINNED] });
  const target = ref(`actions/checkout@${PINNED}`);
  const provenance = await verifyProvenance(client, target);

  assert.equal(provenance.onDefaultBranch, true);
  assert.deepEqual(codes(provenanceFindings(target, provenance)), []);
});

// The version comment is a checkable claim: run this commit, and this commit is
// that release. Only the first is enforced by GitHub.
test('flags a pin whose claimed version now points somewhere else', async () => {
  const client = fakeClient({
    refsContaining: { [PINNED]: ['tag:v4.2.2'] },
    tagTargets: { 'v4.2.2': OTHER },
  });
  const target = ref(`actions/checkout@${PINNED} # v4.2.2`);
  const provenance = await verifyProvenance(client, target);

  assert.equal(provenance.tagPointsElsewhere, OTHER);
  const finding = provenanceFindings(target, provenance)
    .find((entry) => entry.code === 'provenance.tag-mismatch');
  assert.equal(finding?.severity, 'critical');
});

test('stays quiet when the claimed version still points at the pin', async () => {
  const client = fakeClient({
    refsContaining: { [PINNED]: ['tag:v4.2.2'] },
    tagTargets: { 'v4.2.2': PINNED },
  });
  const target = ref(`actions/checkout@${PINNED} # v4.2.2`);
  const provenance = await verifyProvenance(client, target);

  assert.equal(provenance.tagPointsElsewhere, undefined);
  assert.deepEqual(codes(provenanceFindings(target, provenance)), []);
});

test('flags a mutable reference regardless of provenance', async () => {
  const client = fakeClient({
    tagTargets: { v5: PINNED },
    refsContaining: { [PINNED]: ['tag:v5'] },
  });
  const target = ref('actions/checkout@v5');
  const provenance = await verifyProvenance(client, target);

  const finding = provenanceFindings(target, provenance)
    .find((entry) => entry.code === 'pin.not-a-sha');
  assert.equal(finding?.severity, 'high');
});

// Not being able to look must never read as having looked and found nothing.
test('reports an unreachable upstream as unverified rather than as tampering', async () => {
  const client = fakeClient({ failResolve: true });
  const target = ref('actions/checkout@v5');
  const provenance = await verifyProvenance(client, target);

  assert.ok(provenance.unverified !== undefined);
  const findings = provenanceFindings(target, provenance);
  assert.deepEqual(codes(findings), ['provenance.unverified']);
  assert.equal(findings[0]?.severity, 'low');
});

test('a floating major tag that has moved past the pin is not a tag mismatch', () => {
  // `# v4` names a floating tag whose whole purpose is to advance. The pinned
  // commit carrying v4.1.0 is inside that line, so the tag pointing elsewhere is
  // ordinary staleness, not the retag shape that provenance.tag-mismatch means.
  const ref = parseActionRef(`owner/repo@${PINNED}`, '# v4') as ActionRef;
  const findings = provenanceFindings(ref, {
    sha: PINNED,
    reachableFrom: ['tag:v4.1.0'],
    onDefaultBranch: true,
    tagPointsElsewhere: OTHER,
  });
  const codes = findings.map((f: Finding) => f.code);
  assert.ok(!codes.includes('provenance.tag-mismatch'), `got ${codes.join(', ')}`);
});

test('a specific version claim that disagrees is still a tag mismatch', () => {
  // v2.4.0 is not a floating tag. A commit tagged v7.0.0 is not that release, so
  // this must keep reporting.
  const ref = parseActionRef(`owner/repo@${PINNED}`, '# v2.4.0') as ActionRef;
  const findings = provenanceFindings(ref, {
    sha: PINNED,
    reachableFrom: ['tag:v7.0.0'],
    onDefaultBranch: true,
    tagPointsElsewhere: OTHER,
  });
  assert.ok(findings.some((f: Finding) => f.code === 'provenance.tag-mismatch'));
});

test('a floating claim with no matching tag on the pin still reports', () => {
  // If the pinned commit carries nothing in the v4 line, `# v4` is not a
  // truthful description of it and the mismatch stands.
  const ref = parseActionRef(`owner/repo@${PINNED}`, '# v4') as ActionRef;
  const findings = provenanceFindings(ref, {
    sha: PINNED,
    reachableFrom: ['tag:v9.9.9'],
    onDefaultBranch: true,
    tagPointsElsewhere: OTHER,
  });
  assert.ok(findings.some((f: Finding) => f.code === 'provenance.tag-mismatch'));
});
