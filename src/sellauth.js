/**
 * Minimal SellAuth merchant API client.
 * Base: https://api.sellauth.com/v1 — auth: Authorization: Bearer <key>
 */

const API_BASE = "https://api.sellauth.com/v1";

export class SellAuthError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "SellAuthError";
    this.status = status;
    this.body = body;
  }
}

export class SellAuthClient {
  constructor(apiKey, shopId) {
    this.apiKey = apiKey;
    this.shopId = shopId;
  }

  async #call(path, init = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // leave json null; error path below reports the raw body
    }
    if (!res.ok) {
      const message =
        (json && (json.error ?? json.message)) ?? `SellAuth ${path} failed with HTTP ${res.status}`;
      throw new SellAuthError(String(message), res.status, text);
    }
    return json;
  }

  /** GET /shops/{shopId}/invoices/{invoiceId} */
  getInvoice(invoiceId) {
    return this.#call(`/shops/${this.shopId}/invoices/${invoiceId}`);
  }

  /**
   * GET /shops/{shopId}/invoices/{invoiceId}/process
   * Processes a pending, confirming or out-of-stock invoice, delivering its
   * items and emailing the buyer. mark_as_paid also records the invoice price
   * as paid (money arrived outside SellAuth — exactly our case).
   */
  processInvoice(invoiceId, markAsPaid = true) {
    const q = markAsPaid ? "?mark_as_paid=true" : "";
    return this.#call(`/shops/${this.shopId}/invoices/${invoiceId}/process${q}`);
  }
}
