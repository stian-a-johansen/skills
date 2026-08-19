---
name: groupthink
description: Run a multi-agent co-editing workflow for non-trivial implementation work. Use Codex for a pre-code plan review and post-diff review, then use Opencode with Claude or another different model family for a final review before reporting done.
---

# Groupthink

Use this when the user asks for a second opinion, cross-model review, extra scrutiny, or agent co-editing during implementation.

Required loop:

1. Understand the code yourself.
2. Write a provisional plan.
3. Ask Codex to review the plan before edits.
4. Implement the corrected plan.
5. Test or run the changed behavior.
6. Ask Codex to review the applied diff.
7. Ask Opencode with Claude, or another different model family, for a final review.
8. Fix real issues and repeat review only for changed areas.
9. Report the result, evidence, and residual risks.

Do not push. Ask before committing.

## Before Edits

Read the real files. Verify external reports against the code.

Write a short plan with:

- confirmed facts
- assumptions
- minimal change
- out-of-scope items
- tests or runs that will prove the change

Use a targeted prompt. Ask for go/no-go, missed risks, and scope errors. Tell the reviewer to inspect the files, not trust your summary.

```bash
codex exec -s read-only -C <repo_dir> "$(cat <prompt_file>)" < /dev/null
```

Keep prompts and diff files inside the repo when the reviewer sandbox must read them.

## Implement

Make the smallest change that matches the reviewed plan.

Follow local patterns for:

- config
- errors
- tests
- validation
- naming

Do not add adjacent fixes unless they are necessary for this task. Record them as residual work.

## Verify

Run the relevant tests or a real behavior check.

If failures look pre-existing, prove it with a clean baseline or an unchanged failure set. Do not claim no regressions without evidence.

## Diff Review

Ask Codex to review the applied changes:

```bash
codex exec -s read-only -C <repo_dir> "$(cat <review_prompt_file>)" < /dev/null
```

Ask whether:

- the diff matches the reviewed plan
- the fix is correct
- the scope is right
- tests prove the change
- local conventions are followed

Apply clear defects. Flag scope expansion to the user.

## Final Review

Use a different model family through Opencode, usually Claude:

```bash
opencode run -m <provider>/<claude_model> --dir <repo_dir> "$(cat <review_prompt_file>)" < /dev/null
```

If the model id is unknown, run:

```bash
opencode models
```

Give this reviewer full context. It has no memory of earlier review.

Ask for:

- correctness review
- scope review
- test review
- explicit approve or changes-needed verdict

Fix blocking issues. Repeat only the needed review pass.

## Report

Tell the user:

- what changed and why
- what each reviewer checked and decided
- what tests or runs passed
- which failures were pre-existing, if any
- what remains out of scope and why
- whether anything is staged

Do not say done until implementation, verification, and final review are complete.
