/** Parse "12.34" into integer cents, or null when not a valid amount. */
export function cents(amount) {
  if (amount === null || amount === undefined || amount === "") return null;
  const n = typeof amount === "number" ? amount : parseFloat(amount);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

const PAGE_STYLE = `
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f1220;color:#e8eaf2;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{max-width:420px;padding:32px;background:#171b2e;border:1px solid #2a3050;border-radius:12px;text-align:center}
  h1{font-size:18px;margin:0 0 8px}
  p{color:#9aa3c0;font-size:14px;line-height:1.5;margin:0 0 16px}
  a{color:#7aa2ff;text-decoration:none;font-weight:600}
`;

export function htmlPage(status, title, message, linkHref, linkText) {
  const link = linkHref ? `<p><a href="${linkHref}">${linkText ?? "Back to your order"}</a></p>` : "";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${PAGE_STYLE}</style></head><body><div class="card"><h1>${title}</h1><p>${message}</p>${link}</div></body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    }
  );
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
