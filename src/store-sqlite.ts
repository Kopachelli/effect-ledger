import { DatabaseSync } from 'node:sqlite';
import type { LedgerStore } from './store.js';
import type { OperationRecord, OperationStatus } from './types.js';

interface Row {
  scope: string;
  operation_id: string;
  fingerprint: string;
  status: string;
  result: string | null;
  error: string | null;
  attempt_id: string;
  lease_expires_at: number;
  created_at: number;
  updated_at: number;
}

function toRecord(row: Row): OperationRecord {
  return {
    scope: row.scope,
    operationId: row.operation_id,
    fingerprint: row.fingerprint,
    status: row.status as OperationStatus,
    result: row.result === null ? undefined : JSON.parse(row.result),
    error: row.error === null ? undefined : JSON.parse(row.error),
    attemptId: row.attempt_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Durable store backed by SQLite via the built-in `node:sqlite` module.
 * Requires Node >= 22.13. On Node 22 this module prints an experimental
 * warning; the API is stable enough for production ledgers but pin your
 * Node version and test upgrades.
 *
 * Pass `':memory:'` for a private in-process database, or a file path
 * for durability across restarts. One process should own a given file.
 */
export class SqliteStore implements LedgerStore {
  private readonly db: DatabaseSync;

  constructor(pathOrMemory: string = ':memory:') {
    this.db = new DatabaseSync(pathOrMemory);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS action_ledger (
        scope TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        attempt_id TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, operation_id)
      )
    `);
  }

  async get(scope: string, operationId: string): Promise<OperationRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM action_ledger WHERE scope = ? AND operation_id = ?')
      .get(scope, operationId) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  async insert(record: OperationRecord): Promise<boolean> {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO action_ledger
         (scope, operation_id, fingerprint, status, result, error, attempt_id, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.scope,
        record.operationId,
        record.fingerprint,
        record.status,
        record.result === undefined ? null : JSON.stringify(record.result),
        record.error === undefined ? null : JSON.stringify(record.error),
        record.attemptId,
        record.leaseExpiresAt,
        record.createdAt,
        record.updatedAt,
      );
    return Number(res.changes) > 0;
  }

  async updateIf(
    scope: string,
    operationId: string,
    expectAttemptId: string,
    expectStatuses: readonly OperationStatus[],
    patch: Partial<OperationRecord>,
  ): Promise<boolean> {
    const columns: Record<string, string> = {
      status: 'status',
      result: 'result',
      error: 'error',
      attemptId: 'attempt_id',
      leaseExpiresAt: 'lease_expires_at',
      fingerprint: 'fingerprint',
      updatedAt: 'updated_at',
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [field, column] of Object.entries(columns)) {
      const v = (patch as Record<string, unknown>)[field];
      if (v === undefined) continue;
      sets.push(`${column} = ?`);
      if (field === 'result' || field === 'error') {
        values.push(v === null ? null : JSON.stringify(v));
      } else {
        values.push(v as string | number);
      }
    }
    if (sets.length === 0) return false;
    const placeholders = expectStatuses.map(() => '?').join(', ');
    const res = this.db
      .prepare(
        `UPDATE action_ledger SET ${sets.join(', ')}
         WHERE scope = ? AND operation_id = ? AND attempt_id = ? AND status IN (${placeholders})`,
      )
      .run(
        ...values,
        scope,
        operationId,
        expectAttemptId,
        ...expectStatuses,
      );
    return Number(res.changes) > 0;
  }

  /** Close the underlying database. */
  close(): void {
    this.db.close();
  }
}
