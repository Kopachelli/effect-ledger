import type { OperationRecord, OperationStatus } from './types.js';

/**
 * Storage contract. `updateIf` must be a single atomic conditional write:
 * it applies `patch` only when the stored record still has `attemptId`
 * and a status in `expectStatuses`. This is the fencing mechanism that
 * prevents a stale worker from overwriting a newer attempt.
 */
export interface LedgerStore {
  get(scope: string, operationId: string): Promise<OperationRecord | null>;

  /** Insert a new record. Returns false when (scope, operationId) exists. */
  insert(record: OperationRecord): Promise<boolean>;

  /**
   * Atomically patch a record fenced by attemptId and expected statuses.
   * Returns true when the patch was applied.
   */
  updateIf(
    scope: string,
    operationId: string,
    expectAttemptId: string,
    expectStatuses: readonly OperationStatus[],
    patch: Partial<OperationRecord>,
  ): Promise<boolean>;
}
