# Clean code rules

How code gets written in this repo. Binds everyone — human and agent alike,
main session and subagent alike. Loaded into every session via `CLAUDE.md`.

These are only the rules no checker can verify. Formatting, import boundaries
and file shape are enforced by `pnpm test`; if a rule here becomes mechanically
checkable, delete it from here and let the checker own it.

## Change discipline

AI-assisted changes fail in one direction: more surface area, presented as
thoroughness. These rules push back.

- Build the smallest thing that satisfies the request. No options, flags, or
  extension points nobody asked for.
- No abstraction with one caller. Wait for the third case.
- No defensive branches for states that cannot occur.
- Prefer deleting to adding.
- Fix the cause, never the symptom. Never widen a type, swallow an error, or
  add a retry to stop a failure being visible.
- No new dependencies without asking. Everything here ships in the Docker image.

## Comments

The comments in this codebase carry incident history. That is the most valuable
thing in it and the easiest thing to erode.

- Explain **why**, never what. A comment restating the code is deleted on sight.
- Every non-obvious guard, ordering constraint or workaround **names the failure
  that caused it**. See the route comments in `server/router.js` (~line 51) —
  the file opens with imports, not a header comment.
- Never delete an explanatory comment while editing around it. Update it if it
  has gone stale.

## Verification

- Never claim something works without showing the command and its output.
  "Should work" is not a result.
- A behaviour change needs a test that fails before it and passes after.
- Report outcomes faithfully. If tests fail, say so with the output. If a step
  was skipped, say that.
