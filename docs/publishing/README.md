# Publishing the write-up

The article lives at [`../the-pin-you-stopped-reading.md`](../the-pin-you-stopped-reading.md).

Published so far:

- **GitHub Discussions** — https://github.com/helgafinn/action-diff/discussions/4 (canonical)

## dev.to

[`devto.md`](devto.md) is the same article with dev.to frontmatter already
filled in: title, description, tags, and `canonical_url` pointing at the
discussion above.

Setting the canonical URL matters. Without it, two identical articles compete in
search results and both rank worse than one would have.

To publish: sign in at [dev.to](https://dev.to) (GitHub OAuth works), open the
editor, switch it to markdown mode, and paste the file contents including the
frontmatter block. dev.to reads the frontmatter, so the title and tags do not
need setting by hand.

## Hacker News

Submit the canonical discussion URL, not a link to the repository. The article
argues a mechanic and stands on its own; a repository link reads as promotion and
gets flagged.

Title should match the article — no "Show HN" prefix, since the submission is
the writing rather than the tool.

## What not to do

Do not post links to this on unrelated issue threads, even ones discussing
supply-chain attacks. It is spam, it gets accounts banned, and it makes the tool
look like something to avoid. If somebody asks how to review Dependabot action
bumps, answering is fine. Volunteering is not.
