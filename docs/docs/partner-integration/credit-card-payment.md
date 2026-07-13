# Credit Card Payment Integration Guide

For product teams (Registries, PPR, NRO, Business Registry, etc.)
integrating credit card payments with a BCROS account.

Credit card integration is a three-step handoff:

1. **Create** the payment request.
2. **Redirect** the user to pay-web if `isPaymentActionRequired` is `true`.
3. **Query** the invoice status when the user is redirected back to your app.


## 1. Sequence

```
Partner UI              pay-api                pay-web
    │                      │                      │
    │ 1. POST /payment-requests (CC)              │
    ├─────────────────────►│                      │
    │◄─────────────────────┤ invoiceId,           │
    │                      │ isPaymentActionRequired=true
    │                      │                      │
    │ 2. Redirect browser to pay-web with invoiceId + returnUrl
    ├────────────────────────────────────────────►│
    │                      │                      │ (card entry happens here)
    │◄────────────────────────────────────────────┤ redirect back to returnUrl
    │                      │                      │
    │ 3. GET /payment-requests/{invoiceId}        │
    ├─────────────────────►│                      │
    │◄─────────────────────┤ statusCode: COMPLETED│
```

## 2. Step 1 - Create the payment request

**`POST /api/v1/payment-requests`**

Headers:

- `Authorization: Bearer <keycloak-jwt>` - the end user's session token.
- `Account-Id: <auth-account-id>` - the BCROS account that owns this payment.

Body:

```json
{
  "businessInfo": {
    "corpType": "CP",
    "businessIdentifier": "CP0001234",
    "businessName": "Example Co-op"
  },
  "filingInfo": {
    "folioNumber": "MY-REF-001",
    "filingTypes": [
      { "filingTypeCode": "OTANN", "priority": false }
    ]
  }
}
```


Response:

```json
{
  "id": 1234567,
  "statusCode": "CREATED",
  "paymentMethod": "CC",
  "total": 30.00,
  "serviceFees": 1.50,
  "isPaymentActionRequired": true
}
```

Keep `id` - it is the `invoiceId` used in the next two steps.

## 3. Step 2 - Check the flag, then redirect

Branch on **`isPaymentActionRequired`**:

- **`true`** → redirect the browser to pay-web's makepayment page, passing
  the invoice id and the URL you want the user returned to. Coordinate the
  exact URL pattern with the SBC connect team for your environment. It typically looks like:

  ```
  https://<pay-web-host>/makepayment/{invoiceId}/{returnUrl}
  ```

  Note: URL-encode `returnUrl` before appending it.

  Pay-web hosts for TEST and PROD:

  - TEST: https://test.account.bcregistry.gov.bc.ca
  - PROD: https://account.bcregistry.gov.bc.ca

  PS: Share the redirectUrl with BCROS team to add to the safe list.
  
- **`false`** → nothing more to do. The invoice does not require a user-driven
  payment step. Proceed as if payment is complete.

## 4. Step 3 - Query status on return

When pay-web sends the user back to your `returnUrl`, ask pay-api for the
current state of the invoice:

**`GET /api/v1/payment-requests/{invoiceId}`**

Check `statusCode`:

| statusCode  | What it means                                                     |
| ----------- | ----------------------------------------------------------------- |
| `COMPLETED` | Payment succeeded. Proceed with the filing / downstream work.     |
| `CREATED`   | User did not complete payment, or the return fired early. Offer them a way to resume payment. |
| `DELETED`   | Invoice was voided. Treat as failed.                              |

Do not treat "the user landed on my returnUrl" as proof of success — always re-query.

