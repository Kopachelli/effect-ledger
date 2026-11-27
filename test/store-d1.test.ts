import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createLedger, D1Store, D1_SCHEMA_SQL } from '../dist/esm/index.js';
import type { D1DatabaseLike, D1PreparedStatement, D1RunResult } from '../dist/esm/index.js';

// Minimal D1DatabaseLike backed by node:sqlite — exercises the real SQL.
class FakeD1 implements D1DatabaseLike {
  private readonly db = new DatabaseSync(':memory:');
  constructor() { this.db.exec(D1_SCHEMA_SQL); }
  prepare(query: string): D1PreparedStatement {
    const db = this.db;
    let params: unknown[] = [];
    const stmt = {
      bind(...values: unknown[]) { params = values; return stmt; },
      async run(): Promise<D1RunResult> {
        const info = db.prepare(query).run(...(params as never[]));
        return { meta: { changes: Number(info.changes) } };
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        return (db.prepare(query).get(...(params as never[])) as T) ?? null;
      },
    };
    return stmt as D1PreparedStatement;
  }
}

test('D1Store round-trips records through real SQL', async () => {
  const store = new D1Store(new FakeD1());
  const ledger = createLedger({ store, leaseMs: 1000 });
  let calls = 0;
  const out = await ledger.execute({
    scope: 'test', operationId: 'op1', input: { x: 1 },
    adapter: { run: async () => { calls++; return { done: true }; } },
  });
  assert.equal(out.status, 'succeeded');
  assert.equal(calls, 1);
  const rec = await store.get('test', 'op1');
  assert.equal(rec?.status, 'succeeded');
  assert.deepEqual(rec?.result, { done: true });
});

test('D1Store insert is atomic (OR IGNORE on PK)', async () => {
  const store = new D1Store(new FakeD1());
  const now = Date.now();
  const rec = {
    scope: 's', operationId: 'o', fingerprint: 'f', status: 'pending' as const,
    attemptId: 'a1', leaseExpiresAt: now + 1000, createdAt: now, updatedAt: now,
  };
  assert.equal(await store.insert(rec), true);
  assert.equal(await store.insert({ ...rec, attemptId: 'a2' }), false);
  assert.equal((await store.get('s', 'o'))?.attemptId, 'a1');
});

test('D1Store updateIf fences on attemptId and status', async () => {
  const store = new D1Store(new FakeD1());
  const now = Date.now();
  await store.insert({
    scope: 's', operationId: 'o', fingerprint: 'f', status: 'pending',
    attemptId: 'a1', leaseExpiresAt: now + 1000, createdAt: now, updatedAt: now,
  });
  const ok = await store.updateIf('s', 'o', 'a1', ['pending'], { status: 'succeeded', result: { v: 1 } });
  assert.equal(ok, true);
  const wrongAttempt = await store.updateIf('s', 'o', 'a2', ['succeeded'], { status: 'failed' });
  assert.equal(wrongAttempt, false);
  const rec = await store.get('s', 'o');
  assert.equal(rec?.status, 'succeeded');
  assert.deepEqual(rec?.result, { v: 1 });
});

test('full ledger flow: claim, succeed, replay on D1', async () => {
  const store = new D1Store(new FakeD1());
  const ledger = createLedger({ store });
  let calls = 0;
  const adapter = { run: async () => { calls++; return calls; } };
  const o1 = await ledger.execute({ scope: 's', operationId: 'o', input: {}, adapter });
  const o2 = await ledger.execute({ scope: 's', operationId: 'o', input: {}, adapter });
  assert.equal(o1.status, 'succeeded');
  assert.equal(o2.status, 'succeeded');
  assert.equal(o2.replayed, true);
  assert.equal(calls, 1);
});
