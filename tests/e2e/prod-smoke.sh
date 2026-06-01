#!/usr/bin/env bash
#
# Prod smoke — guards the fresh-install → auth → chat → tools path against regression.
#
# Every check here maps to a real bug that reached a client machine during the
# June 2026 portability QA sweep. If one of these flips red, a client's first-run
# experience is broken again:
#   #117823  installer redirect dropped --token/--user-id (scripted onboarding broke)
#   #117097  chat "Unauthorized" — chat completions must accept a valid login token
#   #117199  iris tools list 404 — /api/v1/tools must live on iris-api
#   (#117200 class is covered by iris-daemon's check-requires gate)
#
# Usage:
#   IRIS_API_KEY=<token> bash tests/e2e/prod-smoke.sh      # full run
#   bash tests/e2e/prod-smoke.sh                            # public checks only (token ones skip)
#
# In CI the token comes from the IRIS_SMOKE_TOKEN secret. Token-gated checks SKIP
# (not fail) when no token is present, so the public checks still run everywhere.
#
set -uo pipefail

IRIS_API="${IRIS_API_URL:-https://freelabel.net}"
INSTALL_URL="${INSTALL_URL:-https://heyiris.io/install-iris.sh}"
TOKEN="${IRIS_API_KEY:-}"
MODEL="${SMOKE_MODEL:-iris/gpt-4.1-nano}"   # nano only — cheap, per house rule

PASSES=0 FAILS=0 SKIPS=0
pass() { echo "  ✓ $1"; PASSES=$((PASSES + 1)); }
fail() { echo "  ✗ $1"; FAILS=$((FAILS + 1)); }
skip() { echo "  ⊘ $1 — skipped ($2)"; SKIPS=$((SKIPS + 1)); }
code() { curl -s -o /dev/null -w "%{http_code}" --max-time 25 "$@"; }

echo "Prod smoke against ${IRIS_API}"
echo

echo "── Installer flag forwarding (#117823) ──"
if curl -fsSL --max-time 15 "$INSTALL_URL" 2>/dev/null | grep -q '"\$@"'; then
  pass "install-iris.sh forwards \"\$@\" (flags reach the real installer)"
else
  fail "install-iris.sh does NOT forward \"\$@\" — scripted installs silently drop --token/--user-id"
fi

echo "── Chat model discovery, public (#117097 base) ──"
c=$(code "$IRIS_API/api/v6/openai/models")
[ "$c" = "200" ] && pass "GET /api/v6/openai/models = 200" || fail "GET /api/v6/openai/models = $c (expected 200)"

echo "── Tools endpoint on iris-api (#117199) ──"
c=$(code "$IRIS_API/api/v1/tools")
[ "$c" = "200" ] && pass "GET /api/v1/tools = 200 (iris-api)" || fail "GET /api/v1/tools = $c (expected 200)"

echo "── Chat auth — valid token accepted, bogus token rejected (#117097) ──"
if [ -n "$TOKEN" ]; then
  c=$(code -X POST "$IRIS_API/api/v6/openai/chat/completions" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":5}")
  [ "$c" = "200" ] \
    && pass "POST /api/v6/openai/chat/completions with valid token = 200" \
    || fail "POST chat/completions = $c (expected 200 — AUTH REGRESSION, first-run chat is broken)"

  c=$(code -X POST "$IRIS_API/api/v6/openai/chat/completions" \
    -H "Authorization: Bearer not-a-real-token-0000-1111-2222-3333" -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":5}")
  [ "$c" = "401" ] \
    && pass "POST chat/completions with bogus token = 401 (auth is enforced)" \
    || fail "bogus token returned $c (expected 401 — auth may be wide open)"
else
  skip "chat auth check" "no IRIS_API_KEY / IRIS_SMOKE_TOKEN"
fi

echo
echo "── Summary: ${PASSES} passed, ${FAILS} failed, ${SKIPS} skipped ──"
[ "$FAILS" -eq 0 ] || { echo "PROD SMOKE FAILED"; exit 1; }
echo "PROD SMOKE OK"
