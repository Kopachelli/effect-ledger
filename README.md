# effect-ledger

Framework-independent ledger for **external action outcomes**. It answers the question every automation eventually hits:

> *"Did this operation actually happen — and what is safe to do next?"*

A timeout tells you what the caller observed, not what the provider did. `effect-ledger` records each intended operation once, replays recorded outcomes instead of re-executing them, and surfaces uncertain execution as `unknown` rather than guessing.

```ts
import { createLedger, MemoryStore } from 'effect-ledger';

const ledger = createLedger({ store: new MemoryStore() });

const outcome = await ledger.execute({
  scope: tenantId,
  operationId: savedOperationId,   // your durable intent ID
  input: invoiceInput,             // fingerprinted automatically
  adapter: invoiceProvider,        // { run(ctx, input), lookup?(ctx, input) }
});

if (outcome.status === 'unknown') {
  const checked = await ledger.reconcile({
    scope: tenantId,
    operationId: savedOperationId,
    adapter: invoiceProvider,
  });
  // Application policy decides what happens next.
}
```

## Behavior

| Situation | Result |
|---|---|
| Completed operation submitted again | Recorded outcome replayed; adapter is not called |
| Concurrent workers, same operation | Exactly one runs; others get `in-progress` or the replayed outcome |
| Same `operationId`, different input | `FingerprintMismatchError` — use a new `operationId` for a new intent |
| Response lost after the provider committed | Status `unknown` — never silently retried |
| Provider supports idempotency keys | Pass `ctx.idempotencyKey` (stable per operation) to `adapter.run` |
| Provider exposes status lookup | `reconcile()` resolves `unknown`/`pending` records |
| Provider offers neither | Record stays `unknown`; the decision stays with your policy |

## How it compares

See [docs/COMPARISON.md](docs/COMPARISON.md) for an honest feature-by-feature
comparison against idemkit, steadykey, armorer, and mcp-tool-idempotency —
including where effect-ledger is *not* the right tool.

## Related packages

Part of the Kopachelli reliability toolkit:

- [one-flight](https://www.npmjs.com/package/one-flight) — in-flight async
  dedupe for the cases that don't need durability
- [verifiable-log](https://www.npmjs.com/package/verifiable-log) — hash-chained
  audit trail for the records a ledger produces
- [time-budget](https://www.npmjs.com/package/time-budget) — deadline
  propagation for the calls inside your adapter
- [httpsig-js](https://www.npmjs.com/package/httpsig-js) — RFC 9421 HTTP Message
  Signatures for authenticating the callers

## Guarantees and limits

**Guaranteed:**

- One `(scope, operationId)` pair records exactly one intent; the fingerprint binds it to one input.
- Terminal outcomes (`succeeded`, `failed`) are replayed, never re-executed.
- Uncertain outcomes are reported as `unknown`, never guessed.
- All state transitions are fenced by `attemptId` — a stale worker cannot overwrite a newer attempt's record.

**Not guaranteed:**

- The ledger cannot prove what a provider did. Without `adapter.lookup`, `unknown` records stay unknown until you resolve them.
- `leaseMs` must exceed your worst-case `adapter.run` duration. A run that outlives its lease can be duplicated by the next attempt — the same limit every lease-based system has. Set `leaseMs` generously.
- `restart: true` is an explicit opt-in for `failed`/`unknown` records. Never enable it automatically for `unknown`: the external effect may already have happened.

## Adapters

```ts
interface ActionAdapter {
  run(ctx: RunContext, input): Promise<TResult>;
  lookup?(ctx: RunContext, input): Promise<LookupResult>;
}
```

- Throw an error with `definitive: true` (or `name === 'DefinitiveError'`) when you can prove the effect did **not** happen — the record becomes `failed`.
- Any other throw means the outcome is uncertain — the record becomes `unknown`.
- `lookup` should report `{ status: 'succeeded' | 'failed' | 'pending' | 'unknown' }`.

## Stores

- `MemoryStore` — in-process; tests and single-process apps.
- `SqliteStore` — durable, via Node's built-in `node:sqlite` (Node ≥ 22.13). Pass `':memory:'` or a file path. On Node 22 it prints an experimental warning; pin your Node version.
- `D1Store` — Cloudflare D1 (SQLite at the edge). Apply `D1_SCHEMA_SQL` once, then `new D1Store(env.DB)`. Uses a structural `D1DatabaseLike` interface — no `@cloudflare/workers-types` dependency needed.

Implement `LedgerStore` for your own database — the contract is three methods (`get`, `insert`, `updateIf`), and `updateIf` must be an atomic conditional write.

## Development

```sh
npm install
npm test    # builds, then runs node:test suites
```

Requires Node ≥ 22.13.
