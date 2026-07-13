const express = require('express');
const app = express();

const PAGE = `<!doctype html>
<html>
<head>
  <title>BCROS Portal (POC)</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; }
    .banner { background: #e8f5e9; padding: 1rem; border-radius: 8px; }
    a.button { display: inline-block; padding: 0.6rem 1.2rem; background: #2e7d32; color: #fff;
               text-decoration: none; border-radius: 6px; margin: 0.3rem 0.3rem 0.3rem 0; }
    code { background: #f5f5f5; padding: 0.1rem 0.3rem; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="banner">
    <h1>BCROS Portal (fake)</h1>
    <p>Placeholder for the real BCROS user portal / auth-web.</p>
    <p>In the POC, users don't need to visit this — the linking flow happens via
       Keycloak's IdP brokering in the Partner backend.</p>
  </div>

  <h2>Where the real logic lives</h2>
  <ul>
    <li><b>BCROS backend</b> (:3003) — fake sbc-auth (<code>/users/@me/orgs</code>) and fake pay-api
        (<code>/pay-api/payment-requests</code>)</li>
    <li><b>Keycloak</b> (:8080) — BCROS realm holds users like <code>alice.bcros</code>, <code>bob.bcros</code></li>
  </ul>

  <p><a class="button" href="http://localhost:3000/">Back to Partner app</a></p>
</body>
</html>`;

app.get('/', (_req, res) => res.type('html').send(PAGE));

app.listen(3002, () => console.log('BCROS web running on http://localhost:3002'));
