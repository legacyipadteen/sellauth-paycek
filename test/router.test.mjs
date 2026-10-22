/**
 * End-to-end router test with mocked SellAuth/Paycek upstreams.
 * Stateless design: the order context travels inside the MAC-signed callback
 * ref (sa-{shopId}-{invoiceId}-{amountCents}-{uniqueId}). Run: node test/router.test.mjs
 */
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const API_KEY = "test-paycek-key";
const API_SECRET = "test-paycek-secret";

/** Reference MAC from the official Paycek SDKs. */
function sdkMac(nonce, endpoint, body, method = "GET", contentType = "") {
  const h = createHash("sha3-512");
  h.update("\0");
  h.update(Buffer.from(API_KEY, "utf-8"));
  h.update("\0");
  h.update(Buffer.from(API_SECRET, "utf-8"));
  h.update("\0");
  h.update(Buffer.from(nonce, "utf-8"));
  h.update("\0");
  h.update(Buffer.from(method, "utf-8"));
  h.update("\0");
  h.update(Buffer.from(endpoint, "utf-8"));
  h.update("\0");
  h.update(Buffer.from(contentType, "utf-8"));
  h.update("\0");
  h.update(body);
  h.update("\0");
  return h.digest("hex");
}

/* ── Fakes ─────────────────────────────────────────────────────────────────── */

const state = {
  invoice: {
    id: 42,
    unique_id: "abc123-0000000042",
    status: "pending",
    price: "14.99",
    currency: "EUR",
    price_usd: "16.30",
    email: "buyer@example.com",
  },
  paycekPayment: {
    payment_code: "PCODE1",
    payment_url: "https://paycek.io/en/checkout/PCODE1",
  },
  calls: { sellauthProcess: [], paycekOpen: [] },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "api.sellauth.com") {
    assert.equal(
      (init.headers?.Authorization ?? input.headers?.get?.("authorization")),
      `Bearer ${env.SELLAUTH_API_KEY}`,
      "SellAuth call must be authenticated"
    );
    if (url.pathname.endsWith("/process")) {
      state.calls.sellauthProcess.push(url.search);
      state.invoice.status = "completed"; // SellAuth marks it processed
      return new Response(JSON.stringify({ success: "Invoice processed" }), { status: 200 });
    }
    return new Response(JSON.stringify(state.invoice), { status: 200 });
  }
  if (url.hostname === "paycek.io") {
    const body = typeof init.body === "string" ? init.body : "";
    const mac = init.headers?.["ApiKeyAuth-MAC"];
    const nonce = init.headers?.["ApiKeyAuth-Nonce"];
    assert.equal(
      mac,
      sdkMac(nonce, url.pathname, Buffer.from(body, "utf-8"), "POST", "application/json"),
      "outgoing Paycek request MAC must verify"
    );
    if (url.pathname.endsWith("payment/open")) {
      const parsed = JSON.parse(body);
      state.calls.paycekOpen.push(parsed);
      return new Response(
        JSON.stringify({
          meta: { status: "ok", code: 200, message: "Request was successful." },
          data: { ...state.paycekPayment, payment_id: parsed.payment_id },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const env = {
  SELLAUTH_API_KEY: "sa-key",
  SELLAUTH_SHOP_ID: "7",
  SELLAUTH_CHECKOUT_URL_TEMPLATE: "https://shop.example.com/checkout/{unique_id}",
  PAYCEK_API_KEY: API_KEY,
  PAYCEK_API_SECRET: API_SECRET,
  PAYCEK_PROFILE_CODE: "PROF1",
  PUBLIC_BASE_URL: "https://worker.test",
};

async function call(path, headers = {}) {
  return worker.fetch(new Request(`https://worker.test${path}`, { headers }), env, {});
}

function signedCallback(path, nonce) {
  return call(path, { "apikeyauth-nonce": nonce, "apikeyauth-mac": sdkMac(nonce, path, Buffer.alloc(0), "GET", "") });
}

const REF = "sa-7-42-1499-abc123-0000000042";

/* ── 1. Buyer flow: /pay creates a Paycek payment and redirects ───────────── */

{
  const res = await call(`/pay?id=42&unique_id=${encodeURIComponent(state.invoice.unique_id)}&price=0.01&currency=EUR`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), state.paycekPayment.payment_url);
  assert.equal(state.calls.paycekOpen.length, 1, "exactly one payment opened");
  const opened = state.calls.paycekOpen[0];
  assert.equal(opened.profile_code, env.PAYCEK_PROFILE_CODE);
  assert.equal(opened.dst_amount, 14.99); // from the API-verified invoice, not the query string
  assert.equal(opened.payment_id, REF, "payment_id carries the stateless ref");
  assert.ok(opened.status_url_callback.endsWith(`/paycek/callback?ref=${encodeURIComponent(REF)}`));
  console.log("✓ /pay verifies the invoice, opens one Paycek payment with the ref, redirects the buyer");
}

/* ── 2. /pay re-entry opens a fresh payment (stateless) ───────────────────── */

{
  const res = await call(`/pay?id=42&unique_id=${encodeURIComponent(state.invoice.unique_id)}`);
  assert.equal(res.status, 302);
  assert.equal(state.calls.paycekOpen.length, 2, "a fresh payment is opened");
  console.log("✓ /pay re-entry opens a fresh payment");
}

/* ── 3. Callback with a forged MAC is rejected with 401 ───────────────────── */

{
  const res = await call(`/paycek/callback?ref=${encodeURIComponent(REF)}&status=successful`, {
    "apikeyauth-nonce": "1763458499999",
    "apikeyauth-mac": "0".repeat(128),
  });
  assert.equal(res.status, 401);
  assert.equal(state.calls.sellauthProcess.length, 0, "no SellAuth call on forged callback");
  console.log("✓ Forged callback → 401 (Paycek integration-test requirement)");
}

/* ── 4. Successful callback processes the invoice with mark_as_paid ───────── */

{
  state.invoice.status = "pending";
  const path = `/paycek/callback?ref=${encodeURIComponent(REF)}&status=successful`;
  const res = await signedCallback(path, "1763458500001");
  const body = JSON.parse(await res.text());
  assert.equal(res.status, 200);
  assert.equal(body.processed, true);
  assert.deepEqual(state.calls.sellauthProcess, ["?mark_as_paid=true"]);
  console.log("✓ Successful callback processes the invoice (mark_as_paid=true)");
}

/* ── 5. Duplicate callback is a no-op (invoice already completed) ─────────── */

{
  const path = `/paycek/callback?ref=${encodeURIComponent(REF)}&status=successful`;
  const res = await signedCallback(path, "1763458500002");
  const body = JSON.parse(await res.text());
  assert.equal(res.status, 200);
  assert.equal(body.already, "completed");
  assert.equal(state.calls.sellauthProcess.length, 1, "no second process call");
  console.log("✓ Duplicate successful callback is idempotent via invoice status");
}

/* ── 6. Non-success statuses never touch SellAuth ─────────────────────────── */

{
  state.invoice.status = "pending";
  const path = `/paycek/callback?ref=${encodeURIComponent(REF)}&status=expired`;
  const res = await signedCallback(path, "1763458500003");
  assert.equal(res.status, 200);
  assert.equal(state.calls.sellauthProcess.length, 1);
  console.log("✓ Expired/failed callbacks leave the SellAuth invoice untouched");
}

/* ── 7. Amount changed on the invoice since charging → blocked ────────────── */

{
  state.invoice.status = "pending";
  state.invoice.price = "1.49"; // no longer matches the 1499c charged in the ref
  const path = `/paycek/callback?ref=${encodeURIComponent(REF)}&status=successful`;
  const res = await signedCallback(path, "1763458500004");
  const body = JSON.parse(await res.text());
  assert.equal(res.status, 200);
  assert.equal(body.error, "amount mismatch");
  assert.equal(state.calls.sellauthProcess.length, 1, "invoice NOT processed");
  state.invoice.price = "14.99";
  console.log("✓ Amount mismatch is detected and the invoice is not processed");
}

/* ── 8. USD shop without a conversion rate is refused ─────────────────────── */

{
  state.invoice.currency = "USD";
  const res = await call(`/pay?id=42&unique_id=${encodeURIComponent(state.invoice.unique_id)}`);
  assert.equal(res.status, 409);
  state.invoice.currency = "EUR";
  console.log("✓ USD shop without USD_TO_EUR rate → clear error page (409)");
}

console.log("\nAll router tests passed.");
globalThis.fetch = realFetch;
