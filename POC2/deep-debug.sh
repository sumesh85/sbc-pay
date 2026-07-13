#!/usr/bin/env bash
# Systematic root-cause exploration for the "Invalid token" error.
# Tests reachability, JWKS state, TE variants, and specific validation gates.
#
# Usage:
#   ./deep-debug.sh <DEV_KC_URL> <DEV_REALM> <DEV_CLIENT_ID> <DEV_CLIENT_SECRET> [<TEST_PARTNER_TOKEN>]
#
# If TEST_PARTNER_TOKEN is provided, actual exchange attempts are run.
# Get the token from browser (http://localhost:3001/debug/partner-token → view page source
# for the raw token, OR add a copy button).

set -uo pipefail

DEV_KC="${1:-}"
DEV_REALM="${2:-}"
DEV_CID="${3:-}"
DEV_SEC="${4:-}"
TEST_TOKEN="${5:-}"

if [[ -z "$DEV_KC" || -z "$DEV_REALM" || -z "$DEV_CID" || -z "$DEV_SEC" ]]; then
  echo "Usage: $0 <DEV_KC_URL> <DEV_REALM> <DEV_CID> <DEV_SEC> [<TEST_TOKEN>]"
  exit 1
fi

# ==================================================================
# Phase 1: Admin token + basic reachability
# ==================================================================
echo "======================================================================"
echo "PHASE 1: Admin auth on DEV"
echo "======================================================================"
TOKEN=$(curl -s -X POST "$DEV_KC/realms/$DEV_REALM/protocol/openid-connect/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=$DEV_CID" \
  -d "client_secret=$DEV_SEC" | jq -r .access_token)

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "ERROR: could not get DEV admin token"
  exit 1
fi
echo "✓ DEV admin token acquired"

ADMIN="$DEV_KC/admin/realms/$DEV_REALM"

# ==================================================================
# Phase 2: Force IdP key reload on DEV → this is the killer test
# ==================================================================
echo
echo "======================================================================"
echo "PHASE 2: Force JWKS reload from DEV → TEST"
echo "======================================================================"
echo "This is the critical test. If DEV cannot reach TEST's JWKS URL,"
echo "signature verification will fail regardless of any config we set."
echo
echo "Triggering key reload on partner-realm IdP..."
RELOAD_RESP=$(curl -s -w "\nHTTP:%{http_code}" -X POST \
  "$ADMIN/identity-provider/instances/partner-realm/reload-keys" \
  -H "Authorization: Bearer $TOKEN")
echo "$RELOAD_RESP"
echo
if echo "$RELOAD_RESP" | grep -q "HTTP:200"; then
  echo "✓ Reload endpoint returned 200 — but this doesn't confirm DEV actually FETCHED the JWKS"
elif echo "$RELOAD_RESP" | grep -q "HTTP:204"; then
  echo "✓ Reload endpoint returned 204 — same, doesn't confirm fetch"
else
  echo "✗ Reload failed → could indicate reachability problem"
fi

# ==================================================================
# Phase 3: Check user's federated identity links
# ==================================================================
echo
echo "======================================================================"
echo "PHASE 3: Verify user's federated identity links state"
echo "======================================================================"
# Look for the BCSC user
USER_JSON=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "$ADMIN/users?username=bcsc/malpaovmqyxtxfdu47z54mwswuerbdni&exact=true")
USER_ID=$(echo "$USER_JSON" | jq -r '.[0].id // empty')

if [[ -z "$USER_ID" ]]; then
  echo "✗ User not found — the username might have URL-encoding issues"
  # Try with URL encoded
  USER_JSON=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "$ADMIN/users?username=bcsc%2Fmalpaovmqyxtxfdu47z54mwswuerbdni&exact=true")
  USER_ID=$(echo "$USER_JSON" | jq -r '.[0].id // empty')
  echo "Retried with URL encoding: user_id=$USER_ID"
fi

if [[ -n "$USER_ID" ]]; then
  echo "user_id: $USER_ID"
  echo
  echo "Federated identity links on this user:"
  curl -s -H "Authorization: Bearer $TOKEN" \
    "$ADMIN/users/$USER_ID/federated-identity" | jq '.'
fi

# ==================================================================
# Phase 4: Actual token exchange attempts (if token provided)
# ==================================================================
if [[ -z "$TEST_TOKEN" ]]; then
  echo
  echo "======================================================================"
  echo "PHASE 4: SKIPPED (no TEST token provided)"
  echo "To run exchange attempts, pass the TEST partner token as 5th arg."
  echo "Get it from http://localhost:3001/debug/partner-token"
  echo "======================================================================"
  exit 0
fi

echo
echo "======================================================================"
echo "PHASE 4: Token exchange attempts"
echo "======================================================================"

TE_URL="$DEV_KC/realms/$DEV_REALM/protocol/openid-connect/token"

try_exchange() {
  local label="$1"; shift
  echo
  echo "--- $label"
  echo "Request params:"
  local params=""
  for p in "$@"; do
    params="$params --data-urlencode $p"
    echo "  $p"
  done
  echo "Response:"
  eval curl -s -w "\\\"HTTP:%{http_code}\\\"" -X POST \"$TE_URL\" \
    --data-urlencode "\"client_id=$DEV_CID\"" \
    --data-urlencode "\"client_secret=$DEV_SEC\"" \
    $params
  echo
}

try_exchange "A1: Standard TE, access_token type, no audience" \
  "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  "subject_token=$TEST_TOKEN" \
  "subject_token_type=urn:ietf:params:oauth:token-type:access_token"

try_exchange "A2: Standard TE, access_token type, audience=partner-client" \
  "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  "subject_token=$TEST_TOKEN" \
  "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  "audience=partner-client"

try_exchange "A3: Standard TE, no subject_token_type" \
  "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  "subject_token=$TEST_TOKEN"

try_exchange "A4: Standard TE with requested_token_type" \
  "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  "subject_token=$TEST_TOKEN" \
  "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  "requested_token_type=urn:ietf:params:oauth:token-type:access_token"

# ==================================================================
# Phase 5: Introspect the TEST token from DEV
# ==================================================================
echo
echo "======================================================================"
echo "PHASE 5: Try token introspection on DEV"
echo "======================================================================"
echo "If DEV can validate the token via introspection, it can definitely"
echo "read TEST's public keys. If introspection fails, JWKS is likely"
echo "unreachable from DEV."
echo
curl -s -w "\nHTTP:%{http_code}\n" -X POST \
  "$DEV_KC/realms/$DEV_REALM/protocol/openid-connect/token/introspect" \
  -u "$DEV_CID:$DEV_SEC" \
  --data-urlencode "token=$TEST_TOKEN" \
  --data-urlencode "token_type_hint=access_token" \
  | jq . 2>/dev/null || cat

echo
echo "======================================================================"
echo "Done"
echo "======================================================================"
