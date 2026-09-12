#!/bin/bash
# ── PROOF 1, adversarial. Epic #184607.
#
# "A machine granted {A} cannot retrieve C through tools, files, sibling processes,
#  or network. Not 'C wasn't in the prompt'. Actually cannot."
#
# EVERY attack runs TWICE: once SEALED, once UNSEALED (the control). A block only
# counts when the control shows the same command SUCCEEDING — otherwise "0 results"
# may just mean the thing was never reachable and the wall was never tested.
#
# Usage: proof1.sh <iris-cmd> <A-uuid> <C-uuid> <C-item-id> <marker>
set -uo pipefail
IRIS="$1"; AU="$2"; CU="$3"; CID="$4"; MARK="$5"
# What counts as C's content arriving. Defaults to the marker; an attack may override it
# when the marker is also the query.
LEAK="$MARK"
SEALED_HOME="${SEALED_HOME:-/tmp/proof1-sealed}"
OPEN_HOME="${OPEN_HOME:-/tmp/proof1-open}"
pass=0; fail=0; untested=0

run() { IRIS_ATLAS_HOME="$1" $IRIS "${@:2}" 2>&1; }
# A command that SEARCHES for the marker prints the marker back in its own banner
# ("Search — ZEBRA-9931"). Matching that is matching my own query, not leaked content —
# a check that cannot tell the echo from the answer will report a leak that is not there,
# and would just as happily miss one that is. So drop the lines the tool wrote about the
# REQUEST, and look only at what came back.
leaked() {
  echo "$1" \
    | grep -v '◈' \
    | grep -viE 'search(ing)? *[—-]|no (item|board)|matches for|0 item' \
    | grep -q "$LEAK"
}

attack() { # [LEAK=<indicator>] name, then command args
  local name="$1"; shift
  local sealed_out control_out
  control_out=$(run "$OPEN_HOME" "$@")
  sealed_out=$(run "$SEALED_HOME" "$@")

  if ! leaked "$control_out"; then
    printf "  ?? %-44s UNTESTED — the control did not leak either, so this proves nothing\n" "$name"
    untested=$((untested+1)); return
  fi
  if leaked "$sealed_out"; then
    printf "  ✗  %-44s LEAKED\n" "$name"
    fail=$((fail+1))
  else
    printf "  ✓  %-44s blocked (control leaked, sealed did not)\n" "$name"
    pass=$((pass+1))
  fi
}

echo "PROOF 1 — granted {A}, attacking for C"
echo "  marker: $MARK   sealed home: $SEALED_HOME"
echo

# Set up: both homes pin A; only the sealed one is sealed.
rm -rf "$SEALED_HOME" "$OPEN_HOME"
run "$SEALED_HOME" atlas pin "$AU" >/dev/null 2>&1
run "$OPEN_HOME"   atlas pin "$AU" >/dev/null 2>&1
run "$SEALED_HOME" atlas seal >/dev/null 2>&1

attack "read C by uuid"              atlas use "$CU"
attack "read C by item id"           atlas get-item "$CID"
# The marker IS the query here, so the leak indicator has to be something only the
# RESULT would contain: C's title.
LEAK="Item C" attack "enumerate: search the marker" atlas search "$MARK"
LEAK="$MARK" attack "enumerate: search by title"   atlas search "Item C"
attack "read C as json"              atlas use "$CU" --json
attack "read C via atlas item alias" atlas item "$CID"

echo
echo "  FILESYSTEM — is C on the sealed machine's disk at all?"
if grep -rq "$MARK" "$SEALED_HOME" 2>/dev/null; then
  echo "  ✗  C's content found in the sealed store"; fail=$((fail+1))
else
  echo "  ✓  C's content is not on disk"; pass=$((pass+1))
fi

echo
echo "  THE CONTROL THAT MATTERS MOST — does unsealing restore access?"
out=$(run "$SEALED_HOME" atlas unseal 2>&1; run "$SEALED_HOME" atlas use "$CU" 2>&1)
if leaked "$out"; then
  echo "  ✓  after unseal, C IS readable — the seal was the thing blocking it"; pass=$((pass+1))
else
  echo "  ✗  still blocked after unseal — something ELSE was blocking, the test is invalid"; fail=$((fail+1))
fi
run "$SEALED_HOME" atlas seal >/dev/null 2>&1

echo
echo "  ── $pass blocked · $fail LEAKED · $untested untested ──"
[ "$fail" -eq 0 ] && [ "$untested" -eq 0 ]
