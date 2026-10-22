/**
 * Verifies the worker's Paycek MAC implementation against a byte-for-byte
 * re-implementation of the official paycek-js / paycek-python SDKs, using
 * Node's own crypto (the worker itself bundles js-sha3 because WebCrypto has
 * no SHA-3).
 *
 * Run: npm test
 */
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { macDigest, verifyCallbackMac } from "../src/paycek.js";

const API_KEY = "k" + "e".repeat(31); // 32-char key
const API_SECRET = "s" + "e".repeat(63); // 64-char secret

/** Reference implementation copied from electrocoin-eu/paycek-js index.js. */
function sdkMac(nonceString, endpoint, bodyBytes, httpMethod = "POST", contentType = "application/json") {
  const hash = createHash("sha3-512");
  hash.update(`\0`);
  hash.update(Buffer.from(API_KEY, "utf-8"));
  hash.update(`\0`);
  hash.update(Buffer.from(API_SECRET, "utf-8"));
  hash.update(`\0`);
  hash.update(Buffer.from(nonceString, "utf-8"));
  hash.update(`\0`);
  hash.update(Buffer.from(httpMethod, "utf-8"));
  hash.update(`\0`);
  hash.update(Buffer.from(endpoint, "utf-8"));
  hash.update(`\0`);
  hash.update(Buffer.from(contentType, "utf-8"));
  hash.update(`\0`);
  hash.update(bodyBytes);
  hash.update(`\0`);
  return hash.digest("hex");
}

const enc = new TextEncoder();

// 1. API-call shape (POST /processing/api/payment/open with a JSON body)
{
  const body = JSON.stringify({
    profile_code: "AB12",
    dst_amount: 14.99,
    payment_id: "sa-1-42-abc",
  });
  const nonce = "1763458492381";
  const expected = sdkMac(nonce, "/processing/api/payment/open", Buffer.from(body, "utf-8"));
  const actual = macDigest(API_KEY, API_SECRET, nonce, "POST", "/processing/api/payment/open", "application/json", enc.encode(body));
  assert.equal(actual, expected, "API-call MAC must match SDK");
  console.log("✓ API-call MAC matches the official SDK algorithm");
}

// 2. Empty-body edge case
{
  const expected = sdkMac("123", "/x", Buffer.alloc(0), "GET", "");
  const actual = macDigest(API_KEY, API_SECRET, "123", "GET", "/x", "", new Uint8Array(0));
  assert.equal(actual, expected);
  console.log("✓ Empty-body MAC matches");
}

// 3. Callback verification accepts a MAC computed over path+query (the most
//    likely signing form: Paycek appends &status=… to our callback URL).
{
  const callbackUrl = "https://worker.example.com/paycek/callback?ref=sa-1-42-abc&status=successful";
  const nonce = "1763458499999";
  const signed = sdkMac(nonce, "/paycek/callback?ref=sa-1-42-abc&status=successful", Buffer.alloc(0), "GET", "");
  assert.ok(
    verifyCallbackMac({ url: callbackUrl, nonce, mac: signed, apiKey: API_KEY, apiSecret: API_SECRET }),
    "must accept path+query signing"
  );
  console.log("✓ Callback verified when signed over path+query");
}

// 4. Callback verification also accepts the other plausible signing forms
for (const endpoint of [
  "/paycek/callback", // path only
  "https://worker.example.com/paycek/callback?ref=sa-1-42-abc&status=successful", // absolute URL
  "/paycek/callback?ref=sa-1-42-abc", // query without the appended status param
]) {
  const nonce = "1763458500000";
  const signed = sdkMac(nonce, endpoint, Buffer.alloc(0), "GET", "");
  assert.ok(
    verifyCallbackMac({
      url: "https://worker.example.com/paycek/callback?ref=sa-1-42-abc&status=successful",
      nonce,
      mac: signed,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
    }),
    `must accept signing over: ${endpoint}`
  );
}
console.log("✓ Callback verified for path-only / absolute-URL / status-less forms");

// 5. Tampering is rejected
{
  const nonce = "1763458500123";
  const signed = sdkMac(nonce, "/paycek/callback?ref=sa-1-42-abc&status=successful", Buffer.alloc(0), "GET", "");
  const base = { url: "https://worker.example.com/paycek/callback?ref=sa-1-42-abc&status=successful", nonce };
  assert.ok(!verifyCallbackMac({ ...base, mac: signed, apiKey: API_KEY, apiSecret: "wrong-secret" }), "wrong secret");
  assert.ok(!verifyCallbackMac({ ...base, mac: signed.toUpperCase().slice(0, -1) + "0", apiKey: API_KEY, apiSecret: API_SECRET }), "flipped MAC char");
  assert.ok(!verifyCallbackMac({ ...base, mac: signed, apiKey: "wrong-key", apiSecret: API_SECRET }), "wrong key");
  assert.ok(
    !verifyCallbackMac({ url: "https://worker.example.com/paycek/callback?ref=sa-1-42-abc&status=successful&extra=1", nonce, mac: signed, apiKey: API_KEY, apiSecret: API_SECRET }),
    "extra param appended by attacker"
  );
  assert.ok(!verifyCallbackMac({ ...base, mac: "", apiKey: API_KEY, apiSecret: API_SECRET }), "empty MAC");
  assert.ok(!verifyCallbackMac({ url: base.url, nonce: "abc", mac: signed, apiKey: API_KEY, apiSecret: API_SECRET }), "non-numeric nonce");
  console.log("✓ Tampered / forged callbacks rejected");
}

console.log("\nAll MAC tests passed.");
