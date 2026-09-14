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
BUNDLE_ONLY=0
for a in "$@"; do
  case "$a" in
    --deep) DEEP=1 ;;
    --json) JSON=1 ;;
    # Release-path mode: audit a freshly BUILT bundle on a CI runner, where there is no
    # ~/.iris/bin/iris to compare against. The machine-local checks are named as skipped
    # rather than quietly dropped — a check that vanishes in CI is how a gate becomes
    # decorative without anyone deciding to remove it.
    --bundle-only) BUNDLE_ONLY=1 ;;
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
skip() { record "$1" skipped "$2"; [ "$JSON" -eq 1 ] || printf '  \033[90m-\033[0m %s\n    \033[90mnot applicable: %s\033[0m\n' "$1" "$2"; }
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

# Can this binary be executed here AT ALL?
#
# This matters because an unrunnable binary scores ZERO platform commands — the same
# number upstream scores — so "0" reads as "upstream, as expected" for a bundle that was
# never actually run. On the release path that is a live case: an x86_64 sidecar cannot
# execute on an arm64 runner, and Rosetta does not help, because Bun's x64 builds use AVX2
# which Rosetta 2 does not implement (SIGILL).
#
# A FIRST ATTEMPT AT THIS WAS ITSELF WRONG and passed the falsification test it was meant
# to fail: it asked whether the control probe produced any output, but the probe captures
# 2>&1, so the shell's own "cannot execute" message made the output non-empty and the
# check concluded the probe was fine. Asking "did something come back" cannot distinguish
# an answer from an error about not being able to ask.
#
# So: compare the binary's architecture to the host's (deterministic, no execution — the
# same approach verify-shipped-app.sh already takes), and separately require that the
# process actually starts. 126 = cannot execute, 127 = not found/not a valid executable.
probe_is_meaningful() {
  local bin="$1" barch harch rc
  barch="$(file "$bin" 2>/dev/null | grep -oE 'x86_64|arm64' | head -1)"
  harch="$(uname -m)"
  case "$harch" in aarch64) harch=arm64 ;; amd64) harch=x86_64 ;; esac

  # Not a recognisable native binary for this host.
  [ -n "$barch" ] || return 1
  [ "$barch" = "$harch" ] || return 1

  HOME="$WORK/probe-home" perl -e 'alarm 25; exec @ARGV' "$bin" --version >/dev/null 2>&1
  rc=$?
  [ "$rc" -ne 126 ] && [ "$rc" -ne 127 ]
}

sha() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }
mkdir -p "$WORK/probe-home"

TOTAL=${#PLATFORM_CMDS[@]}

step "1. The CLI on this machine — is it ours?"
if [ "$BUNDLE_ONLY" -eq 1 ]; then
  skip installed_cli_identity "no CLI is installed on a CI runner; this check is for a real machine (or --deep, which installs into an isolated HOME)"
  skip cli_version_series "same — needs an installed CLI to read a version from"
  skip cli_is_not_the_sidecar "same — needs an installed CLI to hash against the bundled sidecar"
elif [ ! -x "$INSTALLED_CLI" ]; then
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
  # A binary that CANNOT BE EXECUTED scores 0 platform commands, which is the same number
  # upstream scores — so "0" would read as "upstream, as expected" for a bundle that was
  # simply never run. That happens for real on the release path: an x86_64 sidecar cannot
  # execute on an arm64 runner (and Rosetta does not help — Bun's x64 builds use AVX2,
  # which Rosetta 2 does not implement, so it dies with SIGILL). Establish that the probe
  # can speak at all before believing what it says.
  if ! probe_is_meaningful "$SIDECAR"; then
    warn sidecar_is_upstream "the sidecar produced NO output for any probe, including the unknown-command control — it could not be executed here (wrong architecture, or not runnable). Its command surface was NOT measured. A count of 0 from an unrunnable binary is indistinguishable from upstream and must not be reported as such."
    SN=""
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
  fi

  # The check that cannot be fooled by a version string: the same bytes.
  if [ "$BUNDLE_ONLY" -eq 1 ]; then
    :
  elif [ -x "$INSTALLED_CLI" ]; then
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
  # Match the RUST MANGLED form, not the bare word. A bare substring grep over a 30MB
  # binary is the anti-pattern the production debugging guide warns about: it reports
  # "present" for any incidental occurrence. Demonstrated by this very check — it PASSED
  # against a 54-byte file whose entire content was the sentence
  #   "not a real app, no cli_state here, no cli_health either"
  # because that sentence contains both words. A check that a paragraph of English can
  # satisfy is not measuring the binary.
  #
  # Rust mangles identifiers with a LENGTH PREFIX, so a real symbol appears as
  # `10cli_health` / `9cli_state` (observed in situ as `de_lib3cli10cli_health`). Prose
  # cannot produce that by accident, and it was verified to score 0 on the same sentence
  # above while scoring 1 on the shipped binary.
  FOUND=0
  for sym in 9cli_state 10cli_health; do
    grep -aqF "$sym" "$APP_BIN" 2>/dev/null && FOUND=$((FOUND + 1))
  done
  if [ "$FOUND" -eq 2 ]; then
    pass app_has_identity_gate "the shipped binary carries the Rust symbols cli_state and cli_health — it gates on IDENTITY, not on a version comparison across two release series"
  else
    fail app_has_identity_gate "found $FOUND of 2 identity-gate symbols (Rust-mangled 9cli_state / 10cli_health) in the shipped binary. This build predates the #184861 fix and will overwrite the CLI on every launch."
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

# A mode that skips everything would exit 0 and mean nothing. Require that at least two
# checks actually produced a verdict.
RAN=0
for r in "${RESULTS[@]}"; do
  st="${r#*|}"; st="${st%%|*}"
  case "$st" in pass|fail) RAN=$((RAN + 1)) ;; esac
done
if [ "$RAN" -lt 2 ]; then
  FAIL=1
  RESULTS+=("audit_actually_ran|fail|only $RAN check(s) produced a verdict — this run measured nothing and must not read as a pass")
  [ "$JSON" -eq 1 ] || printf '  \033[31m✗\033[0m audit_actually_ran\n    \033[91monly %s check(s) produced a verdict — this run measured nothing\033[0m\n' "$RAN"
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
