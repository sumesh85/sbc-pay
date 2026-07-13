# Partner Setup Steps — Cross-Realm Identity Federation

Partners integrating with BCROS have two supported approaches for cross-realm identity federation:

1. **Token Exchange V1** — the interim option (Keycloak's Legacy Token Exchange)
2. **JWT Authorization Grant** — the recommended long-term option (RFC 7523)

Both achieve the same outcome: partner users transact with BCROS on the strength of a one-time identity link. This document lists the setup steps in each case.

---

## Approach 1 — Token Exchange V1

### Partner IdP / Keycloak setup

| Step | Detail |
|---|---|
| 1.1 | Have an OIDC-capable identity provider hosting your users (Keycloak realm, Auth0, Okta, custom OIDC — anything that issues signed JWT access tokens). |
| 1.2 | Ensure the OIDC discovery URL (`.../.well-known/openid-configuration`) is publicly reachable from BCROS SSO. |
| 1.3 | Ensure the JWKS URL referenced by discovery is publicly reachable and returns current signing keys. |
| 1.4 | Create/configure an OIDC client for your backend to handle the auth-code login flow for your users. Standard confidential client. |
| 1.5 | Add your backend's callback URL to the client's Valid Redirect URIs (e.g., `https://<partner-app>/login/callback`). |
| 1.6 | Add BCROS's broker endpoint URL to the client's Valid Redirect URIs — needed so BCROS can act as an OAuth client of your realm during the one-time linking flow. URL format: `https://<bcros-sso>/realms/bcros/broker/<partner-alias>/endpoint` (BCROS provides the alias during onboarding). |

### Partner application code

| Step | Detail |
|---|---|
| 2.1 | Implement standard OIDC authorization-code login flow against your own IdP. Store the user's access token in session. |
| 2.2 | Obtain from BCROS onboarding: `bcros_client_id`, `bcros_client_secret`, BCROS token endpoint URL, and the partner-realm alias configured on BCROS. |
| 2.3 | When a user initiates a payable action, call BCROS's token endpoint:<br/>```POST https://<bcros-sso>/realms/bcros/protocol/openid-connect/token``` <br/> body:<br/>```grant_type=urn:ietf:params:oauth:grant-type:token-exchange```<br/>```subject_token=<user's partner access token>```<br/>```subject_token_type=urn:ietf:params:oauth:token-type:access_token```<br/>```subject_issuer=<partner-alias>```<br/>```client_id=<bcros_client_id>```<br/>```client_secret=<bcros_client_secret>``` |
| 2.4 | On first attempt for a new user, the response will indicate the user isn't linked yet. Catch this and redirect the user's browser to BCROS's authorize endpoint with `kc_idp_hint=<partner-alias>` to trigger the one-time interactive linking flow. |
| 2.5 | On the linking callback returned to your backend, retry the token exchange call from step 2.3. It will now succeed. |
| 2.6 | Use the returned BCROS access token to call pay-api and other BCROS services. Pass `Account-Id` header with the target BCROS account when applicable. |
| 2.7 | On subsequent payments for the same user, the exchange succeeds immediately — no browser redirect. |

### What BCROS side does (for reference — not partner's action)

- Registers partner realm as external OIDC IdP with alias
- Grants token-exchange permission to partner-client on the IdP
- Issues `bcros_client_id` + `bcros_client_secret` + partner-realm alias to partner during onboarding

---

## Approach 2 — JWT Authorization Grant

### Partner IdP / Keycloak setup

| Step | Detail |
|---|---|
| 1.1 | Have an OIDC-capable identity provider hosting your users. |
| 1.2 | Ensure the OIDC discovery URL is publicly reachable from BCROS SSO. |
| 1.3 | Ensure the JWKS URL is publicly reachable and returns current signing keys. |
| 1.4 | Create/configure an OIDC client for your backend to handle auth-code login. |
| 1.5 | Add your backend's callback URL to Valid Redirect URIs. |
| 1.6 | **Configure token audience.** Access tokens issued to this client must include **exactly one audience**: `https://<bcros-sso>/realms/bcros` (the target realm URL). Two sub-steps: |
| 1.6a | Add a hardcoded Audience mapper on the client that adds `https://<bcros-sso>/realms/bcros` to access tokens. |
| 1.6b | Prevent default audiences from being auto-added. Either set **Full Scope Allowed = OFF** on the client, or remove the `roles` client scope from its defaults. Result: token has **only one** aud value, matching the BCROS realm URL. |
| 1.7 | (Optional) Add BCROS's broker endpoint to Valid Redirect URIs — same URL format as V1, only needed if you support the interactive linking fallback. |

### Partner application code

| Step | Detail |
|---|---|
| 2.1 | Implement standard OIDC authorization-code login. Store the user's access token **and refresh token** in session. |
| 2.2 | Obtain from BCROS onboarding: `bcros_client_id`, `bcros_client_secret`, BCROS token endpoint URL. (No IdP alias needed — the assertion's `iss` claim tells BCROS which IdP.) |
| 2.3 | **Before each JWT Bearer Grant call**, refresh the user's access token using the stored refresh token. Assertions are single-use in JWT Bearer Grant (Keycloak tracks the `jti`); resubmitting the same token fails with "Token reuse detected". |
| 2.4 | Call BCROS's token endpoint:<br/>```POST https://<bcros-sso>/realms/bcros/protocol/openid-connect/token``` <br/> body:<br/>```grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer```<br/>```assertion=<freshly-refreshed user access token>```<br/>```client_id=<bcros_client_id>```<br/>```client_secret=<bcros_client_secret>``` |
| 2.5 | On first attempt for a new user, the response will indicate the user isn't linked. Catch this and redirect the user's browser to BCROS's authorize endpoint with `kc_idp_hint=<partner-alias>` to trigger interactive linking (same flow as V1). |
| 2.6 | On the linking callback, refresh the token again (step 2.3) and retry the JWT bearer grant. It will now succeed. |
| 2.7 | Use the returned BCROS access token to call pay-api and other BCROS services. Pass `Account-Id` header with the target BCROS account when applicable. |
| 2.8 | On every subsequent payment: refresh user token → JWT bearer grant → call BCROS API. No browser redirect after first linking. |

### What BCROS side does (for reference — not partner's action)

- Registers partner realm as external OIDC IdP
- Enables "JWT Authorization Grant" toggle on the IdP
- Enables "JWT Authorization Grant" capability on partner-client + allows the partner-realm IdP
- (Optionally) Enables "Allows Client ID as audience for assertions" — allows partner tokens to use partner's client_id as audience instead of BCROS realm URL. Trade-off: non-standard, but simpler on the partner audience config.
- Issues `bcros_client_id` + `bcros_client_secret` to partner during onboarding

---

## Common to both approaches — interactive linking flow

The one-time linking flow is identical regardless of grant type. Partner code:

1. Detect the "not linked" error from the exchange/grant call.
2. Redirect user's browser to:<br/>```https://<bcros-sso>/realms/bcros/protocol/openid-connect/auth```<br/>with query params:<br/>- `client_id=<bcros_client_id>`<br/>- `redirect_uri=<partner-app>/link/callback`<br/>- `response_type=code`<br/>- `scope=openid`<br/>- `kc_idp_hint=<partner-alias>`
3. User completes: brokered through partner realm (silent — session exists), then BCROS's login page prompts them to confirm and prove ownership of their existing BCROS account (e.g., via BCSC).
4. BCROS Keycloak writes the federated identity link.
5. Browser returns to `redirect_uri` with `code=<auth-code>`.
6. Partner backend redirects the user back to the original destination (retry the payment).
7. Next exchange/grant call succeeds because the link now exists.

For scale (100k+ users): each user goes through this once. No admin intervention. No bulk linking.

---

## Side-by-side comparison of partner-side effort

| Aspect | V1 Token Exchange | JWT Authorization Grant |
|---|---|---|
| Partner realm changes | None beyond standard OIDC | Add audience mapper; ensure single audience in tokens |
| Redirect URIs to add | 2 (partner callback + BCROS broker) | 2 (same) |
| Token refresh before each call | Not required | **Required** (single-use assertions) |
| Grant type parameter | `subject_token` + `subject_issuer` | `assertion` |
| Interactive linking flow | Same | Same |
| Partner IdP requirement | Must be Keycloak-compatible OIDC | Any JWT-signing OIDC provider |
| Migration cost between approaches | ~10 LOC change in partner backend + one Keycloak mapper toggle | Same |
| Long-term durability | Deprecated (will be removed in future Keycloak versions) | Standards-based (RFC 7523), future-proof |
| Recommended for new integrations | No — use as short-term unblock only | **Yes** |

---

## Recommendation

- **For new partner integrations**: implement JWT Authorization Grant. Standards-based, works with any JWT-signing partner IdP, aligned with Keycloak's forward direction.
- **If BCROS is not yet ready with JWT Bearer Grant enabled**: implement V1 Token Exchange as a temporary bridge. Migration to JWT Bearer Grant is a ~10 line code change plus one Keycloak audience mapper — no schema or architecture changes.
- **For aggregator-style partners** (municipalities, health authorities, BPS — where the partner is the payer of record and end users are opaque): don't use either approach. Use `client_credentials` grant against BCROS and pass user references as tags on invoices. See separate aggregator integration guide.

---

## Related documents

- [External-realm integration design](external-realm-integration.md) — the overall pattern, sequence diagrams, failure paths
- [Credit card payment integration](credit-card-payment.md) — the partner-facing payment redirect flow (still needed after token federation for CC payments)
