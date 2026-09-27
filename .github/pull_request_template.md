## What

Closes #

## How

<!-- What changed and why. Call out changes to the API (update openapi.yaml), DB schema (commit the migration) or config (.env.example + README). -->

## Checklist

- [ ] I was assigned to the linked issue before starting
- [ ] `npm run lint`, `npm run format:check` and `npm run typecheck` pass
- [ ] `npm test` passes and new behaviour is tested
- [ ] No float math on amounts (use `src/lib/amount.ts`)
- [ ] Status changes go through `TransferService.transition` (state machine + audit log)
- [ ] Schema changes: ran `npm run db:generate` and committed `drizzle/`
- [ ] API changes: updated `openapi.yaml`
- [ ] No secrets, keys or `.env` files committed; user-facing HTML escapes dynamic values
