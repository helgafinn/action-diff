import type { GitHubClient } from './github.js';
import { isFullSha, versionClaimSatisfiedBy } from './refs.js';
import type { ActionRef, Finding, Provenance } from './types.js';

/**
 * Establishes whether a revision is something upstream actually publishes.
 *
 * This exists because "the reference resolves" and "the reference was not
 * tampered with" are different claims. The tj-actions compromise moved release
 * tags onto malicious commits, so a workflow pinned by tag kept resolving while
 * the code underneath it changed. A commit that no tag or branch contains, and
 * that is not an ancestor of the default branch, is not part of any published
 * history — that is the shape a rewritten tag leaves behind.
 *
 * Failure to reach GitHub is reported as unverified rather than as a problem.
 * Treating a network error as evidence of tampering would train reviewers to
 * ignore the finding.
 */
export async function verifyProvenance(
  client: GitHubClient,
  ref: ActionRef,
): Promise<Provenance> {
  let sha: string;
  try {
    sha = isFullSha(ref.ref) ? ref.ref : await client.resolveCommit(ref.slug, ref.ref);
  } catch (error) {
    return {
      sha: ref.ref,
      reachableFrom: [],
      onDefaultBranch: false,
      unverified: error instanceof Error ? error.message : String(error),
    };
  }

  const [reachableFrom, onDefaultBranch, tagPointsElsewhere] = await Promise.all([
    client.refsContaining(ref.slug, sha).catch(() => []),
    defaultBranchContains(client, ref.slug, sha),
    tagMoved(client, ref, sha),
  ]);

  return {
    sha,
    reachableFrom,
    onDefaultBranch,
    ...(tagPointsElsewhere === undefined ? {} : { tagPointsElsewhere }),
  };
}

async function defaultBranchContains(
  client: GitHubClient,
  slug: string,
  sha: string,
): Promise<boolean> {
  try {
    const branch = await client.defaultBranch(slug);
    return await client.isAncestor(slug, sha, branch);
  } catch {
    return false;
  }
}

/**
 * Checks the claim a pinned SHA makes about itself.
 *
 * `uses: owner/repo@<sha> # v4.2.2` asserts two things: run this commit, and
 * this commit is v4.2.2. Only the first is enforced by GitHub. Resolving the
 * named tag and comparing it to the pinned commit tests the second, which is
 * precisely the assertion a retagged release breaks.
 *
 * Returns the tag's current target only when it genuinely disagrees. A tag that
 * cannot be resolved yields no finding, since a deleted or renamed tag is
 * ordinary repository maintenance.
 */
async function tagMoved(
  client: GitHubClient,
  ref: ActionRef,
  sha: string,
): Promise<string | undefined> {
  const claimed = ref.versionComment;
  if (claimed === undefined || !isFullSha(ref.ref)) return undefined;

  try {
    const tagSha = await client.resolveCommit(ref.slug, claimed);
    return tagSha === sha ? undefined : tagSha;
  } catch {
    return undefined;
  }
}

/** Turns provenance into reviewer-facing findings. */
export function provenanceFindings(ref: ActionRef, provenance: Provenance): Finding[] {
  const findings: Finding[] = [];

  if (provenance.unverified !== undefined) {
    findings.push({
      code: 'provenance.unverified',
      severity: 'low',
      message:
        `Could not confirm that ${ref.slug}@${ref.ref} is published upstream: `
        + provenance.unverified,
    });
    return findings;
  }

  if (!isFullSha(ref.ref)) {
    findings.push({
      code: 'pin.not-a-sha',
      severity: 'high',
      message:
        `${ref.raw} is pinned to a mutable reference. A tag or branch can be `
        + 'repointed at different code without the workflow changing.',
      after: ref.ref,
    });
  }

  if (provenance.reachableFrom.length === 0 && !provenance.onDefaultBranch) {
    findings.push({
      code: 'provenance.unpublished-commit',
      severity: 'critical',
      message:
        `${ref.slug}@${provenance.sha.slice(0, 12)} is not contained in any tag or `
        + 'branch and is not an ancestor of the default branch. A commit outside '
        + 'published history is what a rewritten tag leaves behind.',
      after: provenance.sha,
    });
  }

  if (
    provenance.tagPointsElsewhere !== undefined
    && versionClaimSatisfiedBy(ref.versionComment, provenance.reachableFrom)
  ) {
    // The comment names a floating tag and the pinned commit does sit in that
    // line, so the tag having advanced is how floating tags work. Saying "the tag
    // was moved" here would put normal staleness next to genuine retag evidence
    // and teach reviewers to skim past both.
    findings.push({
      code: 'pin.behind-floating-tag',
      severity: 'low',
      message:
        `${ref.slug} is pinned to ${provenance.sha.slice(0, 12)} and labelled `
        + `${ref.versionComment ?? 'a release'}, which is accurate, but that tag now `
        + `points at ${provenance.tagPointsElsewhere.slice(0, 12)}. The pin is behind `
        + 'the line it names.',
      before: provenance.sha,
      after: provenance.tagPointsElsewhere,
    });
  } else if (provenance.tagPointsElsewhere !== undefined) {
    findings.push({
      code: 'provenance.tag-mismatch',
      severity: 'critical',
      message:
        `${ref.slug} is pinned to ${provenance.sha.slice(0, 12)} and labelled `
        + `${ref.versionComment ?? 'a release'}, but that tag now points at `
        + `${provenance.tagPointsElsewhere.slice(0, 12)}. Either the pin is stale or `
        + 'the tag was moved.',
      before: provenance.sha,
      after: provenance.tagPointsElsewhere,
    });
  }

  return findings;
}
