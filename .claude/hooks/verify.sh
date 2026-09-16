#!/usr/bin/env bash
# Tier 3 of the governance plan: the agent cannot end a turn having left the
# suite red. This holds no rules of its own — it shells out to the exact
# `pnpm build && pnpm test` CI runs (ci.yml's own job order), so "correct"
# has one definition whether the check fires here, in a terminal, or in
# GitHub Actions. Do not enumerate checks in this file; that would let this
# copy drift from CI's. (It used to shell out to `pnpm test` alone — that
# never typechecked, so `export const probe: number = 'not a number'` in
# client/ passed the hook and only broke `pnpm build`.)
set -uo pipefail

# If Claude Code already told us once this turn ("stop_hook_active": true in
# the JSON on stdin), a red suite is unfixable right now — returning 2 again
# would trap the session in a loop with no new information for the agent.
# Guard the read: a bare terminal invocation (this file run by hand) has no
# piped stdin, and blocking on `cat` there would hang the shell forever.
if [ -t 0 ]; then
  stdin_json=""
else
  stdin_json="$(cat 2>/dev/null)"
fi

if [ -n "$stdin_json" ]; then
  jq_bin="$(command -v jq || true)"
  if [ -z "$jq_bin" ] && [ -x /opt/homebrew/bin/jq ]; then
    jq_bin=/opt/homebrew/bin/jq
  fi
  if [ -n "$jq_bin" ]; then
    stop_hook_active="$("$jq_bin" -r '.stop_hook_active // false' <<<"$stdin_json" 2>/dev/null)"
    if [ "$stop_hook_active" = "true" ]; then
      exit 0
    fi
  fi
fi

# Every other failure path below exits 2 deliberately — an unresolved root
# must too. `cd ""` returns 0 in bash, so a silent `|| exit 0` here used to
# mean "both CLAUDE_PROJECT_DIR and git rev-parse failed" was indistinguishable
# from "verified clean", and the hook would run `git status` in whatever cwd
# it inherited and pass.
root="${CLAUDE_PROJECT_DIR:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null)}"
if [ -z "$root" ]; then
  echo "verify.sh: could not resolve project root (CLAUDE_PROJECT_DIR unset and git rev-parse --show-toplevel failed); refusing to run in an unknown directory" >&2
  exit 2
fi
cd "$root" || { echo "verify.sh: cd to resolved root '$root' failed" >&2; exit 2; }

# Skip only when nothing has changed since the last successful verification,
# so a conversational turn (no edits at all) costs nothing. This used to be
# `git status --porcelain -- client/ server/ scripts/ test/`, which put
# biome.json, package.json, tsconfig*.json and .claude/ itself outside the
# gate's view — a reviewer emptied biome.json's client/server boundary rule
# and deleted `node scripts/lint-shape.mjs` from package.json's `test`
# script, and the pathspec-scoped `git status` stayed empty so the hook
# exited 0 having run nothing. It also meant committing (which always empties
# `git status --porcelain`) skipped the gate outright — and CLAUDE.md mandates
# committing straight to main, so that was the common case, not an edge case.
# The fingerprint below changes when EITHER HEAD moves OR the working tree
# changes anywhere in the repo, with no pathspec to be blind behind.
marker="$root/.claude/.last-verified"
head_sha="$(git rev-parse HEAD 2>/dev/null)"
status_hash="$(git status --porcelain 2>/dev/null | git hash-object --stdin 2>/dev/null)"
fingerprint="$head_sha:$status_hash"

if [ -f "$marker" ] && [ "$(cat "$marker" 2>/dev/null)" = "$fingerprint" ]; then
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

# Prepend node22's bin dir so every `node` invocation inside `pnpm build` and
# `pnpm test` (pnpm itself, and each script it shells out to) resolves to 22,
# not whatever ambient Node this hook's shell inherited. Build runs first,
# matching ci.yml exactly — build is the only step that runs `tsc --noEmit`,
# so a hook that only ran `pnpm test` never typechecked at all.
output="$(PATH="$node22_bin:$PATH" sh -c 'pnpm build && pnpm test' 2>&1)"
status=$?

if [ "$status" -ne 0 ]; then
  echo "verify.sh: pnpm build && pnpm test failed (exit $status) on Node $resolved_version — last 40 lines:" >&2
  echo "$output" | tail -n 40 >&2
  exit 2
fi

echo "$fingerprint" > "$marker"
exit 0
