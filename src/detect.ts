import {
  listWorkflowFiles,
  readFileAtRevision,
  type GitContext,
} from './git.js';
import { actionIdentity, extractActionRefs } from './refs.js';
import type { ActionBump, ActionRef } from './types.js';

/** Every action reference at one revision, grouped by action identity. */
type RefsByAction = Map<string, { ref: ActionRef; workflows: Set<string> }>;

async function collectRefs(
  context: GitContext,
  revision: string,
  paths: string[],
): Promise<RefsByAction> {
  const collected: RefsByAction = new Map();

  for (const path of paths) {
    const source = await readFileAtRevision(context, revision, path);
    if (source === undefined) continue;

    for (const ref of extractActionRefs(source)) {
      const identity = actionIdentity(ref);
      const existing = collected.get(identity);
      if (existing === undefined) {
        collected.set(identity, { ref, workflows: new Set([path]) });
        continue;
      }
      existing.workflows.add(path);
      // One action pinned to two different revisions in the same tree is a
      // pre-existing inconsistency, not a bump. Keep the first seen so the
      // comparison stays deterministic.
    }
  }
  return collected;
}

/**
 * Finds actions whose pinned revision differs between two commits.
 *
 * Only changed references are returned. An action that appears in the head tree
 * at the same revision, or only in one tree, is not a bump: additions and
 * removals are visible in the pull request diff and carry no hidden change.
 */
export async function detectBumps(
  context: GitContext,
  base: string,
  head: string,
  restrictTo?: string[],
): Promise<ActionBump[]> {
  const [basePaths, headPaths] = await Promise.all([
    listWorkflowFiles(context, base),
    listWorkflowFiles(context, head),
  ]);

  const wanted = restrictTo === undefined || restrictTo.length === 0
    ? undefined
    : new Set(restrictTo);
  const paths = [...new Set([...basePaths, ...headPaths])]
    .filter((path) => wanted === undefined || wanted.has(path))
    .sort();

  const [before, after] = await Promise.all([
    collectRefs(context, base, paths),
    collectRefs(context, head, paths),
  ]);

  const bumps: ActionBump[] = [];
  for (const [identity, headEntry] of after) {
    const baseEntry = before.get(identity);
    if (baseEntry === undefined) continue;
    if (baseEntry.ref.ref === headEntry.ref.ref) continue;

    bumps.push({
      action: identity,
      before: baseEntry.ref,
      after: headEntry.ref,
      workflows: [...headEntry.workflows].sort(),
    });
  }
  return bumps.sort((a, b) => a.action.localeCompare(b.action));
}
