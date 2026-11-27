// D1-backed LedgerStore for Cloudflare Workers (D1 is SQLite at the edge).
// Uses a structural D1DatabaseLike interface so no @cloudflare/workers-types
// dependency is required — any object with prepare().bind().run()/.first()
// works, including mocks in tests.
import type { LedgerStore } from './store.js';
import type { OperationRecord, OperationStatus } from './types.js';

export interface D1ResultMeta {
  changes?: number;
}
export interface D1RunResult {
  meta?: D1ResultMeta;
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1RunResult>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
}

/**
 * Schema for the effect_ledger table. Apply once per D1 database
 * (`wrangler d1 execute <db> --command "$D1_SCHEMA_SQL"` or a migration).
 */
export const D1_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS effect_ledger (
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
)`;

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

const PATCH_COLUMNS: Record<string, string> = {
  status: "status",
  result: "result",
  error: "error",
  attemptId: "attempt_id",
  leaseExpiresAt: "lease_expires_at",
  fingerprint: "fingerprint",
  updatedAt: "updated_at",
};

export class D1Store implements LedgerStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async get(scope: string, operationId: string): Promise<OperationRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM effect_ledger WHERE scope = ? AND operation_id = ?")
      .bind(scope, operationId)
      .first<Row>();
    return row ? toRecord(row) : null;
  }

  async insert(record: OperationRecord): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT OR IGNORE INTO effect_ledger
         (scope, operation_id, fingerprint, status, result, error, attempt_id, lease_expires_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        record.scope,
        record.operationId,
        record.fingerprint,
        record.status,
        record.result === undefined ? null : JSON.stringify(record.result),
        record.error === undefined ? null : JSON.stringify(record.error),
        record.attemptId,
        record.leaseExpiresAt,
        record.createdAt,
        record.updatedAt
      )
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  async updateIf(
    scope: string,
    operationId: string,
    expectAttemptId: string,
    expectStatuses: readonly OperationStatus[],
    patch: Partial<OperationRecord>
  ): Promise<boolean> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
      const v = (patch as Record<string, unknown>)[field];
      if (v === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(field === "result" || field === "error" ? (v === null ? null : JSON.stringify(v)) : (v as string | number));
    }
    if (sets.length === 0) return false;
    const placeholders = expectStatuses.map(() => "?").join(", ");
    const res = await this.db
      .prepare(
        `UPDATE effect_ledger SET ${sets.join(", ")}
         WHERE scope = ? AND operation_id = ? AND attempt_id = ? AND status IN (${placeholders})`
      )
      .bind(...values, scope, operationId, expectAttemptId, ...expectStatuses)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }
}
