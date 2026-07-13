#!/usr/bin/env bash
# Usage:
#   Service-account mode:
#     ./diagnose.sh <KC_BASE_URL> <REALM> <CLIENT_ID> <CLIENT_SECRET>
#   User mode (admin-cli password grant):
#     ./diagnose.sh <KC_BASE_URL> <REALM> --user <USERNAME> <PASSWORD>
# Requires: curl, jq

KC_URL="${1:-}"
REALM="${2:-}"
MODE="${3:-}"

if [[ "$MODE" == "--user" ]]; then
  USERNAME="${4:-}"
  PASSWORD="${5:-}"
  if [[ -z "$KC_URL" || -z "$REALM" || -z "$USERNAME" || -z "$PASSWORD" ]]; then
    echo "Usage: $0 <KC_BASE_URL> <REALM> --user <USERNAME> <PASSWORD>"
    exit 1
  fi
  echo "=== 1. Getting admin token via password grant on admin-cli as $USERNAME ==="
  TOKEN_RESP=$(curl -s -X POST "$KC_URL/realms/$REALM/protocol/openid-connect/token" \
    -d "grant_type=password" \
    -d "client_id=admin-cli" \
    -d "username=$USERNAME" \
    -d "password=$PASSWORD")
else
  CLIENT_ID="${3:-}"
  CLIENT_SECRET="${4:-}"
  if [[ -z "$KC_URL" || -z "$REALM" || -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
    echo "Usage: $0 <KC_BASE_URL> <REALM> <CLIENT_ID> <CLIENT_SECRET>"
    exit 1
  fi
  echo "=== 1. Getting admin token via client_credentials on $CLIENT_ID ==="
  TOKEN_RESP=$(curl -s -X POST "$KC_URL/realms/$REALM/protocol/openid-connect/token" \
    -d "grant_type=client_credentials" \
    -d "client_id=$CLIENT_ID" \
    -d "client_secret=$CLIENT_SECRET")
fi

TOKEN=$(echo "$TOKEN_RESP" | jq -r .access_token 2>/dev/null)
if [[ "$TOKEN" == "null" || -z "$TOKEN" ]]; then
  echo "ERROR: token acquisition failed"
  echo "$TOKEN_RESP"
  exit 1
fi
echo "OK — token acquired."

ADMIN="$KC_URL/admin/realms/$REALM"

kc_get() {
  local path="$1"
  local label="$2"
  local filter="${3:-.}"
  echo
  echo "--- $label"
  echo "GET $ADMIN$path"
  local body status
  body=$(curl -s -w "\n<<HTTP_STATUS:%{http_code}>>" -H "Authorization: Bearer $TOKEN" "$ADMIN$path")
  status=$(echo "$body" | sed -n 's/.*<<HTTP_STATUS:\([0-9]*\)>>.*/\1/p')
  body=$(echo "$body" | sed 's/<<HTTP_STATUS:[0-9]*>>//')
  echo "HTTP $status"
  if [[ -n "$body" ]]; then
    if echo "$body" | jq . >/dev/null 2>&1; then
      echo "$body" | jq "$filter" 2>/dev/null || echo "$body" | jq .
    else
      echo "$body"
    fi
  fi
}

section() { echo; echo "=== $1 ==="; }

section "2. Identity providers list"
kc_get "/identity-provider/instances" \
  "IdPs" \
  '[.[] | {alias, providerId, enabled, firstBrokerLoginFlowAlias, trustEmail, config: (.config // {} | with_entries(select(.key | test("issuer|jwks|validateSignature|tokenUrl|authorizationUrl|clientId|clientAuthMethod|useJwks"))))}]'

section "3. partner-realm IdP full config"
kc_get "/identity-provider/instances/partner-realm" \
  "partner-realm IdP config" \
  'del(.config.clientSecret)'

section "4. partner-realm IdP mappers"
kc_get "/identity-provider/instances/partner-realm/mappers" \
  "IdP mappers" \
  '[.[] | {name, identityProviderMapper, config}]'

section "5. partner-client info"
CLIENT_LIST=$(curl -s -H "Authorization: Bearer $TOKEN" "$ADMIN/clients?clientId=partner-client")
CLIENT_UUID=$(echo "$CLIENT_LIST" | jq -r '.[0].id // empty' 2>/dev/null)
echo "partner-client UUID: ${CLIENT_UUID:-<not found>}"
if [[ -n "$CLIENT_UUID" ]]; then
  kc_get "/clients/$CLIENT_UUID" \
    "partner-client core config" \
    '{clientId, publicClient, standardFlowEnabled, directAccessGrantsEnabled, serviceAccountsEnabled, consentRequired, fullScopeAllowed, attributes: (.attributes // {} | with_entries(select(.key | test("token.exchange|token-exchange|standard.token|consent"))))}'
fi

section "6. partner-client permissions state"
if [[ -n "$CLIENT_UUID" ]]; then
  kc_get "/clients/$CLIENT_UUID/management/permissions" "client permissions" '.'
fi

section "7. partner-realm IdP permissions state"
kc_get "/identity-provider/instances/partner-realm/management/permissions" "idp permissions" '.'

section "8a. Authentication flows (aliases)"
kc_get "/authentication/flows" \
  "Flows" \
  '[.[] | {alias, description, providerId, topLevel, builtIn}]'

section "8b. 'first broker login for exchange' flow — executions"
# URL-encode the flow alias (spaces → %20)
FLOW_ALIAS_ENC="first%20broker%20login%20for%20exchange"
kc_get "/authentication/flows/$FLOW_ALIAS_ENC/executions" \
  "flow executions" \
  '[.[] | {displayName, requirement, providerId, alias, authenticationFlow, authenticator, level, index, authenticationConfig}]'

section "8c. 'first broker login for exchange' flow — resolved authenticator configs"
# Any executions with an authenticationConfig id → fetch it
CONFIGS=$(curl -s -H "Authorization: Bearer $TOKEN" "$ADMIN/authentication/flows/$FLOW_ALIAS_ENC/executions" \
  | jq -r '[.[] | select(.authenticationConfig != null) | .authenticationConfig] | .[]' 2>/dev/null)
if [[ -z "$CONFIGS" ]]; then
  echo "(no authenticator configs referenced in this flow)"
else
  for CFG_ID in $CONFIGS; do
    kc_get "/authentication/config/$CFG_ID" "config $CFG_ID" '.'
  done
fi

section "9. DEV bcregistry .well-known"
echo
echo "GET $KC_URL/realms/$REALM/.well-known/openid-configuration"
curl -s "$KC_URL/realms/$REALM/.well-known/openid-configuration" | jq '{issuer, token_endpoint, grant_types_supported}'

section "10. Source IdP (TEST bcregistry) JWKS from your machine"
TEST_JWKS="https://test.loginproxy.gov.bc.ca/auth/realms/bcregistry/protocol/openid-connect/certs"
echo "GET $TEST_JWKS"
curl -s "$TEST_JWKS" | jq '{kids: [.keys[].kid], key_count: (.keys | length)}' 2>/dev/null || echo "(non-JSON)"

echo
echo "=== Done. Paste all output. ==="
