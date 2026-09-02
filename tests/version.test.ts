import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { VERSION } from '../src/version.js';

const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');

// `VERSION` is compiled into the CLI rather than read from package.json at
// runtime, because the entry point resolves through an npm bin symlink whose
// location says nothing about where the manifest is. That leaves two copies of
// one fact, and a release that bumps only the manifest would have `--version`
// confidently report the previous release to every user.
test('the compiled VERSION matches the published package version', () => {
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };

  assert.equal(typeof manifest.version, 'string');
  assert.equal(VERSION, manifest.version);
});

// A tag is cut from this string, so a stray `v` or prerelease suffix would
// produce a tag that disagrees with the manifest it claims to describe.
test('the version is a bare semantic version', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/u);
});
