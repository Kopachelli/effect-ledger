import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, MemoryStore, SqliteStore } from '../dist/esm/index.js';
import type { ActionAdapter, LookupResult, RunContext } from '../dist/esm/index.js';

function adapter<T = unknown>(
  run: (ctx: RunContext, input?: unknown) => Promise<T>,
  lookup?: (ctx: RunContext, input?: unknown) => Promise<LookupResult>,
): ActionAdapter<unknown, T> {
  return { run: run as ActionAdapter<unknown, T>['run'], lookup: lookup as never };
}

test('memory: success path records and replays outcome', async () => {
  const ledger = createLedger({ store: new MemoryStore() });
  let calls = 0;
  const ad = adapter(async () => {
    calls++;
    return { invoiceId: 'inv_1' };
  });

  const first = await ledger.execute({
    scope: 'tenant-1',
    operationId: 'op-1',
    input: { amount: 100 },
    adapter: ad,
  });
  assert.equal(first.status, 'succeeded');
  assert.equal(calls, 1);

  const second = await ledger.execute({
    scope: 'tenant-1',
    operationId: 'op-1',
    input: { amount: 100 },
    adapter: ad,
  });
  assert.equal(second.status, 'succeeded');
  assert.equal(second.replayed, true);
  assert.equal(calls, 1, 'adapter must not run twice');
});

test('memory: same operationId with different input is rejected', async () => {
  const ledger = createLedger({ store: new MemoryStore() });
  const ad = adapter(async () => 'ok');
  await ledger.execute({ scope: 's', operationId: 'op', input: { a: 1 }, adapter: ad });
  await assert.rejects(
    ledger.execute({ scope: 's', operationId: 'op', input: { a: 2 }, adapter: ad }),
    /different input fingerprint/,
  );
});

test('memory: lost response becomes unknown, reconcile resolves it', async () => {
  const ledger = createLedger({ store: new MemoryStore() });
  let providerDidIt = false;
  const ad = adapter(
    async () => {
      providerDidIt = true;
      throw new Error('socket hangup'); // response lost after commit
    },
    async () => (providerDidIt ? { status: 'succeeded' as const, result: 'done' } : { status: 'unknown' as const }),
  );

  const out = await ledger.execute({ scope: 's', operationId: 'op', input: {}, adapter: ad });
  assert.equal(out.status, 'unknown');
  assert.equal(providerDidIt, true);

  const rec = await ledger.reconcile({ scope: 's', operationId: 'op', adapter: ad });
  assert.equal(rec.status, 'succeeded');
  assert.equal(rec.result, 'done');

  // Terminal outcome replays without re-running or re-looking-up.
  const again = await ledger.execute({ scope: 's', operationId: 'op', input: {}, adapter: ad });
  assert.equal(again.status, 'succeeded');
  assert.equal(again.replayed, true);
});

test('memory: definitive rejection records failed and replays it', async () => {
  const ledger = createLedger({ store: new MemoryStore() });
  let calls = 0;
  const ad = adapter(async () => {
    calls++;
    const e = new Error('card declined') as Error & { definitive: boolean };
    e.definitive = true;
    throw e;
  });
  const out = await ledger.execute({ scope: 's', operationId: 'op', input: {}, adapter: ad });
  assert.equal(out.status, 'failed');
  const again = await ledger.execute({ scope: 's', operationId: 'op', input: {}, adapter: ad });
  assert.equal(again.status, 'failed');
  assert.equal(again.replayed, true);
  assert.equal(calls, 1);
});

test('memory: concurrent executes run the adapter once', async () => {
  const ledger = createLedger({ store: new MemoryStore() });
  let calls = 0;
  const ad = adapter(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return 'ok';
  });
  const [a, b] = await Promise.all([
    ledger.execute({ scope: 's', operationId: 'op', input: {}, adapter: ad }),
    ledger.execute({ scope: 's', operationId: 'op', input: {}, adapter: ad }),
  ]);
  assert.equal(calls, 1);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ['in-progress', 'succeeded']);
});

test('memory: expired pending lease becomes unknown, not silently retried', async () => {
  const ledger = createLedger({ store: new MemoryStore(), leaseMs: 5 });
  let now = 1_000;
  const clock = () => now;
  let calls = 0;
  const ad = adapter(async () => {
    calls++;
    // Simulate crash: never resolves the record (we throw a non-definitive error)
    throw new Error('worker died');
  });
  const out1 = await ledger.execute({ scope: 's', operationId: 'op', input: {}, adapter: ad, now: clock });
  assert.equal(out1.status, 'unknown');

  now += 10_000; // lease long expired
  const out2 = await ledger.execute({ scope: 's', operationId: 'op', input: {}, adapter: ad, now: clock });
  assert.equal(out2.status, 'unknown');
  assert.equal(calls, 1, 'must not auto-rerun an uncertain operation');
});

test('memory: explicit restart re-runs a failed operation', async () => {
  const ledger = createLedger({ store: new MemoryStore() });
  let calls = 0;
  const ad = adapter(async () => {
    calls++;
    if (calls === 1) {
      const e = new Error('definitive') as Error & { definitive: boolean };
      e.definitive = true;
      throw e;
    }
    return 'recovered';
  });
  const first = await ledger.execute({ scope: 's', operationId: 'op', input: {}, adapter: ad });
  assert.equal(first.status, 'failed');
  const second = await ledger.execute({ scope: 's', operationId: 'op', input: {}, adapter: ad, restart: true });
  assert.equal(second.status, 'succeeded');
  assert.equal(second.result, 'recovered');
  assert.equal(calls, 2);
});

test('memory: idempotency key is stable across attempts', async () => {
  const ledger = createLedger({ store: new MemoryStore() });
  const keys: string[] = [];
  const ad = adapter(async (ctx) => {
    keys.push(ctx.idempotencyKey);
    if (keys.length === 1) throw new Error('lost');
    return 'ok';
  });
  await ledger.execute({ scope: 's', operationId: 'op', input: {}, adapter: ad });
  await ledger.execute({ scope: 's', operationId: 'op', input: {}, adapter: ad, restart: true });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test('sqlite: full lifecycle survives store semantics', async () => {
  const store = new SqliteStore(':memory:');
  const ledger = createLedger({ store });
  let calls = 0;
  const ad = adapter(async () => {
    calls++;
    return { id: calls };
  });
  const out = await ledger.execute({ scope: 's', operationId: 'op', input: { x: 1 }, adapter: ad });
  assert.equal(out.status, 'succeeded');
  const replay = await ledger.execute({ scope: 's', operationId: 'op', input: { x: 1 }, adapter: ad });
  assert.equal(replay.replayed, true);
  assert.equal(calls, 1);
  store.close();
});

test('sqlite: fingerprint mismatch rejected', async () => {
  const store = new SqliteStore(':memory:');
  const ledger = createLedger({ store });
  const ad = adapter(async () => 'ok');
  await ledger.execute({ scope: 's', operationId: 'op', input: { a: 1 }, adapter: ad });
  await assert.rejects(
    ledger.execute({ scope: 's', operationId: 'op', input: { a: 2 }, adapter: ad }),
    /different input fingerprint/,
  );
  store.close();
});
