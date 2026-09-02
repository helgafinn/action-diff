export { classifyRevisions } from './classify.js';
export { detectBumps } from './detect.js';
export {
  formatGithub,
  formatJson,
  formatMarkdown,
  formatPretty,
  formatReport,
  shouldFail,
  worstSeverity,
} from './format.js';
export { RestGitHubClient, selectReviewableFiles } from './github.js';
export type { GitHubClient, RestClientOptions, TreeEntry } from './github.js';
export { manifestEntryPoints, parseActionManifest } from './manifest.js';
export { provenanceFindings, verifyProvenance } from './provenance.js';
export {
  actionIdentity,
  extractActionRefs,
  isAbbreviatedSha,
  isFullSha,
  normalizeVersionComment,
  parseActionRef,
} from './refs.js';
export { reviewBumps } from './review.js';
export { ActionDiffError, GitError, GitHubError, UsageError } from './errors.js';
export {
  REPORT_SCHEMA_VERSION,
  SEVERITY_ORDER,
  compareSeverity,
  meetsThreshold,
} from './types.js';
export type {
  ActionBump,
  ActionManifest,
  ActionRef,
  ActionRevision,
  BumpReview,
  FailOn,
  Finding,
  OutputFormat,
  Provenance,
  ReviewOptions,
  ReviewReport,
  ReviewSummary,
  Severity,
} from './types.js';
export { VERSION } from './version.js';
