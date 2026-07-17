# Externally-Initiated Invoice Flow

Design for a hosted payment flow where an **external system** creates an
invoice in Pay-API without a linked BC Registries account, and the payer
completes payment on a hosted BCROS checkout via a signed email link.

Three payment rails are supported:

- **CC** — credit card via PayBC hosted page (guest or optional login)
- **OB** — online banking (login required, settlement via CAS recon)
- **PAD** — pre-authorized debit (login required, hold window before release)

The signed link is an **invoice locator**, not an auth token. Payer identity
is established by the rail itself (PayBC for CC, Keycloak for OB/PAD).

## 1. Container diagram

```mermaid
flowchart LR
  subgraph pub["Public internet"]
    ext["External System<br/>(integrator)"]
    payer(("Payer"))
    inbox["Payer's inbox"]
  end

  subgraph gov["BC Gov network"]
    web["BCROS Web<br/>(hosted checkout)"]
    api["Pay-API<br/>(Flask)"]
    notif["Notification Service"]
    kc["Keycloak"]
    paybc["PayBC<br/>(hosted CC page)"]
    ps[("PubSub<br/>payment events")]
    queue["Pay-Queue<br/>(reconciliation)"]
    db[("Postgres")]
    cas[("CAS<br/>OB/PAD recon files")]
  end

  ext -- "POST /invoices (unlinked)" --> api
  api -- "invoice id + signed link" --> ext
  api --> notif
  notif -- "email w/ signed link" --> inbox
  inbox -- "click" --> payer
  payer -- "https + token" --> web
  web -- "verify token, fetch invoice" --> api
  web -. redirect .-> paybc
  web -. login .-> kc
  api --> db
  api --> ps
  cas --> queue
  queue --> api
  queue --> ps
  ps -- "payment events" --> ext
```

## 2. Sequence — CC (guest + optional login)

```mermaid
sequenceDiagram
  autonumber
  actor Payer
  participant Web as BCROS Web
  participant API as Pay-API
  participant KC as Keycloak
  participant PayBC
  participant PS as PubSub/Webhook

  Payer->>Web: Open signed link
  Web->>API: Verify token, GET invoice
  API-->>Web: Invoice details (unlinked)
  Payer->>Web: Choose CC
  opt Optional login
    Web->>KC: Authenticate
    KC-->>Web: JWT
    Web->>API: Link invoice to account
  end
  Web->>PayBC: Redirect to hosted CC page
  Payer->>PayBC: Enter card
  PayBC-->>API: Payment result callback
  API->>API: Mark invoice SETTLED
  API->>PS: emit invoice.settled
```

<!-- ## 3. Sequence — Online Banking

```mermaid
sequenceDiagram
  autonumber
  actor Payer
  participant Web as BCROS Web
  participant API as Pay-API
  participant KC as Keycloak
  participant Bank as Payer's Bank
  participant CAS
  participant Queue as Pay-Queue
  participant PS as PubSub

  Payer->>Web: Open signed link
  Web->>API: Verify token, GET invoice
  Payer->>Web: Choose OB
  Web->>KC: Login required
  KC-->>Web: JWT
  Web->>API: Link invoice to account
  API-->>Web: OB payment reference + payee
  Web-->>Payer: Show OB instructions
  API->>PS: emit invoice.awaiting_bank
  Note over Payer,Bank: Payer initiates OB transfer<br/>(hours to days)
  Bank->>CAS: Deposit reported
  CAS-->>Queue: Reconciliation file
  Queue->>API: Match by ref, mark SETTLED
  API->>PS: emit invoice.settled
``` 
-->

## 3. Sequence — PAD

```mermaid
sequenceDiagram
  autonumber
  actor Payer
  participant Web as BCROS Web
  participant API as Pay-API
  participant KC as Keycloak
  participant CAS
  participant Queue as Pay-Queue
  participant PS as PubSub/Webhook

  Payer->>Web: Open signed link
  Web->>API: Verify token, GET invoice
  Web->>KC: Login required
  KC-->>Web: JWT
  Web->>API: Link invoice to account
  alt New PAD account
    Payer->>Web: Enter banking info
    Web->>API: Store mandate (encrypted)
  end
  API->>API: Mark AUTHORIZED (hold 3 biz days)
  API->>CAS: PAD debit
  CAS-->>Queue: Settlement or NSF return
  alt Settled
    Queue->>API: Mark SETTLED
    API->>PS: emit invoice.settled
  else NSF
    Queue->>API: Mark NSF
    API->>PS: emit invoice.nsf
  end
```

