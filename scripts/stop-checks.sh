#!/usr/bin/env bash
# Claude Code Stop hook (.claude/settings.json): before an agent finishes, run the checks from AGENTS.md →
# "Before you finish a change" (tests, type-check, lint errors) and send any failures back to fix.
# Runs only when files changed since the last passing run, so a turn that only answers a question costs nothing.
set -u
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}" || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
gitdir=$(git rev-parse --git-dir)
stamp="$gitdir/claude-checks-passed"
blocks="$gitdir/claude-checks-blocked"
input=$(cat)

# Nothing to check: no edits, and no commits beyond main.
if [ -z "$(git status --porcelain)" ] && git rev-parse -q --verify origin/main >/dev/null \
  && [ -z "$(git rev-list origin/main..HEAD 2>/dev/null)" ]; then exit 0; fi

# What the code is now: the commit, the edits, and new files. Same as the last passing run → skip.
now=$( { git rev-parse HEAD; git diff HEAD; git ls-files -o --exclude-standard -z | xargs -0 -r cat 2>/dev/null; } | sha1sum | cut -d' ' -f1)
[ "$(cat "$stamp" 2>/dev/null)" = "$now" ] && { rm -f "$blocks"; exit 0; }

block() {
  # After three blocks in a row, let the agent stop (it reports the failure) rather than loop forever.
  n=$(( $(cat "$blocks" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$blocks"
  if [ "$n" -gt 3 ]; then
    rm -f "$blocks"
    printf '%s' "$1" | jq -Rs '{systemMessage: ("Checks still failing after 3 tries; tell the owner what is broken.\n" + .)}'
    exit 0
  fi
  printf '%s' "$1" | jq -Rs '{decision: "block", reason: ("The checks in AGENTS.md (Before you finish a change) failed. Fix these before finishing:\n\n" + .)}'
  exit 0
}

[ -d node_modules ] || block "node_modules is missing: run npm install, then npm test, npx tsc -b and npm run lint."

out=$(mktemp -d)
npm test --silent >"$out/test" 2>&1 & t=$!
npx tsc -b >"$out/tsc" 2>&1 & c=$!
npx eslint . --quiet >"$out/lint" 2>&1 & l=$!
fail=""
wait $t || fail+=$'npm test failed:\n'"$(grep -E '×|FAIL|Error|\+ ' "$out/test" | head -40)"$'\n\n'
wait $c || fail+=$'npx tsc -b failed:\n'"$(head -30 "$out/tsc")"$'\n\n'
wait $l || fail+=$'npm run lint has errors:\n'"$(head -30 "$out/lint")"$'\n\n'
rm -rf "$out"

[ -n "$fail" ] && block "$fail"
echo "$now" > "$stamp"; rm -f "$blocks"
exit 0
