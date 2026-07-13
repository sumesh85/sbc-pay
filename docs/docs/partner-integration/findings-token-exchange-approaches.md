# Findings: Token Exchange Approaches for Cross-Realm Partner Integration

Consolidated findings from three POCs exploring how partner applications on a different Keycloak realm can transact with BCROS on behalf of their users. Written for architecture review, management context, and future team onboarding.

## Summary

Three approaches to cross-realm identity federation were evaluated:

| Approach | Verdict | Status |
|---|---|---|
| Standard Token Exchange V2 (RFC 8693) | ✗ Does not solve our problem | Ruled out |
| Legacy V1 Token Exchange | ✓ Works but deprecated | Interim option |
| JWT Authorization Grant (RFC 7523) | ✓ Works, standards-based, future-proof | **Recommended** |

Two of three approaches have been proven end-to-end in local Keycloak environments. The third (V2) was ruled out based on official Keycloak documentation stating it does not support external tokens.

Attempted verification against BC Gov RH-SSO DEV `bcregistry` realm hit multiple server-level feature flags that are currently disabled. The specific ask to the SSO team is now well-scoped: enable one of two documented features.

## POCs conducted

### POC1 — Legacy V1 Token Exchange (local Keycloak)

**Location:** `POC/`
**Status:** ✓ Works end-to-end

- Two realms (`partner`, `bcros`) in one local Keycloak 26.0 container
- Server features enabled: `token-exchange,admin-fine-grained-authz`
- Partner backend uses `subject_issuer=partner-realm` parameter (V1 syntax)
- Demonstrates: user login → click Pay → interactive one-time link on first payment → silent every payment after
- **Purpose served:** proved the end-to-end design pattern works

### POC2 — Real BC Gov RH-SSO (TEST → DEV loginproxy)

**Location:** `POC2/`
**Status:** Blocked pending SSO team action

- Partner side: TEST loginproxy `bcregistry` realm
- BCROS side: DEV loginproxy `bcregistry` realm
- Partner-realm registered on DEV bcregistry as external OIDC IdP (already done)
- Two features disabled at server level blocking every path tried:
  - Legacy V1 Token Exchange (`token-exchange` server feature) — not enabled
  - `admin-fine-grained-authz` server feature — not enabled (verified via HTTP 501 on `/management/permissions` endpoints)
  - JWT Authorization Grant — not available (verified via `grant_types_supported` in discovery doc)
- Included diagnostic scripts (`diagnose.sh`, `check-fgap.sh`, `check-jwt-bearer.sh`) for reproducible verification of Keycloak feature state
- **Purpose served:** identified the specific server-level configuration gaps on RH-SSO

### POC3 — JWT Authorization Grant (local Keycloak 26.6)

**Location:** `POC3/`
**Status:** ✓ Works end-to-end

- Two realms (`partner`, `bcros`) in one local Keycloak 26.6 container
- Deliberately NO `token-exchange` server feature — proves the pattern works without V1
- Uses `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` with `assertion=<partner token>`
- Demonstrates: same UX as POC1 (user login → click Pay → one-time link → silent thereafter) but on the standards-based, non-deprecated grant
- **Purpose served:** proved JWT Authorization Grant produces identical outcomes to V1 for our use case, and is the correct target for the SSO team ask

## Technical findings by approach

### Standard Token Exchange V2

- Enabled by default on modern Keycloak (26+)
- **Does not support external tokens** (per official docs: "Standard token exchange supports only use-case (1)" — internal-to-internal only)
- "External" here means any token whose issuer is registered as an IdP on the target realm — includes tokens from another realm on the same Keycloak instance
- **Ruled out.** No amount of configuration makes V2 solve external-realm federation.

### Legacy V1 Token Exchange

- Requires `--features=token-exchange` server startup flag
- Requires `--features=admin-fine-grained-authz` for the client + IdP permission grants
- Uses `subject_issuer` parameter to identify the source IdP alias
- Marked **deprecated** in Keycloak docs; will be removed in a future major release
- Works reliably; POC1 demonstrated end-to-end
- **Not enabled on BC Gov RH-SSO** currently

### JWT Authorization Grant (RFC 7523)

- Available in Keycloak **26.5+ (preview)** and **26.6+ (GA)** per release notes
- Uses `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` with `assertion` parameter
- No `subject_issuer` — receiving realm identifies the source by matching the JWT's `iss` claim against a configured IdP
- Assertion `aud` must be a **single value** per strict RFC 7523; partner IdP must be configured to emit exactly one audience matching the target realm URL (or IdP client-id if the "Allows Client ID as audience" setting is enabled on BCROS side)
- Assertions are **single-use** (Keycloak tracks `jti`); partner backend must refresh the source access token before each grant call
- Does NOT require `admin-fine-grained-authz`
- Requires per-IdP + per-client capability toggles: "JWT Authorization Grant" ON on the IdP; "JWT Authorization Grant" ON on the client with the allowed IdPs listed
- **Not enabled on BC Gov RH-SSO** currently; verification via discovery doc showed `jwt-bearer` grant type not advertised

### Common to V1 and JWT Bearer

- **Interactive one-time linking flow** for first payment per user (browser redirect through BCROS Keycloak, user proves ownership of existing BCROS account, federated identity link written)
- **Silent every payment thereafter** — no browser redirects, no prompts
- **Same user experience end-to-end** — partner-side UX is identical
- **Same federated identity link mechanism** — the underlying `FEDERATED_IDENTITY` row Keycloak writes is the same
- **Different linking mechanisms possible** — email match, username match, `idp_userid` attribute, or interactive re-auth (BCROS uses interactive to avoid email dependency since not all BCROS users have email)

## Verified state of BC Gov RH-SSO

Verified 2026-07-10 on DEV `bcregistry` realm via automated probing:

| Feature | State |
|---|---|
| Standard Token Exchange V2 | Enabled (default) — but doesn't help |
| Legacy V1 Token Exchange | **Disabled** |
| JWT Authorization Grant | **Disabled** (not in `grant_types_supported`) |
| `admin-fine-grained-authz` | **Disabled** (HTTP 501 on permissions endpoints) |
| Realm-level Admin Permissions (KC 26 new feature) | Enabled but different concern — for admin-operation delegation, not token exchange authorization |

Access constraints during investigation:
- Realm admin access to `bcregistry` only, not `master`
- Cannot see Server Info (master realm access required)
- Cannot enable server-level features (SSO/platform team responsibility)
- Keycloak minor version could not be verified directly; inferred from feature availability

## Recommendation

**Target JWT Authorization Grant as the strategic long-term path.** Reasons:

1. **Standards-based (RFC 7523)** — same primitive used by GCP service accounts, Salesforce, Auth0, and many other identity products. Partner integrators already know how to build against it.
2. **Not deprecated** — Keycloak's own docs recommend it as the modern replacement for Legacy V1.
3. **Broader partner universe** — any JWT-signing identity provider (Auth0, Okta, custom OIDC, Firebase Auth, cloud service accounts) can integrate, not just Keycloak-hosted realms.
4. **Enables new patterns** — machine identity federation, asymmetric linking (user arrives via low-assurance IdP but proves BCSC once during linking), attested claims.
5. **No `admin-fine-grained-authz` dependency** — simpler configuration model.

**As an interim if timing pressures require:** enable Legacy V1 Token Exchange on RH-SSO. Migration to JWT Bearer Grant is a small partner-side change (~10 lines of backend code plus one Keycloak audience mapper) that we can facilitate later.

## Open items / dependencies

### SSO / platform team ask

> Please enable **JWT Authorization Grant** on RH-SSO instances (DEV first, then TEST/PROD). This is Keycloak's documented replacement for Legacy Token Exchange V1 and enables cross-realm partner identity federation for BC Registries services.
>
> **Verification:** the discovery endpoint should include `urn:ietf:params:oauth:grant-type:jwt-bearer` in `grant_types_supported`. Included scripts (`POC2/check-jwt-bearer.sh`) provide before/after verification.
>
> **If JWT Authorization Grant is not immediately feasible:** enable Legacy V1 Token Exchange (`--features=token-exchange,admin-fine-grained-authz`) as a bridge. Both are additive (no breaking impact on existing flows).
>
> **Version requirement for JWT Bearer:** Keycloak ≥26.5 (preview) or ≥26.6 (GA). If RH-SSO is on an earlier 26.x, an upgrade is needed. Current version could not be verified from realm-admin access; SSO team can confirm.

### Partner-facing documentation

- Setup steps for both approaches: [`partner-setup-steps.md`](partner-setup-steps.md)
- Overall design and sequence diagrams: [`external-realm-integration.md`](external-realm-integration.md)

### Additional design considerations for future iterations

- **Aggregator model** (`client_credentials`, no user federation) is a separate but complementary pattern for municipalities / BPS / health-authority partners where the partner is the payer of record. Documented separately; different set of trade-offs.
- **Asymmetric linking** (low-assurance IdP arrival + high-assurance IdP proof) is a natural capability of JWT Bearer Grant. Documented in [`external-realm-integration.md`](external-realm-integration.md).
- **Per-vendor identity mapping** (handling pairwise `sub` values from non-Google IdPs) may need a small BCROS-side mapping table if partner IdPs configure pairwise identifiers. Future consideration.

## Local reproduction

All three POCs are reproducible locally:

```bash
# POC1 (V1 Token Exchange)
cd POC && docker compose up

# POC3 (JWT Authorization Grant)
cd POC3 && docker compose up

# Feature-state checks against any Keycloak
./POC2/check-fgap.sh <kc-url> <realm> <client> <secret>
./POC2/check-jwt-bearer.sh <kc-url> <realm> <client> <secret>
```

## References

- Keycloak Token Exchange docs: https://www.keycloak.org/securing-apps/token-exchange
- Keycloak JWT Authorization Grant docs: https://www.keycloak.org/securing-apps/jwt-authorization-grant
- RFC 8693 (Standard Token Exchange): https://datatracker.ietf.org/doc/html/rfc8693
- RFC 7523 (JWT Authorization Grant): https://datatracker.ietf.org/doc/html/rfc7523
- Keycloak GitHub issue confirming V2 does not support external tokens: https://github.com/keycloak/keycloak/issues/43392
