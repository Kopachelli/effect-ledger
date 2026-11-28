// Cloudflare Worker example: D1-backed effect-ledger.
//
// This file is a TEMPLATE, not a runnable Node script — it needs a Worker
// environment (env.DB binding). Paste the handler into your Worker's
// src/index.ts, apply D1_SCHEMA_SQL once, and deploy.
//
// Setup:
//   1. wrangler d1 create my-db
//   2. Paste D1_SCHEMA_SQL into a migration and apply:
//        wrangler d1 execute my-db --remote --file=./schema.sql
//   3. Bind it in wrangler.jsonc:  "d1_databases": [{ "binding": "DB", ... }]
import { createLedger, D1Store, D1_SCHEMA_SQL } from 'effect-ledger';

export { D1_SCHEMA_SQL }; // re-exported so you can copy it into a migration

// One ledger per request is fine — D1Store is stateless, the DB is the state.
function ledgerFor(env) {
  return createLedger({ store: new D1Store(env.DB), leaseMs: 60_000 });
}

export default {
  async fetch(request, env) {
    const ledger = ledgerFor(env);
    const url = new URL(request.url);

    // Paid/critical operation: dedupe + replay via the ledger.
    // operationId must be durable — a client-supplied id, a payment
    // signature hash, a queue message id — NOT a random value per request.
    const operationId = request.headers.get('x-operation-id')
      || `op_${url.pathname}`;

    const outcome = await ledger.execute({
      scope: 'my-worker',
      operationId,
      input: { path: url.pathname, amount: '0.01' }, // fingerprinted automatically
      adapter: {
        // The effect you must not duplicate: charge, provision, deliver.
        async run(ctx, input) {
          const res = await fetch('https://api.example.com/charge', {
            method: 'POST',
            headers: { 'idempotency-key': ctx.idempotencyKey },
            body: JSON.stringify({ amount: input.amount }),
          });
          if (!res.ok) {
            const err = new Error(`charge failed: ${res.status}`);
            err.definitive = true; // provably did not happen — safe to retry
            throw err;
          }
          return res.json();
        },
        // Optional: let the provider answer "did it happen?" for unknowns,
        // used by ledger.reconcile() — not by execute() itself.
        async lookup(ctx, input) {
          // return { status: 'succeeded', result } | { status: 'pending' }
          //      | { status: 'failed', error } | { status: 'unknown' }
          return { status: 'unknown' };
        },
      },
    });

    if (outcome.replayed && outcome.status === 'succeeded') {
      return Response.json({ replayed: true, result: outcome.result });
    }
    if (outcome.status === 'failed') {
      return Response.json({ error: outcome.error }, { status: 502 });
    }
    if (outcome.status === 'unknown' || outcome.status === 'in-progress') {
      // Don't let the client blindly retry-and-pay — reconcile first.
      return Response.json({ error: outcome.status }, { status: 503 });
    }
    return Response.json({ result: outcome.result });
  },
};
