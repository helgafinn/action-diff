import { GitHubError } from './errors.js';

export interface TreeEntry {
  path: string;
  size?: number;
}

/**
 * The GitHub reads this tool needs, as an interface so review logic can be
 * tested without network access.
 */
export interface GitHubClient {
  /** Resolves a tag, branch, or SHA to a commit SHA. */
  resolveCommit(slug: string, ref: string): Promise<string>;
  /** Recursive file listing at a commit. */
  listTree(slug: string, sha: string): Promise<TreeEntry[]>;
  /** File contents at a commit, or undefined when absent. */
  readFile(slug: string, sha: string, path: string): Promise<string | undefined>;
  /** Tags and branches whose tip contains the commit. */
  refsContaining(slug: string, sha: string): Promise<string[]>;
  /** The repository's default branch name. */
  defaultBranch(slug: string): Promise<string>;
  /** Whether `ancestor` is reachable from `descendant`. */
  isAncestor(slug: string, ancestor: string, descendant: string): Promise<boolean>;
}

const API = 'https://api.github.com';

/** Files worth reading for review, in priority order. */
const MANIFEST_NAMES = ['action.yml', 'action.yaml'] as const;

/**
 * Caps on how much of an action repository is read.
 *
 * An action repository can carry a multi-megabyte bundled `dist/`, and reviewing
 * every byte of it would be slow without being informative — a bundle diff is
 * unreadable either way. The interesting signal lives in the manifest, the
 * declared entry points, and any shell or container definitions.
 */
const MAX_FILES = 40;
const MAX_FILE_BYTES = 512 * 1024;

export interface RestClientOptions {
  token?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
}

export class RestGitHubClient implements GitHubClient {
  readonly #token: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #userAgent: string;
  readonly #cache = new Map<string, unknown>();

  constructor(options: RestClientOptions = {}) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#userAgent = options.userAgent ?? 'action-diff';
  }

  async #json<T>(path: string): Promise<T> {
    const cached = this.#cache.get(path);
    if (cached !== undefined) return cached as T;

    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': this.#userAgent,
      'x-github-api-version': '2022-11-28',
    };
    if (this.#token !== undefined && this.#token !== '') {
      headers.authorization = `Bearer ${this.#token}`;
    }

    const response = await this.#fetch(`${API}${path}`, { headers });
    if (response.status === 404) {
      throw new GitHubError(`not found: ${path}`, 404);
    }
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      const hint = remaining === '0'
        ? ' Rate limit exhausted; supply a token via --token or GITHUB_TOKEN.'
        : '';
      throw new GitHubError(`GitHub refused the request for ${path}.${hint}`, response.status);
    }
    if (!response.ok) {
      throw new GitHubError(`GitHub returned ${response.status} for ${path}`, response.status);
    }

    const body = (await response.json()) as T;
    this.#cache.set(path, body);
    return body;
  }

  async resolveCommit(slug: string, ref: string): Promise<string> {
    const body = await this.#json<{ sha: string }>(
      `/repos/${slug}/commits/${encodeURIComponent(ref)}`,
    );
    return body.sha;
  }

  async listTree(slug: string, sha: string): Promise<TreeEntry[]> {
    const body = await this.#json<{
      tree?: { path?: string; type?: string; size?: number }[];
      truncated?: boolean;
    }>(`/repos/${slug}/git/trees/${sha}?recursive=1`);

    return (body.tree ?? [])
      .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
      .map((entry) => ({
        path: entry.path as string,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      }));
  }

  async readFile(slug: string, sha: string, path: string): Promise<string | undefined> {
    try {
      const body = await this.#json<{ content?: string; encoding?: string; size?: number }>(
        `/repos/${slug}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`,
      );
      if (body.encoding !== 'base64' || body.content === undefined) return undefined;
      if ((body.size ?? 0) > MAX_FILE_BYTES) return undefined;
      return Buffer.from(body.content, 'base64').toString('utf8');
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return undefined;
      throw error;
    }
  }

  async refsContaining(slug: string, sha: string): Promise<string[]> {
    // The REST API has no "refs containing commit" endpoint, so this compares
    // the commit against every tag and branch tip. Bounded by page size on
    // purpose: an action repository with hundreds of tags does not need an
    // exhaustive answer for a provenance signal.
    const [tags, branches] = await Promise.all([
      this.#json<{ name: string; commit: { sha: string } }[]>(
        `/repos/${slug}/tags?per_page=100`,
      ).catch(() => []),
      this.#json<{ name: string; commit: { sha: string } }[]>(
        `/repos/${slug}/branches?per_page=100`,
      ).catch(() => []),
    ]);

    const found: string[] = [];
    for (const tag of tags) if (tag.commit?.sha === sha) found.push(`tag:${tag.name}`);
    for (const branch of branches) {
      if (branch.commit?.sha === sha) found.push(`branch:${branch.name}`);
    }
    return found;
  }

  async defaultBranch(slug: string): Promise<string> {
    const body = await this.#json<{ default_branch: string }>(`/repos/${slug}`);
    return body.default_branch;
  }

  async isAncestor(slug: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      const body = await this.#json<{ status?: string }>(
        `/repos/${slug}/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(descendant)}`,
      );
      return body.status === 'behind' || body.status === 'identical';
    } catch {
      return false;
    }
  }
}

/**
 * Chooses which files inside an action are worth reviewing.
 *
 * Exported so the selection is testable and so callers can see that review
 * covers the manifest, declared entry points, shell scripts, container
 * definitions, and dependency manifests — not the whole repository.
 */
export function selectReviewableFiles(
  entries: TreeEntry[],
  subpath: string | undefined,
  entryPoints: string[],
): string[] {
  const prefix = subpath === undefined || subpath === '' ? '' : `${subpath.replace(/\/$/u, '')}/`;
  const within = entries.filter((entry) => entry.path.startsWith(prefix));
  const wanted = new Set<string>();

  for (const name of MANIFEST_NAMES) wanted.add(`${prefix}${name}`);
  for (const entry of entryPoints) {
    if (entry !== '') wanted.add(`${prefix}${entry.replace(/^\.\//u, '')}`);
  }

  for (const entry of within) {
    const relative = entry.path.slice(prefix.length);
    if (relative.includes('/node_modules/') || relative.startsWith('node_modules/')) continue;
    const isInteresting =
      relative.endsWith('.sh')
      || relative.endsWith('.bash')
      || relative === 'Dockerfile'
      || relative.endsWith('/Dockerfile')
      || relative === 'package.json'
      || relative === 'entrypoint.sh';
    if (isInteresting) wanted.add(entry.path);
  }

  const present = new Set(within.map((entry) => entry.path));
  const oversize = new Set(
    within.filter((entry) => (entry.size ?? 0) > MAX_FILE_BYTES).map((entry) => entry.path),
  );

  return [...wanted]
    .filter((path) => present.has(path) && !oversize.has(path))
    .sort()
    .slice(0, MAX_FILES);
}
