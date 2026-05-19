---
name: daily-github-activity
description: Summarise the user's GitHub activity for a given day (default today) in a fixed format. Pulls PRs authored, release promotions, reviews, and commits via the `gh` CLI. Use when the user asks for a daily summary, standup notes, or "what did I do today/yesterday on GitHub".
---

# Daily GitHub Activity Summary

Produce a consistent daily report of the user's GitHub activity.

## Inputs

- **Date**: defaults to today (use the `currentDate` from the session context). Accept ISO date (`YYYY-MM-DD`) or relative ("yesterday", "Monday") — resolve to absolute before querying.
- **GitHub user**: read from `gh api user --jq .login`. Do not hardcode.

## Data collection

Run these in parallel via the Bash tool:

1. **PRs / issues authored & touched**
   ```
   gh api "/search/issues?q=author:<LOGIN>+updated:<DATE>" \
     --jq '.items[] | "\(.created_at) [\(.state)] \(.title) - \(.html_url)"'
   ```

2. **All event activity for the day** (merges, pushes, reviews, branch creates):
   ```
   gh api "/users/<LOGIN>/events?per_page=100" \
     --jq '.[] | select(.created_at | startswith("<DATE>")) |
       "\(.created_at) \(.type) \(.repo.name) \(.payload.action // "") \(.payload.pull_request.title // .payload.commits[0].message // .payload.ref // "")"'
   ```

3. **Local commits in cwd** (only if inside a git repo — best-effort, do not fail if not):
   ```
   git log --author="<git user.name or email>" --since="<DATE> 00:00" --until="<DATE> 23:59" --all --pretty=format:"%h %ai %s"
   ```

If pagination matters (>100 events), warn the user that older events of the day may be missing.

## Output format (always use this exact structure)

```
# GitHub activity — <YYYY-MM-DD>

## Pull Requests Opened & Merged
<Per repo, list "#<num> `<title>` (<open time> → merged <merge time>)". Omit if none.>

## Release Promotions (qa → staging → production)
<Per repo, group qa→staging and staging→production PRs with merge times. Note related branches/hotfixes. Omit if none.>

## Code Reviews
<Per repo: "submitted a PR review" / "left inline comments on #<num>" with time. Omit if none.>

## Other Activity
<Branch creations not tied to a PR, dependabot cleanups, force pushes, deletions. Omit if none.>

## Local Commits (<repo name>)
<Only if cwd is a git repo and there are commits. Otherwise omit.>

## Summary
- <One bullet per noteworthy theme: number of PRs authored & merged, services promoted, reviews given.>
```

## Rules

- **Never invent activity.** If a section is empty, omit it entirely.
- **Use UTC timestamps as returned by GitHub** — display as `HH:MM` only (drop seconds and `Z`) for readability.
- **Group by repo** within each section, ordered chronologically by first event.
- **Distinguish promotion PRs** (titles like "Promote qa → staging" / "Promote staging → production") from substantive code PRs — promotion PRs go under "Release Promotions", everything else under "Pull Requests Opened & Merged".
- **Dependabot/auto-merges** belong under "Other Activity", not under authored PRs.
- **Do not editorialise** — report what happened, not whether it was a productive day.
- **No emojis.**
