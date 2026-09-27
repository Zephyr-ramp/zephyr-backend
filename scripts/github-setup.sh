#!/usr/bin/env bash
# Create this repo's labels and Wave issues on GitHub with the gh CLI.
#
# Usage:  ./scripts/github-setup.sh [owner/repo]     (default: zephyr-ramp/zephyr-backend)
#         DRY_RUN=1 ./scripts/github-setup.sh         print what would be created
#
# Labels come from .github/labels.json and issues from issues/<repo>.json.
# Labels are upserted (--force). Issues are skipped if an open or closed issue
# with the same title already exists, so the script is safe to re-run.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="${1:-zephyr-ramp/zephyr-backend}"
NAME="${REPO#*/}"
ISSUES="issues/$NAME.json"
RUN=""
[[ -n "${DRY_RUN:-}" ]] && RUN="echo"

command -v gh >/dev/null || { echo "gh CLI not found: https://cli.github.com" >&2; exit 1; }
[[ -f "$ISSUES" ]] || { echo "Missing $ISSUES" >&2; exit 1; }

echo "==> Labels for $REPO"
node -e 'for (const l of require("./.github/labels.json")) console.log([l.name, l.color, l.description].join("\t"))' |
  while IFS=$'\t' read -r name color description; do
    $RUN gh label create "$name" --repo "$REPO" --color "$color" --description "$description" --force
  done

echo "==> Issues for $REPO"
EXISTING="$(gh issue list --repo "$REPO" --state all --limit 500 --json title -q '.[].title' 2>/dev/null || true)"
COUNT="$(node -e "console.log(require('./$ISSUES').length)")"
for ((i = 0; i < COUNT; i++)); do
  TITLE="$(node -e "console.log(require('./$ISSUES')[$i].title)")"
  if grep -Fxq -- "$TITLE" <<<"$EXISTING"; then
    echo "skip (exists): $TITLE"
    continue
  fi
  BODY_FILE="$(mktemp)"
  node -e "process.stdout.write(require('./$ISSUES')[$i].body)" >"$BODY_FILE"
  LABELS="$(node -e "console.log(require('./$ISSUES')[$i].labels.join(','))")"
  $RUN gh issue create --repo "$REPO" --title "$TITLE" --body-file "$BODY_FILE" --label "$LABELS"
  rm -f "$BODY_FILE"
done
