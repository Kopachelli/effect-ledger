export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export class FingerprintMismatchError extends LedgerError {
  readonly scope: string;
  readonly operationId: string;

  constructor(scope: string, operationId: string) {
    super(
      `Operation "${operationId}" in scope "${scope}" already exists with a different input fingerprint. ` +
        `Use a new operationId for a different intent.`,
    );
    this.name = 'FingerprintMismatchError';
    this.scope = scope;
    this.operationId = operationId;
  }
}

export class OperationNotFoundError extends LedgerError {
  readonly scope: string;
  readonly operationId: string;

  constructor(scope: string, operationId: string) {
    super(`No operation "${operationId}" in scope "${scope}".`);
    this.name = 'OperationNotFoundError';
    this.scope = scope;
    this.operationId = operationId;
  }
}
