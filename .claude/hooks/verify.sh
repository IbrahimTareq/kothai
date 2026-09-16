#!/usr/bin/env bash
# Tier 3 of the governance plan: the agent cannot end a turn having left the
# suite red. This holds no rules of its own — it shells out to the exact
# `pnpm test` CI runs, so "correct" has one definition whether the check
# fires here, in a terminal, or in GitHub Actions. Do not enumerate checks
# in this file; that would let this copy drift from CI's.
set -uo pipefail
root="${CLAUDE_PROJECT_DIR:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null)}"
cd "$root" || exit 0

# Skip when nothing under the source dirs changed, so a conversational turn
# (no edits, or edits to docs/.claude/etc.) costs nothing. `pnpm test` runs
# the whole suite (~5s); paying that on every Stop would make the hook
# noticeable rather than invisible.
if [ -z "$(git status --porcelain -- client/ server/ scripts/ test/ 2>/dev/null)" ]; then
  exit 0
fi

# The suite must run on Node 22, never the ambient shell's Node (v24 here).
# CLAUDE.md records that Node 24 once hid a `mock.module()` misuse that only
# fails on 22 — a gate that silently checked the wrong runtime would be worse
# than no gate, so a missing/broken mise resolution fails loud instead of
# falling back to whatever `node` happens to be on PATH.
if ! command -v mise >/dev/null 2>&1; then
  echo "verify.sh: mise not found on PATH; cannot guarantee Node 22, refusing to run the suite on an unverified Node version" >&2
  exit 2
fi

node22_bin="$(mise where node@22 2>/dev/null)/bin"
if [ ! -x "$node22_bin/node" ]; then
  echo "verify.sh: mise could not resolve a Node 22 install (looked in $node22_bin); run 'mise install node@22'" >&2
  exit 2
fi

resolved_version="$("$node22_bin/node" --version)"
case "$resolved_version" in
  v22.*) ;;
  *)
    echo "verify.sh: resolved Node is $resolved_version, not v22.x; refusing to run the suite on the wrong runtime" >&2
    exit 2
    ;;
esac

# Prepend node22's bin dir so every `node` invocation inside `pnpm test`
# (pnpm itself, and each script it shells out to) resolves to 22, not
# whatever ambient Node this hook's shell inherited.
output="$(PATH="$node22_bin:$PATH" pnpm test 2>&1)"
status=$?

if [ "$status" -ne 0 ]; then
  echo "verify.sh: pnpm test failed (exit $status) on Node $resolved_version — last 40 lines:" >&2
  echo "$output" | tail -n 40 >&2
  exit 2
fi

exit 0
