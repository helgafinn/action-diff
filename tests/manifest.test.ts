import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { manifestEntryPoints, parseActionManifest } from '../src/manifest.js';

test('reads the declared interface of a javascript action', () => {
  const manifest = parseActionManifest(`
name: Example
description: does a thing
runs:
  using: node24
  main: dist/index.js
inputs:
  token:
    required: true
    description: a token
  level:
    default: warn
outputs:
  result:
    description: the result
`);

  assert.equal(manifest?.using, 'node24');
  assert.equal(manifest?.entry, 'dist/index.js');
  assert.equal(manifest?.inputs.token?.required, true);
  assert.equal(manifest?.inputs.level?.required, false);
  assert.equal(manifest?.inputs.level?.default, 'warn');
  assert.deepEqual(Object.keys(manifest?.outputs ?? {}), ['result']);
});

// GitHub treats a missing `required` as false, so the parser must not guess.
test('treats an unspecified required flag as optional', () => {
  const manifest = parseActionManifest('runs:\n  using: composite\ninputs:\n  a: {}\n');
  assert.equal(manifest?.inputs.a?.required, false);
});

test('accepts the string form of required that YAML users write', () => {
  const manifest = parseActionManifest(
    'runs:\n  using: composite\ninputs:\n  a:\n    required: "true"\n',
  );
  assert.equal(manifest?.inputs.a?.required, true);
});

test('uses image or entrypoint as the entry for a docker action', () => {
  assert.equal(parseActionManifest('runs:\n  using: docker\n  image: Dockerfile\n')?.entry, 'Dockerfile');
  assert.equal(
    parseActionManifest('runs:\n  using: docker\n  image: Dockerfile\n  entrypoint: run.sh\n')?.entry,
    'run.sh',
  );
});

// An empty interface and an unreadable manifest must not look the same: the
// former means "declares nothing", the latter means "we could not tell". YAML
// recovers from a lot of damage, so requiring `runs` is what actually separates
// an action manifest from an arbitrary document that happens to parse.
test('rejects documents that are not action manifests', () => {
  assert.equal(parseActionManifest('- a\n- b\n'), undefined);
  assert.equal(parseActionManifest('just a string'), undefined);
  assert.equal(parseActionManifest('a: [unclosed\n'), undefined);
  assert.equal(parseActionManifest('name: no runs section\n'), undefined);
  assert.equal(parseActionManifest('runs: not-a-mapping\n'), undefined);
});

test('collects every entry point worth reading', () => {
  const points = manifestEntryPoints(`
runs:
  using: node24
  pre: dist/pre.js
  main: dist/index.js
  post: dist/post.js
`);
  assert.deepEqual(points.sort(), ['dist/index.js', 'dist/post.js', 'dist/pre.js']);
});

// A remote image is not a file in the repository, so there is nothing to fetch.
test('skips container images when choosing files to read', () => {
  assert.deepEqual(manifestEntryPoints('runs:\n  using: docker\n  image: docker://alpine:3\n'), []);
});
