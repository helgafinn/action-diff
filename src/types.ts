export const REPORT_SCHEMA_VERSION = 1 as const;

/** A parsed `uses:` reference to a published action. */
export interface ActionRef {
  /** `owner/repo`, without any subdirectory or ref. */
  slug: string;
  owner: string;
  repo: string;
  /** Subdirectory for actions that do not live at the repository root. */
  subpath?: string;
  /** Whatever followed `@`: a commit SHA, tag, or branch. */
  ref: string;
  /** The verbatim `uses:` value, for reporting. */
  raw: string;
  /**
   * Version named in a trailing comment, as Dependabot writes it:
   * `uses: owner/repo@<sha> # v4.2.2`. This is the claim the pinned SHA makes
   * about which release it is, and it is independently checkable.
   */
  versionComment?: string;
}

/** The same action referenced at two different revisions. */
export interface ActionBump {
  /** `owner/repo[/subpath]` — the identity that stayed the same. */
  action: string;
  before: ActionRef;
  after: ActionRef;
  /** Workflow files where this bump appears, repository-relative. */
  workflows: string[];
}

/**
 * Severity ordering is meaningful: `compareSeverity` and every `--fail-on`
 * threshold rely on it.
 */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_ORDER: readonly Severity[] = [
  'info',
  'low',
  'medium',
  'high',
  'critical',
] as const;

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  /** Where inside the action the change was seen, when applicable. */
  path?: string;
  before?: unknown;
  after?: unknown;
}

/** How an action's declared interface changed between two revisions. */
export interface ActionManifest {
  name?: string;
  description?: string;
  /** `node24`, `docker`, `composite`, and so on. */
  using?: string;
  /** Entry point for javascript actions, image for docker actions. */
  entry?: string;
  inputs: Record<string, { required: boolean; default?: string; description?: string }>;
  outputs: Record<string, { description?: string }>;
}

/**
 * Whether a revision is something the upstream repository actually publishes.
 *
 * The tj-actions compromise rewrote release tags to point at malicious commits,
 * so "the tag resolves" is not the same as "the tag was not moved".
 */
export interface Provenance {
  /** The commit the reference resolved to. */
  sha: string;
  /** Tags and branches that contain this commit, when discoverable. */
  reachableFrom: string[];
  /** Whether the commit is an ancestor of the repository's default branch. */
  onDefaultBranch: boolean;
  /** Set when a tag exists but no longer points at the reviewed commit. */
  tagPointsElsewhere?: string;
  /** Set when provenance could not be established rather than being disproven. */
  unverified?: string;
}

/** The reviewed source of one action revision. */
export interface ActionRevision {
  ref: ActionRef;
  sha: string;
  manifest?: ActionManifest;
  /** Files considered during review, keyed by path within the action. */
  files: Record<string, string>;
}

export interface BumpReview {
  action: string;
  workflows: string[];
  before: { ref: string; sha: string };
  after: { ref: string; sha: string };
  provenance?: Provenance;
  findings: Finding[];
}

export interface ReviewSummary {
  bumps: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface ReviewReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  base: string;
  head: string;
  reviews: BumpReview[];
  /** Bumps that could not be reviewed, with the reason. */
  skipped: { action: string; reason: string }[];
  summary: ReviewSummary;
}

export type OutputFormat = 'pretty' | 'json' | 'github' | 'markdown';

/** Lowest severity that should fail the run. `never` always exits zero. */
export type FailOn = Severity | 'never';

export interface ReviewOptions {
  base: string;
  head?: string;
  root?: string;
  /** Restrict review to these workflow paths, repository-relative. */
  paths?: string[];
  /** Skip network provenance checks; contract and source diffing still run. */
  skipProvenance?: boolean;
}

/** Ranks two severities using SEVERITY_ORDER. Positive means `a` is worse. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_ORDER.indexOf(a) - SEVERITY_ORDER.indexOf(b);
}

/** Whether `severity` meets or exceeds the `--fail-on` threshold. */
export function meetsThreshold(severity: Severity, threshold: FailOn): boolean {
  if (threshold === 'never') return false;
  return compareSeverity(severity, threshold) >= 0;
}
