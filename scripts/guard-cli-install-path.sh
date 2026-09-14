#!/usr/bin/env bash
#
# guard-cli-install-path.sh — a PR gate that refuses the reintroduction of #183738.
#
# The desktop app overwrote the user's `iris` with its own bundled opencode sidecar on
# every launch, for two weeks, on client machines. It was filed three times (#182922,
# #183738, #184861) before anyone found it, because every signal available said the app
# was healthy: it booted, it served, it reported a version, and the file it had clobbered
# existed at the expected path.
#
# Two lines caused it:
#
#     .arg("--binary").arg(sidecar_path)      # install OUR sidecar as the user's CLI
#     if cli_version >= app_version { skip }  # 1.3.252 vs 1.18.60 -> false FOREVER
#
# The second is the subtle one. The CLI ships on the `v1.3.x` line and the desktop on
# `desktop-v1.18.x`. They are independent series, so comparing them as semver is not a
# stale check — it is a check that can never be satisfied, which made the first line run
# on every single launch.
#
# THIS IS A SOURCE GUARD, NOT AN ARTIFACT AUDIT. It runs in seconds on any runner, with no
# macOS host, no build, and no network, and it answers one question: could this tree
# reintroduce the defect? The artifact side — is the SHIPPED binary the product — is
# scripts/verify-cli-identity.sh, which belongs on the release path where a build exists.
#
# Falsified against the real pre-fix code rather than a fixture, because a guard that has
# only ever been run on a healthy tree has not been tested:
#
#     git archive a5533e106 | tar x -C /tmp/prefix      # the commit that shipped the bug
#     scripts/guard-cli-install-path.sh --root /tmp/prefix   -> must FAIL
#
# Usage:
#   scripts/guard-cli-install-path.sh                  # guard this tree
#   scripts/guard-cli-install-path.sh --root <dir>      # guard another checkout
#   scripts/guard-cli-install-path.sh --json
#
set -uo pipefail

ROOT="."
JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    -h|--help) sed -n '2,36p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

CLI_RS="$ROOT/packages/desktop/src-tauri/src/cli.rs"
LOGIN_RS="$ROOT/packages/desktop/src-tauri/src/login.rs"
INSTALL_SH="$ROOT/install"

FAIL=0
RESULTS=()
_esc() { python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().rstrip("\n")))'; }
pass() { RESULTS+=("$1|pass|$2"); [ "$JSON" -eq 1 ] || printf '  \033[32m✓\033[0m %s\n    \033[90m%s\033[0m\n' "$1" "$2"; }
fail() { RESULTS+=("$1|fail|$2"); FAIL=1; [ "$JSON" -eq 1 ] || printf '  \033[31m✗\033[0m %s\n    \033[91m%s\033[0m\n' "$1" "$2"; }

# Strip // and /* */ comments before matching. Otherwise the ADR comments that EXPLAIN the
# deleted flag would themselves trip the guard — the same way a check once matched its own
# comment stating the rule it was checking for.
rust_code() {
  [ -f "$1" ] || return 1
  sed -e 's://.*::' "$1" | perl -0777 -pe 's{/\*.*?\*/}{}gs'
}

# The desktop app lives only on the iris/1.18.x line; `main` owns the CLI and its `install`.
# Both branches carry this script, so the desktop assertions are reported as NOT APPLICABLE
# on a tree with no desktop package rather than failing it — an always-red gate is one
# people learn to ignore, which is worse than not having it.
#
# The installer assertion below still runs on BOTH, deliberately: main's `install` is what
# every curl-pipe user gets, and it is the copy that was missing the read-back (#185159).
# A floor at the end refuses to report success if nothing was actually asserted.
if [ ! -f "$CLI_RS" ]; then
  RESULTS+=("desktop_checks|skipped|no packages/desktop under $ROOT — this tree does not build the app, so the five cli.rs assertions do not apply here. They run on the iris/1.18.x branch, where CI enforces them.")
  [ "$JSON" -eq 1 ] || printf '  \033[90m-\033[0m desktop_checks\n    \033[90mnot applicable: no packages/desktop under this tree; the cli.rs assertions run on the iris/1.18.x branch\033[0m\n' 
else
  CODE="$(rust_code "$CLI_RS")"

  # ── 1. The flag whose deletion WAS the fix ────────────────────────────────
  if printf '%s' "$CODE" | grep -qE '\.arg\(\s*"--binary"'; then
    fail no_binary_flag "cli.rs passes --binary to the installer. That makes it install the app's own bundled sidecar as the user's \`iris\` — a different product answering to the same name, with 0 of the 216 platform command modules and no \`iris mcp serve\`. Deleting this flag is the whole fix (#183738); run the installer without it and the SAME script downloads the real CLI."
  else
    pass no_binary_flag "cli.rs does not pass --binary — it cannot write a non-platform binary to the CLI's path"
  fi

  # ── 2. The comparison that could never be satisfied ───────────────────────
  # Matched as "both identifiers in one comparison", not as a literal string, so a rename
  # or a reformat cannot slip past it.
  if printf '%s' "$CODE" | grep -qE '(cli_version[^;]*(>=|>|<|<=|cmp|partial_cmp)[^;]*app_version|app_version[^;]*(>=|>|<|<=|cmp|partial_cmp)[^;]*cli_version)'; then
    fail no_cross_series_version_gate "cli.rs compares the CLI version to the APP version. These are independent release series (CLI v1.3.x, desktop desktop-v1.18.x), so the comparison is not merely stale — it can never be satisfied, and that is what made the install run on every launch. Gate on IDENTITY (cli_state()) instead; a version number cannot express 'is this the right product'."
  else
    pass no_cross_series_version_gate "no CLI-version-vs-app-version comparison on the install path"
  fi

  # ── 3. The identity gate must exist ───────────────────────────────────────
  MISSING=""
  printf '%s' "$CODE" | grep -qE 'enum\s+CliState' || MISSING="$MISSING CliState"
  printf '%s' "$CODE" | grep -qE 'fn\s+cli_state' || MISSING="$MISSING cli_state()"
  if [ -n "$MISSING" ]; then
    fail identity_gate_exists "cli.rs is missing:$MISSING. Something must be able to answer 'what is actually at ~/.iris/bin/iris' — path.exists() cannot, because a 216-module platform CLI and a core-only sidecar are the same answer to it."
  else
    pass identity_gate_exists "CliState + cli_state() are defined — the app can tell the product from the sidecar"
  fi

  # ── 4. The gate must be USED, not merely defined ──────────────────────────
  # A gate nobody calls is indistinguishable from no gate. This is the shape that let
  # login.rs keep the old behaviour after cli.rs was fixed — CI caught that one (73ec72061),
  # and this assertion is that catch made permanent.
  USES=0
  for f in "$CLI_RS" "$LOGIN_RS"; do
    [ -f "$f" ] || continue
    C="$(rust_code "$f")"
    printf '%s' "$C" | grep -qE 'cli_state\s*\(' && USES=$((USES + 1))
  done
  if [ "$USES" -eq 0 ]; then
    fail identity_gate_is_used "cli_state() is defined but never called in cli.rs or login.rs. A gate nobody calls is not a gate. login.rs called install_cli() directly after cli.rs was fixed, which is exactly this failure (73ec72061)."
  else
    pass identity_gate_is_used "cli_state() is called in $USES of the install-triggering sources"
  fi

  # ── 5. Read back after installing ─────────────────────────────────────────
  if printf '%s' "$CODE" | grep -qE 'cli_state\s*\(\s*\)' && printf '%s' "$CODE" | grep -qE 'NotThePlatformCli'; then
    pass reads_back_after_install "cli.rs inspects cli_state() after installing — a green exit status is not evidence that the product landed"
  else
    fail reads_back_after_install "cli.rs does not read back what it installed. The original bug reported success for two weeks because nothing ever asked the path what it now held."
  fi
fi

# ── 6. The installer needs the same read-back ───────────────────────────────
# The desktop got one when #183738 was fixed; `install` did not, and `install` is what
# every new user runs. Filed and fixed as #185159.
if [ ! -f "$INSTALL_SH" ]; then
  fail installer_reads_back "no ./install under $ROOT"
else
  if grep -qE '^\s*verify_installed_cli\s*\(\)' "$INSTALL_SH"; then
    CALLS=$(grep -cE '^\s*verify_installed_cli(\s|$|\s*\|\|)' "$INSTALL_SH")
    # Both install paths — the download path and --binary — must call it. --binary needs it
    # more: that flag is what caused #183738 in the first place.
    if [ "$CALLS" -ge 2 ]; then
      pass installer_reads_back "install defines verify_installed_cli and calls it from $CALLS install paths"
    else
      fail installer_reads_back "verify_installed_cli is defined but called from only $CALLS path(s); both the download path and the --binary path must verify (#185159)"
    fi
  else
    fail installer_reads_back "./install never verifies the binary it installed. Its only existence check was [ -f \"\$INSTALL_DIR/iris\" ] — the same path.exists() cli.rs documents as unable to fail. A codesign failure is swallowed by '|| true', and on macOS an unsigned binary is SIGKILLed on every run (#185159)."
  fi
fi

# A run where everything was skipped would exit 0 and assert nothing.
RAN=0
for r in "${RESULTS[@]}"; do
  st="${r#*|}"; st="${st%%|*}"
  case "$st" in pass|fail) RAN=$((RAN + 1)) ;; esac
done
if [ "$RAN" -lt 1 ]; then
  FAIL=1
  RESULTS+=("guard_actually_ran|fail|no assertion produced a verdict — this run checked nothing and must not read as a pass")
  [ "$JSON" -eq 1 ] || printf '  \033[31m✗\033[0m guard_actually_ran\n    \033[91mno assertion produced a verdict — this run checked nothing\033[0m\n'
fi

# ── 7. Windows needs the read-back too ──────────────────────────────────────
# install.ps1 had exactly the same gap as install: its only check was
# `Test-Path "$INSTALL_DIR\iris.exe"`, and it never executed what it wrote. Windows has
# the least verification coverage of any platform here, so it needs this most.
INSTALL_PS1="$ROOT/install.ps1"
if [ ! -f "$INSTALL_PS1" ]; then
  RESULTS+=("windows_installer_reads_back|skipped|no install.ps1 under $ROOT")
  [ "$JSON" -eq 1 ] || printf '  \033[90m-\033[0m windows_installer_reads_back\n    \033[90mnot applicable: no install.ps1 under this tree\033[0m\n'
else
  if grep -qE '^\s*function\s+Test-InstalledCli' "$INSTALL_PS1" \
     && grep -qE 'Test-InstalledCli\s+-BinPath' "$INSTALL_PS1"; then
    pass windows_installer_reads_back "install.ps1 defines Test-InstalledCli and calls it before reporting the install"
  else
    fail windows_installer_reads_back "install.ps1 never verifies the binary it installed. Its only check is Test-Path on the destination — the same path.exists() that cannot distinguish the platform CLI from the app's bundled sidecar. Mirror the bash verify_installed_cli (#185159)."
  fi
fi

if [ "$JSON" -eq 1 ]; then
  printf '{"ok":%s,"exitCode":%d,"checks":[' "$([ $FAIL -eq 0 ] && echo true || echo false)" "$FAIL"
  first=1
  for r in "${RESULTS[@]}"; do
    id="${r%%|*}"; rest="${r#*|}"; st="${rest%%|*}"; d="${rest#*|}"
    [ $first -eq 1 ] || printf ','
    first=0
    printf '{"id":"%s","status":"%s","detail":%s}' "$id" "$st" "$(printf '%s' "$d" | _esc)"
  done
  printf ']}\n'
else
  printf '\n'
  if [ $FAIL -eq 0 ]; then
    printf '  \033[32mINSTALL PATH GUARDED\033[0m — this tree cannot reintroduce #183738.\n\n'
  else
    printf '  \033[31mINSTALL PATH REGRESSION\033[0m — see above. This is the defect that uninstalled the\n'
    printf '  product on every app launch, on client machines, for two weeks.\n\n'
  fi
fi
exit $FAIL
