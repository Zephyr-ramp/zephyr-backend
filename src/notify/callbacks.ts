import type { Keypair } from "@stellar/stellar-sdk";

type Logger = { warn: (obj: object, msg?: string) => void };

/** Delivers SEP-24 `on_change_callback` notifications. */
export interface CallbackNotifier {
  /** Fire-and-forget: never throws, never blocks the state machine. */
  notify(url: string, body: { transaction: unknown }): void;
}

/**
 * POSTs `{ "transaction": {...} }` to the wallet's callback URL, signed as
 * SEP-24 describes: `Signature: t=<unix seconds>, s=<base64 ed25519 signature
 * of "<t>.<callback host>.<body>">` with the anchor's SIGNING_KEY. The same
 * value goes in the older `X-Stellar-Signature` header for older wallets.
 */
export class HttpCallbackNotifier implements CallbackNotifier {
  constructor(
    private readonly signingKey: Keypair,
    private readonly log: Logger,
    private readonly opts: { retries?: number; backoffMs?: number; timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {}

  notify(url: string, body: { transaction: unknown }): void {
    void this.deliver(url, body);
  }

  /** Exposed for tests; resolves true once delivered. */
  async deliver(url: string, body: { transaction: unknown }): Promise<boolean> {
    const fetchFn = this.opts.fetch ?? globalThis.fetch;
    const retries = this.opts.retries ?? 3;
    const payload = JSON.stringify(body);

    for (let attempt = 0; attempt < retries; attempt++) {
      const t = Math.floor(Date.now() / 1000);
      const signature = Buffer.from(this.signingKey.sign(Buffer.from(`${t}.${new URL(url).host}.${payload}`))).toString(
        "base64",
      );
      const header = `t=${t}, s=${signature}`;
      try {
        const res = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json", signature: header, "x-stellar-signature": header },
          body: payload,
          redirect: "error",
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
        });
        if (res.ok) return true;
        this.log.warn({ url, status: res.status, attempt }, "wallet callback rejected");
      } catch (err) {
        this.log.warn({ url, err, attempt }, "wallet callback failed");
      }
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, (this.opts.backoffMs ?? 1_000) * 4 ** attempt));
      }
    }
    return false;
  }
}

/**
 * Validates a wallet-supplied callback URL. HTTPS only, except `http://localhost`
 * on testnet for local development. Returns an error message, or undefined if OK.
 */
export function validateCallbackUrl(value: string, network: "testnet" | "public"): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "on_change_callback must be a valid URL";
  }
  if (url.protocol === "https:") return undefined;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && local && network === "testnet") return undefined;
  return "on_change_callback must use https";
}
