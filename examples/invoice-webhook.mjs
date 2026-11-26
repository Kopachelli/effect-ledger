// Webhook handler that creates an invoice exactly once — even when the
// provider's response is lost in transit.
//
// Run:  npm install && npm run build && node examples/invoice-webhook.mjs
import { createLedger, MemoryStore } from 'effect-ledger';

// --- Simulated invoice provider -------------------------------------
// `loseNextResponse` reproduces the classic failure: the provider commits
// the invoice but the HTTP response never reaches us.
const provider = {
  invoices: new Map(),
  loseNextResponse: false,
  async createInvoice(ctx, input) {
    const key = ctx.idempotencyKey; // stable per operationId
    if (this.invoices.has(key)) return this.invoices.get(key); // provider-side dedup
    const invoice = { id: `inv_${this.invoices.size + 1}`, ...input };
    this.invoices.set(key, invoice);
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error('socket hangup'); // effect happened, response lost
    }
    return invoice;
  },
  async lookupInvoice(ctx) {
    const inv = this.invoices.get(ctx.idempotencyKey);
    return inv ? { status: 'succeeded', result: inv } : { status: 'unknown' };
  },
};

const adapter = {
  run: (ctx, input) => provider.createInvoice(ctx, input),
  lookup: (ctx) => provider.lookupInvoice(ctx),
};

// --- The handler -----------------------------------------------------
const ledger = createLedger({ store: new MemoryStore(), leaseMs: 30_000 });

async function handleWebhook(event) {
  // event.operationId must be durable: webhook delivery ID, queue message ID, etc.
  const outcome = await ledger.execute({
    scope: 'tenant_acme',
    operationId: event.operationId,
    input: event.invoice,
    adapter,
  });

  if (outcome.status === 'unknown') {
    // The provider may or may not have created the invoice. Ask, don't retry.
    const checked = await ledger.reconcile({
      scope: 'tenant_acme',
      operationId: event.operationId,
      adapter,
    });
    console.log('reconciled →', checked.status, checked.result ?? '');
    return checked;
  }
  console.log('outcome →', outcome.status, outcome.result ?? outcome.error ?? '');
  return outcome;
}

// --- Demo ------------------------------------------------------------
const event = { operationId: 'wh_deliveries_42', invoice: { amount: 19900, currency: 'usd' } };

provider.loseNextResponse = true; // first attempt loses its response
await handleWebhook(event);        // → unknown → reconcile → succeeded, ONE invoice
await handleWebhook(event);        // replay: same recorded outcome, no new invoice

console.log('invoices created:', provider.invoices.size); // 1, not 2
