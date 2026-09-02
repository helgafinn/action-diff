---
title: The pin you stopped reading
published: true
description: Pinning GitHub Actions to a commit SHA is what saved repositories during the tj-actions compromise. Then Dependabot bumps the pin dozens of times a year, and the review it depends on quietly stops happening.
tags: githubactions, security, devops, cicd
canonical_url: https://github.com/helgafinn/action-diff/discussions/4
---

In March 2025 an attacker compromised `tj-actions/changed-files` and rewrote its
release tags to point at malicious code. The injected code dumped runner memory
into workflow logs, which on a public repository means printing your secrets
where anyone can read them. Around 23,000 repositories depended on that action,
most of them through a mutable tag like `@v45`.

Repositories that had pinned the action to a commit SHA were unaffected. That is
worth sitting with for a moment, because it is rare for a security practice to
draw such a clean line through a real incident. The advice worked exactly as
advertised.

So we all pinned. And then we quietly undid it.

## What pinning actually buys you

`uses: actions/checkout@v5` means "run whatever `v5` points at when this
workflow starts". The tag is a pointer the upstream author can move at any time,
and nothing about your repository changes when they do. You are trusting the tag
to keep meaning what it meant when you wrote the line.

`uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` means "run
this exact commit". Nobody can repoint it. If the upstream repository is
compromised tomorrow, your workflow keeps running the code you reviewed.

That is the entire mechanism. It is not clever, and that is its strength.

## The part nobody mentions

A pin is a snapshot, and snapshots go stale. The action you froze in March has
since fixed bugs, gained features, and patched its own vulnerabilities, and you
are running none of it. So you enable Dependabot, which is exactly the right
call — an un-updated pin is its own risk.

Now look at what arrives in your pull request queue:

```diff
- uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8
+ uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09
```

What changed? You cannot tell. Not because you are careless — because the diff
contains no information. Two hex strings differ. That is the whole change.

GitHub's own engineering blog describes a repository where
[roughly one in six commits were Dependabot version bumps](https://github.blog/security/supply-chain-security/tame-dependabot-group-your-updates-slow-the-cadence-keep-security-fast/),
61 of them in twelve months, sometimes several in a single day. Nobody
meaningfully reviews an opaque hash 61 times a year. You approve it, because the
alternative is manually diffing a third-party repository before every merge, and
nobody has budgeted for that.

One maintainer put it plainly on her own blog, admitting she
[blindly accepts Dependabot pull requests and noting this negates the benefit of pinning](https://some-natalie.dev/blog/github-actions-changes/).
That is not a confession of bad practice. It is an accurate description of what
the workflow makes people do.

So the pin is still in the file. The review it depends on is gone. You are
running unreviewed third-party code with your credentials, with a line in your
YAML that looks like diligence.

## It gets slightly worse

Two details make this sharper than it first appears.

**Dependabot Alerts do not cover SHA-pinned actions.** Users have been
[asking GitHub to fix this asymmetry](https://github.com/orgs/community/discussions/154189)
for a while. You are told to pin, then told to enable version updates to combat
staleness, and the alerting that would tell you a pinned action has a known
vulnerability does not apply to the form you were told to use.

**The version comment is not verified by anything.** Tooling writes bumps like
this:

```yaml
uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
```

That line makes two claims. First, run this commit — GitHub enforces it. Second,
this commit is v5.1.0 — nothing enforces it at all. It is a comment. Your eyes
read `v5.1.0` and move on, and the only thing GitHub cares about is the hash.

Those two claims agreeing is precisely what a retagged release breaks. In the
tj-actions incident the tags were moved; the SHAs were not. If a pin's comment
says `v5.1.0` and the `v5.1.0` tag now resolves to a different commit, something
worth knowing has happened — either your pin is stale, or the tag moved under
you. That check takes one API call, and almost nobody performs it.

## This is not a niche concern

GitHub reported
[11.5 billion Actions minutes used in 2025, up 35% year over year](https://github.blog/news-insights/product-news/lets-talk-about-github-actions/).
Datadog's security research found that
[two out of three organizations have at least one vulnerability in an Actions workflow](https://securitylabs.datadoghq.com/articles/case-for-github-actions-security/).

And the incidents kept coming after tj-actions. In May 2026 a threat group
[compromised 5,561 public repositories in about six hours](https://dev.to/unbearablelabs/two-supply-chain-attacks-in-one-week-heres-what-to-actually-fix-in-your-ci-2knc)
by pushing workflows carrying dormant `workflow_dispatch` backdoors. TanStack's
router was breached through
[cache poisoning that led to OIDC token theft and 84 malicious npm packages](https://www.copilotkit.ai/blog/tanstack-supply-chain-attack-and-how-to-lock-down-github-actions).

Attackers moved to CI because CI holds credentials, runs on every push, and is
reviewed less carefully than application code. Workflow files are code with
production access that we treat as configuration.

## What would actually help

Not "review your Dependabot PRs more carefully." That advice has been available
the whole time and it loses to arithmetic: 61 bumps a year against a finite
attention budget.

What helps is making the diff contain information again. When a pin moves, the
questions worth answering are mechanical, and mechanical questions can be
answered mechanically:

- Does the new commit exist in any tag or branch upstream, or is it floating
  outside published history?
- If the pin claims a version, does that tag still resolve to this commit?
- Did the action's declared interface change — inputs, outputs, required flags?
- Did its execution model change, for instance a JavaScript action becoming a
  Docker action that can pull an arbitrary image?
- Did it gain network calls, secret references, or dynamic code execution that
  it did not have before?

None of that requires judgment. It requires fetching two revisions and
comparing them, which is a thing a computer should do for you before you click
approve.

## Two honest caveats

**No static check can be certain.** An action that builds a resource name at
runtime could reach anything, and a tool claiming certainty there is lying. The
right behaviour is to say what could not be determined rather than stay quiet.

**A clean report is not a safety guarantee.** It means the reviewable surface
did not change in a way worth flagging. A sufficiently careful attacker can stay
below that line. This raises the cost of an attack; it does not eliminate it.

## The point

Pinning to a SHA is still correct. Keep doing it.

But recognise what it is: a mechanism that converts a trust problem into a
review problem. It only pays out if the review happens, and we built a workflow
that guarantees it does not. The pin in your YAML is not protection. It is a
place where protection could go, if something were reading it.

---

I wrote [action-diff](https://github.com/helgafinn/action-diff) to do the
comparison above — it reads both revisions of a bumped action and reports what
changed, including whether the pin's claimed version still resolves to the
commit it names. It is MIT licensed and runs as a GitHub Action or a CLI.

Use it, use something else, or write your own. The tooling matters much less
than noticing that a practice we all adopted has quietly stopped working.
