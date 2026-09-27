/**
 * Generates fresh testnet keys for local development and funds them with Friendbot.
 * Usage: npm run keys:generate
 */
import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

const signing = Keypair.random();
const distribution = Keypair.random();

async function fund(pub: string) {
  try {
    const res = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
    return res.ok ? "funded" : `friendbot returned ${res.status}`;
  } catch {
    return "friendbot unreachable; fund manually at https://lab.stellar.org";
  }
}

console.log(`# Paste into .env (testnet only)
SEP10_SIGNING_SECRET=${signing.secret()}
DISTRIBUTION_SECRET=${distribution.secret()}
JWT_SECRET=${randomBytes(32).toString("hex")}
`);
console.error(`distribution account ${distribution.publicKey()}: ${await fund(distribution.publicKey())}`);
console.error("Next: add a USDC trustline to the distribution account and get testnet USDC (see README).");
