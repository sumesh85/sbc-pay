# External-Realm Integration POC

A minimal, working demo of the cross-realm partner integration described in
[`docs/docs/partner-integration/external-realm-integration.md`](../docs/docs/partner-integration/external-realm-integration.md).

Everything runs in Docker Compose. All apps are fake (Node.js/Express) but wire together the real
OIDC flow — Partner-realm login via a shared external IdP (Google or GitHub), RFC 8693 token
exchange to BCROS realm with **silent auto-linking via a shared `idp_userid` attribute**, org
discovery, and a mock pay-api call with an explicit `Account-Id` header.

**No demo passwords needed.** Both realms use Google (or GitHub) as an external IdP, and Keycloak
stores that IdP's stable subject as user attribute `idp_userid` on both sides. Matching values on
both sides make the auto-link silent.

## What's included

| Service | Port | Role |
|---|---|---|
| Keycloak | 8080 | Hosts `partner` and `bcros` realms |
| partner-web | 3000 | Landing page for the fake customer app |
| partner-backend | 3001 | OIDC client for both realms; token exchange lives here |
| bcros-web | 3002 | Placeholder for BCROS auth-web / user portal |
| bcros-backend | 3003 | Fake sbc-auth (`/users/@me/orgs`) + fake pay-api (`/pay-api/payment-requests`) |
| Keycloak admin | http://localhost:8080/admin — `admin` / `admin` |

## Quick start

```bash
# from the POC/ directory
docker compose up
```

Wait for every service to log that it's up, then perform the one-time manual configuration below.

---

## One-time setup

### A. Create a Google OAuth 2.0 client (once, for the demo)

1. https://console.cloud.google.com/apis/credentials → Create OAuth 2.0 Client ID → Web application.
2. **Authorized redirect URIs** — add both:
   - `http://localhost:8080/realms/partner/broker/google/endpoint`
   - `http://localhost:8080/realms/bcros/broker/google/endpoint`
3. Save. Copy the **Client ID** and **Client Secret** — used twice below.

> Prefer GitHub? Fine — GitHub OAuth Apps only allow one callback URL, so you have to create two
> GitHub OAuth Apps (one per realm). Google is simpler.

### B. Register Google as an external IdP on both realms (populates `idp_userid`)

Repeat this **once for `partner` realm and once for `bcros` realm**:

1. Admin console → realm dropdown → pick the realm.
2. **Identity providers** → **Add provider…** → **Google**.
3. Paste **Client ID** and **Client Secret** from Step A.
4. Alias: `google` (default).
5. Save.
6. On the created Google IdP page → **Mappers** → **Add mapper**:
   - Name: `google-sub-to-idp-userid`
   - Sync mode: `Force`
   - Mapper type: **Attribute Importer**
   - Claim: `sub`
   - User attribute name: **`idp_userid`**
7. Save.

Now whenever any user logs into either realm via Google, that realm stores Google's `sub` as user
attribute `idp_userid`. Same person on both sides → same value on both sides.

**No changes needed on the client-side claim mapper** — the realm imports already include an
`idp_userid` claim mapper on both `partner-webapp` (Partner realm) and `partner-service` (BCROS
realm) clients. Tokens will carry `idp_userid` automatically once the attribute is populated.

### C. Register Partner realm as an external OIDC IdP on BCROS realm

In the `bcros` realm only:

1. **Identity providers** → **Add provider…** → **OpenID Connect v1.0**.
2. Fill in:
   - **Alias**: `partner-realm` (must match — this is what the Partner backend sends as `subject_issuer`)
   - **Display name**: `Partner Realm`
   - **Use discovery endpoint**: ON
   - **Discovery endpoint**: `http://keycloak:8080/realms/partner/.well-known/openid-configuration`
   - **Client authentication**: Client secret sent as post
   - **Client ID**: `partner-webapp`
   - **Client Secret**: leave empty (public client)
3. Save.
4. On the created IdP → **Mappers** → **Add mapper**:
   - Name: `import-idp-userid`
   - Sync mode: `Force`
   - Mapper type: **Attribute Importer**
   - Claim: `idp_userid`
   - User attribute name: `idp_userid`
5. Save.

Now when a Partner user is brokered into BCROS realm (via token exchange), their `idp_userid`
claim is copied to a user attribute on the (about-to-be-linked) shadow user.

### D. Configure BCROS's first-broker-login flow (no auto-create, auto-match on `idp_userid`)

In the `bcros` realm:

1. **Authentication** → tab **Flows** → duplicate **first broker login** →
   name the copy `first-broker-login-poc`.
2. In the copy:
   - **Disable** (or delete) "Create User If Unique".
   - Add **Automatically Set Existing User** as **REQUIRED** at the top of "Handle Existing Account"
     (or as a required alternative). Config: match by user attribute **`idp_userid`**.
   - Leave "Confirm Link Existing Account" + "Verify Existing Account by Re-authentication" as
     **ALTERNATIVE** (fallback if no match).
3. Go to **Identity providers** → `partner-realm` → set **First login flow** to
   `first-broker-login-poc` → **Save**.

### E. Enable Standard Token Exchange on `partner-service`

1. `bcros` realm → **Clients** → `partner-service` → tab **Permissions**.
2. **Permissions enabled**: ON.
3. Find the **token-exchange** permission → open it → in **Policies**, add a client policy allowing
   `partner-realm` (or leave open for POC).
4. Save.

> The client attribute `standard.token.exchange.enabled=true` is already set in the realm import.

---

## Running the demo

### Path 1 — Auto-link via `idp_userid` (the interesting demo)

1. **Bootstrap your BCROS account** — one time only:
   ```
   http://localhost:8080/realms/bcros/account
   ```
   Click **Sign in** → **Sign in with Google** → complete Google auth. BCROS realm creates a user
   for you with `idp_userid` set to your Google `sub`.

2. **Log into the Partner app**. Visit http://localhost:3000 → click through to Partner backend
   (:3001) → **Sign in** → Partner-realm login page → click **Sign in with Google** (same Google
   account). Partner realm creates its own user for you, with the same `idp_userid`.

3. **Click Pay via BCROS**. Under the hood:
   - Partner backend calls **token exchange** on BCROS Keycloak.
   - BCROS Keycloak has no shadow user for this Partner user → runs `first-broker-login-poc`
     **headlessly**.
   - Attribute Importer copies `idp_userid` from the Partner token onto the shadow user.
   - Automatically Set Existing User finds your existing BCROS user with the matching
     `idp_userid` → writes the federated identity link → issues the BCROS token.
   - Partner backend uses the BCROS token, calls fake sbc-auth `/users/@me/orgs`, gets the org
     list (keyed by email for demo convenience — see below), shows picker or auto-selects, creates
     invoice.

**No BCROS login prompt shown.** The linking is invisible.

### The hardcoded emails and orgs

The fake `bcros-backend` returns three specific org lists based on the token's email claim (a POC
convenience — real sbc-auth would key by BCROS user id):

| Google account email | BCROS orgs returned |
|---|---|
| `sumesh.punakkal@gmail.com` | **1** Sumesh Personal (PAD), **2** Sumesh Consulting Ltd. (DIRECT_PAY), **3** Sumesh Ventures Inc. (PAD) |
| `sumesh@daxiom.com` | **4** Daxiom Solutions Inc. (PAD), **5** Daxiom Consulting (no method — filtered), **6** Daxiom Ventures Ltd. (DIRECT_PAY) |
| any other Google account | `DEFAULT_ORGS` (900 / 901 / 902) |

Sign in with either of the two seeded Google accounts to see labelled data; any other Google
account still works and shows the picker via `DEFAULT_ORGS`.

### Path 2 — Interactive fallback (when auto-link can't match)

If a Partner user has no matching BCROS user (nothing with the same `idp_userid`), token exchange
fails with `invalid_grant`. Partner backend catches that and redirects the user through the
interactive linking flow — one-time redirect to BCROS Keycloak where the user proves ownership by
signing in with an existing BCROS account. No user action needed; it's automatic.

To exercise this: sign into Partner via Google account **A**, but never bootstrap BCROS with
account A. Click Pay → auto-link fails → redirected to BCROS Keycloak → prompted to sign in with
an existing BCROS account (use one you bootstrapped previously, e.g. Google account **B**) →
link established between Partner-A and BCROS-B → back to Pay flow.

---

## Where the design constraints show up

| Constraint | Where in the POC |
|---|---|
| BCROS Keycloak never calls sbc-auth | No custom authenticators; matching is stock "Automatically Set Existing User" on an attribute |
| Prerequisite BCROS account | "Create User If Unique" disabled on `first-broker-login-poc` — no auto-provisioning of BCROS users during token exchange |
| Auto-link only via a strong identifier | Match on `idp_userid` (Google's `sub`, cryptographically issued by a trusted third party), not on email |
| Account-Id passed explicitly to pay-api | `partner-backend/server.js` → `createInvoiceAndRender` sends the header |
| BCROS token doesn't carry a dynamic account | `bcros-backend` reads `Account-Id` header; email is only used to look up demo data |
| Partner realm changes are minimal | Google IdP + one mapper + the (already-imported) client claim mapper |

## Troubleshooting

**Auto-link fails, user hits the interactive prompt.**
- Decode the Partner-realm token at jwt.io — does it contain `idp_userid`?
  - If not: the Google IdP Attribute Importer mapper isn't firing on Partner realm. Confirm mapper
    is on the Google IdP entry, not on the realm generally.
  - Also confirm the user actually logged in via Google (not another IdP) so the attribute exists.
- Check the BCROS user's Attributes tab — does it have `idp_userid` set to the same value?
- Check the "Automatically Set Existing User" authenticator config in `first-broker-login-poc` —
  user attribute must be `idp_userid`.

**Token exchange returns `access_denied`.**
Step E. Also verify `partner-service` client has `standard.token.exchange.enabled=true` under
Advanced (already set in the realm import).

**Google IdP save fails with "invalid discovery".**
Container network / DNS issue. `docker compose logs keycloak`.

**Google redirect fails with "redirect_uri_mismatch".**
Verify the exact URIs in Google Cloud Console match the ones Keycloak uses (case-sensitive, no
trailing slash). Both realms need their own entry.

**IdP discovery URL fails when saving Step C.**
Use `http://keycloak:8080/...` (container hostname), not `http://localhost:8080/...`.

**Realm import didn't take effect.**
`docker compose down -v` then `docker compose up`. The `-v` flag clears Keycloak's H2 volume so
realms re-import.

## What this POC deliberately does NOT do

- Token signature verification in the fake backends (they decode JWTs unverified — POC only).
- HTTPS / secure cookies.
- Refresh-token handling.
- Real pay-api business logic (fees, payment methods beyond a mock enum).
- Real sbc-auth affiliation checks (pay-api simulates via email-based lookup only).
- Persistence — everything is in-memory and resets when containers restart.

These are all fine for demonstrating the identity + integration shape, but would need to be built
out for anything beyond a demo.
