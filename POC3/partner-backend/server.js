const express = require('express');
const session = require('express-session');
const axios = require('axios');
const qs = require('querystring');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'partner-poc-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

const KC_INTERNAL = process.env.KC_INTERNAL || 'http://keycloak:8080';
const KC_PUBLIC = process.env.KC_PUBLIC || 'http://localhost:8080';
const PARTNER_REALM = process.env.PARTNER_REALM || 'partner';
const BCROS_REALM = process.env.BCROS_REALM || 'bcros';
const PARTNER_CLIENT_ID = process.env.PARTNER_CLIENT_ID || 'partner-webapp';
const BCROS_CLIENT_ID = process.env.BCROS_CLIENT_ID || 'partner-service';
const BCROS_CLIENT_SECRET = process.env.BCROS_CLIENT_SECRET || 'partner-service-secret';
const BCROS_BACKEND_URL = process.env.BCROS_BACKEND_URL || 'http://bcros-backend:3003';

const SELF = 'http://localhost:3001';

// Optional cache — partner side never *requires* this. Token exchange itself is
// authoritative: if it succeeds, the user is (or was just) linked; if it fails
// with invalid_grant, we fall back to the interactive linking flow.
const partnerUserDb = {};

function decodeJwt(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
}

function layout(title, body) {
  return `<!doctype html><html><head><title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; }
      a.button, button { display: inline-block; padding: 0.6rem 1.2rem; background: #1976d2;
        color: #fff; text-decoration: none; border-radius: 6px; margin: 0.3rem 0.3rem 0.3rem 0;
        border: none; font: inherit; cursor: pointer; }
      a.button.secondary { background: #666; }
      a.button.warn { background: #d32f2f; }
      pre { background: #f5f5f5; padding: 0.8rem; border-radius: 4px; overflow-x: auto; }
      .step { background: #fff8e1; padding: 0.8rem; border-radius: 6px; margin-bottom: 1rem; }
      .info { background: #e3f2fd; padding: 0.8rem; border-radius: 6px; margin-bottom: 1rem; }
      .ok { color: #2e7d32; } .no { color: #d32f2f; }
      small { color: #666; }
    </style></head><body>${body}</body></html>`;
}

// ------- Home -------
app.get('/', (req, res) => {
  const u = req.session.user;
  if (!u) {
    return res.type('html').send(layout('Partner backend', `
      <h1>Partner App</h1>
      <p>Sign in with your Partner-realm account to try a payment.</p>
      <a class="button" href="/login">Sign in</a>
    `));
  }
  return res.type('html').send(layout('Partner backend', `
    <h1>Partner App</h1>
    <div class="step">
      <p>Signed in as: <b>${u.username}</b> ${u.email ? `&lt;${u.email}&gt;` : ''} (Partner realm)</p>
      <p><small>Sub: <code>${u.sub}</code></small></p>
    </div>
    <div class="info">
      <p>Filing: <b>BC Annual Report</b> — Fee: <b>$30.00</b></p>
    </div>
    <a class="button" href="/pay">Pay via BCROS</a>
    <a class="button secondary" href="/debug/tokens">View tokens</a>
    <a class="button warn" href="/link/reset">Reset link cache (demo)</a>
    <a class="button secondary" href="/logout">Logout</a>
    <p><small>Linking is automatic on Pay. You'll only see a sign-in prompt if the auto-link can't find a matching BCROS user.</small></p>
  `));
});

// ------- Debug: show both tokens with decoded claims -------
app.get('/debug/tokens', async (req, res) => {
  const u = req.session.user;
  if (!u) return res.redirect('/');

  const partnerHeader = JSON.parse(Buffer.from(u.partnerToken.split('.')[0], 'base64').toString());
  const partnerClaims = decodeJwt(u.partnerToken);

  // Try to get a BCROS token — either from session cache or by doing a fresh grant
  let bcrosToken = req.session.bcrosToken;
  let bcrosNote = 'from previous Pay';
  if (!bcrosToken) {
    try {
      const fresh = await refreshPartnerToken(u);
      bcrosToken = await tokenExchange(fresh);
      req.session.bcrosToken = bcrosToken;
      bcrosNote = 'freshly obtained via JWT Bearer Grant';
    } catch (e) {
      bcrosNote = `unavailable — grant failed: ${e.response?.data?.error_description || e.message}`;
    }
  }

  let bcrosSection = '';
  if (bcrosToken) {
    const bcrosHeader = JSON.parse(Buffer.from(bcrosToken.split('.')[0], 'base64').toString());
    const bcrosClaims = decodeJwt(bcrosToken);
    bcrosSection = `
      <h2 style="color:#2e7d32;">BCROS realm token (${bcrosNote})</h2>
      <p><small>Issued by <code>${bcrosClaims.iss}</code></small></p>
      <h4>Header</h4>
      <pre>${JSON.stringify(bcrosHeader, null, 2)}</pre>
      <h4>Payload (decoded claims)</h4>
      <pre>${JSON.stringify(bcrosClaims, null, 2)}</pre>
      <h4>Raw JWT</h4>
      <pre style="word-break:break-all;white-space:pre-wrap;font-size:11px;">${bcrosToken}</pre>`;
  } else {
    bcrosSection = `
      <h2 style="color:#d32f2f;">BCROS realm token</h2>
      <p>${bcrosNote}</p>`;
  }

  res.type('html').send(layout('Tokens', `
    <h1>Tokens for ${u.username}</h1>
    <p><a class="button secondary" href="/">Home</a></p>

    <h2 style="color:#1976d2;">Partner realm token</h2>
    <p><small>Issued by <code>${partnerClaims.iss}</code></small></p>
    <h4>Header</h4>
    <pre>${JSON.stringify(partnerHeader, null, 2)}</pre>
    <h4>Payload (decoded claims)</h4>
    <pre>${JSON.stringify(partnerClaims, null, 2)}</pre>
    <h4>Raw JWT</h4>
    <pre style="word-break:break-all;white-space:pre-wrap;font-size:11px;">${u.partnerToken}</pre>

    <hr/>
    ${bcrosSection}

    <p><a class="button secondary" href="/">Home</a></p>
  `));
});

// ------- Partner-realm login (OAuth code flow) -------
app.get('/login', (_req, res) => {
  const url = `${KC_PUBLIC}/realms/${PARTNER_REALM}/protocol/openid-connect/auth` +
    `?client_id=${PARTNER_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(SELF + '/login/callback')}` +
    `&response_type=code&scope=openid%20email%20profile`;
  res.redirect(url);
});

app.get('/login/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const resp = await axios.post(
      `${KC_INTERNAL}/realms/${PARTNER_REALM}/protocol/openid-connect/token`,
      qs.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: PARTNER_CLIENT_ID,
        redirect_uri: SELF + '/login/callback'
      })
    );
    const partnerToken = resp.data.access_token;
    const refreshToken = resp.data.refresh_token;
    const claims = decodeJwt(partnerToken);
    req.session.user = {
      username: claims.preferred_username,
      email: claims.email || null,
      sub: claims.sub,
      partnerToken,
      refreshToken
    };
    res.redirect('/');
  } catch (e) {
    res.status(500).send(errorPage('Partner login failed', e));
  }
});

// ------- Pay (attempts JWT Bearer Grant; falls back to /link on invalid_grant) -------
app.get('/pay', async (req, res) => {
  const u = req.session.user;
  if (!u) return res.redirect('/');
  console.log(`[pay] user=${u.username} attempting JWT bearer grant`);

  // Refresh partner-realm token — JWT Bearer assertions are one-use.
  let freshPartnerToken;
  try {
    freshPartnerToken = await refreshPartnerToken(u);
  } catch (e) {
    console.log(`[pay] refresh failed → re-login required: ${e.message}`);
    req.session.destroy(() => res.redirect('/'));
    return;
  }

  // Loop protection: don't ping-pong between /pay and /link
  req.session.payAttempts = (req.session.payAttempts || 0) + 1;
  if (req.session.payAttempts > 2) {
    req.session.payAttempts = 0;
    return res.status(500).send(errorPage('Link failed after retry',
      new Error('JWT bearer grant still fails after interactive linking; ' +
                'check that /link/callback actually established the federated identity link on the BCROS user.')));
  }

  let bcrosToken;
  try {
    bcrosToken = await tokenExchange(freshPartnerToken);
    console.log(`[pay] JWT bearer grant SUCCESS for ${u.username}`);
    req.session.bcrosToken = bcrosToken;
    req.session.payAttempts = 0;
    partnerUserDb[u.username] = { bcrosLinked: true };
  } catch (e) {
    const errBody = e.response?.data;
    console.log(`[pay] JWT bearer grant FAILED for ${u.username}: status=${e.response?.status} body=${JSON.stringify(errBody)}`);
    if (isNeedsLinkError(e)) {
      console.log(`[pay] classified as needs-link → redirecting to /link (attempt ${req.session.payAttempts})`);
      delete partnerUserDb[u.username];
      return res.redirect('/link?returnTo=/pay');
    }
    console.log(`[pay] not classified as needs-link → returning 500`);
    return res.status(500).send(errorPage('JWT bearer grant failed', e));
  }

  try {
    // (2) Fetch orgs
    const orgs = await getUserOrgs(bcrosToken);
    // (3) Decide
    const usable = orgs.filter(o => o.paymentMethod);
    if (usable.length === 0) {
      return res.type('html').send(layout('No payment setup', `
        <h1>No BCROS payment method</h1>
        <p>Your BCROS accounts have no payment method configured.</p>
        <a class="button" href="/">Home</a>`));
    }
    if (usable.length === 1) {
      return await createInvoiceAndRender(res, usable[0], bcrosToken);
    }
    // Picker
    let html = `<h1>Choose a BCROS account</h1>
      <p>Your BCROS user has multiple accounts. Pick one to charge:</p>`;
    for (const o of usable) {
      html += `<div class="step">
        <b>${o.name}</b> — payment method: ${o.paymentMethod}<br/>
        <small>Account id: ${o.id}</small><br/>
        <a class="button" href="/pay/confirm?accountId=${o.id}">Pay with this account</a>
      </div>`;
    }
    html += `<a class="button secondary" href="/">Cancel</a>`;
    res.type('html').send(layout('Pick account', html));
  } catch (e) {
    res.status(500).send(errorPage('Pay flow failed', e));
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

// ------- Interactive linking (fallback only — used when auto-link fails) -------
app.get('/link', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  req.session.linkReturnTo = req.query.returnTo || '/';
  const url = `${KC_PUBLIC}/realms/${BCROS_REALM}/protocol/openid-connect/auth` +
    `?client_id=${BCROS_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(SELF + '/link/callback')}` +
    `&response_type=code&scope=openid%20email%20profile` +
    `&kc_idp_hint=partner-realm`;
  res.redirect(url);
});

app.get('/link/callback', async (req, res) => {
  try {
    const { code, error, error_description } = req.query;
    console.log(`[link/callback] code=${!!code} error=${error || 'none'} desc=${error_description || 'none'}`);
    if (error) {
      return res.type('html').send(layout('Link failed', `
        <h1>Link failed</h1>
        <p>${error}: ${error_description || ''}</p>
        <a class="button" href="/">Home</a>`));
    }
    await axios.post(
      `${KC_INTERNAL}/realms/${BCROS_REALM}/protocol/openid-connect/token`,
      qs.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: BCROS_CLIENT_ID,
        client_secret: BCROS_CLIENT_SECRET,
        redirect_uri: SELF + '/link/callback'
      })
    );
    const returnTo = req.session.linkReturnTo || '/';
    delete req.session.linkReturnTo;
    const u = req.session.user;
    if (u) partnerUserDb[u.username] = { bcrosLinked: true };
    res.redirect(returnTo);
  } catch (e) {
    res.status(500).send(errorPage('BCROS link failed', e));
  }
});

app.get('/link/reset', (req, res) => {
  const u = req.session.user;
  if (u) delete partnerUserDb[u.username];
  res.redirect('/');
});

// ------- Helpers -------
// NOTE: POC3 uses JWT Authorization Grant (RFC 7523) instead of Legacy V1
// Token Exchange. The partner-realm-issued JWT is submitted as an "assertion"
// to obtain a bcros-realm access token. No `subject_issuer` — the receiving
// realm identifies the source IdP via the JWT's `iss` claim.
//
// IMPORTANT: JWT Bearer assertions are one-use (Keycloak tracks jti). We must
// get a fresh partner-realm token before each attempt.
async function refreshPartnerToken(sessionUser) {
  if (!sessionUser?.refreshToken) {
    throw new Error('no refresh token in session — user must re-login');
  }
  const resp = await axios.post(
    `${KC_INTERNAL}/realms/${PARTNER_REALM}/protocol/openid-connect/token`,
    qs.stringify({
      grant_type: 'refresh_token',
      refresh_token: sessionUser.refreshToken,
      client_id: PARTNER_CLIENT_ID
    })
  );
  sessionUser.partnerToken = resp.data.access_token;
  if (resp.data.refresh_token) sessionUser.refreshToken = resp.data.refresh_token;
  return sessionUser.partnerToken;
}

async function tokenExchange(partnerToken) {
  const claims = JSON.parse(Buffer.from(partnerToken.split('.')[1], 'base64').toString());
  console.log(`[jwtBearer] assertion iss=${claims.iss} sub=${claims.sub} aud=${JSON.stringify(claims.aud)} jti=${claims.jti}`);
  const resp = await axios.post(
    `${KC_INTERNAL}/realms/${BCROS_REALM}/protocol/openid-connect/token`,
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

function isNeedsLinkError(e) {
  const data = e.response?.data;
  if (!data) return false;
  // Keycloak returns any of these when the broker flow can't complete headlessly.
  // We treat all of them as "needs interactive linking":
  const err = data.error;
  const desc = data.error_description || '';
  const needsLinkErrorCodes = new Set([
    'invalid_grant',
    'access_denied',
    'invalid_token',
    'federated_identity_account_exists'
  ]);
  const needsLinkDescriptions = [
    'User already exists',
    'federated_identity_account_exists',
    'account exists'
  ];
  return needsLinkErrorCodes.has(err)
      || needsLinkDescriptions.some(s => desc.toLowerCase().includes(s.toLowerCase()));
}

async function getUserOrgs(bcrosToken) {
  const resp = await axios.get(`${BCROS_BACKEND_URL}/users/@me/orgs`, {
    headers: { Authorization: `Bearer ${bcrosToken}` }
  });
  return resp.data;
}

async function createInvoiceAndRender(res, org, bcrosToken) {
  const resp = await axios.post(
    `${BCROS_BACKEND_URL}/pay-api/payment-requests`,
    { businessInfo: { businessIdentifier: 'BC0871427', corpType: 'BEN' },
      filingInfo: { filingTypes: [{ filingTypeCode: 'BCANN' }] } },
    { headers: { Authorization: `Bearer ${bcrosToken}`, 'Account-Id': org.id } }
  );
  res.type('html').send(layout('Invoice created', `
    <h1>Invoice created</h1>
    <div class="step">
      <p>Charged to: <b>${org.name}</b> (account id ${org.id}, method ${org.paymentMethod})</p>
    </div>
    <h3>Response from fake pay-api</h3>
    <pre>${JSON.stringify(resp.data, null, 2)}</pre>
    <a class="button" href="/">Home</a>`));
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

app.listen(3001, () => console.log('Partner backend running on http://localhost:3001'));
