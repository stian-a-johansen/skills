---
name: SAST
description: Triage and remediate Semgrep SAST findings for a repo. Pulls findings via the semgrep-guardian MCP tools, gets an independent triage from codex CLI before writing any code, fixes only what is real and straightforward, gets a codex review of the implementation, and records finding links as inline PR review comments rather than code comments. Use when asked to run/check SAST, work through Semgrep findings, or fix security scanner results.
---

# SAST triage and remediation

Work through Semgrep AppSec Platform findings end to end. The defining constraint: **an
independent model reviews the plan before code is written and reviews the diff after**, and
**traceability lives in the PR, not in the source**.

Never mark a finding fixed without proving it. Never commit or push — stage and stop.

## 1. Pull the findings

```
mcp__plugin_semgrep_guardian__whoami            # confirm deployment name
mcp__plugin_semgrep_guardian__get_semgrep_sast_findings
    deployment_name=<deployment>
    repository_name=<Org/Repo>                  # full path; a bare repo name will not match
    severities=["critical","high","medium"]     # unless asked otherwise
    max_num_findings=200
```

Pass `deployment_name` and `repository_name` on every subsequent call so the user is not
re-prompted to pick from a dropdown.

Record each finding's **id**, path, line, rule, and severity — the ids are needed in step 5.

## 2. Read the flagged code yourself

Open every flagged file before forming an opinion. Batch the reads in parallel. Findings
reference the commit that was scanned, which may be behind HEAD — check whether the line
still says what the finding claims.

## 3. Triage with codex BEFORE writing code

Write a briefing to the scratchpad grouping findings by rule, with the relevant code inline
and **your own provisional verdict on each group**, then:

```bash
codex exec --sandbox read-only "$(cat <briefing>.md)"
```

Ask for, per group: (a) real vulnerability or false positive, (b) straightforward-and-safe
to fix now or needs design work, (c) the exact change if straightforward. Tell it to read
the files itself.

Give codex your verdict to argue against rather than a blank slate — it catches more when
it has something to disagree with. Do not take its answer on faith either; it is another
model, not an oracle. Verify claims about tool behaviour independently (see step 4).

## 4. Fix, verifying every external fact

Fix only what is real and low-risk. Leave anything needing design work, and say so.

Verify rather than assume:
- Resolve action tags to a real 40-char SHA (`gh api repos/<o>/<r>/git/ref/tags/<tag>`).
- Check the tool version in use actually supports a suggested option before adding it.
- After a lockfile-affecting change, re-lock and diff — confirm **no package versions moved**.
- Run the project's lint/type checks, and diff the error count against a `git stash` baseline
  so pre-existing failures are not mistaken for regressions.

For any validator or other security control you introduce, write a parametrised test
covering both the values that must keep working and every attack vector — including the
specific bypasses found in review. That test is the deliverable that stops a future edit
silently reopening the hole.

Prefer behaviour-preserving remediation on legacy endpoints: downgrade a bad value to a safe
default with a warning log rather than returning an error, when the client population is
unknown. Flag the choice to the user.

## 5. Review the implementation with codex

```bash
codex exec --sandbox read-only "<what changed, why, and what you already verified>"
```

State what you changed and what you tested, then ask: any remaining bypass; any bug
introduced by the edits; do the tests cover the right things; ship or not. Ask it to be
blunt.

Expect real defects and fix them, then run another round. A validator is not done until a
round comes back clean. Two failure modes seen repeatedly:
- **Fail-open loops** — a bounded decode/normalise loop that accepts the value when it runs
  out of rounds. Use `for/else` to return "unsafe" instead.
- **Edge-only checks** — stripping control characters at the ends while a payload sits in the
  middle. Check the whole string, before any stripping.

Codex runs can exceed 10 minutes; run them in the background and wait on completion rather
than chaining sleeps.

## 6. Comments: minimal in code, links in the PR

**In code:** no comment unless it records something the code cannot. A constant's name
usually says it. Delete "why this is a security fix" narration and any history of what the
line used to be. What survives is typically: a non-obvious interaction (a per-attempt timeout
multiplied by a mounted retry policy), a subtle control-flow intent (`for/else` failing
closed), and why a safe-looking alternative was rejected.

**In the PR:** post finding links as **inline review comments anchored to the changed line**,
so a reviewer sees which finding each hunk closes. Body is the URL and nothing else.

```bash
gh pr view <n> --json headRefOid,headRefName
gh api repos/<o>/<r>/pulls/<n>/files --jq '.[] | "\(.filename)\n\(.patch)"'
# verify each anchor resolves to the intended line at the PR head:
/usr/bin/git show <headSha>:<path> | cat -n | grep -E "^ +<line>\t"
gh api repos/<o>/<r>/pulls/<n>/reviews --method POST --input review.json
```

`review.json`: `{commit_id, event: "COMMENT", comments: [{path, line, side: "RIGHT", body}]}`.
Finding URL format: `https://semgrep.dev/orgs/<deployment>/findings/<id>`. The API returns
ids, not UI links — say the format is inferred and offer to repost if it differs.

Rules for the comments:
- One anchor per fix. Where one line closes several findings of the same rule, put every link
  in that one comment.
- **Do not comment on a change that resolves nothing** — e.g. hardening added alongside a
  false-positive finding. A link there implies a fix that does not exist.
- Verify each line number against the PR head commit before posting; a stale anchor is
  rejected or lands on the wrong line.

## 7. Report

Give the user, separately:
- The **finding ids to dismiss as false positives**, as a copyable table with a one-sentence
  justification they can paste into the platform.
- What was fixed, and how it was verified (tests passed, lint clean, baseline unchanged).
- Judgment calls they may want to overturn, and anything deliberately left undone.

Then `git add` the changes and stop. The human commits.

## Environment notes

- Settings are often validated at import, so tests need the full env var set. Discover the
  required names from the pydantic ValidationError and pass dummies to run a unit test
  locally.
