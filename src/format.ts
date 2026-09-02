import {
  SEVERITY_ORDER,
  meetsThreshold,
  type FailOn,
  type Finding,
  type ReviewReport,
  type Severity,
} from './types.js';

const LABEL: Record<Severity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  info: 'INFO',
};

function shortSha(sha: string): string {
  return /^[0-9a-f]{40}$/u.test(sha) ? sha.slice(0, 12) : sha;
}

function countsLine(report: ReviewReport): string {
  const { summary } = report;
  return (
    `${summary.bumps} bump${summary.bumps === 1 ? '' : 's'} reviewed, `
    + `${summary.critical} critical, ${summary.high} high, `
    + `${summary.medium} medium, ${summary.low} low, ${summary.info} informational.`
  );
}

export function formatPretty(report: ReviewReport): string {
  const lines = ['action-diff'];
  lines.push(`Base: ${shortSha(report.base)}  Head: ${shortSha(report.head)}`);

  if (report.reviews.length === 0 && report.skipped.length === 0) {
    lines.push('', 'No pinned action bumps between these revisions.');
    return `${lines.join('\n')}\n`;
  }

  for (const review of report.reviews) {
    lines.push('');
    lines.push(
      `${review.action}  ${shortSha(review.before.sha)} -> ${shortSha(review.after.sha)}`,
    );
    lines.push(`  used by: ${review.workflows.join(', ')}`);
    if (review.findings.length === 0) {
      lines.push('  no reviewable changes found');
      continue;
    }
    for (const finding of review.findings) {
      lines.push(`  ${LABEL[finding.severity]} [${finding.code}] ${finding.message}`);
    }
  }

  if (report.skipped.length > 0) {
    lines.push('', 'Not fully reviewed');
    for (const entry of report.skipped) {
      lines.push(`  ${entry.action}: ${entry.reason}`);
    }
  }

  lines.push('', countsLine(report));
  return `${lines.join('\n')}\n`;
}

export function formatJson(report: ReviewReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** GitHub workflow commands, so findings surface as annotations on the run. */
export function formatGithub(report: ReviewReport): string {
  const lines: string[] = [];
  for (const review of report.reviews) {
    for (const finding of review.findings) {
      const level = finding.severity === 'critical' || finding.severity === 'high'
        ? 'error'
        : finding.severity === 'medium' ? 'warning' : 'notice';
      const title = `${review.action} ${finding.code}`;
      lines.push(`::${level} title=${title}::${finding.message.replace(/\n/gu, ' ')}`);
    }
  }
  if (lines.length === 0) {
    lines.push('::notice title=action-diff::No reviewable changes in pinned action bumps.');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Markdown for a pull request comment or step summary.
 *
 * Ordered worst-first so the decision a reviewer has to make is the first thing
 * they read, rather than being buried under informational noise.
 */
export function formatMarkdown(report: ReviewReport): string {
  const lines = ['## Pinned action review', ''];

  if (report.reviews.length === 0 && report.skipped.length === 0) {
    lines.push('No pinned action bumps in this change.');
    return `${lines.join('\n')}\n`;
  }

  const worst = worstSeverity(report);
  if (worst === undefined) {
    lines.push('No reviewable changes found in the bumped actions.');
  } else if (worst === 'critical' || worst === 'high') {
    lines.push(`**Review needed.** Highest finding: ${LABEL[worst]}.`);
  } else {
    lines.push(`Highest finding: ${LABEL[worst]}.`);
  }
  lines.push('');

  for (const review of report.reviews) {
    lines.push(
      `### \`${review.action}\``,
      '',
      `\`${shortSha(review.before.sha)}\` → \`${shortSha(review.after.sha)}\``,
      '',
    );
    if (review.findings.length === 0) {
      lines.push('No reviewable changes found.', '');
      continue;
    }
    lines.push('| Severity | Finding |', '| --- | --- |');
    for (const finding of review.findings) {
      lines.push(`| ${LABEL[finding.severity]} | ${escapeCell(finding.message)} |`);
    }
    lines.push('');
  }

  if (report.skipped.length > 0) {
    lines.push('### Not fully reviewed', '');
    for (const entry of report.skipped) {
      lines.push(`- \`${entry.action}\`: ${entry.reason}`);
    }
    lines.push('');
  }

  lines.push(`<sub>${countsLine(report)}</sub>`);
  return `${lines.join('\n')}\n`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\n/gu, ' ');
}

/** The most severe finding anywhere in the report, or undefined when clean. */
export function worstSeverity(report: ReviewReport): Severity | undefined {
  for (const severity of [...SEVERITY_ORDER].reverse()) {
    for (const review of report.reviews) {
      if (review.findings.some((finding: Finding) => finding.severity === severity)) {
        return severity;
      }
    }
  }
  return undefined;
}

/** Whether the report should fail the run at the given threshold. */
export function shouldFail(report: ReviewReport, threshold: FailOn): boolean {
  const worst = worstSeverity(report);
  return worst !== undefined && meetsThreshold(worst, threshold);
}

export function formatReport(report: ReviewReport, format: string): string {
  switch (format) {
    case 'json':
      return formatJson(report);
    case 'github':
      return formatGithub(report);
    case 'markdown':
      return formatMarkdown(report);
    default:
      return formatPretty(report);
  }
}
