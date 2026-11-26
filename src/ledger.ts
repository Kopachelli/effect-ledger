import { randomUUID } from 'node:crypto';
import {
  FingerprintMismatchError,
  OperationNotFoundError,
} from './errors.js';
import { fingerprintOf } from './fingerprint.js';
import type { LedgerStore } from './store.js';
import type {
  ActionAdapter,
  ExecuteOptions,
  LookupResult,
  OperationRecord,
  OperationStatus,
  Outcome,
  ReconcileOptions,
  RunContext,
  SerializedError,
} from './types.js';

const TERMINAL: readonly OperationStatus[] = ['succeeded', 'failed'];
const LIVE: readonly OperationStatus[] = ['pending', 'unknown'];
const RESTARTABLE: readonly OperationStatus[] = ['pending', 'unknown', 'failed'];

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const definitive =
      (err as { definitive?: boolean }).definitive === true ||
      err.name === 'DefinitiveError';
    return { name: err.name, message: err.message, ...(definitive ? { definitive: true } : {}) };
  }
  return { name: 'Error', message: String(err) };
}

function isDefinitive(err: unknown): boolean {
  return (
    err instanceof Error &&
    ((err as { definitive?: boolean }).definitive === true || err.name === 'DefinitiveError')
  );
}

function toOutcome(rec: OperationRecord): Outcome {
  if (rec.status === 'succeeded') {
    return { status: 'succeeded', result: rec.result, replayed: true, record: rec };
  }
  if (rec.status === 'failed') {
    return { status: 'failed', error: rec.error, replayed: true, record: rec };
  }
  return { status: rec.status === 'pending' ? 'in-progress' : 'unknown', replayed: false, record: rec };
}

export interface Ledger {
  execute<TInput, TResult>(
    options: ExecuteOptions<TInput, TResult>,
  ): Promise<Outcome<TResult>>;
  reconcile<TInput>(options: ReconcileOptions<TInput>): Promise<Outcome>;
  get(scope: string, operationId: string): Promise<OperationRecord | null>;
}

export interface LedgerOptions {
  store: LedgerStore;
  /** Default lease duration in ms. Default: 30_000. */
  leaseMs?: number;
}

/**
 * Records the outcome of external actions so retries cannot silently
 * duplicate them and lost responses surface as 'unknown' instead of
 * being mistaken for failure.
 *
 * Guarantees:
 * - One operationId + fingerprint pair has exactly one recorded intent.
 * - A terminal outcome is replayed, never re-executed.
 * - An uncertain outcome is reported as 'unknown', never guessed.
 * - All record transitions are fenced by attemptId.
 *
 * Limits (read the README):
 * - The ledger cannot prove what a provider did. Without adapter.lookup,
 *   'unknown' records stay unknown until an operator resolves them.
 * - leaseMs must exceed the worst-case adapter.run duration. A run that
 *   outlives its lease may be duplicated by the next attempt — the same
 *   limit every lease-based system has.
 */
export function createLedger(options: LedgerOptions): Ledger {
  const { store } = options;
  const defaultLeaseMs = options.leaseMs ?? 30_000;

  function ctxFor(record: OperationRecord): RunContext {
    return {
      scope: record.scope,
      operationId: record.operationId,
      attemptId: record.attemptId,
      idempotencyKey: `effect-ledger:${record.scope}:${record.operationId}`,
    };
  }

  async function runAttempt<TInput, TResult>(
    record: OperationRecord,
    adapter: ActionAdapter<TInput, TResult>,
    input: TInput | undefined,
    now: () => number,
  ): Promise<Outcome<TResult>> {
    const ctx = ctxFor(record);
    try {
      const result = await adapter.run(ctx, input as TInput);
      const ok = await store.updateIf(
        record.scope,
        record.operationId,
        record.attemptId,
        ['pending'],
        { status: 'succeeded', result, leaseExpiresAt: 0, updatedAt: now() },
      );
      if (!ok) {
        // Our lease was lost mid-run. The external effect may have
        // happened; the new owner decides what happens next.
        const current = await store.get(record.scope, record.operationId);
        return {
          status: 'unknown',
          replayed: false,
          record: current ?? record,
        };
      }
      const saved = await store.get(record.scope, record.operationId);
      return {
        status: 'succeeded',
        result,
        replayed: false,
        record: saved ?? { ...record, status: 'succeeded', result },
      };
    } catch (err) {
      const patch = isDefinitive(err)
        ? {
            status: 'failed' as const,
            error: serializeError(err),
            leaseExpiresAt: 0,
            updatedAt: now(),
          }
        : { status: 'unknown' as const, error: serializeError(err), updatedAt: now() };
      await store.updateIf(
        record.scope,
        record.operationId,
        record.attemptId,
        ['pending'],
        patch,
      );
      const saved = await store.get(record.scope, record.operationId);
      return {
        status: patch.status === 'failed' ? 'failed' : 'unknown',
        error: patch.error,
        replayed: false,
        record: saved ?? { ...record, ...patch },
      };
    }
  }

  async function tryRestart<TInput, TResult>(
    record: OperationRecord,
    adapter: ActionAdapter<TInput, TResult>,
    input: TInput | undefined,
    leaseMs: number,
    now: () => number,
  ): Promise<Outcome<TResult>> {
    const next: OperationRecord = {
      ...record,
      status: 'pending',
      attemptId: randomUUID(),
      leaseExpiresAt: now() + leaseMs,
      error: undefined,
      updatedAt: now(),
    };
    const ok = await store.updateIf(
      record.scope,
      record.operationId,
      record.attemptId,
      RESTARTABLE,
      {
        status: 'pending',
        attemptId: next.attemptId,
        leaseExpiresAt: next.leaseExpiresAt,
        error: undefined,
        updatedAt: next.updatedAt,
      },
    );
    if (!ok) {
      const current = await store.get(record.scope, record.operationId);
      return (current ? toOutcome(current) : { status: 'unknown' as const, replayed: false, record }) as Outcome<TResult>;
    }
    return runAttempt(next, adapter, input, now);
  }

  async function resume<TInput, TResult>(
    record: OperationRecord,
    adapter: ActionAdapter<TInput, TResult>,
    input: TInput | undefined,
    leaseMs: number,
    restart: boolean,
    now: () => number,
  ): Promise<Outcome<TResult>> {
    if (record.status === 'pending' && record.leaseExpiresAt > now()) {
      return { status: 'in-progress', replayed: false, record };
    }
    // pending-with-expired-lease or unknown: the external effect is
    // uncertain. Mark it durably unknown, then either report it or
    // honor an explicit restart.
    if (record.status === 'pending') {
      await store.updateIf(
        record.scope,
        record.operationId,
        record.attemptId,
        ['pending'],
        { status: 'unknown', updatedAt: now() },
      );
      const current = await store.get(record.scope, record.operationId);
      const settled = current ?? { ...record, status: 'unknown' as const };
      if (!restart) {
        return { status: 'unknown', replayed: false, record: settled };
      }
      return tryRestart(settled, adapter, input, leaseMs, now);
    }
    // status === 'unknown'
    if (!restart) {
      return { status: 'unknown', replayed: false, record };
    }
    return tryRestart(record, adapter, input, leaseMs, now);
  }

  return {
    async execute<TInput, TResult>(
      opts: ExecuteOptions<TInput, TResult>,
    ): Promise<Outcome<TResult>> {
      const now = opts.now ?? Date.now;
      const leaseMs = opts.leaseMs ?? defaultLeaseMs;
      const fp = opts.fingerprint ?? fingerprintOf(opts.input);
      const attemptId = randomUUID();

      const existing = await store.get(opts.scope, opts.operationId);
      if (existing) {
        if (existing.fingerprint !== fp) {
          throw new FingerprintMismatchError(opts.scope, opts.operationId);
        }
        if (existing.status === 'succeeded') {
          return toOutcome(existing) as Outcome<TResult>;
        }
        if (existing.status === 'failed') {
          if (opts.restart === true) {
            return tryRestart(existing, opts.adapter, opts.input, leaseMs, now);
          }
          return toOutcome(existing) as Outcome<TResult>;
        }
        return resume(existing, opts.adapter, opts.input, leaseMs, opts.restart === true, now);
      }

      const record: OperationRecord = {
        scope: opts.scope,
        operationId: opts.operationId,
        fingerprint: fp,
        status: 'pending',
        attemptId,
        leaseExpiresAt: now() + leaseMs,
        createdAt: now(),
        updatedAt: now(),
      };
      const inserted = await store.insert(record);
      if (!inserted) {
        // Lost an insert race: treat as an existing record.
        const raced = await store.get(opts.scope, opts.operationId);
        if (!raced) throw new Error('Ledger store lost a record during insert race.');
        if (raced.fingerprint !== fp) {
          throw new FingerprintMismatchError(opts.scope, opts.operationId);
        }
        if (raced.status === 'succeeded' || raced.status === 'failed') {
          if (raced.status === 'failed' && opts.restart === true) {
            return tryRestart(raced, opts.adapter, opts.input, leaseMs, now);
          }
          return toOutcome(raced) as Outcome<TResult>;
        }
        return resume(raced, opts.adapter, opts.input, leaseMs, opts.restart === true, now);
      }
      return runAttempt(record, opts.adapter, opts.input, now);
    },

    async reconcile<TInput>(opts: ReconcileOptions<TInput>): Promise<Outcome> {
      const now = opts.now ?? Date.now;
      const rec = await store.get(opts.scope, opts.operationId);
      if (!rec) throw new OperationNotFoundError(opts.scope, opts.operationId);
      if (TERMINAL.includes(rec.status)) return toOutcome(rec);

      const lookup = opts.adapter.lookup;
      if (!lookup) return { status: 'unknown', replayed: false, record: rec };

      const ctx = ctxFor(rec);
      const verdict: LookupResult = await lookup(ctx, opts.input as TInput);

      if (verdict.status === 'succeeded' || verdict.status === 'failed') {
        const ok = await store.updateIf(
          rec.scope,
          rec.operationId,
          rec.attemptId,
          LIVE,
          verdict.status === 'succeeded'
            ? { status: 'succeeded', result: verdict.result, leaseExpiresAt: 0, updatedAt: now() }
            : {
                status: 'failed',
                error: verdict.error ?? { name: 'Error', message: 'Provider reported failure.' },
                leaseExpiresAt: 0,
                updatedAt: now(),
              },
        );
        if (!ok) {
          const current = await store.get(rec.scope, rec.operationId);
          return current ? toOutcome(current) : { status: 'unknown', replayed: false, record: rec };
        }
        const saved = await store.get(rec.scope, rec.operationId);
        return saved ? toOutcome(saved) : { status: verdict.status, replayed: false, record: rec };
      }
      if (verdict.status === 'pending') {
        // Provider confirms the effect is still executing. Extend the
        // lease window modestly so the record does not look abandoned.
        await store.updateIf(rec.scope, rec.operationId, rec.attemptId, LIVE, {
          leaseExpiresAt: now() + 60_000,
          updatedAt: now(),
        });
        const current = await store.get(rec.scope, rec.operationId);
        return {
          status: 'in-progress',
          replayed: false,
          record: current ?? rec,
        };
      }
      return { status: 'unknown', replayed: false, record: rec };
    },

    get(scope, operationId) {
      return store.get(scope, operationId);
    },
  };
}
