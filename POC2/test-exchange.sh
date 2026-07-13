#!/usr/bin/env bash
# Direct token-exchange test — takes a TEST bcregistry access token and runs
# the exchange against DEV bcregistry with verbose output.
#
# Usage:
#   ./test-exchange.sh <TEST_ACCESS_TOKEN>
#
# Get the TEST token from partner-backend:
#   docker logs poc2-partner-backend | grep -oE "partnerToken[^ ]*" | head -1
# Or add a debug endpoint that dumps req.session.user.partnerToken

set -uo pipefail

TOKEN="${1:-}"
if [[ -z "$TOKEN" ]]; then
  echo "Usage: $0 <TEST_ACCESS_TOKEN>"
  exit 1
fi

DEV_KC="https://dev.loginproxy.gov.bc.ca/auth"
DEV_REALM="bcregistry"
CLIENT_ID="partner-client"
CLIENT_SECRET="7eMdVswg5kexZQOfSAHOvcdEor689h6x"

echo "=== Token header ==="
echo "$TOKEN" | cut -d. -f1 | base64 -d 2>/dev/null | jq .

echo
echo "=== Token payload (relevant fields) ==="
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq '{iss, aud, azp, typ, exp, iat, preferred_username, sub}'

echo
echo "=== Now: JWKS fetch test from your machine ==="
curl -s "https://test.loginproxy.gov.bc.ca/auth/realms/bcregistry/protocol/openid-connect/certs" \
  | jq '[.keys[].kid]'
echo "Token kid:"
echo "$TOKEN" | cut -d. -f1 | base64 -d 2>/dev/null | jq -r .kid

echo
echo "=== Attempt 1: Standard TE (no subject_issuer) ==="
curl -sv -X POST "$DEV_KC/realms/$DEV_REALM/protocol/openid-connect/token" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "subject_token=$TOKEN" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  --data-urlencode "scope=openid email profile" 2>&1 | grep -E "^(> POST|< HTTP|<|{|\")"

echo
echo "=== Attempt 2: Legacy TE with subject_issuer ==="
curl -sv -X POST "$DEV_KC/realms/$DEV_REALM/protocol/openid-connect/token" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "subject_token=$TOKEN" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  --data-urlencode "subject_issuer=partner-realm" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" 2>&1 | grep -E "^(> POST|< HTTP|<|{|\")"

echo
echo "=== Attempt 3: audience parameter (Standard TE with audience) ==="
curl -sv -X POST "$DEV_KC/realms/$DEV_REALM/protocol/openid-connect/token" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "subject_token=$TOKEN" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  --data-urlencode "audience=partner-client" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" 2>&1 | grep -E "^(> POST|< HTTP|<|{|\")"

echo
echo "=== Done ==="
