#!/usr/bin/env bash
# CLAUDE.md's @import covers the main session, but the requirement is that any
# agent works off these rules — so inject them here too rather than trusting a
# single delivery path. Cheap: one small file read per session start.
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
