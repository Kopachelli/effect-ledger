# How effect-ledger compares

An honest comparison against the packages that already cover parts of this
space. **Methodology:** competitor capabilities below are taken from their
published READMEs/docs (npm, GitHub) — *documented* claims, not an independent
audit. effect-ledger's behavior is covered by the failure-injection test
suite in `test/ledger.test.ts` (lost responses, crashes, races, stale workers,
fingerprint mismatch, inconclusive reconciliation).

| | **effect-ledger** | **idemkit** | **steadykey** | **armorer** | **mcp-tool-idempotency** |
|---|---|---|---|---|---|
| Shape | Framework-agnostic core (`execute`/`reconcile`) | HTTP middleware + function wrapper | Key manager + execute-once + middleware | Tool registry/runtime (corvidae) | MCP-server middleware |
| Operation identity | Caller `operationId` + input fingerprint (SHA-256, key-sorted) | Idempotency-Key header / message id / args | Deterministic key derivation from payload | Tool call + full input key | Request fingerprint |
| Replay of completed op | ✅ recorded result | ✅ original response | ✅ | ✅ cached tool result | ✅ |
| Concurrent duplicate | ✅ one winner, others `in-progress` | ✅ 423 + Retry-After | ✅ | ✅ | ✅ atomic claims |
| Same id, different input | ✅ `FingerprintMismatchError` | ✅ 422 payload-mismatch | n/a (key derived from payload) | ✅ | ✅ fingerprint |
| Crash / lost response | ✅ explicit `unknown` status | in-progress until lease expiry | lease-based | ✅ `unknown-outcome` | ✅ opt-in uncertain outcomes |
| Provider reconcile | ✅ `adapter.lookup` → `reconcile()` | — | — | — | — |
| Provider idempotency key | ✅ stable `ctx.idempotencyKey` passthrough | — | — | — | — |
| Stale-worker fencing | ✅ attemptId CAS on every transition | ✅ fencing tokens | ✅ | partial | ✅ leases |
| Backends | Memory, SQLite (`node:sqlite`) | Redis, Postgres, Mongo, Dynamo, memory | Many storage adapters | Pluggable KV store | Postgres, memory |
| HTTP middleware | — | ✅ Express/Fastify/Hono/Fetch | ✅ | — | MCP-specific |
| Runtime deps | zero | several | zero | part of corvidae | — |
| Distribution | npm `effect-ledger` | npm `idemkit` | npm `steadykey` | npm `armorer` | GitHub only |

## Where effect-ledger is genuinely different

1. **`unknown` is a first-class, durable outcome.** idemkit and steadykey model
   the world as "completed or in-flight"; a lost response eventually resolves by
   lease expiry. effect-ledger persists `unknown` until `reconcile()` produces
   evidence — matching the reality that *the timeout describes what the caller
   observed, not what the provider did*.

2. **Reconciliation is a contract, not a hope.** `adapter.lookup` lets the
   provider answer "what actually happened?" and the ledger records the verdict
   under fencing. None of the compared packages document an equivalent
   outcome-resolution path.

3. **Smallest possible adoption surface.** Three store methods, two adapter
   methods, zero dependencies. It is designed to be *embedded* — inside MCP
   servers, agent runtimes, job workers — rather than to own an HTTP edge or a
   tool registry (which is what idemkit and armorer already do well).

## Where it is NOT the right tool

- **HTTP API edge dedupe** → use `idemkit` (middleware, problem+json semantics,
  many backends).
- **Deterministic key generation across services** → use `steadykey`.
- **Inside the armorer/corvidae tool runtime** → armorer's idempotency cache
  already covers tool-call dedupe including re-authorization on replay.
- **Multi-datacenter storage** → effect-ledger ships Memory + single-file
  SQLite only. The `LedgerStore` contract is deliberately three methods so a
  Postgres/Redis implementation is ~100 lines, but it does not exist yet.

## The honest bottom line

effect-ledger does not beat idemkit at HTTP dedupe, steadykey at key
management, or armorer inside its own runtime. Its claim is narrower: the
smallest correct core for "an external action may or may not have happened,
persist that fact, and let the application decide" — the layer *under* those
systems. First production integration: `x402-mcp`
(github.com/Kopachelli/x402-mcp), where paid calls spend real USDC.
