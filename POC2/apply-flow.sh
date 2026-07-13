#!/usr/bin/env bash
# Modifies the "first broker login for exchange" > "Handle Existing Account"
# subflow to be headless-capable:
#   - Adds Automatically Set Existing User (REQUIRED)
#   - Adds Automatically Link Brokered Account (REQUIRED)
#   - Disables Confirm link existing account
#   - Disables Account verification options subflow
#
# Idempotent — safe to re-run. Skips adds if the authenticators are already there.
#
# Usage:
#   ./apply-flow.sh <KC_BASE_URL> <REALM> <CLIENT_ID> <CLIENT_SECRET>

set -uo pipefail

KC_URL="${1:-}"
REALM="${2:-}"
CLIENT_ID="${3:-}"
CLIENT_SECRET="${4:-}"

if [[ -z "$KC_URL" || -z "$REALM" || -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  echo "Usage: $0 <KC_BASE_URL> <REALM> <CLIENT_ID> <CLIENT_SECRET>"
  exit 1
fi

FLOW="first broker login for exchange"
SUBFLOW="first broker login for exchange Handle Existing Account"
FLOW_ENC=$(echo -n "$FLOW" | jq -sRr @uri)
SUBFLOW_ENC=$(echo -n "$SUBFLOW" | jq -sRr @uri)

echo "=== Getting admin token ==="
TOKEN=$(curl -s -X POST "$KC_URL/realms/$REALM/protocol/openid-connect/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" | jq -r .access_token)
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "ERROR: could not acquire admin token"
  exit 1
fi
echo "OK."

ADMIN="$KC_URL/admin/realms/$REALM"

get_executions() {
  curl -s -H "Authorization: Bearer $TOKEN" "$ADMIN/authentication/flows/$FLOW_ENC/executions"
}

echo
echo "=== Current flow state ==="
get_executions | jq '[.[] | {displayName, providerId, requirement, level, index, id}]'

# Helper: check if provider already present in the subflow (level 2)
has_provider() {
  local pid="$1"
  get_executions | jq -e --arg pid "$pid" \
    '[.[] | select(.providerId == $pid and .level == 2)] | length > 0' >/dev/null
}

echo
echo "=== Step 1: Add 'Detect Existing Broker User' to subflow ==="
# This authenticator finds an existing Keycloak user matching the brokered
# identity (by BROKER_USERNAME or email) and sets it as the flow's user.
# It's the "find the user" step that idp-auto-link needs.
if has_provider "idp-detect-existing-broker-user"; then
  echo "already present, skipping"
else
  RESP=$(curl -s -X POST "$ADMIN/authentication/flows/$SUBFLOW_ENC/executions/execution" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"provider":"idp-detect-existing-broker-user"}' \
    -w "\nHTTP:%{http_code}")
  echo "$RESP"
fi

echo
echo "=== Step 2: Add 'Automatically Link Brokered Account' to subflow ==="
if has_provider "idp-auto-link"; then
  echo "already present, skipping"
else
  curl -s -X POST "$ADMIN/authentication/flows/$SUBFLOW_ENC/executions/execution" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"provider":"idp-auto-link"}' \
    -w "HTTP %{http_code}\n"
fi

echo
echo "=== Step 3: Update requirements ==="
# Refresh execution list to get new IDs
EXECS=$(get_executions)

# Function to update a single execution's requirement
set_requirement() {
  local match_field="$1"
  local match_value="$2"
  local requirement="$3"
  local level="${4:-any}"
  local exec_json
  if [[ "$level" == "any" ]]; then
    exec_json=$(echo "$EXECS" | jq --arg mf "$match_field" --arg mv "$match_value" \
      '.[] | select(.[$mf] == $mv)' | head -c 10000)
  else
    exec_json=$(echo "$EXECS" | jq --arg mf "$match_field" --arg mv "$match_value" --argjson lvl "$level" \
      '.[] | select(.[$mf] == $mv and .level == $lvl)' | head -c 10000)
  fi
  if [[ -z "$exec_json" ]]; then
    echo "  - $match_field=$match_value not found, skipping"
    return
  fi
  # Update requirement in the JSON
  local updated
  updated=$(echo "$exec_json" | jq --arg r "$requirement" '.requirement = $r')
  echo "  - setting $match_field=$match_value to $requirement"
  curl -s -X PUT "$ADMIN/authentication/flows/$FLOW_ENC/executions" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$updated" \
    -w "    HTTP %{http_code}\n"
}

set_requirement "providerId" "idp-detect-existing-broker-user" "REQUIRED" 2
set_requirement "providerId" "idp-auto-link" "REQUIRED" 2
set_requirement "providerId" "idp-confirm-link" "DISABLED" 2
# Disable the Account verification options subflow (it's an authenticationFlow at level 2)
# Its displayName is "first broker login for exchange Account verification options"
set_requirement "displayName" "first broker login for exchange Account verification options" "DISABLED" 2

echo
echo "=== Step 4: Reorder so Detect Existing Broker User runs before Auto Link ==="
# Refresh execution list to get current indexes
EXECS=$(get_executions)
DETECT_INDEX=$(echo "$EXECS" | jq -r '[.[] | select(.providerId == "idp-detect-existing-broker-user" and .level == 2)][0].index // -1')
AUTOLINK_INDEX=$(echo "$EXECS" | jq -r '[.[] | select(.providerId == "idp-auto-link" and .level == 2)][0].index // -1')
DETECT_ID=$(echo "$EXECS" | jq -r '[.[] | select(.providerId == "idp-detect-existing-broker-user" and .level == 2)][0].id // empty')

echo "  detect index=$DETECT_INDEX auto-link index=$AUTOLINK_INDEX"
if [[ -n "$DETECT_ID" && "$DETECT_INDEX" -gt "$AUTOLINK_INDEX" ]]; then
  # Raise detect until it comes before auto-link
  STEPS=$(( DETECT_INDEX - AUTOLINK_INDEX ))
  echo "  raising 'Detect' priority $STEPS times"
  for i in $(seq 1 "$STEPS"); do
    curl -s -X POST "$ADMIN/authentication/executions/$DETECT_ID/raise-priority" \
      -H "Authorization: Bearer $TOKEN" \
      -w "    HTTP %{http_code}\n"
  done
else
  echo "  already in correct order or missing, skipping reorder"
fi

echo
echo "=== Final flow state ==="
get_executions | jq '[.[] | {displayName, providerId, requirement, level, index}]'

echo
echo "=== Done. Retry Pay. ==="
