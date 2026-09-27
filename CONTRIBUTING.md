# Contributing to Zephyr Backend

Thanks for helping build an open USD ⇄ USDC ramp on Stellar.

## Setup

Requirements: Node.js 20+. Docker is optional (it enables the real-Postgres tests and `docker compose`).

```bash
git clone https://github.com/<you>/zephyr-backend
cd zephyr-backend
npm install
cp .env.example .env && npm run keys:generate   # paste the printed keys into .env
npm test
```

The whole test suite runs **offline**:

- Horizon is replaced by `FakeStellarGateway` (`test/helpers.ts`).
- The escrow contract is replaced by `SandboxEscrowGateway` (`src/escrow/sandbox.ts`), which enforces the contract's rules in memory.
- The Postgres store runs against **PGlite** (Postgres compiled to WASM), and also against a real Postgres container when Docker is available.

## Picking up an issue

1. Find an issue labelled `good first issue` or `help wanted`.
2. Comment on it, or apply through Drips Wave if it's a Wave issue, and **wait to be assigned before starting**. Unassigned PRs may be closed so assigned contributors don't lose their work.
3. One issue per PR. If the issue is unclear, ask in the thread before writing code.

### Drips Wave

| Label                 | Points | Typical scope                                |
| --------------------- | ------ | -------------------------------------------- |
| `complexity: trivial` | 100    | Docs, copy, a small fix or test              |
| `complexity: medium`  | 150    | A feature or non-trivial bug fix, with tests |
| `complexity: high`    | 200    | A new subsystem, integration or refactor     |

Points are awarded when your PR is merged and the issue is resolved **during an active Wave**. Apply early so there's time for review.

## Branches, commits and PRs

- Branch from `main`: `feat/…`, `fix/…`, `docs/…`, `test/…`, `chore/…`.
- Use [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), with small, logical commits.
- Fill in the PR template and link the issue (`Closes #123`). CI must be green.

## Commands

| Command                           | What it does                                                         |
| --------------------------------- | -------------------------------------------------------------------- |
| `npm run dev`                     | Run with hot reload                                                  |
| `npm test`                        | All tests (offline)                                                  |
| `npm run test:coverage`           | Tests with coverage (≥ 80% lines)                                    |
| `npm run lint` / `npm run format` | ESLint / Prettier                                                    |
| `npm run typecheck`               | `tsc --noEmit`                                                       |
| `npm run db:generate`             | New migration from `src/store/schema.ts` changes (commit `drizzle/`) |
| `npm run bindings:update`         | Re-vendor `@zephyr-ramp/escrow-client` from `../zephyr-contracts`    |
| `docker compose up --build`       | Postgres + backend + frontend (needs `../zephyr-frontend`)           |

## Code style and rules

- TypeScript strict mode, ES modules, `.js` extensions on relative imports. Prettier formats; ESLint must pass.
- **Money:** never use floats. Use `src/lib/amount.ts` (BigInt, 7 decimals). ESLint bans `parseFloat`.
- **State changes** go through `TransferService.transition()`. It checks `src/sep24/state.ts`, writes the audit log and notifies wallets. Never call `store.update` with a new `status` directly.
- **Unexpected input or state → `error`** for manual review. Never auto-pay.
- **Integrations sit behind interfaces** (`PaymentRail`, `StellarGateway`, `EscrowGateway`, `TransactionStore`, `CallbackNotifier`) with fakes in tests. Tests must never hit the network.
- **SEP endpoints follow the spec.** Link the relevant SEP section in your PR when you change one.
- **API changes** to non-SEP endpoints update `openapi.yaml`. A test checks every documented path exists.
- **Schema changes** come with a generated migration. Never edit a committed migration.
- Escape user input in any HTML you render.

## Security

Never report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## Code of Conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
