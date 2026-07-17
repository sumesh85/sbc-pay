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
  participant PS as PubSub

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

## 3. Sequence — Online Banking

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

## 4. Sequence — PAD

```mermaid
sequenceDiagram
  autonumber
  actor Payer
  participant Web as BCROS Web
  participant API as Pay-API
  participant KC as Keycloak
  participant CAS
  participant Queue as Pay-Queue
  participant PS as PubSub

  Payer->>Web: Open signed link
  Web->>API: Verify token, GET invoice
  Payer->>Web: Choose PAD
  Web->>KC: Login required
  KC-->>Web: JWT
  Web->>API: Link invoice to account
  alt New PAD account
    Payer->>Web: Enter banking info
    Web->>API: Store mandate (encrypted)
  end
  API->>API: Mark AUTHORIZED (hold 3 biz days)
  API->>PS: emit invoice.authorized
  Note over API,CAS: On release date, include in PAD debit file
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

## 5. Invoice state

```mermaid
stateDiagram-v2
  [*] --> CREATED_UNLINKED: External system POST
  CREATED_UNLINKED --> LINKED: Login (required for OB/PAD, optional for CC)
  CREATED_UNLINKED --> SETTLED: CC guest checkout
  LINKED --> SETTLED: CC after retro-link
  LINKED --> AWAITING_BANK: OB details displayed
  AWAITING_BANK --> SETTLED: CAS recon match
  LINKED --> AUTHORIZED: PAD mandate captured
  AUTHORIZED --> SETTLED: Hold elapsed + CAS confirms
  AUTHORIZED --> NSF: CAS return
  NSF --> AUTHORIZED: Retry
  SETTLED --> [*]
```

## Open decisions

- **CC retro-link timing** — currently shown *before* PayBC redirect so the
  receipt lands on the right account. Alternative: link on PayBC callback.
- **OB event name** — `invoice.awaiting_bank` is a placeholder; align with
  existing CloudEvents taxonomy in `pay-api` publishers.
- **PAD hold window for externally-initiated invoices** — 3 business days
  proposed as default (first-time payer, no NSF history), even though
  internally-initiated PAD releases same-day today.
- **Signed link TTL and single-use enforcement** — TBD; low-severity leak
  risk but worth capping.
