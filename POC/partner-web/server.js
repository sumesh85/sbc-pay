const express = require('express');
const app = express();

const PAGE = `<!doctype html>
<html>
<head>
  <title>Partner App (POC)</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; }
    .banner { background: #e3f2fd; padding: 1rem; border-radius: 8px; }
    a.button { display: inline-block; padding: 0.6rem 1.2rem; background: #1976d2; color: #fff;
               text-decoration: none; border-radius: 6px; margin: 0.3rem 0.3rem 0.3rem 0; }
    a.button.secondary { background: #666; }
    pre { background: #f5f5f5; padding: 0.6rem; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="banner">
    <h1>Partner App (fake)</h1>
    <p>Simulates a customer app whose users authenticate against <b>Partner realm</b> Keycloak.</p>
    <p>All the interesting logic (login, linking, token exchange, payment) lives in
       the Partner backend at <code>http://localhost:3001</code>.</p>
  </div>

  <h2>Try the flow</h2>
  <ol>
    <li><a class="button" href="http://localhost:3001/">Go to Partner backend</a></li>
    <li>Log in with a Partner-realm user (alice.partner / alice, or bob.partner / bob)</li>
    <li>Click "Pay" — first time you'll be walked through the BCROS linking flow.</li>
  </ol>

  <h2>What's simulated where</h2>
  <ul>
    <li><b>Partner web</b> (this page, :3000) — landing page only</li>
    <li><b>Partner backend</b> (:3001) — OIDC client for both realms; token exchange</li>
    <li><b>BCROS web</b> (:3002) — placeholder for auth-web / user portal</li>
    <li><b>BCROS backend</b> (:3003) — fake sbc-auth + fake pay-api endpoints</li>
    <li><b>Keycloak</b> (:8080) — hosts <code>partner</code> and <code>bcros</code> realms</li>
  </ul>
</body>
</html>`;

app.get('/', (_req, res) => res.type('html').send(PAGE));

app.listen(3000, () => console.log('Partner web running on http://localhost:3000'));
