const express = require('express');
const app = express();
app.use(express.json());

// ---- Fake sbc-auth ----
// Mock org memberships keyed by the user's email (from the BCROS access token).
// NOTE: The IDENTITY LINK between Partner and BCROS realms is done in Keycloak
// on `idp_userid` (populated by the shared external IdP like Google/GitHub).
// Email here is only a convenience for hardcoding demo data — in real sbc-auth
// the lookup would be by BCROS user id, not email.
const ORGS_BY_EMAIL = {
  'sumesh.punakkal@gmail.com': [
    { id: 1, name: 'Sumesh Personal',         paymentMethod: 'PAD',        orgType: 'BASIC'   },
    { id: 2, name: 'Sumesh Consulting Ltd.',  paymentMethod: 'DIRECT_PAY', orgType: 'PREMIUM' },
    { id: 3, name: 'Sumesh Ventures Inc.',    paymentMethod: 'PAD',        orgType: 'PREMIUM' }
  ],
  'sumesh@daxiom.com': [
    { id: 4, name: 'Daxiom Solutions Inc.',   paymentMethod: 'PAD',        orgType: 'PREMIUM' },
    { id: 5, name: 'Daxiom Consulting',       paymentMethod: null,          orgType: 'BASIC'   },
    { id: 6, name: 'Daxiom Ventures Ltd.',    paymentMethod: 'DIRECT_PAY', orgType: 'PREMIUM' }
  ]
};

const DEFAULT_ORGS = [
  { id: 900, name: 'Demo Personal Account',   paymentMethod: 'PAD',        orgType: 'BASIC'   },
  { id: 901, name: 'Demo No-Payment-Method',  paymentMethod: null,          orgType: 'PREMIUM' },
  { id: 902, name: 'Demo Business Inc.',      paymentMethod: 'DIRECT_PAY', orgType: 'PREMIUM' }
];

function orgsFor(email) {
  if (!email) return DEFAULT_ORGS;
  return ORGS_BY_EMAIL[email.toLowerCase()] || DEFAULT_ORGS;
}

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
  } catch { return null; }
}

function requireBcrosToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const claims = decodeJwt(token);
  if (!claims) return res.status(401).json({ error: 'unauthorized' });
  // NOTE: real service would verify signature via Keycloak JWKS.
  req.bcrosUser = claims.preferred_username;
  req.bcrosEmail = claims.email || null;
  req.idpUserId = claims.idp_userid || null;
  req.bcrosClaims = claims;
  next();
}

// GET /users/@me/orgs — fake sbc-auth endpoint
app.get('/users/@me/orgs', requireBcrosToken, (req, res) => {
  const orgs = orgsFor(req.bcrosEmail);
  console.log(`[sbc-auth] orgs for email=${req.bcrosEmail || '(none)'} (idp_userid=${req.idpUserId}): ${orgs.length}`);
  res.json(orgs);
});

// POST /pay-api/payment-requests — fake pay-api endpoint
app.post('/pay-api/payment-requests', requireBcrosToken, (req, res) => {
  const accountIdHeader = req.headers['account-id'];
  if (!accountIdHeader) {
    return res.status(400).json({ error: 'Missing Account-Id header' });
  }
  const orgs = orgsFor(req.bcrosEmail);
  const org = orgs.find(o => String(o.id) === String(accountIdHeader));
  if (!org) {
    // Simulates check_auth returning 403 — user is not a member of that org
    console.log(`[pay-api] 403: email=${req.bcrosEmail} is not a member of org ${accountIdHeader}`);
    return res.status(403).json({ error: 'forbidden', reason: 'user not authorized on account' });
  }
  if (!org.paymentMethod) {
    return res.status(400).json({ error: 'no payment method configured on account' });
  }
  const invoice = {
    id: Math.floor(Math.random() * 1_000_000),
    statusCode: org.paymentMethod === 'PAD' ? 'APPROVED' : 'CREATED',
    total: 30.0,
    paymentMethod: org.paymentMethod,
    paymentAccount: { id: org.id, name: org.name },
    businessIdentifier: req.body?.businessInfo?.businessIdentifier,
    corpType: req.body?.businessInfo?.corpType,
    isPaymentActionRequired: org.paymentMethod !== 'PAD',
    createdBy: req.bcrosEmail || req.bcrosUser
  };
  console.log(`[pay-api] invoice ${invoice.id} created for ${req.bcrosEmail} on org=${org.id} (${org.paymentMethod})`);
  res.status(201).json(invoice);
});

// Health
app.get('/', (_req, res) => {
  res.type('html').send(`
    <h1>BCROS Backend (fake)</h1>
    <p>Endpoints:</p>
    <ul>
      <li><code>GET /users/@me/orgs</code> — fake sbc-auth org list (needs <code>Authorization: Bearer &lt;bcros-token&gt;</code>). Orgs are keyed by <b>email</b> from the token (a POC convenience — real sbc-auth would key by BCROS user id).</li>
      <li><code>POST /pay-api/payment-requests</code> — fake pay-api (needs BCROS token + <code>Account-Id</code> header)</li>
    </ul>
    <p>Identity linking between Partner and BCROS realms is done in Keycloak via the shared <code>idp_userid</code> attribute (populated by Google/GitHub login on both realms).</p>
    <h3>Hardcoded mock data</h3>
    <pre>${JSON.stringify(ORGS_BY_EMAIL, null, 2)}</pre>
    <p>Unknown emails fall back to <code>DEFAULT_ORGS</code>.</p>
  `);
});

app.listen(3003, () => console.log('BCROS backend running on http://localhost:3003'));
