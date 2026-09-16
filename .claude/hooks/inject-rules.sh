#!/usr/bin/env bash
# CLAUDE.md's @import puts clean-code-rules.md in context at the start of a
# session, but SessionStart also fires on `/clear` and `/compact` — and
# neither of those re-runs the @import, since they act on the existing
# session rather than starting a fresh one. Without this, both would drop
# the rules from context; this re-injects them so they survive. It does NOT
# reach Task-tool subagents — SessionStart is a main-session lifecycle event,
# not a per-subagent one. Depends on `jq` (see docs/development.md's Setup
# section) with no fallback: if it's missing, this hook errors.
set -uo pipefail
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
rules="$root/.claude/clean-code-rules.md"
[ -f "$rules" ] || exit 0

jq -Rs --arg name SessionStart '{
  hookSpecificOutput: {
    hookEventName: $name,
    additionalContext: .
  }
}' < "$rules"
