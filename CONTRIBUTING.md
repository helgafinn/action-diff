# Contributing to action-diff

## Development setup

Use Node.js 24 or newer and the npm version declared in `package.json`.

```bash
npm ci
npm run check
```

`npm run check` runs strict TypeScript checking, the test suite, the library build, and the bundled-action build.

## Project structure

- `src/refs.ts`: parsing `uses:` references, including the version a trailing comment claims
- `src/detect.ts`: finding action references whose revision changed between two commits
- `src/github.ts`: the `GitHubClient` interface, its REST implementation, and file selection
- `src/manifest.ts`: reading an action's declared interface
- `src/provenance.ts`: checking that a revision is something upstream publishes
- `src/classify.ts`: comparing two revisions into severity-ranked findings
- `src/review.ts`: orchestration across Git, GitHub, provenance, and classification
- `src/format.ts`: terminal, JSON, markdown, and workflow-command output
- `src/cli.ts` and `src/action.ts`: the two entry points

## Tests

Tests live in `tests/` and run through `node:test`. They must not reach the network: `GitHubClient` is an interface precisely so review logic can be driven from fixtures. `tests/detect.test.ts` creates real temporary Git repositories, which is local and cheap.

When adding a finding, cover both directions. A rule that fires correctly is half the requirement; a rule that stays quiet when it should is what keeps the tool worth reading. Several existing tests exist only to pin the quiet case, such as source lines moving without a capability being added.

## Severity

Severity is a claim about what a reviewer must do, not about how interesting a change is.

- **Critical**: the revision may not be what it claims to be, or it can now do categorically different things
- **High**: callers can break, or a new capability appeared such as network access, secret use, or dynamic execution
- **Medium**: behaviour can change silently
- **Low**, **Info**: worth seeing, not worth blocking

Adding findings at high or above raises the cost of ignoring the tool. Prefer the lowest severity that still communicates the decision.

## The bundled action

`action/index.cjs` is committed because GitHub runs an action straight from the repository without installing dependencies. Rebuild it with `npm run build` whenever `src/` changes; CI fails if it drifts. It is marked `linguist-generated` so it collapses in diffs.

Note that it bundles to CommonJS, so top-level `await` is not available in `src/action.ts`.

## Pull requests

Keep changes focused, explain the reasoning behind a new rule rather than only its mechanics, and make sure `npm run check` passes.
