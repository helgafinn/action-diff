#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { argv, env, exit, stderr, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ActionDiffError, UsageError } from './errors.js';
import { formatReport, shouldFail } from './format.js';
import { RestGitHubClient } from './github.js';
import { reviewBumps } from './review.js';
import { SEVERITY_ORDER, type FailOn, type OutputFormat } from './types.js';
import { VERSION } from './version.js';

const HELP = `action-diff ${VERSION}

Review what a pinned GitHub Action SHA bump actually changes.

Usage:
  action-diff review --base <git-ref> [options]

Options:
  --base <git-ref>               Revision to compare against. Required.
  --head <git-ref>               Revision to review (default: HEAD).
  --root <path>                  Repository root (default: current directory).
  --path <workflow>              Limit review to a repository-relative workflow; repeatable.
  --format <pretty|json|github|markdown>
                                 Output format (default: pretty).
  --fail-on <critical|high|medium|low|info|never>
                                 Exit 1 at this severity or worse (default: high).
  --token <value>                GitHub token. Falls back to GITHUB_TOKEN or GH_TOKEN.
  --skip-provenance              Skip upstream provenance checks; diff only.
  -h, --help                     Show help.
  -v, --version                  Show version.

Exit codes:
  0  No findings at or above the failure threshold.
  1  Findings met the threshold.
  2  Invalid invocation, Git failure, or unexpected error.

A token is strongly recommended: unauthenticated GitHub requests are limited to
60 per hour, which one review can exhaust. Inside a workflow, pass
\${{ secrets.GITHUB_TOKEN }}.`;

interface ParsedArgs {
  command: string;
  base?: string;
  head?: string;
  root?: string;
  paths: string[];
  format: OutputFormat;
  failOn: FailOn;
  token?: string;
  skipProvenance: boolean;
  help: boolean;
  version: boolean;
}

const FORMATS = new Set<OutputFormat>(['pretty', 'json', 'github', 'markdown']);

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('-')) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: '',
    paths: [],
    format: 'pretty',
    failOn: 'high',
    skipProvenance: false,
    help: false,
    version: false,
  };

  let index = 0;
  if (args[index] !== undefined && !args[index]!.startsWith('-')) {
    parsed.command = args[index]!;
    index += 1;
  }

  for (; index < args.length; index += 1) {
    const arg = args[index]!;
    switch (arg) {
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      case '-v':
      case '--version':
        parsed.version = true;
        break;
      case '--skip-provenance':
        parsed.skipProvenance = true;
        break;
      case '--base':
        parsed.base = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--head':
        parsed.head = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--root':
        parsed.root = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--token':
        parsed.token = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--path':
        parsed.paths.push(requireValue(arg, args[index + 1]));
        index += 1;
        break;
      case '--format': {
        const value = requireValue(arg, args[index + 1]);
        if (!FORMATS.has(value as OutputFormat)) {
          throw new UsageError(`unknown format "${value}"`);
        }
        parsed.format = value as OutputFormat;
        index += 1;
        break;
      }
      case '--fail-on': {
        const value = requireValue(arg, args[index + 1]);
        const allowed: string[] = [...SEVERITY_ORDER, 'never'];
        if (!allowed.includes(value)) {
          throw new UsageError(`unknown --fail-on value "${value}"`);
        }
        parsed.failOn = value as FailOn;
        index += 1;
        break;
      }
      default:
        throw new UsageError(`unknown option "${arg}"`);
    }
  }
  return parsed;
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);

  if (parsed.help || (parsed.command === '' && args.length === 0)) {
    stdout.write(`${HELP}\n`);
    return 0;
  }
  if (parsed.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.command !== '' && parsed.command !== 'review') {
    throw new UsageError(`unknown command "${parsed.command}"`);
  }
  if (parsed.base === undefined) {
    throw new UsageError('--base is required');
  }

  const token = parsed.token ?? env.GITHUB_TOKEN ?? env.GH_TOKEN;
  const client = new RestGitHubClient(token === undefined ? {} : { token });

  const report = await reviewBumps(client, {
    base: parsed.base,
    ...(parsed.head === undefined ? {} : { head: parsed.head }),
    ...(parsed.root === undefined ? {} : { root: parsed.root }),
    ...(parsed.paths.length === 0 ? {} : { paths: parsed.paths }),
    skipProvenance: parsed.skipProvenance,
  });

  stdout.write(formatReport(report, parsed.format));
  return shouldFail(report, parsed.failOn) ? 1 : 0;
}

/**
 * Whether this module was executed directly.
 *
 * Compares real paths because npm installs the bin as a symlink, so the
 * entry path and this module's path differ by one level of indirection.
 */
export function isEntryModule(moduleUrl: string, entry: string | undefined): boolean {
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
  } catch {
    return pathToFileURL(entry).href === moduleUrl;
  }
}

if (isEntryModule(import.meta.url, argv[1])) {
  try {
    exit(await run(argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`action-diff: ${message}\n`);
    if (error instanceof ActionDiffError && error.code === 'usage') {
      stderr.write('Run action-diff --help for usage.\n');
    }
    exit(2);
  }
}
