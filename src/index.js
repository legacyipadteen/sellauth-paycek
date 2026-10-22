import { PaycekClient, verifyCallbackMac } from "./paycek.js";
import { SellAuthClient } from "./sellauth.js";
import { cents, htmlPage, json } from "./util.js";

/**
 * SellAuth ⇄ Paycek bridge on Cloudflare Workers (stateless — no KV needed).
 *
 * Flow:
 *  1. SellAuth custom payment method ("Redirect to URL") sends the buyer to
 *     GET /pay?id={id}&unique_id={unique_id}.
 *  2. The worker re-verifies the invoice against the SellAuth API (never
 *     trusting the query string for amounts), opens a Paycek payment for the
 *     exact invoice price and redirects the buyer to Paycek's hosted checkout
 *     (payment_url). Everything the webhook needs later — shop, invoice,
 *     charged amount — is encoded into the callback URL as a "ref" and
 *     protected by Paycek's MAC, so no database is required.
 *  3. Paycek calls GET /paycek/callback?ref=<ref>&status=<status> on every
 *     status change. The worker verifies the request's SHA3-512 MAC
 *     (401 on failure — mandatory), re-checks the amount against the live
 *     SellAuth invoice, and on success processes the invoice
 *     (mark_as_paid=true), which delivers the items and emails the buyer.
 */

const PROCESSIBLE = ["pending", "confirming", "out_of_stock", "out-of-stock"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/pay") return await handlePay(url, request, env);
      if (url.pathname === "/paycek/callback") return await handleCallback(url, request, env);
      if (url.pathname === "/healthz") return json({ ok: true });
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("unhandled error:", err);
      return new Response("Internal error", { status: 500 });
    }
  },
};

function clients(env, shopId) {
  return {
    paycek: new PaycekClient(env.PAYCEK_API_KEY, env.PAYCEK_API_SECRET),
    sellauth: new SellAuthClient(env.SELLAUTH_API_KEY, shopId ?? env.SELLAUTH_SHOP_ID),
  };
}

function checkoutUrlFor(env, uniqueId) {
  const tpl = env.SELLAUTH_CHECKOUT_URL_TEMPLATE;
  if (!tpl) {
    console.error("SELLAUTH_CHECKOUT_URL_TEMPLATE is not configured");
    return null;
  }
  return tpl.replace("{unique_id}", encodeURIComponent(uniqueId));
}

/**
 * Amount to charge on Paycek, in the profile's settlement currency (EUR).
 * Uses the invoice's own price when the currencies match; otherwise converts
 * price_usd with the configured fixed USD→EUR rate.
 */
function computeDstAmount(env, invoice) {
  const settlement = (env.PAYCEK_SETTLEMENT_CURRENCY || "EUR").toUpperCase();
  const rate = parseFloat(env.USD_TO_EUR || "");
  if ((invoice.currency || "").toUpperCase() === settlement && cents(invoice.price) !== null) {
    return invoice.price;
  }
  if (Number.isFinite(rate) && rate > 0 && cents(invoice.price_usd) !== null) {
    const converted = (parseFloat(invoice.price_usd) * rate * 100) / 100;
    return (Math.round(converted * 100) / 100).toFixed(2);
  }
  return null;
}

function confirmMinutes(env) {
  const n = parseInt(env.PAYCEK_CONFIRM_MINUTES || "", 10);
  if (!Number.isFinite(n)) return 15;
  return Math.min(15, Math.max(2, n));
}

/** ref = sa-{shopId}-{invoiceId}-{amountCents}-{uniqueId} (uniqueId may contain dashes) */
function buildRef(env, invoiceId, amountCents, uniqueId) {
  return `sa-${env.SELLAUTH_SHOP_ID}-${invoiceId}-${amountCents}-${uniqueId}`;
}

function parseRef(ref) {
  const m = /^sa-(\d+)-(\d+)-(\d+)-(.+)$/.exec(ref);
  if (!m) return null;
  return { shopId: m[1], invoiceId: parseInt(m[2], 10), amountCents: parseInt(m[3], 10), uniqueId: m[4] };
}

/* ── Step 2: buyer arrives from SellAuth, create the Paycek payment ────────── */

async function handlePay(url, request, env) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const invoiceId = parseInt(url.searchParams.get("id") || "", 10);
  const uniqueId = url.searchParams.get("unique_id") || "";
  if (!Number.isInteger(invoiceId) || invoiceId <= 0 || !uniqueId) {
    return htmlPage(400, "Invalid payment link", "This link is malformed. Please start a new checkout.");
  }

  const { paycek, sellauth } = clients(env);
  const checkoutUrl = checkoutUrlFor(env, uniqueId);
  if (!checkoutUrl) {
    return htmlPage(
      500,
      "Payment unavailable",
      "This payment method is not fully configured yet. Please contact the shop or pick another payment method."
    );
  }

  // Re-fetch the invoice from SellAuth: the query string is only a hint —
  // amounts, status and the unique_id match are verified server-side.
  let invoice;
  try {
    invoice = await sellauth.getInvoice(invoiceId);
  } catch (err) {
    console.error("sellauth getInvoice failed:", err);
    return htmlPage(
      502,
      "Order lookup failed",
      "We could not verify this order with the shop. Please go back and try again.",
      checkoutUrl
    );
  }
  if (invoice.unique_id !== uniqueId) {
    return htmlPage(403, "Payment link mismatch", "This link does not match the order.", checkoutUrl);
  }
  if (invoice.status === "completed") {
    return Response.redirect(checkoutUrl, 302);
  }
  if (!["pending", "confirming"].includes(invoice.status)) {
    return htmlPage(
      409,
      "Order no longer payable",
      `This order can no longer be paid (status: ${invoice.status}).`,
      checkoutUrl
    );
  }

  const dstAmount = computeDstAmount(env, invoice);
  if (dstAmount === null) {
    console.error(
      `cannot price invoice ${invoiceId}: currency ${invoice.currency}, price_usd ${invoice.price_usd}, USD_TO_EUR=${env.USD_TO_EUR ?? "unset"}`
    );
    return htmlPage(
      409,
      "Currency not supported",
      "This order's currency is not supported by the crypto payment profile. Please contact the shop or choose another payment method.",
      checkoutUrl
    );
  }

  const ref = buildRef(env, invoiceId, cents(dstAmount), uniqueId);
  const callbackUrl = `${(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "")}/paycek/callback?ref=${encodeURIComponent(ref)}`;

  let data;
  try {
    data = await paycek.openPayment({
      profile_code: env.PAYCEK_PROFILE_CODE,
      dst_amount: Number(dstAmount),
      payment_id: ref,
      email: invoice.email || undefined,
      description: `SellAuth invoice #${invoiceId}`,
      success_url: checkoutUrl,
      fail_url: checkoutUrl,
      status_url_callback: callbackUrl,
      success_url_callback: callbackUrl,
      fail_url_callback: callbackUrl,
      confirm_by_time_delta: confirmMinutes(env),
    });
  } catch (err) {
    console.error("paycek payment/open failed:", err);
    return htmlPage(
      502,
      "Could not start the crypto payment",
      "The payment provider did not accept the request. Please try again in a moment.",
      checkoutUrl
    );
  }

  const paymentUrl = data.payment_url ?? data.payment?.payment_url;
  if (!paymentUrl) {
    console.error("paycek payment/open response missing payment_url:", JSON.stringify(data));
    return htmlPage(502, "Could not start the crypto payment", "Unexpected provider response.", checkoutUrl);
  }

  return Response.redirect(paymentUrl, 302);
}

/* ── Step 3: Paycek status callbacks ───────────────────────────────────────── */

async function handleCallback(url, request, env) {
  // Mandatory: 401 for anything not correctly signed by Paycek, or Paycek's
  // automated integration test cancels ongoing payments and blocks the profile.
  const authorized = verifyCallbackMac({
    url: request.url,
    nonce: request.headers.get("apikeyauth-nonce"),
    mac: request.headers.get("apikeyauth-mac"),
    apiKey: env.PAYCEK_API_KEY,
    apiSecret: env.PAYCEK_API_SECRET,
    method: request.method,
    contentType: request.headers.get("content-type") || "",
  });
  if (!authorized) {
    return json({ error: "unauthorized" }, 401);
  }

  const status = url.searchParams.get("status") || "";
  const parsed = parseRef(url.searchParams.get("ref") || "");
  if (!parsed) return json({ ok: true, ignored: "unrecognized ref" });

  if (status !== "successful") {
    // created/pending/sent/confirmed/underpaid are progress updates;
    // failed/expired/canceled leave the SellAuth invoice untouched — the buyer
    // can simply pay again from the checkout page.
    return json({ ok: true, status });
  }

  const { sellauth } = clients(env, parsed.shopId);

  let invoice;
  try {
    invoice = await sellauth.getInvoice(parsed.invoiceId);
  } catch (err) {
    console.error("sellauth getInvoice failed:", err);
    return json({ error: "sellauth lookup failed" }, 500); // 500 → Paycek retries
  }
  if (invoice.unique_id !== parsed.uniqueId) {
    console.error(`ref/invoice mismatch for invoice ${parsed.invoiceId}`);
    return json({ ok: false, error: "ref mismatch" });
  }
  if (invoice.status === "completed") {
    return json({ ok: true, already: "completed" });
  }
  if (!PROCESSIBLE.includes(invoice.status)) {
    return json({ ok: true, ignored: `invoice status ${invoice.status}` });
  }

  // The charged amount lives in the MAC-protected ref; re-derive it from the
  // live invoice as a final consistency check before delivering items.
  const current = computeDstAmount(env, invoice);
  if (current === null || Math.abs(cents(current) - parsed.amountCents) > 1) {
    console.error(
      `amount mismatch for invoice ${parsed.invoiceId}: charged ${parsed.amountCents}c, invoice now prices at ${current}c — NOT processed`
    );
    return json({ ok: false, error: "amount mismatch" });
  }

  try {
    await sellauth.processInvoice(parsed.invoiceId, true);
  } catch (err) {
    // A concurrent callback may have processed it first — double-check before
    // asking Paycek to retry.
    const fresh = await sellauth.getInvoice(parsed.invoiceId).catch(() => null);
    if (fresh?.status === "completed") {
      return json({ ok: true, already: "completed" });
    }
    console.error("sellauth processInvoice failed:", err);
    return json({ error: "process failed" }, 500);
  }

  return json({ ok: true, processed: true });
}
