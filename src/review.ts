import { classifyRevisions } from './classify.js';
import { detectBumps } from './detect.js';
import { resolveCommit, assertRepository, type GitContext } from './git.js';
import { selectReviewableFiles, type GitHubClient } from './github.js';
import { manifestEntryPoints, parseActionManifest } from './manifest.js';
import { provenanceFindings, verifyProvenance } from './provenance.js';
import { isFullSha } from './refs.js';
import {
  REPORT_SCHEMA_VERSION,
  compareSeverity,
  type ActionRef,
  type ActionRevision,
  type BumpReview,
  type Finding,
  type ReviewOptions,
  type ReviewReport,
  type ReviewSummary,
} from './types.js';

/**
 * Reads the reviewable surface of one action revision.
 *
 * The manifest is fetched first because it names the entry points, which decides
 * which of the remaining files are worth reading at all.
 */
async function loadRevision(
  client: GitHubClient,
  ref: ActionRef,
): Promise<ActionRevision | undefined> {
  let sha: string;
  try {
    sha = isFullSha(ref.ref) ? ref.ref : await client.resolveCommit(ref.slug, ref.ref);
  } catch {
    return undefined;
  }

  const prefix = ref.subpath === undefined ? '' : `${ref.subpath.replace(/\/$/u, '')}/`;
  const manifestSource =
    (await client.readFile(ref.slug, sha, `${prefix}action.yml`))
    ?? (await client.readFile(ref.slug, sha, `${prefix}action.yaml`));

  const entryPoints = manifestSource === undefined ? [] : manifestEntryPoints(manifestSource);

  let files: Record<string, string> = {};
  try {
    const tree = await client.listTree(ref.slug, sha);
    const wanted = selectReviewableFiles(tree, ref.subpath, entryPoints);
    const contents = await Promise.all(
      wanted.map(async (path) => [path, await client.readFile(ref.slug, sha, path)] as const),
    );
    files = Object.fromEntries(
      contents.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
    );
  } catch {
    // A listable tree is a convenience, not a requirement. Manifest-only review
    // still reports interface changes, which is better than reporting nothing.
    files = {};
  }

  const manifest = manifestSource === undefined ? undefined : parseActionManifest(manifestSource);
  return {
    ref,
    sha,
    ...(manifest === undefined ? {} : { manifest }),
    files,
  };
}

function summarize(reviews: BumpReview[]): ReviewSummary {
  const summary: ReviewSummary = {
    bumps: reviews.length,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const review of reviews) {
    for (const finding of review.findings) summary[finding.severity] += 1;
  }
  return summary;
}

function orderFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = compareSeverity(b.severity, a.severity);
    return bySeverity !== 0 ? bySeverity : a.code.localeCompare(b.code);
  });
}

/**
 * Reviews every action bump between two revisions of the repository.
 *
 * The report distinguishes reviewed bumps from skipped ones. A bump that could
 * not be fetched is surfaced explicitly rather than being reported as clean,
 * because "we could not look" and "we looked and it is fine" must not read the
 * same to a reviewer deciding whether to merge.
 */
export async function reviewBumps(
  client: GitHubClient,
  options: ReviewOptions,
): Promise<ReviewReport> {
  const context: GitContext = { root: options.root ?? process.cwd() };
  await assertRepository(context);

  const head = options.head ?? 'HEAD';
  const [baseSha, headSha] = await Promise.all([
    resolveCommit(context, options.base),
    resolveCommit(context, head),
  ]);

  const bumps = await detectBumps(context, baseSha, headSha, options.paths);
  const reviews: BumpReview[] = [];
  const skipped: { action: string; reason: string }[] = [];

  for (const bump of bumps) {
    const [before, after] = await Promise.all([
      loadRevision(client, bump.before),
      loadRevision(client, bump.after),
    ]);

    // Without the new revision there is nothing to review at all.
    if (after === undefined) {
      skipped.push({
        action: bump.action,
        reason: `could not resolve ${bump.after.raw} on GitHub`,
      });
      continue;
    }

    const findings: Finding[] = [];
    const provenance = (options.skipProvenance ?? false)
      ? undefined
      : await verifyProvenance(client, bump.after);
    if (provenance !== undefined) {
      findings.push(...provenanceFindings(bump.after, provenance));
    }

    // Provenance stands on the new revision alone, so a missing previous
    // revision still produces a partial review rather than silence.
    if (before === undefined) {
      skipped.push({
        action: bump.action,
        reason: `compared provenance only; could not resolve previous revision ${bump.before.raw}`,
      });
    } else {
      findings.push(...classifyRevisions(before, after));
    }

    reviews.push({
      action: bump.action,
      workflows: bump.workflows,
      before: { ref: bump.before.ref, sha: before?.sha ?? bump.before.ref },
      after: { ref: bump.after.ref, sha: after.sha },
      ...(provenance === undefined ? {} : { provenance }),
      findings: orderFindings(findings),
    });
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    base: baseSha,
    head: headSha,
    reviews,
    skipped,
    summary: summarize(reviews),
  };
}
