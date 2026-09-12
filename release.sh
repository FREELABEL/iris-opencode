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

# ─────────────────────────────────────────────────────────────────────────────
# THE VERSION COMES FROM THE TAG. package.json is DERIVED.
#
# This script used to compute the next version from package.json, and that one
# line produced thirteen releases' worth of drift:
#
#   package.json said 1.3.237   ·   the live tag was v1.3.250
#
# Every tag from v1.3.238 to v1.3.250 was cut on a commit where package.json
# still read 1.3.237. It is not the source of truth and never was — the release
# workflow derives the shipped version from the tag itself
# (`version=${GITHUB_REF#refs/tags/v}` in .github/workflows/release.yml), so the
# binary the world installs is named by the tag no matter what this file says.
#
# And the drift was SELF-REINFORCING. Reading the stale number made `--patch`
# compute 1.3.238, which already existed, so the script aborted with "Tag already
# exists" — and the only way to ship became tagging by hand, which skipped the
# bump, which widened the drift. The workaround was the cause.
#
# So: read the highest tag that actually exists ON THE REMOTE, and write
# package.json to match as an output. Local tags are not consulted — a checkout
# that has not fetched (this one had only `vscode-*` tags) would otherwise
# "discover" a much lower version and confidently reissue a released number.
# ─────────────────────────────────────────────────────────────────────────────

# Must run from repo root
if [ ! -f "$PKG" ]; then
  echo "Error: Run from the iris-opencode repo root"
  exit 1
fi

CHECK_ONLY=false
ASSUME_YES=false
ARGS=()
for a in "$@"; do
  case "$a" in
    --check) CHECK_ONLY=true ;;
    --yes|-y) ASSUME_YES=true ;;
    *) ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

# The authoritative current version: what GitHub publishes as the LATEST RELEASE.
#
# NOT "the highest tag". This repo is a fork and still carries the upstream tag
# lineages — 0.0.x through 1.18.x — so a naive semver sort answers 1.18.23, which
# no one has ever installed. My first attempt at this fix did exactly that and
# reported the drift as MINUS 214 patches, which is the only reason it got caught.
#
# The latest GitHub Release is the number `iris update` resolves and the number
# `iris --version` prints on an installed binary, so it is the one the world means.
LIVE=$(gh release view --repo "$REPO" --json tagName --jq '.tagName' 2>/dev/null | sed 's/^v//')

if [ -z "$LIVE" ]; then
  # Refusing is the only safe answer. Guessing from package.json is the bug this
  # rewrite removes; guessing from the tag list picks a lineage nobody ships.
  echo "Error: could not read the latest release from GitHub — refusing to guess a version."
  echo "  Check: gh auth status, then re-run. To override: ./release.sh <explicit-version>"
  exit 2
fi

PKG_VERSION=$(grep '"version"' "$PKG" | head -1 | sed 's/.*"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/')
IFS='.' read -r MAJOR MINOR PATCH <<< "$LIVE"

echo "Live version (latest published release): $LIVE"
if [ "$PKG_VERSION" != "$LIVE" ]; then
  if [ "${LIVE%.*}" = "${PKG_VERSION%.*}" ]; then
    echo "  package.json says $PKG_VERSION — DRIFTED by $(( 10#${LIVE##*.} - 10#${PKG_VERSION##*.} )) release(s); it will be corrected."
  else
    echo "  package.json says $PKG_VERSION — a different line entirely; it will be corrected to the released value."
  fi
fi

if [ "$CHECK_ONLY" = true ]; then
  if [ "$PKG_VERSION" = "$LIVE" ]; then
    echo "In sync. Next --patch would be $MAJOR.$MINOR.$((PATCH + 1))."
  else
    echo "Drifted. Next --patch would still be $MAJOR.$MINOR.$((PATCH + 1)) — computed from the TAG, not package.json."
  fi
  exit 0
fi

# Determine target version
ARG="${1:-}"
if [ -z "$ARG" ]; then
  echo "Usage: ./release.sh [version|--patch|--minor|--major] [--check] [--yes]"
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

# An explicit version must still be AHEAD of what is live. Reissuing a released
# number silently republishes it to everyone running `iris update`.
if [ "$(printf '%s\n%s\n' "$LIVE" "$TARGET" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" != "$TARGET" ] || [ "$TARGET" = "$LIVE" ]; then
  echo "Error: $TARGET is not ahead of the live version $LIVE"
  exit 1
fi

# Must be on main
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  echo "Error: Must be on main branch (currently on '$BRANCH')"
  echo "  Note: this repo's GitHub DEFAULT branch is 'dev', but releases are cut from main."
  exit 1
fi

# Check the tag does not already exist, locally or on the remote
if git ls-remote --tags "https://github.com/$REPO.git" "refs/tags/v$TARGET" 2>/dev/null | grep -q .; then
  echo "Error: Tag v$TARGET already exists on the remote"
  exit 1
fi

# ONLY package.json needs to be clean — not the whole tree.
#
# Several sessions share this checkout and it is essentially never fully clean.
# Demanding a spotless tree is what pushed people to tag by hand. The tag points
# at HEAD, so uncommitted work elsewhere is not in the release either way; the
# one file that MUST be unmodified is the one this script is about to write, so
# another session's edit to it cannot be swept into the release commit.
if ! git diff --quiet -- "$PKG" || ! git diff --cached --quiet -- "$PKG"; then
  echo "Error: $PKG has uncommitted changes — commit or stash just that file first."
  echo "  (Other dirty files are fine: the tag points at HEAD, which does not include them.)"
  git --no-pager diff --stat -- "$PKG"
  exit 1
fi

echo ""
echo "Will release: v$LIVE → v$TARGET"
echo "  1. Write package.json to $TARGET (derived from the tag, not the source of it)"
echo "  2. Commit that ONE file + tag v$TARGET"
echo "  3. Push to origin main"
echo "  4. CI builds binaries + creates the GitHub Release"
echo ""
if [ "$ASSUME_YES" != true ]; then
  # A prompt with no terminal hangs forever and takes the release with it, so only
  # ask when someone is actually there to answer.
  if [ -t 0 ]; then
    read -r -p "Proceed? [y/N] " CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
      echo "Aborted"
      exit 0
    fi
  else
    echo "Error: no terminal to confirm on. Re-run with --yes if that is what you intend."
    exit 1
  fi
fi

# 1. Bump version
sed -i '' "s/\"version\": \"$PKG_VERSION\"/\"version\": \"$TARGET\"/" "$PKG"
if ! grep -q "\"version\": \"$TARGET\"" "$PKG"; then
  echo "Error: failed to write $TARGET into $PKG (it said $PKG_VERSION) — nothing tagged."
  exit 1
fi
echo "Wrote $PKG = $TARGET"

# 2. Commit + tag — EXPLICIT PATHSPEC.
#
# `git add "$PKG"` followed by a bare `git commit` commits the whole INDEX, and in
# a checkout several sessions share that has repeatedly swept other people's staged
# work into an unrelated commit. Naming the path confines it to this file.
git commit -q -m "v$TARGET" -- "$PKG"
git tag "v$TARGET"
echo "Created commit + tag v$TARGET"

# 3. Push
#
# Re-check RIGHT BEFORE pushing. Two releases cut minutes apart is not theoretical
# here — `v1.3.230 — 229 taken by a concurrent release` is in this repo's history.
# The window between the check above and this push is where that happens.
if git ls-remote --tags "https://github.com/$REPO.git" "refs/tags/v$TARGET" 2>/dev/null | grep -q .; then
  echo "Error: v$TARGET was published by someone else while this ran. Nothing pushed."
  echo "  Undo locally:  git tag -d v$TARGET && git reset --hard HEAD~1   (only if HEAD is still your bump)"
  exit 1
fi
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

# gh run watch's exit code conflates a dropped watch stream (transient network /
# auth blip) with an actual CI failure (bug #157631 — false failure on v1.3.112,
# where a 'HTTP 401 Bad credentials' / 'connection reset by peer' on the watch
# aborted a perfectly healthy release and skipped the dev sync below). Treat the
# watch as best-effort live output only; derive the real verdict below.
#
# GROUND TRUTH = the published GitHub Release with assets. CI creates it ONLY on
# success (the final `release` job), so it is the single most authoritative signal
# and it survives the run status/conclusion API queries flaking. (v1.3.116 false-
# failed here: those queries returned empty 'unknown' for 30 min while the release
# had actually published — so we now trust the release itself, then fall back to
# the run status/conclusion, and only fail after the deadline AND no release.)
release_published () {
  [ "$(gh release view "v$TARGET" --json assets --jq '.assets | length' 2>/dev/null || echo 0)" -ge 1 ]
}
WATCH_DEADLINE=$(( $(date +%s) + 1800 ))   # 30 min hard cap
RUN_CONCLUSION=""
while :; do
  # Live progress; ignore its exit code (may drop early on a network blip).
  gh run watch "$RUN_ID" --exit-status >/dev/null 2>&1 || true

  # 1) Ground truth: the release published with assets → success, done.
  if release_published; then RUN_CONCLUSION=success; break; fi

  # 2) Else consult the run's own status (retry the query on transient errors).
  RUN_STATUS=""
  for _ in 1 2 3 4 5; do
    RUN_STATUS=$(gh run view "$RUN_ID" --json status --jq '.status' 2>/dev/null) \
      && [ -n "$RUN_STATUS" ] && break
    sleep 5
  done
  if [ "$RUN_STATUS" = "completed" ]; then
    RUN_CONCLUSION=$(gh run view "$RUN_ID" --json conclusion --jq '.conclusion' 2>/dev/null || echo "")
    break
  fi

  if [ "$(date +%s)" -ge "$WATCH_DEADLINE" ]; then
    # Last-chance ground-truth check before giving up (queries may have flaked).
    if release_published; then RUN_CONCLUSION=success; break; fi
    echo "Error: run $RUN_ID still '${RUN_STATUS:-unknown}' after 30 min and no v$TARGET release published. Check: gh run view $RUN_ID"
    exit 1
  fi
  echo "  …CI ${RUN_STATUS:-unreachable}; re-checking in 15s (watch will resume)"
  sleep 15
done

if [ "$RUN_CONCLUSION" != "success" ]; then
  echo ""
  echo "CI concluded '${RUN_CONCLUSION:-unknown}' (not success). Check: gh run view $RUN_ID"
  exit 1
fi

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
SYNC=n
if [ "$ASSUME_YES" = true ]; then
  SYNC=y
elif [ -t 0 ]; then
  read -r -p "Sync dev branch with main? [y/N] " SYNC
else
  echo "(no terminal — skipping dev sync; run: git checkout dev && git merge origin/main && git push origin dev)"
fi
if [ "$SYNC" = "y" ] || [ "$SYNC" = "Y" ]; then
  git checkout dev
  git pull origin dev
  git merge origin/main -m "Sync dev with main after v$TARGET release"
  git push origin dev
  git checkout main
  echo "Dev branch synced"
fi
