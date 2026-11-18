#!/usr/bin/env bash
# The exit check for the epic "Hive without Tailscale" (Atlas board #833, epic #191642, task 1.1 #191649).
#
#   scripts/hive-without-tailscale-check.sh <nodeA> <nodeB>        # exit 0 = the epic is done
#
# Run it ON nodeA. Every check goes from A to B. Six checks, one line each, PASS or FAIL with the
# reason. A check whose feature does not exist yet FAILS, naming what is missing — it never skips.
#
#   1 run      `iris hive run B 'echo <nonce>'` works AND our servers cannot read it
#   2 ssh      `iris hive ssh B -- true` works without Tailscale (and says it went via the relay)
#   3 fs       a 100 MB file AND a directory round-trip through `iris hive fs push|pull`, sha256-equal
#   4 port     a localhost-only web app on B is reachable from A, and refused for a non-member
#   5 desktop  B's screen-sharing port (VNC 5900 on macOS, RDP 3389 on Windows) is relayed to A
#   6 keys     B's device key has an expiry, and a revoked device key is refused within 60 s
#
# "WITHOUT TAILSCALE". The script exports IRIS_HIVE_NO_TAILSCALE=1, which the CLI under test
# honours: no tailnet address, cached tailnet address or Tailscale peer lookup is used for any
# transport. That lets the check run today between two machines that DO have Tailscale (and whose
# Tailscale must stay up — it carries the operator's own SSH). It is not the acceptance run.
#
#   ACCEPTANCE RUN: a client-shaped pair — two Hive nodes on different networks with Tailscale
#   STOPPED on both (`tailscale down`, or never installed). Set HWT_REQUIRE_NO_TAILSCALE=1 to make
#   the script refuse to report "done" while Tailscale is running on this machine.
#
# Environment:
#   IRIS                    the CLI under test (default: iris on PATH)
#   HWT_REQUIRE_NO_TAILSCALE=1  FAIL the preflight if Tailscale is up on A (use for acceptance)
#   HWT_NONMEMBER_HOME      a HOME whose ~/.iris / auth belongs to an IRIS account that is NOT a
#                           member of B's Hive — check 4's "refused for a non-member" half
#   HWT_FS_MB               size of the big file for check 3 (default 100)
#   HWT_ONLY                run only these checks, e.g. "2" or "1 2" (still exits 1 if any fail)
#   HWT_TIMEOUT             per-step timeout in seconds (default 180)
#
# Interfaces that do not exist yet are named at the top of each check; the phase that builds the
# feature may change the name, and must change it HERE in the same PR.
set -u

A="${1:-}"; B="${2:-}"
if [ -z "$A" ] || [ -z "$B" ]; then
  echo "usage: $0 <nodeA> <nodeB>   (run on nodeA)" >&2
  exit 2
fi
IRIS="${IRIS:-iris}"
T="${HWT_TIMEOUT:-180}"
FS_MB="${HWT_FS_MB:-100}"
export IRIS_HIVE_NO_TAILSCALE=1
WORK="$(mktemp -d "${TMPDIR:-/tmp}/hwt.XXXXXX")"
NONCE="hwt-$(date +%s)-$RANDOM$RANDOM"
REMOTE_DIR="hwt-check-$NONCE"           # relative to B's home
trap 'rm -rf "$WORK"' EXIT

PASSED=0; FAILED=0
pass() { printf '  PASS  %-8s %s\n' "$1" "$2"; PASSED=$((PASSED + 1)); }
fail() { printf '  FAIL  %-8s %s\n' "$1" "$2"; FAILED=$((FAILED + 1)); }
want() { [ -z "${HWT_ONLY:-}" ] || [[ " $HWT_ONLY " == *" $1 "* ]]; }
# yargs prints the parent's help (exit 0) for an unknown subcommand, so "exists" = its own usage line.
has_cmd() { "$IRIS" "$@" --help 2>/dev/null | head -1 | grep -q "^iris $*\b"; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
tree_sha() { (cd "$1" && find . -type f | LC_ALL=C sort | while read -r f; do printf '%s  %s\n' "$(sha "$f")" "$f"; done) | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1; }
# the last line that is a statement, not an indented hint under it
last() { tr -d '\r' | grep -v '^\s*$' | { grep -v '^\s' || true; } | tail -1 | cut -c1-160; }
# run on B through the Hive (not ssh) — for setup/cleanup only, never as the thing being checked
on_b() { timeout "$T" "$IRIS" hive run "$B" "$1" >"$WORK/on_b.out" 2>&1; }

echo "hive-without-tailscale-check  A=$A  B=$B  cli=$("$IRIS" --version 2>/dev/null | head -1)  $(date -u +%FT%TZ)"

# ── preflight ────────────────────────────────────────────────────────────────────────────────
ts_up=no
if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then ts_up=yes; fi
if [ "$ts_up" = yes ]; then
  if [ "${HWT_REQUIRE_NO_TAILSCALE:-0}" = 1 ]; then
    echo "  FAIL  preflight Tailscale is running on this machine — the acceptance run needs it stopped"
    exit 1
  fi
  echo "  note  Tailscale is UP on this machine; the CLI is told to ignore it (IRIS_HIVE_NO_TAILSCALE=1)."
  echo "        This is a development run, not the acceptance run (Tailscale stopped on both nodes)."
fi
me=$(curl -s -m 2 http://localhost:3200/health 2>/dev/null | sed -n 's/.*"node_name":"\([^"]*\)".*/\1/p' | head -1)
if [ -n "$me" ] && [ "$me" != "$A" ]; then
  echo "  FAIL  preflight this machine's daemon says it is \"$me\", not \"$A\" — run the check on $A"
  exit 1
fi

# ── 1 run: works, and our servers cannot read it ─────────────────────────────────────────────
# Today the platform stores a task's prompt and output in plaintext. The check reads back what
# the SERVER holds (iris hive tasks get) and looks for the nonce.
if want 1; then
  if timeout "$T" "$IRIS" hive run "$B" "echo $NONCE" --json >"$WORK/run.json" 2>"$WORK/run.err"; then
    id=$(grep -o '"id": *"[0-9a-f-]\{36\}"' "$WORK/run.json" | head -1 | grep -o '[0-9a-f-]\{36\}')
    if ! grep -q "$NONCE" "$WORK/run.json"; then
      fail run "the command ran but its output did not come back (task ${id:-?})"
    elif [ -z "$id" ]; then
      fail run "no task id in --json output — cannot check what the server stored"
    else
      timeout 60 "$IRIS" hive tasks get "$id" >"$WORK/task.txt" 2>&1
      if grep -q "$NONCE" "$WORK/task.txt"; then
        fail run "works, but the server holds the command/output in PLAINTEXT (task $id contains the nonce) — Phase 2.2"
      else
        pass run "works; the server's copy of task $id does not contain the command or output"
      fi
    fi
  else
    fail run "iris hive run $B failed: $(last <"$WORK/run.err")"
  fi
fi

# ── 2 ssh: an interactive shell, no Tailscale ────────────────────────────────────────────────
if want 2; then
  if timeout "$T" "$IRIS" hive ssh "$B" -- echo "$NONCE" </dev/null >"$WORK/ssh.out" 2>"$WORK/ssh.err"; then
    if ! grep -q "$NONCE" "$WORK/ssh.out"; then
      fail ssh "exit 0 but the remote command's output is missing"
    elif ! grep -qi "via relay" "$WORK/ssh.err"; then
      fail ssh "connected, but not through the Hive relay ($(last <"$WORK/ssh.err")) — a Tailscale path leaked in"
    elif ! timeout "$T" "$IRIS" hive ssh "$B" -- true </dev/null >/dev/null 2>&1; then
      fail ssh "'iris hive ssh $B -- true' did not exit 0"
    else
      pass ssh "iris hive ssh $B -- true over the Hive relay ($(grep -i 'via relay' "$WORK/ssh.err" | last))"
    fi
  else
    fail ssh "iris hive ssh $B without Tailscale: $( (cat "$WORK/ssh.err" "$WORK/ssh.out") | last)"
  fi
fi

# ── 3 fs: 100 MB file + a directory, sha256 end to end ───────────────────────────────────────
if want 3; then
  mkdir -p "$WORK/up/dir/sub" "$WORK/down"
  head -c $((FS_MB * 1024 * 1024)) /dev/urandom >"$WORK/up/big.bin"
  echo "$NONCE a" >"$WORK/up/dir/a.txt"; echo "$NONCE b" >"$WORK/up/dir/sub/b.txt"; head -c 65536 /dev/urandom >"$WORK/up/dir/sub/c.bin"
  why=""
  if ! timeout "$T" "$IRIS" hive fs push "$B" "$WORK/up/big.bin" --to "~/$REMOTE_DIR" >"$WORK/fs1" 2>&1; then
    why="push of the ${FS_MB} MB file failed: $(last <"$WORK/fs1")"
  elif ! timeout "$T" "$IRIS" hive fs pull "$B" "~/$REMOTE_DIR/big.bin" --out "$WORK/down" >"$WORK/fs2" 2>&1; then
    why="pull of the ${FS_MB} MB file failed: $(last <"$WORK/fs2")"
  elif [ "$(sha "$WORK/up/big.bin")" != "$(sha "$WORK/down/big.bin" 2>/dev/null)" ]; then
    why="the ${FS_MB} MB file came back with a different sha256"
  elif ! timeout "$T" "$IRIS" hive fs push "$B" "$WORK/up/dir" --to "~/$REMOTE_DIR" >"$WORK/fs3" 2>&1; then
    why="the file works; pushing a DIRECTORY failed: $(last <"$WORK/fs3")"
  elif ! timeout "$T" "$IRIS" hive fs pull "$B" "~/$REMOTE_DIR/dir" --out "$WORK/down" >"$WORK/fs4" 2>&1; then
    why="the file works; pulling a DIRECTORY failed: $(last <"$WORK/fs4")"
  elif [ "$(tree_sha "$WORK/up/dir")" != "$(tree_sha "$WORK/down/dir" 2>/dev/null)" ]; then
    why="the directory came back different (file list or sha256)"
  fi
  on_b "rm -rf \"\$HOME/$REMOTE_DIR\"" || true
  if [ -z "$why" ]; then pass fs "${FS_MB} MB file and a directory round-tripped, sha256-equal"; else fail fs "$why"; fi
fi

# ── 4 port: a private port, members only ─────────────────────────────────────────────────────
# Interface (Phase 1.4 decides; change it here if it does): on A,
#   iris hive port <node> <remote-port> --local <local-port>   forwards B's 127.0.0.1:<remote-port>
# The relay must check membership BEFORE any byte reaches B.
if want 4; then
  if ! has_cmd hive port; then
    fail port "no 'iris hive port' (private port forward, the 'tailscale serve' equivalent) — Phase 1.4"
  else
    RP=$((20000 + RANDOM % 20000)); LP=$((20000 + RANDOM % 20000))
    on_b "mkdir -p \"\$HOME/$REMOTE_DIR/www\" && echo $NONCE > \"\$HOME/$REMOTE_DIR/www/token\" && cd \"\$HOME/$REMOTE_DIR/www\" && (nohup python3 -m http.server $RP --bind 127.0.0.1 >/dev/null 2>&1 & echo \$! > ../www.pid)"
    "$IRIS" hive port "$B" "$RP" --local "$LP" >"$WORK/port.log" 2>&1 & FP=$!
    got=""; for _ in $(seq 1 30); do got=$(curl -s -m 3 "http://127.0.0.1:$LP/token" 2>/dev/null); [ -n "$got" ] && break; sleep 1; done
    kill "$FP" 2>/dev/null
    if [ "$got" != "$NONCE" ]; then
      fail port "B's localhost:$RP was not reachable from A through 'iris hive port' ($(last <"$WORK/port.log"))"
    elif [ -z "${HWT_NONMEMBER_HOME:-}" ]; then
      fail port "reachable by a member; the non-member half was not run — set HWT_NONMEMBER_HOME to a non-member's HOME"
    else
      LP2=$((LP + 1))
      HOME="$HWT_NONMEMBER_HOME" "$IRIS" hive port "$B" "$RP" --local "$LP2" >"$WORK/port2.log" 2>&1 & FP=$!
      sleep 8; leak=$(curl -s -m 3 "http://127.0.0.1:$LP2/token" 2>/dev/null); kill "$FP" 2>/dev/null
      if [ "$leak" = "$NONCE" ]; then fail port "a NON-MEMBER reached B's private port"; else pass port "member reached B's localhost:$RP; a non-member was refused"; fi
    fi
    on_b "kill \$(cat \"\$HOME/$REMOTE_DIR/www.pid\") 2>/dev/null; rm -rf \"\$HOME/$REMOTE_DIR\"" || true
  fi
fi

# ── 5 desktop: the screen-sharing port relayed ───────────────────────────────────────────────
# Interface (Phase 1.5): `iris hive desktop <node> --forward <local-port>` relays B's VNC (macOS
# Screen Sharing, 5900) or RDP (3389) port to A. PASS = the forwarded port speaks VNC (RFB) or RDP.
if want 5; then
  if ! has_cmd hive desktop; then
    fail desktop "no 'iris hive desktop' (VNC/RDP port relayed over the Hive) — Phase 1.5"
  else
    LP=$((40000 + RANDOM % 20000))
    "$IRIS" hive desktop "$B" --forward "$LP" >"$WORK/desk.log" 2>&1 & FP=$!
    hello=""; for _ in $(seq 1 30); do
      hello=$(python3 -c "
import socket,sys
s=socket.create_connection(('127.0.0.1',$LP),3); s.settimeout(5)
s.sendall(bytes.fromhex('030000130ee000000000000100080003000000'))  # RDP X.224 connect request; VNC ignores it
d=s.recv(32); print('RFB' if d.startswith(b'RFB ') else ('RDP' if d[:2]==b'\x03\x00' else 'other:'+d[:8].hex()))
" 2>/dev/null); [ -n "$hello" ] && break; sleep 1; done
    kill "$FP" 2>/dev/null
    case "$hello" in
      RFB|RDP) pass desktop "B's remote-desktop port answered through the relay ($hello)";;
      *) fail desktop "the forwarded port did not answer as VNC/RDP (${hello:-no answer}; $(last <"$WORK/desk.log"))";;
    esac
  fi
fi

# ── 6 keys: device keys expire; revoke takes effect within 60 s ──────────────────────────────
# Interface (Phase 3.1/3.2): `iris hive nodes show B --json` carries key_expires_at; a disposable
# device key is minted with `iris hive keys device create <node> --ttl 10m --json` ({id, key}),
# revoked with `iris hive revoke --key <id>`, and probed with `iris hive keys device check <key>`
# (exit 0 = accepted). Revoking B itself is never done by this script.
if want 6; then
  timeout 60 "$IRIS" hive nodes show "$B" --json >"$WORK/node.json" 2>&1
  exp=$(grep -o '"key_expires_at": *"[^"]*"' "$WORK/node.json" | head -1)
  if [ -z "$exp" ]; then
    fail keys "B's device key has no expiry (no key_expires_at on the node) — Phase 3.2"
  elif ! has_cmd hive revoke || ! has_cmd hive keys device; then
    fail keys "B's key expires ($exp), but there is no 'iris hive revoke' / disposable device key to prove it — Phase 3.2"
  else
    timeout 60 "$IRIS" hive keys device create "$B" --ttl 10m --json >"$WORK/dk.json" 2>&1
    kid=$(grep -o '"id": *"[^"]*"' "$WORK/dk.json" | head -1 | cut -d'"' -f4)
    key=$(grep -o '"key": *"[^"]*"' "$WORK/dk.json" | head -1 | cut -d'"' -f4)
    if [ -z "$kid" ] || [ -z "$key" ] || ! "$IRIS" hive keys device check "$key" >/dev/null 2>&1; then
      fail keys "could not mint a working disposable device key ($(last <"$WORK/dk.json"))"
    else
      "$IRIS" hive revoke --key "$kid" >/dev/null 2>&1; t0=$(date +%s); refused=""
      while [ $(( $(date +%s) - t0 )) -le 60 ]; do
        "$IRIS" hive keys device check "$key" >/dev/null 2>&1 || { refused=$(( $(date +%s) - t0 )); break; }; sleep 5
      done
      if [ -n "$refused" ]; then pass keys "B's key expires ($exp); a revoked device key was refused after ${refused}s"; else fail keys "a revoked device key was still accepted after 60 s"; fi
    fi
  fi
fi

echo "result: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] && [ "$PASSED" -gt 0 ]
