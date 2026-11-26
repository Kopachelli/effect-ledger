export type OperationStatus = 'pending' | 'succeeded' | 'failed' | 'unknown';

export interface SerializedError {
  name: string;
  message: string;
  /** True when the adapter guarantees the external effect did NOT happen. */
  definitive?: boolean;
}

export interface OperationRecord {
  scope: string;
  operationId: string;
  /** Stable fingerprint of the operation input. */
  fingerprint: string;
  status: OperationStatus;
  result?: unknown;
  error?: SerializedError;
  /** Fencing token identifying the attempt that owns the record. */
  attemptId: string;
  /** Epoch ms. After this, the attempt is presumed dead. */
  leaseExpiresAt: number;
  createdAt: number;
  updatedAt: number;
}

/** Context handed to adapter.run on every attempt. */
export interface RunContext {
  scope: string;
  operationId: string;
  attemptId: string;
  /**
   * Stable key derived from scope + operationId. Forward it to providers
   * that accept idempotency keys so retries collapse into one effect.
   */
  idempotencyKey: string;
}

/** What an adapter lookup reports about the external effect. */
export type LookupResult =
  | { status: 'succeeded'; result?: unknown }
  | { status: 'failed'; error?: SerializedError }
  | { status: 'pending' }
  | { status: 'unknown' };

export interface ActionAdapter<TInput = unknown, TResult = unknown> {
  /**
   * Perform the external action. Throw an error with `definitive: true`
   * (or name 'DefinitiveError') when you can prove the effect did not
   * happen; any other throw is treated as an uncertain outcome.
   */
  run(ctx: RunContext, input: TInput): Promise<TResult>;
  /**
   * Optional. Report what actually happened at the provider, used by
   * reconcile() to resolve 'pending'/'unknown' records.
   */
  lookup?(ctx: RunContext, input: TInput): Promise<LookupResult>;
}

export interface ExecuteOptions<TInput, TResult> {
  scope: string;
  operationId: string;
  /** Raw input; fingerprinted automatically when `fingerprint` is absent. */
  input?: TInput;
  /** Explicit fingerprint. Must be stable for identical intents. */
  fingerprint?: string;
  adapter: ActionAdapter<TInput, TResult>;
  /** Lease duration for this attempt. Must exceed the worst-case run time. */
  leaseMs?: number;
  /**
   * Explicit opt-in to start a new attempt for a 'failed' or 'unknown'
   * record. Never set this automatically: 'unknown' means the external
   * effect may already have happened.
   */
  restart?: boolean;
  now?: () => number;
}

export interface ReconcileOptions<TInput = unknown> {
  scope: string;
  operationId: string;
  input?: TInput;
  adapter: Pick<ActionAdapter<TInput, unknown>, 'lookup'>;
  now?: () => number;
}

export type OutcomeStatus = 'succeeded' | 'failed' | 'unknown' | 'in-progress';

export interface Outcome<TResult = unknown> {
  status: OutcomeStatus;
  /** Present when status is 'succeeded'. */
  result?: TResult;
  /** Present when status is 'failed'. */
  error?: SerializedError;
  /** True when a previously recorded terminal outcome was returned. */
  replayed: boolean;
  record: OperationRecord;
}
