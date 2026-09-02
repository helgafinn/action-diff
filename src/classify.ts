import type { ActionManifest, ActionRevision, Finding } from './types.js';

/**
 * Runtimes that execute code the action repository controls directly, versus a
 * container image it may pull from elsewhere. Moving between these categories
 * changes what the action is capable of, not just how it starts.
 */
function runtimeKind(using: string | undefined): 'node' | 'docker' | 'composite' | 'unknown' {
  if (using === undefined) return 'unknown';
  if (using.startsWith('node')) return 'node';
  if (using === 'docker') return 'docker';
  if (using === 'composite') return 'composite';
  return 'unknown';
}

/** Lines present in `after` that were not anywhere in `before`. */
function addedLines(before: string | undefined, after: string): string[] {
  const seen = new Set(
    (before ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );
  return after
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !seen.has(line));
}

const URL_PATTERN = /\bhttps?:\/\/([A-Za-z0-9.-]+)/gu;
const SHELL_FETCH = /\b(curl|wget|nc|ncat|Invoke-WebRequest|Invoke-RestMethod)\b/u;
const SECRET_REFERENCE = /\b(secrets\.[A-Za-z0-9_]+|GITHUB_TOKEN|ACTIONS_ID_TOKEN|NODE_AUTH_TOKEN)\b/u;
const EVAL_PATTERN = /\b(eval|Function\s*\(|child_process|execSync|spawnSync|vm\.runIn)\b/u;

/** Hostnames GitHub Actions inherently talks to, so their appearance is not news. */
const EXPECTED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'pipelines.actions.githubusercontent.com',
]);

function hostsIn(lines: string[]): Set<string> {
  const hosts = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(URL_PATTERN)) {
      const host = match[1];
      if (host !== undefined) hosts.add(host.toLowerCase());
    }
  }
  return hosts;
}

function manifestFindings(before: ActionManifest, after: ActionManifest): Finding[] {
  const findings: Finding[] = [];

  const beforeKind = runtimeKind(before.using);
  const afterKind = runtimeKind(after.using);
  if (before.using !== after.using) {
    const changedCategory = beforeKind !== afterKind;
    findings.push({
      code: changedCategory ? 'runtime.kind-changed' : 'runtime.version-changed',
      severity: changedCategory ? 'critical' : 'info',
      message: changedCategory
        ? `Execution model changed from ${before.using ?? 'unset'} to ${after.using ?? 'unset'}. `
          + 'A different runtime can reach different resources on the runner.'
        : `Runtime moved from ${before.using ?? 'unset'} to ${after.using ?? 'unset'}.`,
      path: 'runs.using',
      before: before.using,
      after: after.using,
    });
  }

  if (before.entry !== after.entry) {
    findings.push({
      code: 'runtime.entry-changed',
      severity: 'medium',
      message: `Entry point changed from ${before.entry ?? 'unset'} to ${after.entry ?? 'unset'}.`,
      path: 'runs',
      before: before.entry,
      after: after.entry,
    });
  }

  for (const [name, spec] of Object.entries(after.inputs)) {
    const previous = before.inputs[name];
    if (previous === undefined) {
      findings.push({
        code: spec.required ? 'inputs.required-added' : 'inputs.added',
        severity: spec.required ? 'high' : 'info',
        message: spec.required
          ? `New required input "${name}". Existing callers that omit it will fail.`
          : `New optional input "${name}".`,
        path: `inputs.${name}`,
      });
      continue;
    }
    if (!previous.required && spec.required) {
      findings.push({
        code: 'inputs.now-required',
        severity: 'high',
        message: `Input "${name}" is now required.`,
        path: `inputs.${name}`,
        before: previous.required,
        after: spec.required,
      });
    }
    if (previous.default !== spec.default) {
      findings.push({
        code: 'inputs.default-changed',
        severity: 'medium',
        message:
          `Default for "${name}" changed from ${previous.default ?? 'unset'} to `
          + `${spec.default ?? 'unset'}. Callers relying on the old default change behaviour `
          + 'without changing their workflow.',
        path: `inputs.${name}`,
        before: previous.default,
        after: spec.default,
      });
    }
  }

  for (const name of Object.keys(before.inputs)) {
    if (after.inputs[name] === undefined) {
      findings.push({
        code: 'inputs.removed',
        severity: 'medium',
        message: `Input "${name}" was removed and is now ignored if still passed.`,
        path: `inputs.${name}`,
      });
    }
  }

  for (const name of Object.keys(before.outputs)) {
    if (after.outputs[name] === undefined) {
      findings.push({
        code: 'outputs.removed',
        severity: 'high',
        message: `Output "${name}" was removed. Steps reading it receive an empty value.`,
        path: `outputs.${name}`,
      });
    }
  }

  return findings;
}

/**
 * Compares the reviewed source of two revisions of one action.
 *
 * Source comparison is line-set based rather than a positional diff: the
 * question is whether a capability appeared, not where it moved to. A `curl`
 * that shifts between lines is not news; a `curl` that did not exist before is.
 */
export function classifyRevisions(before: ActionRevision, after: ActionRevision): Finding[] {
  const findings: Finding[] = [];

  if (before.manifest !== undefined && after.manifest !== undefined) {
    findings.push(...manifestFindings(before.manifest, after.manifest));
  } else if (before.manifest !== undefined && after.manifest === undefined) {
    findings.push({
      code: 'manifest.unreadable',
      severity: 'high',
      message: 'The new revision has no readable action manifest.',
      path: 'action.yml',
    });
  }

  const allAdded: string[] = [];
  for (const [path, content] of Object.entries(after.files)) {
    const previous = before.files[path];
    const added = addedLines(previous, content);
    if (added.length === 0) continue;
    allAdded.push(...added);

    const introduced = added.join('\n');
    const isNewFile = previous === undefined;

    if (SHELL_FETCH.test(introduced)) {
      findings.push({
        code: 'source.network-command-added',
        severity: 'high',
        message: `${path} gained a command that fetches over the network.`,
        path,
      });
    }
    if (SECRET_REFERENCE.test(introduced)) {
      findings.push({
        code: 'source.secret-reference-added',
        severity: 'high',
        message: `${path} gained a reference to a token or secret.`,
        path,
      });
    }
    if (EVAL_PATTERN.test(introduced)) {
      findings.push({
        code: 'source.dynamic-execution-added',
        severity: 'high',
        message: `${path} gained dynamic code execution or process spawning.`,
        path,
      });
    }
    if (isNewFile && (path.endsWith('.sh') || path.endsWith('Dockerfile'))) {
      findings.push({
        code: 'source.script-added',
        severity: 'medium',
        message: `New executable file ${path}.`,
        path,
      });
    }
  }

  const beforeHosts = hostsIn(
    Object.values(before.files).flatMap((content) => content.split('\n')),
  );
  const newHosts = [...hostsIn(allAdded)]
    .filter((host) => !beforeHosts.has(host) && !EXPECTED_HOSTS.has(host))
    .sort();

  if (newHosts.length > 0) {
    findings.push({
      code: 'source.new-egress-host',
      severity: 'high',
      message:
        `New outbound host${newHosts.length > 1 ? 's' : ''}: ${newHosts.join(', ')}. `
        + 'This revision can reach somewhere the previous one did not.',
      after: newHosts,
    });
  }

  findings.push(...dependencyFindings(before, after));
  return findings;
}

function readDependencies(content: string | undefined): Record<string, string> {
  if (content === undefined) return {};
  try {
    const parsed = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return { ...parsed.dependencies, ...parsed.optionalDependencies };
  } catch {
    return {};
  }
}

/**
 * Runtime dependency changes only.
 *
 * devDependencies are excluded because they do not ship in a bundled action and
 * therefore cannot execute on the runner.
 */
function dependencyFindings(before: ActionRevision, after: ActionRevision): Finding[] {
  const manifestPath = Object.keys(after.files).find((path) => path.endsWith('package.json'));
  if (manifestPath === undefined) return [];

  const previous = readDependencies(before.files[manifestPath]);
  const current = readDependencies(after.files[manifestPath]);
  const added = Object.keys(current).filter((name) => previous[name] === undefined).sort();
  if (added.length === 0) return [];

  return [{
    code: 'dependencies.added',
    severity: 'medium',
    message: `New runtime ${added.length === 1 ? 'dependency' : 'dependencies'}: ${added.join(', ')}.`,
    path: manifestPath,
    after: added,
  }];
}
