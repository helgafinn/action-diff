/** A problem caused by how the tool was invoked or by malformed input. */
export class ActionDiffError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ActionDiffError';
    this.code = code;
  }
}

export class UsageError extends ActionDiffError {
  constructor(message: string) {
    super('usage', message);
    this.name = 'UsageError';
  }
}

export class GitError extends ActionDiffError {
  constructor(message: string) {
    super('git', message);
    this.name = 'GitError';
  }
}

export class GitHubError extends ActionDiffError {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super('github', message);
    this.name = 'GitHubError';
    if (status !== undefined) this.status = status;
  }
}
