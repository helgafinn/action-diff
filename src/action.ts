import { appendFileSync } from 'node:fs';
import { env } from 'node:process';

import { formatMarkdown, formatPretty, shouldFail, worstSeverity } from './format.js';
import { RestGitHubClient } from './github.js';
import { reviewBumps } from './review.js';
import { SEVERITY_ORDER, type FailOn } from './types.js';

function input(name: string): string {
  return (env[`INPUT_${name.replace(/ /gu, '_').toUpperCase()}`] ?? '').trim();
}

function setOutput(name: string, value: string): void {
  const file = env.GITHUB_OUTPUT;
  if (file === undefined || file === '') return;
  const delimiter = `ghadelimiter_${Math.random().toString(36).slice(2)}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, 'utf8');
}

function appendSummary(markdown: string): void {
  const file = env.GITHUB_STEP_SUMMARY;
  if (file === undefined || file === '') return;
  appendFileSync(file, markdown, 'utf8');
}

/**
 * Resolves the base revision.
 *
 * `GITHUB_BASE_REF` is only set for pull request events, and it names a branch
 * rather than a commit, so it is qualified with `origin/` to reference the
 * fetched remote-tracking ref. Outside a pull request the caller must say what
 * to compare against; guessing would silently review the wrong range.
 */
function resolveBase(explicit: string): string | undefined {
  if (explicit !== '') return explicit;
  const baseRef = env.GITHUB_BASE_REF;
  if (baseRef !== undefined && baseRef !== '') return `origin/${baseRef}`;
  return undefined;
}

function parseFailOn(raw: string): FailOn {
  if (raw === '') return 'high';
  const allowed: string[] = [...SEVERITY_ORDER, 'never'];
  if (!allowed.includes(raw)) {
    throw new Error(`invalid fail-on value "${raw}"`);
  }
  return raw as FailOn;
}

async function main(): Promise<void> {
  const base = resolveBase(input('base'));
  if (base === undefined) {
    throw new Error(
      'No base revision. This action derives one from GITHUB_BASE_REF on pull '
      + 'requests; for other events set the "base" input explicitly.',
    );
  }

  const token = input('token') !== '' ? input('token') : env.GITHUB_TOKEN;
  const root = input('root') !== '' ? input('root') : undefined;
  const paths = input('paths').split('\n').map((line) => line.trim()).filter((line) => line !== '');

  const client = new RestGitHubClient(token === undefined ? {} : { token });
  const report = await reviewBumps(client, {
    base,
    ...(root === undefined ? {} : { root }),
    ...(paths.length === 0 ? {} : { paths }),
    skipProvenance: input('skip-provenance') === 'true',
  });

  const failOn = parseFailOn(input('fail-on'));
  const failed = shouldFail(report, failOn);
  const worst = worstSeverity(report);

  process.stdout.write(formatPretty(report));
  appendSummary(formatMarkdown(report));

  setOutput('bumps', String(report.summary.bumps));
  setOutput('critical', String(report.summary.critical));
  setOutput('high', String(report.summary.high));
  setOutput('highest-severity', worst ?? 'none');
  setOutput('markdown', formatMarkdown(report));
  setOutput('passed', failed ? 'false' : 'true');

  if (failed) {
    process.exitCode = 1;
  }
}

// Not top-level await: the Action is bundled to CommonJS, which does not
// support it. A rejected promise handler keeps the same failure behaviour.
void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`::error title=action-diff::${message}\n`);
  process.exitCode = 1;
});
