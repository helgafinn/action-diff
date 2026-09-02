# action-diff

Review what a pinned GitHub Action SHA bump actually changes.

Pinning actions to a commit SHA is the defence that works. When `tj-actions/changed-files` was compromised, repositories pinned to a SHA were unaffected; repositories on a mutable tag were not.

Then Dependabot bumps that SHA, and you approve a 40-character hash. The pin still exists, but nobody is checking what is behind it — so the protection it was supposed to provide is gone. `action-diff` reads both revisions and tells you what changed, so approving a bump becomes a decision instead of a reflex.

The analysis is read-only. It fetches public action repositories through the GitHub API and never executes the action being reviewed.

## What it catches

```text
actions/checkout  11bd71901bbe -> 8ade135a41bc
  used by: .github/workflows/ci.yml
  CRITICAL [provenance.tag-mismatch] actions/checkout is pinned to 8ade135a41bc and
           labelled v4.2.2, but that tag now points at 11bd71901bbe. Either the pin
           is stale or the tag was moved.
  HIGH     [outputs.removed] Output "ref" was removed. Steps reading it receive an
           empty value.
  MEDIUM   [inputs.removed] Input "ssh-user" was removed and is now ignored.
```

| Finding | Severity |
| --- | --- |
| The pinned commit exists in no tag, branch, or default-branch history | Critical |
| A pin's claimed version tag now points at a different commit | Critical |
| Execution model changed, for example node to docker | Critical |
| Reference is a mutable tag or branch rather than a SHA | High |
| A new required input, or an existing input becoming required | High |
| An output was removed | High |
| New network fetching, secret references, or dynamic execution | High |
| A newly reachable outbound host | High |
| Entry point, input default, or dependency changes | Medium |
| Runtime version bump, new optional input | Info |

`provenance.tag-mismatch` is the one worth understanding. `uses: owner/repo@<sha> # v4.2.2` makes two claims: run this commit, and this commit is v4.2.2. GitHub only enforces the first. Resolving the tag and comparing it to the pin tests the second, which is exactly the claim a retagged release breaks.

## Use as an Action

```yaml
name: Review action bumps
on: pull_request

permissions:
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: helgafinn/action-diff@v1
```

`fetch-depth: 0` matters. The default shallow clone has no base commit to compare against, and the run will tell you so rather than silently reviewing nothing.

The base revision comes from the pull request automatically. For other events, set it:

```yaml
      - uses: helgafinn/action-diff@v1
        with:
          base: ${{ github.event.before }}
          fail-on: critical
```

### Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `base` | pull request base | Revision to compare against |
| `root` | `.` | Repository root containing `.github/workflows` |
| `paths` | all | Newline-delimited workflow paths to restrict review to |
| `fail-on` | `high` | `critical`, `high`, `medium`, `low`, `info`, or `never` |
| `skip-provenance` | `false` | Diff source only, skipping upstream checks |
| `token` | `github.token` | Token used to read public action repositories |

### Outputs

`bumps`, `critical`, `high`, `highest-severity`, `markdown`, and `passed`.

Use `markdown` to post the report as a pull request comment:

```yaml
      - uses: helgafinn/action-diff@v1
        id: review
        with:
          fail-on: never
      - uses: thollander/actions-comment-pull-request@v3
        with:
          message: ${{ steps.review.outputs.markdown }}
```

Pair `fail-on: never` with a comment when you want the review visible without blocking the merge.

## Use as a CLI

```bash
npx action-diff review --base origin/main
```

```bash
npx action-diff review --base origin/main --format markdown
npx action-diff review --base HEAD~1 --fail-on critical
npx action-diff review --base origin/main --path .github/workflows/release.yml
npx action-diff review --base origin/main --format json | jq '.reviews[].findings'
```

A token is strongly recommended. Unauthenticated GitHub requests are capped at 60 per hour, which a single review can exhaust. Set `GITHUB_TOKEN` or `GH_TOKEN`, or pass `--token`.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | No findings at or above the failure threshold |
| 1 | Findings met the threshold |
| 2 | Invalid invocation, Git failure, or unexpected error |

## What it does not do

It reviews the manifest, declared entry points, shell scripts, container definitions, and dependency manifests. It does not diff bundled `dist/` output, because a minified bundle diff is unreadable and would drown the signal. A bundle change still surfaces indirectly through entry point, dependency, and manifest findings.

It reports what changed. It does not decide whether a change is malicious, and a clean report is not a safety guarantee.

Local actions (`./path`) and container references (`docker://`) are skipped. A local action's code already appears in the pull request diff.

## Requirements

- Node.js 24 or newer
- Git history containing the base revision

## Library

```ts
import { RestGitHubClient, reviewBumps, formatMarkdown } from 'action-diff';

const client = new RestGitHubClient({ token: process.env.GITHUB_TOKEN });
const report = await reviewBumps(client, { base: 'origin/main' });
console.log(formatMarkdown(report));
```

`GitHubClient` is an interface, so the review logic can be driven against any source without network access.

## License

MIT
