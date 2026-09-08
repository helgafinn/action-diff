import type { ActionRef } from './types.js';

/** A 40-character hex commit SHA, the form pinning is supposed to produce. */
const FULL_SHA = /^[0-9a-f]{40}$/u;
/** Abbreviated SHAs are accepted by GitHub but defeat the point of pinning. */
const ABBREVIATED_SHA = /^[0-9a-f]{7,39}$/u;

export function isFullSha(ref: string): boolean {
  return FULL_SHA.test(ref);
}

export function isAbbreviatedSha(ref: string): boolean {
  return !FULL_SHA.test(ref) && ABBREVIATED_SHA.test(ref);
}

/**
 * Parses a `uses:` value that points at a published action.
 *
 * Returns undefined for the forms this tool has nothing to review: local
 * actions (`./path`), container images (`docker://…`), and anything without an
 * explicit `@ref`. A local action's code already appears in the pull request
 * diff, so re-reviewing it here would duplicate what the reviewer can see.
 */
export function parseActionRef(uses: string, versionComment?: string): ActionRef | undefined {
  const value = uses.trim();
  if (value === '' || value.startsWith('./') || value.startsWith('../')) return undefined;
  if (value.startsWith('docker://')) return undefined;

  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return undefined;

  const target = value.slice(0, at);
  const ref = value.slice(at + 1);
  const segments = target.split('/');
  const owner = segments[0];
  const repo = segments[1];
  if (segments.length < 2 || owner === undefined || repo === undefined) return undefined;
  if (owner === '' || repo === '') return undefined;

  const subpath = segments.slice(2).join('/');
  const claimed = normalizeVersionComment(versionComment);
  return {
    slug: `${owner}/${repo}`,
    owner,
    repo,
    ...(subpath === '' ? {} : { subpath }),
    ref,
    raw: value,
    ...(claimed === undefined ? {} : { versionComment: claimed }),
  };
}

/**
 * Extracts a version from a trailing comment.
 *
 * Accepts the shapes tooling actually produces — `# v4.2.2`,
 * `# pin @v4.2.2`, `# v4.2.2 (immutable)` — and ignores prose comments that
 * name no version, so a stray note is never mistaken for a release claim.
 */
export function normalizeVersionComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined;
  const match = /(?:^|[\s@])(v?\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?)/u.exec(comment.trim());
  return match?.[1];
}

/**
 * Whether a version comment truthfully describes a commit carrying these refs.
 *
 * A floating tag exists to advance. `# v4` on a commit tagged v4.1.0 is an
 * accurate description of the v4 line, so the fact that `v4` now points at a
 * newer commit is ordinary staleness rather than the retag shape that matters.
 * A more specific claim is held to the letter: `# v2.4.0` on a commit tagged
 * v7.0.0 names a release the commit is not.
 *
 * `refs` are the `tag:`/`branch:` entries observed on the pinned commit.
 */
export function versionClaimSatisfiedBy(
  claim: string | undefined,
  refs: readonly string[],
): boolean {
  if (claim === undefined) return false;
  const wanted = bareVersion(claim);
  if (wanted === '') return false;
  for (const entry of refs) {
    if (!entry.startsWith('tag:')) continue;
    const actual = bareVersion(entry.slice('tag:'.length));
    // Strict prefix only. `# v4` against a v4.1.0 pin is a floating claim and the
    // tag advancing is expected. An exact match is different: if the comment says
    // v4.2.2, the pin carries v4.2.2, and that tag now resolves to another commit,
    // the tag was moved off this commit — which is the retag this tool exists to
    // catch, and must not be softened.
    if (actual.startsWith(`${wanted}.`)) return true;
  }
  return false;
}

/**
 * Strips a tag down to a comparable version.
 *
 * Monorepo action collections namespace tags by sub-action, as in
 * `get-vault-secrets/v1.3.1`, and codeql-action publishes `codeql-bundle-vX.Y.Z`.
 * In both cases the sub-action is already identified by the `uses:` path, so the
 * prefix carries no information for this comparison.
 */
function bareVersion(value: string): string {
  const tail = value.slice(value.lastIndexOf('/') + 1);
  return tail.replace(/^codeql-bundle-/u, '').replace(/^v/u, '');
}

/** The identity that must match for two references to be the same action. */
export function actionIdentity(ref: ActionRef): string {
  return ref.subpath === undefined ? ref.slug : `${ref.slug}/${ref.subpath}`;
}

/**
 * Extracts every published-action reference from one workflow document.
 *
 * Deliberately a text scan rather than a YAML walk. A `uses:` value is a plain
 * scalar wherever it appears — job steps, composite action steps, and
 * `jobs.<id>.uses` for reusable workflows — and scanning avoids depending on
 * the surrounding structure being valid. A workflow mid-edit still yields its
 * action references.
 */
export function extractActionRefs(source: string): ActionRef[] {
  const found: ActionRef[] = [];
  const pattern = /(?:^|\s)uses\s*:\s*(?:'([^']*)'|"([^"]*)"|([^\s#]+))[^\S\n]*(?:#[^\S\n]*([^\n]*))?/gmu;

  for (const line of source.split('\n')) {
    // A commented-out step is not a live pin. Reviewing one produces findings
    // about code that never runs. Only a leading `#` disables a line; the
    // trailing inline comment is where the version claim lives and is still read.
    if (line.trimStart().startsWith('#')) continue;
    for (const match of line.matchAll(pattern)) {
      const raw = match[1] ?? match[2] ?? match[3];
      if (raw === undefined) continue;
      const ref = parseActionRef(raw, match[4]);
      if (ref !== undefined) found.push(ref);
    }
  }
  return found;
}
