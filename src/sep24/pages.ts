import type { Config } from "../config.js";
import type { Transaction } from "../store/types.js";

const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function layout(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --bg:#fff; --muted:#666; --line:#ddd; --accent:#2f5bea; --err:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eee; --bg:#121212; --muted:#aaa; --line:#333; --accent:#8fa8ff; --err:#ff8a80; } }
  body { font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: 24px 16px; }
  main { max-width: 420px; margin: 0 auto; }
  h1 { font-size: 1.3rem; margin: 0 0 16px; }
  label { display: block; margin: 12px 0 4px; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
  button { margin-top: 20px; width: 100%; padding: 12px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .muted { color: var(--muted); font-size: .9rem; }
  .error { color: var(--err); margin: 8px 0; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; }
  dt { color: var(--muted); } dd { margin: 0; word-break: break-all; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function renderForm(
  tx: Transaction,
  token: string,
  config: Config,
  opts: { error?: string; values?: Record<string, string | undefined>; escrowEnabled?: boolean } = {},
) {
  const v = opts.values ?? {};
  const limits = tx.kind === "deposit" ? config.limits.deposit : config.limits.withdraw;
  const title = tx.kind === "deposit" ? "Deposit USD, receive USDC" : "Withdraw USDC, receive USD";
  return layout(
    title,
    `<h1>${esc(title)}</h1>
  ${opts.error ? `<p class="error" role="alert">${esc(opts.error)}</p>` : ""}
  <form method="post" action="${esc(config.baseUrl)}/sep24/interactive">
    <input type="hidden" name="transaction_id" value="${esc(tx.id)}" />
    <input type="hidden" name="token" value="${esc(token)}" />
    <label for="amount">Amount (${tx.kind === "deposit" ? "USD" : "USDC"})</label>
    <input id="amount" name="amount" inputmode="decimal" required value="${esc(v.amount ?? tx.amountIn ?? "")}" />
    <p class="muted">Min ${esc(limits.min)}, max ${esc(limits.max)}. Fee: ${esc(config.fee.fixed)} + ${esc(config.fee.percent)}%.</p>
    <label for="name">Full name</label>
    <input id="name" name="name" autocomplete="name" required value="${esc(v.name ?? "")}" />
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required value="${esc(v.email ?? "")}" />
    ${
      tx.kind === "withdrawal" && opts.escrowEnabled
        ? `<fieldset><legend>How will you send USDC?</legend>
    <label><input type="radio" name="withdraw_mode" value="standard" ${v.withdraw_mode === "escrow" ? "" : "checked"} /> Payment with memo (any wallet)</label>
    <label><input type="radio" name="withdraw_mode" value="escrow" ${v.withdraw_mode === "escrow" ? "checked" : ""} /> Escrow contract (refundable if we don't pay out)</label>
    </fieldset>`
        : ""
    }
    <button type="submit">Continue</button>
  </form>`,
  );
}

export function renderStatus(tx: Transaction) {
  const rows: [string, unknown][] = [
    ["Status", tx.status],
    ["You send", tx.amountIn ? `${tx.amountIn} ${tx.kind === "deposit" ? "USD" : "USDC"}` : ""],
    ["Fee", tx.amountFee],
    ["Message", tx.message],
    ["You receive", tx.amountOut ? `${tx.amountOut} ${tx.kind === "deposit" ? "USDC" : "USD"}` : ""],
  ];

  let next = "";
  if (tx.status === "pending_user_transfer_start" && tx.kind === "deposit" && tx.depositInstructions) {
    const instr = Object.entries(tx.depositInstructions)
      .map(([k, val]) => `<dt>${esc(k.replace(/_/g, " "))}</dt><dd>${esc(val)}</dd>`)
      .join("");
    next = `<h2>Send your dollars</h2><p>Use these bank details. Include the reference exactly.</p><dl>${instr}</dl>`;
  } else if (tx.status === "pending_user_transfer_start" && tx.withdrawMode === "escrow" && tx.escrow) {
    next = `<h2>Lock your USDC in escrow</h2><p>Return to your wallet to lock ${esc(tx.amountIn)} USDC in contract <code>${esc(tx.escrow.contractId)}</code> with tx_id <code>${esc(tx.escrow.txId)}</code>.</p>`;
  } else if (tx.status === "pending_user_transfer_start" && tx.kind === "withdrawal") {
    next = `<p>Return to your wallet to confirm sending ${esc(tx.amountIn)} USDC. Your wallet already has the destination and memo.</p>`;
  }

  return layout(
    "Transaction status",
    `<h1>Transaction status</h1>
  <dl>${rows
    .filter(([, val]) => val)
    .map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`)
    .join("")}</dl>
  ${next}
  <p class="muted">You can close this window. Reference: ${esc(tx.id)}</p>`,
  );
}
