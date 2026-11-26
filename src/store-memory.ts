import type { LedgerStore } from './store.js';
import type { OperationRecord, OperationStatus } from './types.js';

function key(scope: string, operationId: string): string {
  return JSON.stringify([scope, operationId]);
}

/**
 * In-process store. Suitable for tests, single-process apps, and as the
 * reference implementation of the storage contract. Not shared across
 * processes.
 */
export class MemoryStore implements LedgerStore {
  private readonly records = new Map<string, OperationRecord>();

  async get(scope: string, operationId: string): Promise<OperationRecord | null> {
    const rec = this.records.get(key(scope, operationId));
    return rec ? structuredClone(rec) : null;
  }

  async insert(record: OperationRecord): Promise<boolean> {
    const k = key(record.scope, record.operationId);
    if (this.records.has(k)) return false;
    this.records.set(k, structuredClone(record));
    return true;
  }

  async updateIf(
    scope: string,
    operationId: string,
    expectAttemptId: string,
    expectStatuses: readonly OperationStatus[],
    patch: Partial<OperationRecord>,
  ): Promise<boolean> {
    const k = key(scope, operationId);
    const rec = this.records.get(k);
    if (!rec) return false;
    if (rec.attemptId !== expectAttemptId) return false;
    if (!expectStatuses.includes(rec.status)) return false;
    Object.assign(rec, patch);
    rec.updatedAt = patch.updatedAt ?? Date.now();
    return true;
  }
}
