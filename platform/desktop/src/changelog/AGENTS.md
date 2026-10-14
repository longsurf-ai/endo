# Changelog

`changelog.json` appears in Settings → Changelog. Every release adds its entry
here.

## Entry

- Add one entry at the top, in the commit that bumps `package.json`. Tests fail
  when the newest `version` differs from the package.
- `date` is the release day as `YYYY-MM-DD`.
- Source: merges since the previous version bump
  (`git log --first-parent <that commit>..HEAD`). Read each PR; keep only what a
  user would notice.
- `items`: one to six sentences, most important first, each under 120 characters.

## Voice

Write as the engineer who shipped it, telling a user what changed.

- State the result, not the work: what people can now do, or what behaves
  differently. Name the place when it helps, e.g. "Settings → Models".
- Plain words, sentence case, a closing period. Fixes start with "Fixed".
- No marketing or filler ("seamless", "enhanced", "various improvements"),
  emoji, exclamation marks, bold or headings.
- No internal names: PRs, files, components, refactors, tests.
- Don't pad a quiet release; one honest line is enough.

Good: "Schedules keep their time zone when you rename them."
Bad: "Enhanced scheduling for a seamless experience."
