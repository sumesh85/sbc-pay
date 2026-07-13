# POC2 — Partner integration against real DEV BCROS

This POC drops the local Keycloak entirely. Both realms are real:

- **Partner realm**: `https://test.loginproxy.gov.bc.ca/auth/realms/bcregistry` (TEST loginproxy, acting as a customer's realm)
- **BCROS realm**: `https://dev.loginproxy.gov.bc.ca/auth/realms/bcregistry` (DEV loginproxy, actual BCROS realm)

BCROS side already has partner realm registered as an external IdP with alias `partner-realm`. The DEV BCROS APIs (auth-api and pay-api) are hit for real.

## What's included

| Service | Port | Role |
|---|---|---|
| partner-web | 3000 | Static landing page |
| partner-backend | 3001 | Signs users in via TEST bcregistry, does token exchange to DEV bcregistry, calls real DEV APIs |

No Keycloak container — both realms are external.

## Configuration

Set these environment variables in `docker-compose.yml` (or override at run time):

| Variable | Value | Notes |
|---|---|---|
| `PARTNER_KC_URL` | `https://test.loginproxy.gov.bc.ca/auth` | pre-filled |
| `PARTNER_REALM` | `bcregistry` | pre-filled |
| `PARTNER_CLIENT_ID` | **your TEST bcregistry client id** | placeholder — fill in |
| `PARTNER_CLIENT_SECRET` | **your TEST bcregistry client secret** | placeholder — leave empty if public client |
| `BCROS_KC_URL` | `https://dev.loginproxy.gov.bc.ca/auth` | pre-filled |
| `BCROS_REALM` | `bcregistry` | pre-filled |
| `BCROS_CLIENT_ID` | `bcros-dev-integration` | pre-filled (the DEV client used for token exchange) |
| `BCROS_CLIENT_SECRET` | **secret for `bcros-dev-integration`** | placeholder — fill in |
| `BCROS_SUBJECT_ISSUER` | `partner-realm` | pre-filled (matches IdP alias on DEV bcregistry) |
| `BCROS_PAY_API` | `https://test.api.connect.gov.bc.ca/pay-dev/api/v1` | pre-filled |
| `BCROS_AUTH_API` | `https://test.api.connect.gov.bc.ca/auth-dev/api/v1` | pre-filled |

Optional (for the test invoice payload):
- `TEST_BUSINESS_IDENTIFIER` (default `BC0871427`)
- `TEST_CORP_TYPE` (default `BEN`)
- `TEST_FILING_TYPE` (default `BCANN`)

## One-time setup on cloud realms

**On TEST bcregistry (partner realm) — the client you're using for `PARTNER_CLIENT_ID`:**
- Add `http://localhost:3001/login/callback` to Valid Redirect URIs
- Standard flow: ON
- If confidential, ensure client secret is set and pasted into `PARTNER_CLIENT_SECRET`

**On DEV bcregistry (BCROS realm) — should already be done:**
- Partner realm registered as external OIDC IdP with alias `partner-realm`
- `bcros-dev-integration` client:
  - Confidential
  - Standard token exchange enabled
  - `token-exchange` permission granted for the `partner-realm` IdP

## Run

```bash
cd POC2
# Edit docker-compose.yml and fill the three __REPLACE_WITH__ placeholders
docker compose up
```

Then open http://localhost:3000 → follow the link to Partner backend (:3001) → sign in.

## Flow

1. **Sign in** — partner backend redirects browser to TEST bcregistry `/authorize`. Complete login however you normally do (BCSC / BCeID / IDIR / etc.).
2. Partner backend exchanges the code for a TEST bcregistry access token, stores it in session.
3. **Click Pay via BCROS**:
   - Partner backend calls DEV bcregistry `/token` with `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<TEST token>`, `subject_issuer=partner-realm`, `client_id=bcros-dev-integration`, `client_secret=…`.
   - DEV bcregistry validates the subject token (via TEST realm's JWKS), resolves the shadow user → issues a DEV bcregistry token.
   - Partner backend calls DEV `auth-api /users/@me/orgs` with the DEV token to list your DEV BCROS accounts.
   - If >1 usable account, pick one; else auto-select.
   - Partner backend calls DEV `pay-api /payment-requests` with `Authorization: Bearer <DEV token>`, `Account-Id: <picked>`, and a test invoice payload.
4. Real DEV invoice comes back.

## Debug

- **`/debug/exchange`** — after login, shows the exchanged DEV token and its decoded claims. Useful for verifying the token has the expected `sub`, `azp=bcros-dev-integration`, `roles`, and any custom claims populated by DEV bcregistry mappers.
- **`docker logs poc2-partner-backend`** — the backend logs each step (login callback, token exchange result, org count, invoice creation attempt).

## Common issues

- **`invalid_client`** at token exchange → wrong `BCROS_CLIENT_SECRET` or the `bcros-dev-integration` client doesn't have token-exchange permission for the `partner-realm` IdP.
- **`invalid_token` / `User already exists`** → first-time federated identity linking issue on DEV bcregistry (needs the equivalent of a first-broker-login flow that either interactively links or auto-links via a shared attribute). For POC2 either link the user manually in DEV bcregistry admin (Identity Provider Links tab on the user), or configure the first-broker-login flow to allow interactive link.
- **`redirect_uri_mismatch`** on login → `http://localhost:3001/login/callback` not added to the TEST bcregistry client's Valid Redirect URIs.
- **`403` from pay-api or auth-api** → user isn't a member of the selected account, or account doesn't have a payment method configured.
- **`404` from auth-api** → check the auth-api URL is correct; the `/users/@me/orgs` endpoint might have a slightly different path in this deployment. Adjust `getUserOrgs()` in `partner-backend/server.js` if needed.

## What POC2 skips

- Local Keycloak (both realms are cloud)
- Fake BCROS backend (uses real DEV pay-api + auth-api)
- Signature verification of the DEV BCROS token in partner-backend (still just decodes for POC purposes)

Everything else — the OIDC login, token exchange, org discovery, picker, invoice creation with `Account-Id` header — is the real production shape, just running from your laptop against DEV.
