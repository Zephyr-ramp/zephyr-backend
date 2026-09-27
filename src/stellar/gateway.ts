import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  NotFoundError,
  Operation,
  StellarToml,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

export interface IncomingPayment {
  transactionHash: string;
  from: string;
  amount: string;
  assetCode: string;
  assetIssuer: string;
  memo?: string | undefined;
}

/** Signers and medium threshold of an on-chain account, for SEP-10 multisig verification. */
export interface AccountSigners {
  threshold: number;
  signers: { key: string; weight: number }[];
}

export interface WatchOptions {
  /** Horizon paging token to resume from. `undefined` starts from "now". */
  cursor?: string | undefined;
  /** Called after each record is processed, so the caller can persist the cursor. */
  onCursor?: (cursor: string) => void | Promise<void>;
}

/** Everything the anchor needs from Horizon and the wider Stellar network. Swappable for tests. */
export interface StellarGateway {
  /** Send `amount` of the anchored asset from the distribution account. Returns the tx hash. */
  sendPayment(input: { destination: string; amount: string; memo?: string | undefined }): Promise<string>;
  /** Stream payments into the distribution account. Returns a function that stops the stream. */
  watchIncomingPayments(onPayment: (p: IncomingPayment) => void | Promise<void>, options?: WatchOptions): () => void;
  /** Signers of `account`, or `undefined` if the account doesn't exist on chain. */
  loadAccountSigners(account: string): Promise<AccountSigners | undefined>;
  /** SIGNING_KEY from `https://<domain>/.well-known/stellar.toml` (SEP-10 client_domain). */
  fetchClientDomainSigningKey(domain: string): Promise<string>;
}

export class HorizonStellarGateway implements StellarGateway {
  private readonly server: Horizon.Server;
  private readonly asset: Asset;

  constructor(
    horizonUrl: string,
    private readonly networkPassphrase: string,
    private readonly distribution: Keypair,
    asset: { code: string; issuer: string },
    private readonly log: { error: (obj: unknown, msg?: string) => void } = console,
  ) {
    this.server = new Horizon.Server(horizonUrl);
    this.asset = new Asset(asset.code, asset.issuer);
  }

  async sendPayment({ destination, amount, memo }: { destination: string; amount: string; memo?: string | undefined }) {
    const source = await this.server.loadAccount(this.distribution.publicKey());
    const builder = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(Operation.payment({ destination, asset: this.asset, amount }))
      .setTimeout(180);
    // SEP-10 memos are numeric ID memos (see sep10/routes.ts), so pay with an ID memo.
    if (memo) builder.addMemo(/^\d+$/.test(memo) ? Memo.id(memo) : Memo.text(memo));

    const tx = builder.build();
    tx.sign(this.distribution);
    const result = await this.server.submitTransaction(tx);
    return result.hash;
  }

  watchIncomingPayments(onPayment: (p: IncomingPayment) => void | Promise<void>, options: WatchOptions = {}) {
    const account = this.distribution.publicKey();
    // Process records one at a time, in order, so the saved cursor never skips a payment.
    let queue = Promise.resolve();
    // After a failure, stop saving the cursor so a restart replays from the failed
    // record. Replays are safe: payment handling is idempotent per transaction status.
    let failed = false;
    return this.server
      .payments()
      .forAccount(account)
      .cursor(options.cursor ?? "now")
      .stream({
        onmessage: (record) => {
          queue = queue.then(async () => {
            const r = record as unknown as Horizon.ServerApi.PaymentOperationRecord;
            try {
              if (
                r.type === "payment" &&
                r.to === account &&
                r.asset_code === this.asset.code &&
                r.asset_issuer === this.asset.issuer
              ) {
                const tx = await this.server.transactions().transaction(r.transaction_hash).call();
                await onPayment({
                  transactionHash: r.transaction_hash,
                  from: r.from,
                  amount: r.amount,
                  assetCode: r.asset_code!,
                  assetIssuer: r.asset_issuer!,
                  memo: tx.memo_type === "text" ? tx.memo : undefined,
                });
              }
              if (!failed) await options.onCursor?.(r.paging_token);
            } catch (err) {
              failed = true;
              this.log.error({ err, pagingToken: r.paging_token }, "failed to process incoming payment");
            }
          });
        },
        onerror: (err) => this.log.error({ err }, "horizon payment stream error"),
      });
  }

  async loadAccountSigners(account: string): Promise<AccountSigners | undefined> {
    try {
      const record = await this.server.loadAccount(account);
      return {
        threshold: record.thresholds.med_threshold,
        signers: record.signers.map((s) => ({ key: s.key, weight: s.weight })),
      };
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }
  }

  async fetchClientDomainSigningKey(domain: string): Promise<string> {
    const toml = await StellarToml.Resolver.resolve(domain, { timeout: 5_000 });
    if (typeof toml.SIGNING_KEY !== "string") throw new Error(`${domain} stellar.toml has no SIGNING_KEY`);
    return toml.SIGNING_KEY;
  }
}
