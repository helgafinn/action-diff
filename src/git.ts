import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { GitError } from './errors.js';

const run = promisify(execFile);

export interface GitContext {
  root: string;
}

async function git(context: GitContext, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd: context.root,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitError(`git ${args.join(' ')} failed: ${detail}`);
  }
}

export async function assertRepository(context: GitContext): Promise<void> {
  await git(context, ['rev-parse', '--git-dir']);
}

/**
 * Resolves a revision to a commit SHA, failing with a usable message when the
 * revision is missing. Shallow clones are the common cause in CI, where
 * `actions/checkout` fetches a single commit by default.
 */
export async function resolveCommit(context: GitContext, revision: string): Promise<string> {
  try {
    const stdout = await git(context, ['rev-parse', '--verify', `${revision}^{commit}`]);
    return stdout.trim();
  } catch {
    throw new GitError(
      `cannot resolve "${revision}". In CI this usually means a shallow clone; ` +
        'set fetch-depth: 0 on actions/checkout.',
    );
  }
}

/** Workflow files present at a revision, repository-relative. */
export async function listWorkflowFiles(
  context: GitContext,
  revision: string,
): Promise<string[]> {
  const stdout = await git(context, [
    'ls-tree',
    '-r',
    '--name-only',
    revision,
    '--',
    '.github/workflows',
  ]);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.yml') || line.endsWith('.yaml'));
}

/** File contents at a revision, or undefined when the path does not exist there. */
export async function readFileAtRevision(
  context: GitContext,
  revision: string,
  path: string,
): Promise<string | undefined> {
  try {
    return await git(context, ['show', `${revision}:${path}`]);
  } catch {
    return undefined;
  }
}
