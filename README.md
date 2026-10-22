# SellAuth ⇄ Paycek bridge (Cloudflare Worker)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/legacyipadteen/sellauth-paycek)

**[One-click deploy link](https://deploy.workers.cloudflare.com/?url=https://github.com/legacyipadteen/sellauth-paycek)** — clones this repo into your GitHub, asks for the three secrets (from `.dev.vars.example`), shows the vars from `wrangler.toml` to edit, and deploys.

Lets a [SellAuth](https://sellauth.com) shop accept crypto payments through
[Paycek](https://paycek.io) (Electrocoin) using SellAuth **custom payment
methods**, with no server of your own — everything runs on a Cloudflare
Worker.

```
Buyer            SellAuth                Worker                    Paycek
 │ checkout, picks        │                   │                        │
 │ "Crypto (Paycek)"      │                   │                        │
 ├───────────────────────►│ redirect to       │                        │
 │                        │  /pay?id&unique_id│                        │
 │                        ├──────────────────►│ verify invoice via API │
 │                        │                   │ open payment           │
 │                        │                   ├───────────────────────►│
 │◄───────── redirect to Paycek hosted checkout (payment_url) ─────────┤
 │ pays crypto            │                   │                        │
 ├─────────────────────────────────────────────────────────────────────►│
 │                        │  GET /paycek/callback?ref&status=successful │
 │                        │                   │◄───────────────────────┤
 │                        │                   │ re-check via payment/get│
 │                        │  process invoice  │                        │
 │                        │  (mark_as_paid)   │                        │
 │                        │◄──────────────────┤                        │
 │◄──── items delivered + receipt email by SellAuth ────────────────────┘
```

## What it does

- `GET /pay?id={id}&unique_id={unique_id}` — buyer lands here from the SellAuth
  custom payment method. The worker **re-fetches the invoice from the SellAuth
  API** (amounts and status are never trusted from the query string), opens a
  Paycek payment for the exact invoice price and redirects the buyer to
  Paycek's hosted checkout. The order context (shop, invoice, charged amount)
  travels inside the callback URL, MAC-protected by Paycek — the worker is
  fully stateless.
- `GET /paycek/callback?ref=…&status=…` — receives Paycek's signed status
  callbacks. On `successful` it verifies the SHA3-512 MAC, re-reads the payment
  from Paycek's API, re-checks the amount, then calls SellAuth's
  *Process Invoice* with `mark_as_paid=true` — which delivers the items and
  emails the buyer. Idempotent — the live invoice status is the guard.
- Invalid callbacks get **401** — required by Paycek: their automated
  integration test fires a forged request at every callback URL on each new
  payment, and anything other than 401 **cancels ongoing payments and blocks
  your profile**.

## Setup — one-click deploy

Push this folder to a **public GitHub repo**, then open:

```
https://deploy.workers.cloudflare.com/?url=https://github.com/<you>/sellauth-paycek
```

The flow clones the repo into your GitHub account, asks you to **fill in the
three secrets** (prompted from `.dev.vars.example`), shows the **vars from
`wrangler.toml`** (edit the placeholders there — shop ID, shop domain, Paycek
profile code, worker URL) and builds + deploys via Workers Builds. The worker
is stateless (no KV, no D1) — nothing else to provision.

> Attaching a custom domain to the worker? After deploying: worker →
> **Settings → Domains & Routes → Add → Custom domain**, then set
> `PUBLIC_BASE_URL` to `https://<that-domain>` and use it in the SellAuth
> redirect URL.

## Setup — manual (wrangler)

### 1. Paycek

1. Create a merchant account at <https://paycek.io> and a (test) profile —
   profiles settle in **EUR**.
2. Under account settings, note your **API key** and **API secret**, and the
   profile's **profile code**.

### 2. Cloudflare Worker

```bash
npm install
npx wrangler deploy
```

Then edit `[vars]` in `wrangler.toml` (or the worker's Settings → Variables and
Secrets in the dashboard):

| Variable | Meaning |
|---|---|
| `SELLAUTH_SHOP_ID` | Numeric shop ID (visible in dashboard URLs) |
| `SELLAUTH_CHECKOUT_URL_TEMPLATE` | Your shop's public checkout URL with a `{unique_id}` placeholder — e.g. `https://your-shop-domain.com/checkout/{unique_id}` on a custom domain (or `https://<subdomain>.sellauth.com/checkout/{unique_id}` on a subdomain). Buyer is returned here after paying. |
| `PAYCEK_PROFILE_CODE` | Profile the payments are opened under |
| `PUBLIC_BASE_URL` | The worker's public HTTPS URL (used for callback URLs) — your custom domain if you attach one, e.g. `https://pay.your-domain.com` |
| `PAYCEK_CONFIRM_MINUTES` | Buyer's window to broadcast the tx, 2–15 (default 15) |
| `USD_TO_EUR` | Optional fixed rate for USD-priced shops (see *Currencies*) |

### 3. SellAuth

1. Dashboard → **Payment Methods** → add a custom payment method
   (requires a plan with custom payment methods).
2. Type: **Redirect to URL**, with redirect URL:

   ```
   https://<your-worker>.workers.dev/pay?id={id}&unique_id={unique_id}
   ```

   (`{id}` and `{unique_id}` are substituted by SellAuth. Prefer a custom
   domain for the worker if you have one.)
3. Enable it. Done — paying invoices with this method now flow through Paycek.

## Cloudflare dashboard deep links

While logged in to Cloudflare, these open the right pages (the `?to=/:account/`
prefix auto-fills your account):

- Workers & Pages list: <https://dash.cloudflare.com/?to=/:account/workers-and-pages>
- This worker after deploy: <https://dash.cloudflare.com/?to=/:account/workers/services/view/sellauth-paycek/settings>

To use a custom domain for the worker (recommended so Paycek callbacks and the
SellAuth redirect URL stay stable): open the worker → **Settings → Domains &
Routes → Add → Custom domain**, then set `PUBLIC_BASE_URL` to
`https://<that-domain>` and use it in the SellAuth redirect URL too.

The plain-text vars (`[vars]` in `wrangler.toml`) can also be edited in the
dashboard under the worker's **Settings → Variables and Secrets**; the three
secrets can be added there as *Secret* type instead of via
`wrangler secret put`.

## Currencies

Paycek profiles settle in EUR. If your shop's currency is **EUR**, the invoice
price is charged as-is. If your shop is priced in another currency, set
`USD_TO_EUR` (a fixed USD→EUR rate you maintain) and the worker charges
`price_usd × rate`. Anything else is refused with a clear error page instead of
silently charging the wrong amount.

## Behaviour & edge cases

- **Re-entry**: reloading `/pay` simply opens a fresh Paycek payment (unpaid
  ones expire after `PAYCEK_CONFIRM_MINUTES`); the invoice is only ever
  processed when a payment actually succeeds.
- **Underpaid** Paycek payments are *not* processed automatically. If you
  accept the underpayment in the Paycek dashboard and its status becomes
  `successful`, the callback will process the invoice (with the amount check
  against what was originally charged — review manually if it differs).
- **Expired/failed/canceled** Paycek payments leave the SellAuth invoice
  untouched (`pending`), so the buyer can pay again from the checkout page
  until SellAuth expires the invoice.
- **Retries**: transient upstream failures make the worker return 5xx so
  Paycek retries the callback; permanent rejections return 200 with a logged
  reason.
- **Amount verification**: the invoice price is taken from the SellAuth API at
  payment creation, and the amount Paycek reports as paid is re-checked against
  it before processing — the query string is never trusted.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real keys for local testing
npm test                         # MAC correctness vs official SDK + full router tests
npx wrangler dev
```

Note: Paycek must be able to reach your callback URLs, so end-to-end tests
need the worker deployed (or a tunnel). Use a Paycek **test profile** first —
its payments aren't settled; the 401-on-forged-callback check still applies.

## Possible extensions

- Listen to SellAuth **HTTP notifications** (Developers → HTTP notifications in
  the dashboard) to `payment/cancel` the open Paycek payment when an invoice is
  cancelled/expired elsewhere.
- Pass SellAuth line items as Paycek `items` for nicer receipts.

## References

- SellAuth manual/custom payment methods: <https://docs.sellauth.com/guides/payment-methods/manual>
- SellAuth API: <https://docs.sellauth.com/api-reference/introduction> —
  `GET /v1/shops/{shopId}/invoices/{invoiceId}`,
  `GET /v1/shops/{shopId}/invoices/{invoiceId}/process?mark_as_paid=true`
- Paycek API: <https://paycek.io/api/docs> — `payment/open`, `payment/get`,
  callbacks, and the ApiKeyAuth SHA3-512 signing scheme (mirrors the official
  [paycek-js](https://github.com/electrocoin-eu/paycek-js) /
  [paycek-python](https://github.com/electrocoin-eu/paycek-python) SDKs).
