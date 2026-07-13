# POC3 — JWT Authorization Grant (RFC 7523)

Local Keycloak demonstration of the **future-proof cross-realm identity federation pattern**. Uses JWT Authorization Grant instead of Legacy V1 Token Exchange (which is deprecated).

## Why POC3

- **POC1** proved the design works — but used Legacy V1 Token Exchange, which Keycloak marks for removal.
- **POC2** hit RH-SSO feature-flag walls (both V1 and JWT Bearer disabled) on real DEV.
- **POC3** proves the **same design works with JWT Authorization Grant** — the officially recommended long-term path — so the SSO team ask becomes "enable `jwt-bearer`" instead of the deprecated V1.

## What's the same as POC1

- Two realms (`partner`, `bcros`) in one local Keycloak container
- `partner-service` client on bcros realm for JWT bearer requests
- Same fake partner-web/backend and bcros-web/backend
- Same "one-time interactive link, silent afterward" user experience

## What's different

| Aspect | POC1 (Legacy V1) | POC3 (JWT Bearer Grant) |
|---|---|---|
| `KC_FEATURES` | `token-exchange,admin-fine-grained-authz` | (nothing needed on Keycloak 26.1+) |
| Grant type | `urn:ietf:params:oauth:grant-type:token-exchange` | `urn:ietf:params:oauth:grant-type:jwt-bearer` |
| Request body | `subject_token` + `subject_issuer` | `assertion` (the JWT itself) |
| Standards status | Deprecated | RFC 7523, current recommendation |
| Fine-grained-authz needed | Yes | No |

## Ports (same as POC1)

Stop POC1 first if it's running:

```bash
cd ../POC && docker compose down
cd ../POC3 && docker compose up
```

## One-time manual Keycloak setup

The realm import creates realms/clients but the JWT-Bearer-specific settings need admin console clicks (their JSON syntax varies per Keycloak version).

### 1. Add `partner-realm` as external OIDC IdP on bcros realm

Admin console (http://localhost:8080/admin, admin/admin) → `bcros` realm → **Identity providers** → **Add provider…** → **OpenID Connect v1.0**

- **Alias**: `partner-realm`
- **Use discovery endpoint**: ON
- **Discovery endpoint**: `http://keycloak:8080/realms/partner/.well-known/openid-configuration`
- **Client authentication**: `Client secret sent as post`
- **Client ID**: `partner-webapp`
- **Client Secret**: `not-used` (partner-webapp is public — value is placeholder)
- **Save**

### 2. Enable JWT Authorization Grant on the IdP

Same IdP (`partner-realm`) → tab **Settings** → scroll to **Authorization Grant Settings**:

- Toggle **JWT Authorization Grant** → **ON**
- **Issuer**: `http://localhost:8080/realms/partner` (must match what the partner-realm-issued JWTs put in `iss`)
- **Use JWKS URL**: ON
- **JWKS URL**: auto-filled from discovery
- **Allowed clock skew**: `60`
- **Save**

If **Authorization Grant Settings** section isn't visible → the Keycloak version doesn't expose JWT Bearer as a stable feature. Bump the image tag in `docker-compose.yml` to `26.2` or `latest`, or add `KC_FEATURES: jwt-bearer` (feature name may vary per release; check Keycloak release notes).

### 3. Enable JWT Authorization Grant on `partner-service` client

`bcros` realm → **Clients** → **partner-service** → tab **Settings** → **Capability config** section:

- Enable **JWT Authorization Grant** checkbox
- In **Allowed Identity Providers for JWT Authorization Grant** → select `partner-realm`
- **Save**

### 4. First-broker-login flow (unchanged from POC1)

- Duplicate `first broker login` → `first-broker-login-poc`
- Disable `Create User If Unique`
- In `Handle Existing Account` subflow, add:
  - `Detect Existing Broker User` (Required)
  - `Automatically Link Brokered Account` (Required)
- Point `partner-realm` IdP → First login flow at `first-broker-login-poc`

## Running the demo

```bash
docker compose up
```

Then open http://localhost:3000 → follow to Partner backend (:3001) → sign in via Partner realm → click Pay.

## Expected flow

1. User signs in (partner realm) — get a partner-realm access token in session.
2. Clicks Pay.
3. Partner backend calls:
   ```
   POST http://keycloak:8080/realms/bcros/protocol/openid-connect/token
   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
   assertion=<partner-realm access token>
   client_id=partner-service
   client_secret=partner-service-secret
   ```
4. **First payment ever for a user**: fails because bcros realm has no federated identity link. Partner backend catches, redirects browser through interactive linking → link written.
5. Retry JWT bearer grant → succeeds → org list → picker → invoice.
6. **Every subsequent Pay**: JWT bearer grant returns a token instantly, no browser redirect.

## Verification

After a successful Pay:

- BCROS user's **Identity Provider Links** tab shows a `partner-realm` link.
- Second Pay completes without browser flicker.
- Legacy V1 is **not enabled** — verify:
  ```bash
  curl -X POST http://localhost:8080/realms/bcros/protocol/openid-connect/token \
    -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
    -d "client_id=partner-service" -d "client_secret=partner-service-secret" \
    -d "subject_token=x" -d "subject_issuer=partner-realm"
  ```
  Should get `unsupported_grant_type` (V1 is off) or similar — NOT a token.

## The SSO team ask (once POC3 proves out)

> Please enable JWT Authorization Grant on DEV RH-SSO `bcregistry` realm. This is Keycloak's documented replacement for the deprecated Legacy Token Exchange V1, providing the same cross-realm identity federation capability via a stable, standards-based (RFC 7523) grant.
>
> Verification: `GET /realms/bcregistry/.well-known/openid-configuration` should include `urn:ietf:params:oauth:grant-type:jwt-bearer` in `grant_types_supported`.
>
> Comparison of options:
> - **JWT Authorization Grant** (this ask) — current recommended path, RFC 7523, standards-based, not deprecated
> - Legacy V1 Token Exchange — functionally equivalent but marked for removal in Keycloak
> - Standard TE V2 — does not support external tokens per Keycloak's own docs
>
> POC3 in this repo demonstrates the pattern with a local Keycloak. Only server-level feature enablement needed on RH-SSO; client-side code and realm config match this POC.

## Deliberate constraints in this POC

- **No `token-exchange` feature flag** — proves the pattern works without Legacy V1
- **No `admin-fine-grained-authz`** — JWT Bearer Grant doesn't need it
- **Same partner-backend UX as POC1** — swap one grant call, keep everything else

That's the surface area of the change SSO team is being asked to enable.
