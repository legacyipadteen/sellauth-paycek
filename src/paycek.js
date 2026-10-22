import jsSha3 from "js-sha3";

const { sha3_512 } = jsSha3;

/**
 * Paycek API client.
 *
 * Signing follows the official Paycek SDKs (paycek-js / paycek-python) exactly:
 * a SHA3-512 digest (hex) over NUL-separated fields:
 *
 *   \0 apiKey \0 apiSecret \0 nonce \0 method \0 endpoint \0 contentType \0 body \0
 *
 * API calls are always POST https://paycek.io/processing/api/<endpoint> with
 * Content-Type: application/json, and the ApiKeyAuth-Key/Nonce/MAC headers.
 */

const API_HOST = "https://paycek.io";
const API_PREFIX = "/processing/api";

const encoder = new TextEncoder();

export function macDigest(apiKey, apiSecret, nonce, method, endpoint, contentType, bodyBytes) {
  const fields = [apiKey, apiSecret, nonce, method, endpoint, contentType].map((f) =>
    encoder.encode(f ?? "")
  );
  const body = bodyBytes ?? new Uint8Array(0);
  const total = fields.reduce((sum, f) => sum + f.length, 0) + body.length + fields.length + 2;
  const buf = new Uint8Array(total);
  let o = 0;
  buf[o++] = 0;
  for (const f of fields) {
    buf.set(f, o);
    o += f.length;
    buf[o++] = 0;
  }
  buf.set(body, o);
  buf[o + body.length] = 0;
  return sha3_512(buf);
}

export function timingSafeHexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Paycek callback (status_url_callback / success_url_callback /
 * fail_url_callback — all GET requests) is genuinely signed by Paycek.
 *
 * The SDKs leave "the callback endpoint" ambiguous (path only vs path+query
 * vs absolute URL, with or without the appended status param), so every
 * plausible derivation of the received URL is tried. All candidates are built
 * from the actual request, so a forged request still cannot produce a match
 * without knowing the API secret.
 *
 * Paycek REQUIRES: 401 for invalid authorization, 200 for valid — failing the
 * automated integration check cancels ongoing payments and blocks the profile.
 */
export function verifyCallbackMac({ url, nonce, mac, apiKey, apiSecret, method = "GET", contentType = "" }) {
  if (!nonce || !mac || !/^\d+$/.test(nonce) || !/^[0-9a-f]{128}$/i.test(mac)) return false;

  const u = new URL(url);
  const noStatus = new URL(url);
  noStatus.searchParams.delete("status");

  const endpoints = new Set([
    u.pathname + u.search,
    u.pathname,
    u.href,
    noStatus.pathname + noStatus.search,
  ]);
  const contentTypes = new Set([""]);
  if (contentType) contentTypes.add(contentType);
  const body = new Uint8Array(0);

  for (const endpoint of endpoints) {
    for (const ct of contentTypes) {
      const computed = macDigest(apiKey, apiSecret, nonce, method, endpoint, ct, body);
      if (timingSafeHexEqual(mac.toLowerCase(), computed)) return true;
    }
  }
  return false;
}

export class PaycekError extends Error {
  constructor(message) {
    super(message);
    this.name = "PaycekError";
  }
}

export class PaycekClient {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  async #apiCall(endpoint, body) {
    const prefixed = `${API_PREFIX}/${endpoint}`;
    const bodyStr = JSON.stringify(body);
    const nonce = Date.now().toString();
    const mac = macDigest(
      this.apiKey,
      this.apiSecret,
      nonce,
      "POST",
      prefixed,
      "application/json",
      encoder.encode(bodyStr)
    );

    const res = await fetch(API_HOST + prefixed, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ApiKeyAuth-Key": this.apiKey,
        "ApiKeyAuth-Nonce": nonce,
        "ApiKeyAuth-MAC": mac,
      },
      body: bodyStr,
    });

    let json = null;
    try {
      json = await res.json();
    } catch {
      throw new PaycekError(`Paycek ${endpoint}: invalid response (HTTP ${res.status})`);
    }
    if (!json?.meta || json.meta.status !== "ok") {
      throw new PaycekError(`Paycek ${endpoint}: ${json?.meta?.message ?? `HTTP ${res.status}`}`);
    }
    return json.data ?? {};
  }

  /** POST payment/open — returns the payment object incl. payment_url + payment_code. */
  openPayment(fields) {
    return this.#apiCall("payment/open", fields);
  }

  /** POST payment/get — returns the payment object incl. current status. */
  getPayment(paymentCode) {
    return this.#apiCall("payment/get", { payment_code: paymentCode });
  }

  /** POST payment/cancel */
  cancelPayment(paymentCode) {
    return this.#apiCall("payment/cancel", { payment_code: paymentCode });
  }
}
