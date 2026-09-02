import { parse } from 'yaml';

import type { ActionManifest } from './types.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * An input is required only when the manifest says so explicitly. GitHub treats
 * a missing `required` as false, and it does not enforce the flag at runtime —
 * it is a declaration, which is exactly why a change to it is worth reporting.
 */
function isRequired(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Reads the declared interface of an action.
 *
 * Returns undefined unless the document is a mapping carrying a `runs` block.
 * That is the one section GitHub requires of every action, so its absence means
 * the file is not an action manifest rather than an action that happens to
 * declare nothing. The distinction matters: treating an unparseable manifest as
 * an empty interface would report every input and output as removed.
 *
 * YAML parsing is lenient and recovers from many malformed documents, so an
 * explicit structural check is needed and a thrown error is not enough.
 */
export function parseActionManifest(source: string): ActionManifest | undefined {
  let document: unknown;
  try {
    document = parse(source, { logLevel: 'silent' });
  } catch {
    return undefined;
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return undefined;
  }

  const root = asRecord(document);
  if (root.runs === null || typeof root.runs !== 'object' || Array.isArray(root.runs)) {
    return undefined;
  }

  const runs = asRecord(root.runs);
  const using = asString(runs.using);

  // Javascript actions declare `main`; docker actions declare `image` and may
  // override `entrypoint`. Both answer "what executes", so they share a field.
  const entry = asString(runs.main) ?? asString(runs.entrypoint) ?? asString(runs.image);

  const inputs: ActionManifest['inputs'] = {};
  for (const [name, raw] of Object.entries(asRecord(root.inputs))) {
    const spec = asRecord(raw);
    const description = asString(spec.description);
    const fallback = asString(spec.default);
    inputs[name] = {
      required: isRequired(spec.required),
      ...(fallback === undefined ? {} : { default: fallback }),
      ...(description === undefined ? {} : { description }),
    };
  }

  const outputs: ActionManifest['outputs'] = {};
  for (const [name, raw] of Object.entries(asRecord(root.outputs))) {
    const description = asString(asRecord(raw).description);
    outputs[name] = description === undefined ? {} : { description };
  }

  const name = asString(root.name);
  const description = asString(root.description);
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(using === undefined ? {} : { using }),
    ...(entry === undefined ? {} : { entry }),
    inputs,
    outputs,
  };
}

/** Entry points declared by a manifest, used to decide which files to read. */
export function manifestEntryPoints(source: string): string[] {
  let document: unknown;
  try {
    document = parse(source, { logLevel: 'silent' });
  } catch {
    return [];
  }
  const runs = asRecord(asRecord(document).runs);
  const candidates = [runs.main, runs.pre, runs.post, runs.entrypoint, runs.image];
  return candidates
    .map((value) => asString(value))
    .filter((value): value is string => value !== undefined && !value.startsWith('docker://'));
}
