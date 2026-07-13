const express = require('express');
const app = express();

const PAGE = `<!doctype html>
<html>
<head>
  <title>Partner App (POC2)</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; }
    .banner { background: #e3f2fd; padding: 1rem; border-radius: 8px; }
    a.button { display: inline-block; padding: 0.6rem 1.2rem; background: #1976d2; color: #fff;
               text-decoration: none; border-radius: 6px; margin: 0.3rem 0.3rem 0.3rem 0; }
    code { background: #f5f5f5; padding: 0.1rem 0.3rem; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="banner">
    <h1>Partner App (POC2 - real DEV BCROS)</h1>
    <p>Simulates a customer app whose users authenticate against the
       <b>TEST loginproxy bcregistry realm</b> (acting as the partner realm), and pays through
       <b>real DEV BCROS APIs</b> after token exchange to the DEV loginproxy bcregistry realm.</p>
  </div>

  <h2>Try the flow</h2>
  <ol>
    <li><a class="button" href="http://localhost:3001/">Go to Partner backend</a></li>
    <li>Sign in (TEST bcregistry) — use any real test user you have there</li>
    <li>Click <b>Pay via BCROS</b> — partner backend does a token exchange to DEV bcregistry, calls real DEV auth-api for your orgs, lets you pick, then creates a real invoice via DEV pay-api</li>
  </ol>

  <h2>Setup</h2>
  <ul>
    <li>Partner side: <code>https://test.loginproxy.gov.bc.ca/auth/realms/bcregistry</code></li>
    <li>BCROS side: <code>https://dev.loginproxy.gov.bc.ca/auth/realms/bcregistry</code></li>
    <li>pay-api DEV: <code>https://test.api.connect.gov.bc.ca/pay-dev/api/v1</code></li>
    <li>auth-api DEV: <code>https://test.api.connect.gov.bc.ca/auth-dev/api/v1</code></li>
  </ul>
</body>
</html>`;

app.get('/', (_req, res) => res.type('html').send(PAGE));

app.listen(3000, () => console.log('Partner web running on http://localhost:3000'));
