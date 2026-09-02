import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { formatGithub, formatMarkdown, formatPretty, shouldFail, worstSeverity } from '../src/format.js';
import { REPORT_SCHEMA_VERSION, meetsThreshold, type ReviewReport, type Severity } from '../src/types.js';

function report(severities: Severity[]): ReviewReport {
  const summary = { bumps: 1, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const severity of severities) summary[severity] += 1;

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    reviews: [{
      action: 'actions/checkout',
      workflows: ['.github/workflows/ci.yml'],
      before: { ref: 'v4', sha: 'c'.repeat(40) },
      after: { ref: 'v5', sha: 'd'.repeat(40) },
      findings: severities.map((severity, index) => ({
        code: `test.${index}`,
        severity,
        message: `finding ${index}`,
      })),
    }],
    skipped: [],
    summary,
  };
}

const EMPTY: ReviewReport = {
  schemaVersion: REPORT_SCHEMA_VERSION,
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  reviews: [],
  skipped: [],
  summary: { bumps: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
};

test('reports the worst severity present', () => {
  assert.equal(worstSeverity(report(['low', 'critical', 'medium'])), 'critical');
  assert.equal(worstSeverity(report(['info', 'low'])), 'low');
  assert.equal(worstSeverity(EMPTY), undefined);
});

test('ranks severities so thresholds are ordered', () => {
  assert.equal(meetsThreshold('critical', 'high'), true);
  assert.equal(meetsThreshold('high', 'high'), true);
  assert.equal(meetsThreshold('medium', 'high'), false);
  assert.equal(meetsThreshold('info', 'info'), true);
});

// `never` is the escape hatch for adopting the tool in report-only mode, so it
// must hold even against a critical finding.
test('never fails when the threshold is never', () => {
  assert.equal(shouldFail(report(['critical']), 'never'), false);
  assert.equal(meetsThreshold('critical', 'never'), false);
});

test('fails only at or above the chosen threshold', () => {
  assert.equal(shouldFail(report(['medium']), 'high'), false);
  assert.equal(shouldFail(report(['high']), 'high'), true);
  assert.equal(shouldFail(report(['medium']), 'medium'), true);
  assert.equal(shouldFail(EMPTY, 'info'), false);
});

test('pretty output states when there is nothing to review', () => {
  assert.match(formatPretty(EMPTY), /No pinned action bumps/u);
});

// A reviewer scanning a comment should meet the decision before the detail.
test('markdown leads with a call to action for severe findings', () => {
  const markdown = formatMarkdown(report(['info', 'critical']));
  const needsReview = markdown.indexOf('Review needed');
  const table = markdown.indexOf('| Severity |');
  assert.ok(needsReview >= 0, 'expected a call to action');
  assert.ok(needsReview < table, 'call to action should precede the detail table');
});

test('markdown escapes pipes so a message cannot break the table', () => {
  const base = report(['high']);
  base.reviews[0]!.findings[0]!.message = 'contains | a pipe';
  assert.match(formatMarkdown(base), /contains \\\| a pipe/u);
});

test('github annotations map severity to annotation level', () => {
  const output = formatGithub(report(['critical', 'medium', 'info']));
  assert.match(output, /^::error title=actions\/checkout test\.0::/mu);
  assert.match(output, /^::warning title=actions\/checkout test\.1::/mu);
  assert.match(output, /^::notice title=actions\/checkout test\.2::/mu);
});

test('github output still says something when there are no findings', () => {
  assert.match(formatGithub(EMPTY), /::notice title=action-diff::/u);
});
