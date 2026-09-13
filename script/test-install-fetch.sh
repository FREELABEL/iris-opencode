#!/bin/bash
# Extract fetch_daemon_source from the shipped installer and exercise it for real.
# Extract BOTH functions — fetch_daemon_source is a thin wrapper over fetch_repo_archive,
# and pulling only the wrapper silently tests nothing (6/14 "passed" that way, which looked
# like a code regression and was a harness bug).
cd "$(dirname "$0")/.." && sed -n '/^fetch_daemon_source() {/,/^}/p' install  > /tmp/fn.sh
sed -n '/^fetch_repo_archive() {/,/^}/p'  install >> /tmp/fn.sh
grep -q "fetch_repo_archive" /tmp/fn.sh || { echo "  ✗ could not extract fetch_repo_archive"; exit 1; }
grep -q "sentinel" /tmp/fn.sh || { echo "  ✗ extraction is incomplete"; exit 1; }
BRIDGE_FETCH_ERROR=""; . /tmp/fn.sh
pass=0; fail=0
chk(){ if [ "$2" = "1" ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fail=$((fail+1)); fi; }
D=/tmp/bashfetch; rm -rf $D

echo "CASE 1 — fresh install, no git"
fetch_daemon_source "$D" && ok=1 || ok=0
chk "succeeds" "$ok"
chk "daemon.js landed" "$([ -f $D/daemon.js ] && echo 1 || echo 0)"
chk "index.js landed"  "$([ -f $D/index.js ] && echo 1 || echo 0)"

echo; echo "CASE 2 — update preserves machine state"
mkdir -p "$D/node_modules"; echo keep > "$D/node_modules/marker"; echo hist > "$D/daemon.log"
mkdir -p "$D/.git"; echo ref > "$D/.git/HEAD"; echo stale > "$D/stale-source.js"
fetch_daemon_source "$D" && ok=1 || ok=0
chk "succeeds" "$ok"
chk "node_modules survived" "$([ -f $D/node_modules/marker ] && echo 1 || echo 0)"
chk "daemon.log survived"   "$([ "$(cat $D/daemon.log 2>/dev/null)" = hist ] && echo 1 || echo 0)"
chk "old .git left alone"   "$([ -f $D/.git/HEAD ] && echo 1 || echo 0)"
chk "stale repo file cleaned" "$([ ! -f $D/stale-source.js ] && echo 1 || echo 0)"

echo; echo "CASE 3 — bad URL must not damage the install"
before=$(ls -A $D | wc -l | tr -d ' ')
IRIS_DAEMON_ARCHIVE_URL="https://github.com/FREELABEL/iris-daemon/archive/refs/heads/nope.tar.gz" fetch_daemon_source "$D" && ok=0 || ok=1
chk "reports failure" "$ok"
chk "install intact"  "$([ -f $D/daemon.js ] && [ -f $D/node_modules/marker ] && echo 1 || echo 0)"
chk "nothing removed" "$([ "$(ls -A $D | wc -l | tr -d ' ')" = "$before" ] && echo 1 || echo 0)"

echo; echo "CASE 4 — a valid archive that is NOT the daemon is refused"
IRIS_DAEMON_ARCHIVE_URL="https://github.com/FREELABEL/iris-opencode/archive/refs/heads/main.tar.gz" fetch_daemon_source "$D" && ok=0 || ok=1
chk "refuses it" "$ok"
chk "says why"   "$(echo "$BRIDGE_FETCH_ERROR" | grep -qi 'daemon.js' && echo 1 || echo 0)"
chk "install intact" "$([ -f $D/daemon.js ] && echo 1 || echo 0)"
rm -rf $D
echo; echo "── $pass passed · $fail failed ──"; [ $fail -eq 0 ]
