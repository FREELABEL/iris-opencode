#!/bin/bash
set -euo pipefail

# IRIS CLI Release Script
# Usage: ./release.sh [version|--patch|--minor|--major]
# Examples:
#   ./release.sh 1.3.38
#   ./release.sh --patch    # 1.3.37 → 1.3.38
#   ./release.sh --minor    # 1.3.37 → 1.4.0
#   ./release.sh --major    # 1.3.37 → 2.0.0

PKG="packages/opencode/package.json"
REPO="FREELABEL/iris-opencode"

# Must run from repo root
if [ ! -f "$PKG" ]; then
  echo "Error: Run from iris-code repo root"
  exit 1
fi

# Must be on main branch
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  echo "Error: Must be on main branch (currently on '$BRANCH')"
  echo "Run: git checkout main && git pull"
  exit 1
fi

# Read current version
CURRENT=$(grep '"version"' "$PKG" | head -1 | sed 's/.*"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

echo "Current version: $CURRENT"

# Determine target version
ARG="${1:-}"
if [ -z "$ARG" ]; then
  echo "Usage: ./release.sh [version|--patch|--minor|--major]"
  exit 1
elif [ "$ARG" = "--patch" ]; then
  TARGET="$MAJOR.$MINOR.$((PATCH + 1))"
elif [ "$ARG" = "--minor" ]; then
  TARGET="$MAJOR.$((MINOR + 1)).0"
elif [ "$ARG" = "--major" ]; then
  TARGET="$((MAJOR + 1)).0.0"
else
  TARGET="$ARG"
fi

echo "Target version:  $TARGET"

# Check tag doesn't already exist
if git tag -l "v$TARGET" | grep -q "v$TARGET"; then
  echo "Error: Tag v$TARGET already exists"
  echo "Check: gh release view v$TARGET"
  exit 1
fi

# Check for clean working tree (allow untracked)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: Working tree has uncommitted changes"
  echo "Commit or stash them first"
  exit 1
fi

echo ""
echo "Will release: v$CURRENT → v$TARGET"
echo "  1. Bump package.json"
echo "  2. Commit + tag v$TARGET"
echo "  3. Push to origin main"
echo "  4. CI builds binaries + creates GitHub Release"
echo ""
read -r -p "Proceed? [y/N] " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Aborted"
  exit 0
fi

# 1. Bump version
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$TARGET\"/" "$PKG"
echo "Bumped $PKG to $TARGET"

# 2. Commit + tag
git add "$PKG"
git commit -m "v$TARGET"
git tag "v$TARGET"
echo "Created commit + tag v$TARGET"

# 3. Push
git push origin main --tags
echo "Pushed to origin main with tag v$TARGET"

# 4. Wait for CI
# Match the run to THIS tag — never just grab the latest run. The new tag's
# workflow may not have registered yet, so --limit 1 can return a PREVIOUS
# release's run (already green) and falsely report success (bug #118232).
echo ""
echo "Waiting for release workflow for v$TARGET..."

RUN_ID=""
for _ in $(seq 1 30); do
  RUN_ID=$(gh run list --workflow=release.yml --limit 15 \
    --json databaseId,headBranch \
    --jq "[.[] | select(.headBranch==\"v$TARGET\")] | .[0].databaseId // empty" 2>/dev/null || echo "")
  [ -n "$RUN_ID" ] && break
  sleep 3
done

if [ -z "$RUN_ID" ]; then
  echo "Error: no release workflow for v$TARGET appeared after ~90s."
  echo "Check manually: gh run list --workflow=release.yml"
  exit 1
fi

# Guard: confirm the resolved run really belongs to this tag before trusting it
RUN_BRANCH=$(gh run view "$RUN_ID" --json headBranch --jq '.headBranch' 2>/dev/null || echo "")
if [ "$RUN_BRANCH" != "v$TARGET" ]; then
  echo "Error: run $RUN_ID is for '$RUN_BRANCH', not 'v$TARGET' — refusing to report false success"
  exit 1
fi

echo "Workflow run: https://github.com/$REPO/actions/runs/$RUN_ID"
echo "Watching CI (Ctrl+C to stop watching — release will continue)..."
gh run watch "$RUN_ID" --exit-status || {
  echo ""
  echo "CI failed or was cancelled. Check: gh run view $RUN_ID"
  exit 1
}

# Confirm the GitHub Release + binaries actually exist before declaring victory
ASSET_COUNT=$(gh release view "v$TARGET" --json assets --jq '.assets | length' 2>/dev/null || echo "0")
if [ "$ASSET_COUNT" -lt 1 ]; then
  echo "Error: CI succeeded but release v$TARGET has no assets. Check: gh release view v$TARGET"
  exit 1
fi

echo ""
echo "Release v$TARGET is live! ($ASSET_COUNT assets)"
echo "Run 'iris update' to install."

# 5. Sync dev branch
echo ""
read -r -p "Sync dev branch with main? [y/N] " SYNC
if [ "$SYNC" = "y" ] || [ "$SYNC" = "Y" ]; then
  git checkout dev
  git pull origin dev
  git merge origin/main -m "Sync dev with main after v$TARGET release"
  git push origin dev
  git checkout main
  echo "Dev branch synced"
fi
