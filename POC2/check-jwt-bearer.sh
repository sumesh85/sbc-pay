#!/usr/bin/env bash
# Checks if JWT Authorization Grant (RFC 7523) is enabled on a Keycloak realm.
#
# Signals checked:
#  1. .well-known/openid-configuration lists jwt-bearer grant
#  2. Live probe of the token endpoint with a fake assertion — response
#     distinguishes "grant not supported" from "grant supported but bad input"
#  3. IdP config exposes JWT bearer settings
#  4. Client config shows JWT bearer capability
#
# Usage:
#   ./check-jwt-bearer.sh <KC_BASE_URL> <REALM> <CLIENT_ID> <CLIENT_SECRET>

set -uo pipefail

KC_URL="${1:-}"
REALM="${2:-}"
CLIENT_ID="${3:-}"
CLIENT_SECRET="${4:-}"

if [[ -z "$KC_URL" || -z "$REALM" || -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  echo "Usage: $0 <KC_BASE_URL> <REALM> <CLIENT_ID> <CLIENT_SECRET>"
  exit 1
fi

echo "======================================================================"
echo " JWT Authorization Grant feature check"
echo "======================================================================"
echo

# ==================================================================
# 1. Well-known
# ==================================================================
echo "[1] .well-known grant_types_supported"
WK=$(curl -s "$KC_URL/realms/$REALM/.well-known/openid-configuration")
GRANTS=$(echo "$WK" | jq -r '.grant_types_supported[]?' 2>/dev/null)
echo "$GRANTS" | sed 's/^/    /'
if echo "$GRANTS" | grep -q "urn:ietf:params:oauth:grant-type:jwt-bearer"; then
  echo "    ✓ jwt-bearer grant is advertised"
  WK_SIGNAL="yes"
else
  echo "    ✗ jwt-bearer grant NOT advertised"
  WK_SIGNAL="no"
fi

# ==================================================================
# 2. Live probe of the token endpoint
# ==================================================================
echo
echo "[2] Live probe: send jwt-bearer grant with a fake assertion"
PROBE=$(curl -s -w "\n<<HTTP:%{http_code}>>" -X POST \
  "$KC_URL/realms/$REALM/protocol/openid-connect/token" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "assertion=obviously.not.a.jwt")
STATUS=$(echo "$PROBE" | sed -n 's/.*<<HTTP:\([0-9]*\)>>.*/\1/p')
BODY=$(echo "$PROBE" | sed 's/<<HTTP:[0-9]*>>//')
echo "    HTTP: $STATUS"
echo "    Body: $BODY"

case "$BODY" in
  *"unsupported_grant_type"*)
    echo "    ✗ Server rejects jwt-bearer grant type — FEATURE OFF"
    LIVE_SIGNAL="off"
    ;;
  *"invalid_client"*)
    echo "    ? Client rejected — feature status inconclusive"
    LIVE_SIGNAL="unknown"
    ;;
  *"invalid_request"*|*"invalid_grant"*)
    echo "    ✓ Server accepted the grant type (rejected only on assertion) — FEATURE ON"
    LIVE_SIGNAL="on"
    ;;
  *)
    echo "    ? Unexpected response — inspect body above"
    LIVE_SIGNAL="unknown"
    ;;
esac

# ==================================================================
# 3. Admin auth
# ==================================================================
echo
echo "[3] Getting admin token for IdP/client inspection"
TOKEN=$(curl -s -X POST "$KC_URL/realms/$REALM/protocol/openid-connect/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" | jq -r .access_token)
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "    ! Could not get admin token — skipping [4] and [5]"
  ADMIN_OK="no"
else
  echo "    ✓ Admin token acquired"
  ADMIN_OK="yes"
fi
ADMIN="$KC_URL/admin/realms/$REALM"

# ==================================================================
# 4. IdP config
# ==================================================================
if [[ "$ADMIN_OK" == "yes" ]]; then
  echo
  echo "[4] partner-realm IdP config — searching for jwt bearer fields"
  IDP=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "$ADMIN/identity-provider/instances/partner-realm")
  JWTG=$(echo "$IDP" | jq '.config | to_entries | .[] | select(.key | test("jwtBearer|jwt_bearer|authorizationGrant|jwt-bearer"; "i"))')
  if [[ -n "$JWTG" ]]; then
    echo "    ✓ jwt-bearer-related fields present on IdP:"
    echo "$JWTG" | sed 's/^/      /'
  else
    echo "    ✗ No jwt-bearer-related fields found in IdP config"
    echo "      (feature may not be available in this Keycloak build)"
  fi
fi

# ==================================================================
# 5. Client config
# ==================================================================
if [[ "$ADMIN_OK" == "yes" ]]; then
  echo
  echo "[5] partner-client capability config"
  CLIENT_UUID=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "$ADMIN/clients?clientId=$CLIENT_ID" | jq -r '.[0].id // empty')
  if [[ -n "$CLIENT_UUID" ]]; then
    CLIENT=$(curl -s -H "Authorization: Bearer $TOKEN" \
      "$ADMIN/clients/$CLIENT_UUID")
    JWTA=$(echo "$CLIENT" | jq '.attributes // {} | to_entries | .[] | select(.key | test("jwt|bearer|authorization.grant"; "i"))')
    if [[ -n "$JWTA" ]]; then
      echo "    ✓ jwt-bearer-related attributes present on client:"
      echo "$JWTA" | sed 's/^/      /'
    else
      echo "    ✗ No jwt-bearer-related client attributes found"
    fi
  fi
fi

# ==================================================================
# Summary
# ==================================================================
echo
echo "======================================================================"
echo " SUMMARY"
echo "======================================================================"
echo "  Well-known advertises jwt-bearer:   $WK_SIGNAL"
echo "  Live token endpoint accepts grant:  $LIVE_SIGNAL"
echo
if [[ "$WK_SIGNAL" == "yes" && "$LIVE_SIGNAL" == "on" ]]; then
  echo "  ✓ JWT Authorization Grant IS supported on this instance"
  echo "    Next: configure the IdP and client for it (Phase 1 setup steps)"
  exit 0
elif [[ "$LIVE_SIGNAL" == "off" ]]; then
  echo "  ✗ JWT Authorization Grant is NOT supported by this Keycloak build"
  echo "    Feature must be enabled at server startup by SSO team."
  echo "    Ask them to enable the jwt-bearer / jwt-authorization-grant feature."
  exit 1
else
  echo "  ? Inconclusive — check [4] and [5] outputs above."
  exit 2
fi
