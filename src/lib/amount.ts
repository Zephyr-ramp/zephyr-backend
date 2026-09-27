/**
 * Exact decimal arithmetic for Stellar amounts (7 decimal places), backed by BigInt.
 * Never use JavaScript floats for money.
 */
const SCALE = 7;
const FACTOR = 10n ** BigInt(SCALE);
const AMOUNT_RE = /^\d+(\.\d{1,7})?$/;

export function isValidAmount(value: string): boolean {
  return AMOUNT_RE.test(value);
}

/** Parse a decimal string into integer stroops. Throws on invalid input. */
export function toStroops(value: string): bigint {
  if (!isValidAmount(value)) throw new Error(`Invalid amount: ${value}`);
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole!) * FACTOR + BigInt(frac.padEnd(SCALE, "0"));
}

/** Format stroops as a decimal string with trailing zeros trimmed (min 2 dp for fiat readability). */
export function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / FACTOR;
  let frac = (abs % FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Round stroops half-up to a given number of decimal places. */
function roundTo(stroops: bigint, decimals: number): bigint {
  const unit = 10n ** BigInt(SCALE - decimals);
  return ((stroops + unit / 2n) / unit) * unit;
}

/**
 * fee = fixed + amount * percent / 100, rounded to cents.
 * `percent` supports up to 4 decimal places (e.g. 0.3725).
 */
export function calculateFee(amount: string, fixed: string, percent: number): string {
  const amt = toStroops(amount);
  const pctBps = BigInt(Math.round(percent * 10_000)); // percent * 10^4
  const variable = (amt * pctBps) / 1_000_000n; // /100 for percent, /10^4 for scaling
  return fromStroops(roundTo(toStroops(fixed) + variable, 2));
}

export function subtract(a: string, b: string): string {
  return fromStroops(toStroops(a) - toStroops(b));
}

export function compare(a: string, b: string): -1 | 0 | 1 {
  const x = toStroops(a);
  const y = toStroops(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
