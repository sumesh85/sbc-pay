#!/usr/bin/env bash
# Checks if admin-fine-grained-authz feature is enabled on a Keycloak realm.
#
# Usage:
#   ./check-fgap.sh <KC_BASE_URL> <REALM> <CLIENT_ID> <CLIENT_SECRET>
#
# Example:
#   ./check-fgap.sh https://dev.loginproxy.gov.bc.ca/auth bcregistry partner-client 7eMdVs...

set -uo pipefail

KC_URL="${1:-}"
REALM="${2:-}"
CLIENT_ID="${3:-}"
CLIENT_SECRET="${4:-}"

if [[ -z "$KC_URL" || -z "$REALM" || -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  echo "Usage: $0 <KC_BASE_URL> <REALM> <CLIENT_ID> <CLIENT_SECRET>"
  exit 1
fi

echo "=== Checking admin-fine-grained-authz on $KC_URL/realms/$REALM ==="
echo

# Get admin token
TOKEN=$(curl -s -X POST "$KC_URL/realms/$REALM/protocol/openid-connect/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" | jq -r .access_token)
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "ERROR: could not get admin token — check client credentials"
  exit 1
fi

# Look up the client UUID to probe (any client works; we use the one we're auth'd as)
CLIENT_UUID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "$KC_URL/admin/realms/$REALM/clients?clientId=$CLIENT_ID" | jq -r '.[0].id // empty')
if [[ -z "$CLIENT_UUID" ]]; then
  echo "ERROR: could not find client $CLIENT_ID"
  exit 1
fi

# Probe the fine-grained permissions endpoint
RESP=$(curl -s -w "\n<<HTTP:%{http_code}>>" \
  -H "Authorization: Bearer $TOKEN" \
  "$KC_URL/admin/realms/$REALM/clients/$CLIENT_UUID/management/permissions")
STATUS=$(echo "$RESP" | sed -n 's/.*<<HTTP:\([0-9]*\)>>.*/\1/p')
BODY=$(echo "$RESP" | sed 's/<<HTTP:[0-9]*>>//')

echo "Probe endpoint: $KC_URL/admin/realms/$REALM/clients/$CLIENT_UUID/management/permissions"
echo "HTTP status:    $STATUS"
echo "Response body:"
echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
echo

case "$STATUS" in
  200)
    echo "✓ admin-fine-grained-authz IS ENABLED"
    echo "  You should see 'Permissions' tabs in the admin console on clients and IdPs."
    exit 0
    ;;
  501)
    echo "✗ admin-fine-grained-authz is DISABLED"
    echo "  This is a server-level feature that must be enabled at RH-SSO startup:"
    echo "    KC_FEATURES=admin-fine-grained-authz (or --features=admin-fine-grained-authz)"
    echo "  Only the SSO admin team can enable this."
    exit 1
    ;;
  403)
    echo "? Admin token lacks permission to check — result inconclusive"
    echo "  Grant the client's service account 'view-clients' role on realm-management."
    exit 2
    ;;
  *)
    echo "? Unexpected status $STATUS — see body above"
    exit 3
    ;;
esac
