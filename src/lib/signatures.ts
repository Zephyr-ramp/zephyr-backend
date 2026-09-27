import { createHmac, timingSafeEqual } from "node:crypto";

/** How far a webhook timestamp may drift from our clock. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Signs a webhook body. Header format: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
 * Rails (and the tests) use this to produce `Zephyr-Signature`.
 */
export function signWebhook(secret: string, rawBody: string | Buffer, timestamp = Math.floor(Date.now() / 1000)) {
  const mac = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
  now = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "missing signature" };
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return { ok: false, reason: "malformed signature" };
  if (Math.abs(now - t) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: "stale signature" };

  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  const given = Buffer.from(parts.v1, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "invalid signature" };
  }
  return { ok: true };
}

/**
 * Read-only token for a transaction's `more_info_url`. Deterministic, so the
 * serializer can build the URL without I/O; it only grants viewing status.
 */
export function moreInfoToken(secret: Uint8Array, transactionId: string): string {
  return createHmac("sha256", secret).update(`more_info:${transactionId}`).digest("base64url");
}

export function verifyMoreInfoToken(secret: Uint8Array, transactionId: string, token: string): boolean {
  const expected = Buffer.from(moreInfoToken(secret, transactionId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
