#!/usr/bin/env bash
#
# verify-cli-identity.sh — is the `iris` on this machine OURS, and did the desktop app
# overwrite it with the upstream opencode binary it bundles?
#
# Companion to verify-shipped-app.sh, which proves the app BOOTS AND SERVES. That is a
# necessary check and a blind one for this failure: upstream opencode boots and serves
# too. Every signal that script reads — HTTP 200, a healthy engine, a provider list, a
# version string — is produced identically by the wrong binary. So this script asks the
# one question none of those can answer: WHICH BINARY IS IT.
#
# The bug this exists for (#184861, #183738, #182922 — filed three times):
#
#   The desktop app ran its installer with `--binary <the bundled sidecar>`, which copies
#   the BUNDLED opencode build over ~/.iris/bin/iris. The gate in front of it compared
#   version numbers across two independent release series — CLI v1.3.x against app
#   v1.18.x — so `1.3.252 >= 1.18.60` was false forever and it reinstalled on EVERY
#   LAUNCH. Opening the app uninstalled the product: `iris` became opencode, the platform
#   commands vanished, and the MCP server went with them.
#
# Two things made it survive three filings:
#   · A version comparison cannot detect a DIFFERENT PRODUCT. Identity is not a number.
#   · `path.exists()` on ~/.iris/bin/iris is true for the wrong binary too.
#
# So every check here discriminates by CAPABILITY or by BYTES, never by version alone.
#
# Usage:
#   scripts/verify-cli-identity.sh                 # audit this machine + the app bundle
#   scripts/verify-cli-identity.sh --deep          # …plus download the release and
#                                                  #   run the installer in a sandbox HOME
#   scripts/verify-cli-identity.sh --json          # machine-readable, non-zero on drift
#
set -uo pipefail

REPO="FREELABEL/iris-opencode"
APP="${IRIS_APP:-/Applications/IRIS.app}"
INSTALLED_CLI="${IRIS_CLI:-$HOME/.iris/bin/iris}"
# The commands that exist ONLY in our fork. This list is the identity test; upstream
# opencode has none of them. Keep it small and load-bearing.
PLATFORM_CMDS=(atlas bloqs hive playbook brands)

DEEP=0
JSON=0
for a in "$@"; do
  case "$a" in
    --deep) DEEP=1 ;;
    --json) JSON=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
  esac
done

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
FAIL=0
RESULTS=()

_json_escape() { python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().rstrip("\n")))'; }
record() { RESULTS+=("$1|$2|$3"); }
pass() { record "$1" pass "$2"; [ "$JSON" -eq 1 ] || printf '  \033[32m✓\033[0m %s\n    \033[90m%s\033[0m\n' "$1" "$2"; }
fail() { record "$1" fail "$2"; FAIL=1; [ "$JSON" -eq 1 ] || printf '  \033[31m✗\033[0m %s\n    \033[91m%s\033[0m\n' "$1" "$2"; }
warn() { record "$1" unknown "$2"; FAIL=1; [ "$JSON" -eq 1 ] || printf '  \033[33m?\033[0m %s\n    \033[33m%s\033[0m\n' "$1" "$2"; }
step() { [ "$JSON" -eq 1 ] || printf '\n\033[1m%s\033[0m\n' "$*"; }

# Count how many of our platform commands a binary actually resolves.
#
# THE EXIT CODE IS USELESS HERE, and finding that out is the reason this function looks
# the way it does. Measured 2026-09-13: BOTH our CLI and the upstream sidecar exit 0 for
# `<binary> flurbleglorp --help`. A probe built on exit status reported "all 5 platform
# commands present" for the upstream binary — the check passed on the very artifact it
# exists to reject, and it passed on ours for the same wrong reason.
#
# Nor is a grep over top-level `--help` enough: it answers about the help TEXT, not about
# what the binary can run.
#
# So each command is probed TWICE — once as itself, once as a token that cannot exist —
# and counts as present only if the two outputs DIFFER. A binary without the command
# falls back to the same generic banner for both, which is exactly what upstream does:
#   ours:     `atlas --help`       -> "Atlas OS  namespaced commands (iris atlas:<name>)"
#   upstream: `atlas --help`       -> the opencode ASCII banner
#             `flurbleglorp --help`-> the SAME opencode ASCII banner
# The negative control is inside the check, so the check calibrates itself on every run
# instead of trusting an assumption about how this binary reports an unknown command.
NONSENSE_CMD="zz-not-a-real-command-$$"

platform_cmd_count() {
  local bin="$1" n=0 c
  local control
  control="$(HOME="$WORK/probe-home" perl -e 'alarm 25; exec @ARGV' "$bin" "$NONSENSE_CMD" --help 2>&1 | head -40)"
  for c in "${PLATFORM_CMDS[@]}"; do
    local out
    out="$(HOME="$WORK/probe-home" perl -e 'alarm 25; exec @ARGV' "$bin" "$c" --help 2>&1 | head -40)"
    # Present only if it said something, and something DIFFERENT from the unknown-command
    # fallback. Equal output means the binary does not distinguish this command from
    # gibberish, i.e. it does not have it.
    if [ -n "$out" ] && [ "$out" != "$control" ]; then
      n=$((n + 1))
    fi
  done
  echo "$n"
}

# Report whether the twice-probe can discriminate at all on this binary. If a binary
# returns EMPTY for everything, "differs" is meaningless and the count would read 0 —
# indistinguishable from upstream. Say so rather than concluding.
probe_is_meaningful() {
  local bin="$1" control
  control="$(HOME="$WORK/probe-home" perl -e 'alarm 25; exec @ARGV' "$bin" "$NONSENSE_CMD" --help 2>&1 | head -40)"
  [ -n "$control" ]
}

sha() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }
mkdir -p "$WORK/probe-home"

TOTAL=${#PLATFORM_CMDS[@]}

step "1. The CLI on this machine — is it ours?"
if [ ! -x "$INSTALLED_CLI" ]; then
  warn installed_cli_present "no executable at $INSTALLED_CLI — nothing to audit; install the CLI first"
else
  N="$(platform_cmd_count "$INSTALLED_CLI")"
  V="$(perl -e 'alarm 25; exec @ARGV' "$INSTALLED_CLI" --version 2>/dev/null | head -1 | tr -d '\r')"
  if [ "$N" -eq "$TOTAL" ]; then
    pass installed_cli_identity "resolves all $TOTAL platform commands (${PLATFORM_CMDS[*]}) — version $V"
  elif [ "$N" -eq 0 ]; then
    fail installed_cli_identity "resolves ZERO platform commands — version $V. This is the upstream opencode binary. The desktop app has overwritten the product (#184861)."
  else
    fail installed_cli_identity "resolves only $N of $TOTAL platform commands — version $V. A partial build, which is neither ours nor upstream; do not trust it."
  fi

  # The version SERIES is the tell that the semver gate missed. Two independent release
  # lines share this repo: the CLI ships v1.3.x, the desktop ships desktop-v1.18.x. A CLI
  # reporting 1.18.x is the app's own version, i.e. the sidecar wearing the CLI's path.
  case "$V" in
    1.3.*)  pass cli_version_series "version $V is on the CLI series (1.3.x)" ;;
    1.18.*) fail cli_version_series "version $V is on the DESKTOP series (1.18.x). The CLI ships 1.3.x — this is the app's bundled sidecar sitting at the CLI's path." ;;
    "")     warn cli_version_series "the binary produced no version output" ;;
    *)      warn cli_version_series "version $V is on neither known series (CLI 1.3.x / desktop 1.18.x)" ;;
  esac
fi

step "2. The app's bundled sidecar — and whether it IS the installed CLI"
SIDECAR=""
if [ -d "$APP" ]; then
  SIDECAR="$(find "$APP/Contents/MacOS" -maxdepth 1 -type f -name 'iris-cli*' 2>/dev/null | head -1)"
fi
if [ -z "$SIDECAR" ]; then
  warn sidecar_present "no sidecar found under $APP/Contents/MacOS — is the app installed?"
else
  SN="$(platform_cmd_count "$SIDECAR")"
  SV="$(perl -e 'alarm 25; exec @ARGV' "$SIDECAR" --version 2>/dev/null | head -1 | tr -d '\r')"
  # This is DOCUMENTED expected state, not a defect: the app bundles upstream for its own
  # internal engine. The check exists so that if it ever changes, we find out here rather
  # than by inference during an incident.
  if [ "$SN" -eq 0 ]; then
    pass sidecar_is_upstream "bundled sidecar has 0 platform commands (upstream, version $SV) — expected; it serves the app's engine, it is NOT the product CLI"
  else
    warn sidecar_is_upstream "bundled sidecar now resolves $SN platform commands (version $SV). That assumption changed; re-read cli.rs before trusting any check below."
  fi

  # The check that cannot be fooled by a version string: the same bytes.
  if [ -x "$INSTALLED_CLI" ]; then
    A="$(sha "$INSTALLED_CLI")"; B="$(sha "$SIDECAR")"
    if [ -n "$A" ] && [ "$A" = "$B" ]; then
      fail cli_is_not_the_sidecar "$INSTALLED_CLI and the bundled sidecar are BYTE-IDENTICAL (sha256 ${A:0:12}…). The app has copied its sidecar over the product CLI."
    else
      pass cli_is_not_the_sidecar "installed CLI (${A:0:12}…) and sidecar (${B:0:12}…) are different binaries"
    fi
  fi
fi

step "3. Does the shipped app contain the identity gate, or the version compare?"
APP_BIN="$APP/Contents/MacOS/IRIS"
if [ ! -f "$APP_BIN" ]; then
  warn app_has_identity_gate "no app binary at $APP_BIN"
else
  # DO NOT USE macOS `strings` FOR THIS. Apple's strings skips sections even with -a:
  # measured 2026-09-13, `strings -a IRIS | grep -cF cli_health` returned 0 while
  # `grep -aoF cli_health IRIS` returned 1 on the same file. A symbol reported absent by
  # macOS strings is not evidence of absence, and reading it that way nearly produced the
  # conclusion that a shipped fix was missing.
  FOUND=0
  for sym in cli_state cli_health; do
    grep -aqF "$sym" "$APP_BIN" 2>/dev/null && FOUND=$((FOUND + 1))
  done
  if [ "$FOUND" -eq 2 ]; then
    pass app_has_identity_gate "the shipped binary contains cli_state and cli_health — it gates on IDENTITY, not on a version comparison across two release series"
  else
    fail app_has_identity_gate "found $FOUND of 2 identity-gate symbols (cli_state, cli_health) in the shipped binary. This build predates the #184861 fix and will overwrite the CLI on every launch."
  fi
fi

step "4. Is the published CLI release asset actually our CLI?"
# The release could be green, signed, downloadable and be the wrong build. Nothing upstream
# of here checks that the bytes on the release page carry the platform commands.
if ! command -v gh >/dev/null 2>&1; then
  warn release_asset_identity "gh is not installed — cannot audit the published release"
else
  TAG="$(perl -e 'alarm 40; exec @ARGV' gh release list --repo "$REPO" --limit 30 --json tagName \
        --jq '[.[] | select(.tagName | startswith("v1."))] | .[0].tagName' 2>/dev/null)"
  if [ -z "$TAG" ] || [ "$TAG" = "null" ]; then
    warn release_asset_identity "could not resolve the newest v1.* CLI release"
  elif [ "$DEEP" -eq 0 ]; then
    pass release_asset_identity "newest CLI release is $TAG (pass --deep to download it and verify its capabilities)"
  else
    HOST_OS=darwin; case "$(uname -m)" in arm64|aarch64) HOST_ARCH=arm64 ;; *) HOST_ARCH=x64 ;; esac
    # The pattern must name the CLI asset EXACTLY. This release tag carries two artifact
    # families — iris-darwin-arm64.zip (the CLI) and IRIS-app-darwin-arm64.zip (the desktop
    # app) — and a glob of "*darwin-arm64*" matches the app first, whose bundle contains no
    # bare executable. The check then reported "found no executable", which reads as a
    # broken release rather than a wrong pattern.
    if perl -e 'alarm 240; exec @ARGV' gh release download "$TAG" --repo "$REPO" \
         --pattern "iris-${HOST_OS}-${HOST_ARCH}.zip" --dir "$WORK/rel" >/dev/null 2>&1; then
      ARC="$(find "$WORK/rel" -type f | head -1)"
      mkdir -p "$WORK/relx"
      case "$ARC" in
        *.zip) unzip -q -o "$ARC" -d "$WORK/relx" ;;
        *.tar.gz|*.tgz) tar xzf "$ARC" -C "$WORK/relx" ;;
        *) cp "$ARC" "$WORK/relx/iris" ;;
      esac
      RB="$(find "$WORK/relx" -type f \( -name iris -o -name 'iris-*' -o -name opencode \) -perm +111 2>/dev/null | head -1)"
      if [ -z "$RB" ]; then
        warn release_asset_identity "downloaded $TAG but found no executable inside $(basename "$ARC")"
      else
        chmod +x "$RB"
        RN="$(platform_cmd_count "$RB")"
        if [ "$RN" -eq "$TOTAL" ]; then
          pass release_asset_identity "$TAG's published binary resolves all $TOTAL platform commands — the release carries the product"
        else
          fail release_asset_identity "$TAG's PUBLISHED binary resolves only $RN of $TOTAL platform commands. The release page is serving the wrong build; every fresh install gets it."
        fi
      fi
    else
      warn release_asset_identity "could not download a ${HOST_OS}-${HOST_ARCH} asset from $TAG"
    fi
  fi
fi

step "5. Behavioural test: run the installer the way the app does, in a sandbox HOME"
# The only check that reproduces the actual defect end to end. Everything above inspects
# artifacts; this one performs the operation that broke and then asks what it produced.
# HOME is redirected, so the real ~/.iris/bin/iris is never touched — install.sh resolves
# INSTALL_DIR=$HOME/.iris/bin.
if [ "$DEEP" -eq 0 ]; then
  [ "$JSON" -eq 1 ] || printf '    \033[90mskipped — pass --deep to run it\033[0m\n'
else
  SANDBOX="$WORK/sandbox-home"; mkdir -p "$SANDBOX"
  # The file is `install`, with NO extension — cli.rs embeds it as
  # include_str!("../../../../install"). Fetching install.sh 404s, and a 404 through
  # `curl -fsSL` is silent, so this check reported "could not fetch" for a file that was
  # never named that.
  if perl -e 'alarm 90; exec @ARGV' curl -fsSL -o "$WORK/install.sh" \
       "https://raw.githubusercontent.com/$REPO/main/install" 2>/dev/null; then
    # NO --binary. That flag is what made the app install its own sidecar; the same script
    # without it downloads the real CLI from the v* release.
    if HOME="$SANDBOX" perl -e 'alarm 600; exec @ARGV' bash "$WORK/install.sh" \
         >"$WORK/install.log" 2>&1; then
      SB="$SANDBOX/.iris/bin/iris"
      if [ ! -x "$SB" ]; then
        fail fresh_install_yields_product "the installer exited 0 but produced no executable at \$HOME/.iris/bin/iris"
      else
        FN="$(platform_cmd_count "$SB")"
        FV="$(perl -e 'alarm 25; exec @ARGV' "$SB" --version 2>/dev/null | head -1 | tr -d '\r')"
        if [ "$FN" -eq "$TOTAL" ]; then
          pass fresh_install_yields_product "a clean install into an isolated HOME produced version $FV with all $TOTAL platform commands"
        else
          fail fresh_install_yields_product "a clean install produced version $FV with only $FN of $TOTAL platform commands — new users are getting the wrong binary"
        fi
      fi
    else
      fail fresh_install_yields_product "the installer failed in a sandbox HOME (exit non-zero). Tail: $(tail -3 "$WORK/install.log" | tr '\n' ' ')"
    fi
  else
    warn fresh_install_yields_product "could not fetch install.sh from $REPO main"
  fi
fi

if [ "$JSON" -eq 1 ]; then
  {
    printf '{"ok":%s,"exitCode":%d,"checks":[' "$([ $FAIL -eq 0 ] && echo true || echo false)" "$FAIL"
    first=1
    for r in "${RESULTS[@]}"; do
      id="${r%%|*}"; rest="${r#*|}"; st="${rest%%|*}"; detail="${rest#*|}"
      [ $first -eq 1 ] || printf ','
      first=0
      printf '{"id":"%s","status":"%s","detail":%s}' "$id" "$st" "$(printf '%s' "$detail" | _json_escape)"
    done
    printf ']}\n'
  }
else
  printf '\n'
  if [ $FAIL -eq 0 ]; then
    printf '  \033[32mCLI IDENTITY VERIFIED\033[0m — the iris on this machine is the product, and the app is not overwriting it.\n\n'
  else
    printf '  \033[31mCLI IDENTITY DRIFT\033[0m — see the failures above.\n'
    printf '  \033[90mNote: "it boots and serves" cannot detect this. Upstream opencode boots and serves too.\033[0m\n\n'
  fi
fi
exit $FAIL
