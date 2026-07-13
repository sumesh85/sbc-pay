const express = require('express');
const session = require('express-session');
const axios = require('axios');
const qs = require('querystring');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: 'poc2-partner-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

// -------- Partner side (TEST loginproxy bcregistry) --------
const PARTNER_KC_URL = process.env.PARTNER_KC_URL;
const PARTNER_REALM = process.env.PARTNER_REALM;
const PARTNER_CLIENT_ID = process.env.PARTNER_CLIENT_ID;
const PARTNER_CLIENT_SECRET = process.env.PARTNER_CLIENT_SECRET;

// -------- BCROS side (DEV loginproxy bcregistry) --------
const BCROS_KC_URL = process.env.BCROS_KC_URL;
const BCROS_REALM = process.env.BCROS_REALM;
const BCROS_CLIENT_ID = process.env.BCROS_CLIENT_ID;
const BCROS_CLIENT_SECRET = process.env.BCROS_CLIENT_SECRET;
const BCROS_SUBJECT_ISSUER = process.env.BCROS_SUBJECT_ISSUER || 'partner-realm';

// -------- Real DEV APIs --------
const BCROS_PAY_API = process.env.BCROS_PAY_API;
const BCROS_AUTH_API = process.env.BCROS_AUTH_API;

const SELF = 'http://localhost:3001';

function decodeJwt(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
}

function layout(title, body) {
  return `<!doctype html><html><head><title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 800px; margin: 3rem auto; padding: 0 1rem; }
      a.button, button { display: inline-block; padding: 0.6rem 1.2rem; background: #1976d2;
        color: #fff; text-decoration: none; border-radius: 6px; margin: 0.3rem 0.3rem 0.3rem 0;
        border: none; font: inherit; cursor: pointer; }
      a.button.secondary { background: #666; }
      a.button.warn { background: #d32f2f; }
      pre { background: #f5f5f5; padding: 0.8rem; border-radius: 4px; overflow-x: auto; font-size: 12px; }
      .step { background: #fff8e1; padding: 0.8rem; border-radius: 6px; margin-bottom: 1rem; }
      .info { background: #e3f2fd; padding: 0.8rem; border-radius: 6px; margin-bottom: 1rem; }
      small { color: #666; }
    </style></head><body>${body}</body></html>`;
}

// ------- Home -------
app.get('/', (req, res) => {
  const u = req.session.user;
  if (!u) {
    return res.type('html').send(layout('POC2 Partner Backend', `
      <h1>Partner Backend — POC2 (real DEV BCROS)</h1>
      <p>Sign in via the TEST bcregistry realm to try a payment through real DEV BCROS APIs.</p>
      <a class="button" href="/login">Sign in</a>
      <div class="info">
        <p>Partner realm: <code>${PARTNER_KC_URL}/realms/${PARTNER_REALM}</code></p>
        <p>BCROS realm: <code>${BCROS_KC_URL}/realms/${BCROS_REALM}</code></p>
      </div>
    `));
  }
  return res.type('html').send(layout('POC2 Partner Backend', `
    <h1>Partner Backend — POC2</h1>
    <div class="step">
      <p>Signed in as: <b>${u.username}</b> ${u.email ? '&lt;' + u.email + '&gt;' : ''}</p>
      <p><small>Sub: <code>${u.sub}</code></small></p>
    </div>
    <div class="info">
      <p>Filing: <b>BC Annual Report</b> — Fee: <b>$30.00</b> (test)</p>
    </div>
    <a class="button" href="/pay">Pay via BCROS</a>
    <a class="button secondary" href="/debug/exchange">Debug: show exchange token</a>
    <a class="button secondary" href="/logout">Logout</a>
  `));
});

// ------- Login via TEST bcregistry -------
app.get('/login', (_req, res) => {
  const url = `${PARTNER_KC_URL}/realms/${PARTNER_REALM}/protocol/openid-connect/auth` +
    `?client_id=${encodeURIComponent(PARTNER_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(SELF + '/login/callback')}` +
    `&response_type=code&scope=openid%20email%20profile`;
  res.redirect(url);
});

app.get('/login/callback', async (req, res) => {
  try {
    const { code } = req.query;
    console.log('[login/callback] exchanging code for partner token');
    const body = {
      grant_type: 'authorization_code',
      code,
      client_id: PARTNER_CLIENT_ID,
      redirect_uri: SELF + '/login/callback'
    };
    if (PARTNER_CLIENT_SECRET) body.client_secret = PARTNER_CLIENT_SECRET;
    const resp = await axios.post(
      `${PARTNER_KC_URL}/realms/${PARTNER_REALM}/protocol/openid-connect/token`,
      qs.stringify(body)
    );
    const partnerToken = resp.data.access_token;
    const claims = decodeJwt(partnerToken);
    req.session.user = {
      username: claims.preferred_username || claims.username || claims.sub,
      email: claims.email || null,
      sub: claims.sub,
      partnerToken
    };
    console.log(`[login/callback] logged in as ${req.session.user.username}`);
    res.redirect('/');
  } catch (e) {
    console.error('[login/callback] failed:', e.response?.data || e.message);
    res.status(500).send(errorPage('Partner login failed', e));
  }
});

// ------- Pay flow: JWT Bearer grant → org list → picker → invoice -------
app.get('/pay', async (req, res) => {
  const u = req.session.user;
  if (!u) return res.redirect('/');
  console.log(`[pay] user=${u.username} attempting JWT bearer grant`);
  let bcrosToken;
  try {
    bcrosToken = await jwtBearerGrant(u.partnerToken);
    console.log(`[pay] JWT bearer grant SUCCESS`);
    req.session.bcrosToken = bcrosToken;
  } catch (e) {
    const errBody = e.response?.data;
    console.log(`[pay] JWT bearer grant FAILED status=${e.response?.status} body=${JSON.stringify(errBody)}`);
    return res.status(500).send(errorPage('JWT bearer grant failed', e));
  }

  try {
    const orgs = await getUserOrgs(bcrosToken);
    console.log(`[pay] got ${orgs.length} orgs from auth-api`);
    const usable = orgs.filter(o => o.paymentSettings?.paymentMethod || o.paymentMethod);
    if (usable.length === 0) {
      return res.type('html').send(layout('No usable orgs', `
        <h1>No BCROS orgs with a usable payment method</h1>
        <p>Signed in as ${u.username} but auth-api returned no orgs that can pay.</p>
        <details><summary>Raw response</summary><pre>${JSON.stringify(orgs, null, 2)}</pre></details>
        <a class="button" href="/">Home</a>`));
    }
    if (usable.length === 1) {
      return await createInvoiceAndRender(res, usable[0], bcrosToken);
    }
    let html = `<h1>Choose a BCROS account</h1><p>Your BCROS user has multiple accounts:</p>`;
    for (const o of usable) {
      const method = o.paymentSettings?.paymentMethod || o.paymentMethod || '(unknown)';
      html += `<div class="step">
        <b>${o.name || 'Account'}</b> — payment method: ${method}<br/>
        <small>Account id: ${o.id}${o.branchName ? ' · ' + o.branchName : ''}</small><br/>
        <a class="button" href="/pay/confirm?accountId=${o.id}">Pay with this account</a>
      </div>`;
    }
    html += `<a class="button secondary" href="/">Cancel</a>`;
    res.type('html').send(layout('Pick account', html));
  } catch (e) {
    console.error('[pay] downstream call failed:', e.response?.data || e.message);
    res.status(500).send(errorPage('Downstream API call failed', e));
  }
});

app.get('/pay/confirm', async (req, res) => {
  try {
    const bcrosToken = req.session.bcrosToken;
    const accountId = req.query.accountId;
    const orgs = await getUserOrgs(bcrosToken);
    const org = orgs.find(o => String(o.id) === String(accountId));
    if (!org) return res.status(400).send('Invalid account');
    await createInvoiceAndRender(res, org, bcrosToken);
  } catch (e) {
    res.status(500).send(errorPage('Invoice creation failed', e));
  }
});

// ------- Debug: show TEST partner token contents (for manual linking) -------
app.get('/debug/partner-token', (req, res) => {
  const u = req.session.user;
  if (!u) return res.redirect('/');
  const claims = decodeJwt(u.partnerToken);
  res.type('html').send(layout('TEST partner token', `
    <h1>TEST partner token (for manual link setup)</h1>
    <div class="step">
      <p><b>To manually create the federated identity link on your DEV BCROS user:</b></p>
      <p>1. DEV bcregistry admin → Users → find <code>${claims.preferred_username}</code></p>
      <p>2. Tab "Identity Provider Links" → Add</p>
      <p>3. Fill in:</p>
      <ul>
        <li>Identity Provider: <b>partner-realm</b></li>
        <li>User ID: <code>${claims.sub}</code></li>
        <li>User Name: <code>${claims.preferred_username}</code></li>
      </ul>
      <p>4. Save. Retry Pay — should succeed silently now.</p>
    </div>
    <h3>Full decoded claims</h3>
    <pre>${JSON.stringify(claims, null, 2)}</pre>
    <h3>Raw TEST token (for deep-debug.sh)</h3>
    <pre style="word-break:break-all;white-space:pre-wrap;font-size:11px;">${u.partnerToken}</pre>
    <a class="button" href="/">Home</a>
  `));
});

// ------- Debug: show the BCROS token contents -------
app.get('/debug/exchange', async (req, res) => {
  const u = req.session.user;
  if (!u) return res.redirect('/');
  try {
    const bcrosToken = await tokenExchange(u.partnerToken);
    const claims = decodeJwt(bcrosToken);
    res.type('html').send(layout('BCROS token', `
      <h1>BCROS access token (from token exchange)</h1>
      <p><small>Raw JWT:</small></p>
      <pre style="word-break:break-all; white-space:pre-wrap;">${bcrosToken}</pre>
      <p><small>Decoded claims:</small></p>
      <pre>${JSON.stringify(claims, null, 2)}</pre>
      <a class="button" href="/">Home</a>
    `));
  } catch (e) {
    res.status(500).send(errorPage('Token exchange failed', e));
  }
});

// ------- Helpers -------
async function getServiceAccountToken() {
  // Aggregator model: partner-backend authenticates as itself using client_credentials
  // against DEV bcregistry. The resulting token represents the partner-client service
  // account, which must be a member of the intended BCROS org in DEV sbc-auth.
  const resp = await axios.post(
    `${BCROS_KC_URL}/realms/${BCROS_REALM}/protocol/openid-connect/token`,
    qs.stringify({
      grant_type: 'client_credentials',
      client_id: BCROS_CLIENT_ID,
      client_secret: BCROS_CLIENT_SECRET
    })
  );
  const claims = decodeJwt(resp.data.access_token);
  console.log(`[getServiceAccountToken] token issued for sub=${claims.sub} preferred_username=${claims.preferred_username}`);
  return resp.data.access_token;
}

async function jwtBearerGrant(partnerToken) {
  // JWT Authorization Grant (RFC 7523). Keycloak's supported path for using an
  // external-realm-issued JWT to obtain a receiving-realm token. Standard Token
  // Exchange V2 does NOT support external tokens — this is the documented
  // replacement for that use case.
  const partnerClaims = decodeJwt(partnerToken);
  const header = JSON.parse(Buffer.from(partnerToken.split('.')[0], 'base64').toString());
  console.log(`[jwtBearerGrant] JWT HEADER: ${JSON.stringify(header)}`);
  console.log(`[jwtBearerGrant] assertion iss=${partnerClaims.iss} aud=${JSON.stringify(partnerClaims.aud)} sub=${partnerClaims.sub}`);

  const resp = await axios.post(
    `${BCROS_KC_URL}/realms/${BCROS_REALM}/protocol/openid-connect/token`,
    qs.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: partnerToken,
      client_id: BCROS_CLIENT_ID,
      client_secret: BCROS_CLIENT_SECRET,
      scope: 'openid email profile'
    })
  );
  return resp.data.access_token;
}

// Legacy token exchange kept for reference — Keycloak V2 doesn't accept external
// tokens via this grant, per official docs.
async function tokenExchange(partnerToken) {
  const partnerClaims = decodeJwt(partnerToken);
  const header = JSON.parse(Buffer.from(partnerToken.split('.')[0], 'base64').toString());
  console.log(`[tokenExchange] JWT HEADER: ${JSON.stringify(header)}`);
  console.log(`[tokenExchange] subject token iss=${partnerClaims.iss} aud=${JSON.stringify(partnerClaims.aud)} payload_typ=${partnerClaims.typ} azp=${partnerClaims.azp}`);

  const attempts = [
    // Standard TE (RFC 8693), no subject_issuer
    {
      label: 'standard-TE access_token',
      params: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: partnerToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        client_id: BCROS_CLIENT_ID,
        client_secret: BCROS_CLIENT_SECRET,
        scope: 'openid email profile'
      }
    },
    // Legacy TE (Keycloak-specific), with subject_issuer
    {
      label: 'legacy-TE access_token + subject_issuer',
      params: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: partnerToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        subject_issuer: BCROS_SUBJECT_ISSUER,
        client_id: BCROS_CLIENT_ID,
        client_secret: BCROS_CLIENT_SECRET,
        scope: 'openid email profile'
      }
    },
    // Legacy TE with requested_issuer
    {
      label: 'legacy-TE with requested_issuer',
      params: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: partnerToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        requested_issuer: BCROS_SUBJECT_ISSUER,
        client_id: BCROS_CLIENT_ID,
        client_secret: BCROS_CLIENT_SECRET,
        scope: 'openid email profile'
      }
    }
  ];

  let lastErr;
  for (const attempt of attempts) {
    try {
      console.log(`[tokenExchange] trying ${attempt.label}`);
      const resp = await axios.post(
        `${BCROS_KC_URL}/realms/${BCROS_REALM}/protocol/openid-connect/token`,
        qs.stringify(attempt.params)
      );
      console.log(`[tokenExchange] SUCCESS with ${attempt.label}`);
      return resp.data.access_token;
    } catch (e) {
      const status = e.response?.status;
      const body = JSON.stringify(e.response?.data);
      console.log(`[tokenExchange] failed with ${attempt.label}: status=${status} body=${body}`);
      lastErr = e;
    }
  }
  throw lastErr;
}

async function getUserOrgs(bcrosToken) {
  // sbc-auth's endpoint that returns the user's org memberships
  const resp = await axios.get(`${BCROS_AUTH_API}/users/@me/orgs`, {
    headers: { Authorization: `Bearer ${bcrosToken}` }
  });
  return resp.data?.orgs || resp.data || [];
}

async function createInvoiceAndRender(res, org, bcrosToken) {
  const payload = {
    businessInfo: {
      // TODO: replace with a real DEV business identifier / corp type
      businessIdentifier: process.env.TEST_BUSINESS_IDENTIFIER || 'BC0871427',
      corpType: process.env.TEST_CORP_TYPE || 'BEN'
    },
    filingInfo: {
      filingTypes: [
        { filingTypeCode: process.env.TEST_FILING_TYPE || 'BCANN' }
      ]
    },
    // Partner-side reference (Shopify-style tag) — echoed on the invoice for reconciliation
    accountInfo: {
      folioNumber: `poc2-${Date.now()}`
    }
  };
  console.log(`[pay] creating invoice on org=${org.id} payload=${JSON.stringify(payload)}`);
  try {
    const resp = await axios.post(
      `${BCROS_PAY_API}/payment-requests`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${bcrosToken}`,
          'Account-Id': org.id,
          'Content-Type': 'application/json'
        }
      }
    );
    res.type('html').send(layout('Invoice created', `
      <h1>Invoice created (DEV pay-api)</h1>
      <div class="step">
        <p>Charged to: <b>${org.name || 'org'}</b> (account id ${org.id})</p>
      </div>
      <h3>Response from DEV pay-api</h3>
      <pre>${JSON.stringify(resp.data, null, 2)}</pre>
      <a class="button" href="/">Home</a>`));
  } catch (e) {
    const body = e.response?.data ? JSON.stringify(e.response.data, null, 2) : e.message;
    res.status(500).send(layout('Invoice creation failed', `
      <h1>DEV pay-api rejected the request</h1>
      <pre>Status: ${e.response?.status}\nBody: ${body}</pre>
      <p>Common causes: invalid businessIdentifier/corpType for DEV, account has no payment method, service account not authorized for this org.</p>
      <a class="button" href="/">Home</a>`));
  }
}

function errorPage(title, e) {
  const body = e.response?.data ? JSON.stringify(e.response.data, null, 2) : e.message;
  return layout(title, `
    <h1>${title}</h1>
    <pre>${body}</pre>
    <a class="button" href="/">Home</a>`);
}

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.listen(3001, () => {
  console.log('Partner backend running on http://localhost:3001');
  console.log(`Partner realm: ${PARTNER_KC_URL}/realms/${PARTNER_REALM}`);
  console.log(`BCROS realm:   ${BCROS_KC_URL}/realms/${BCROS_REALM}`);
});
