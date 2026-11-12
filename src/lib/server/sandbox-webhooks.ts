import { createHash, randomUUID } from 'node:crypto';
import type { SandboxLedger, SandboxWebhookRegistration, SandboxWebhookStatus } from '../sandbox-contract';
import { PayPalProviderError, type PayPalSandboxProvider } from './paypal';
import { invoiceIdFromPayPalEvent, isSupportedPayPalInvoiceEvent } from './paypal-webhook-provider';
import type { SandboxRepository } from './sandbox-repository';
import { SandboxBillingService, SandboxError } from './sandbox-service';

export class SandboxWebhookError extends Error {
  constructor(message: string, public status = 503) { super(message); this.name = 'SandboxWebhookError'; }
}
type Verifier = { verify(headers: Headers, event: Record<string, unknown>, webhookId: string): Promise<boolean> };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
// Property order does not make a second event; the hash is not used as signature proof.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sandboxWebhookStatus(ledger: SandboxLedger): SandboxWebhookStatus {
  const state = ledger.webhooks;
  const configured = !!state?.registration?.enabled;
  const recent = !!state?.workerHeartbeatAt && Date.now() - Date.parse(state.workerHeartbeatAt) < 30_000;
  const outstanding = state?.events.filter(event => event.state === 'pending' || event.state === 'processing') ?? [];
  return {
    configured, listenerState: configured ? recent ? 'active' : 'offline' : 'not-configured',
    workerHeartbeatAt: state?.workerHeartbeatAt, lastVerifiedAt: state?.lastVerifiedAt,
    lastAppliedAt: state?.lastAppliedAt, pending: outstanding.length,
    lastError: outstanding.find(event => event.lastError)?.lastError,
  };
}

/** Durable, sandbox-only inbox. An authenticated event is only a signal to GET the original invoice. */
export class SandboxWebhookService {
  constructor(private repository: SandboxRepository, private provider: PayPalSandboxProvider, private verifier: Verifier) {}

  async receive(headers: Headers, event: unknown): Promise<{ accepted: true; duplicate: boolean }> {
    if (!record(event) || typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.id)
      || typeof event.event_type !== 'string' || !/^[A-Z0-9._-]{1,100}$/.test(event.event_type)) throw new SandboxWebhookError('Invalid sandbox webhook event.', 400);
    const registration = (await this.repository.read()).webhooks?.registration;
    if (!registration?.enabled) throw new SandboxWebhookError('The sandbox webhook listener is not configured.');
    // Verify before deduplication: knowing an existing event ID cannot bypass authentication.
    if (!await this.verifier.verify(headers, event, registration.id)) throw new SandboxWebhookError('Sandbox webhook signature verification failed.', 400);
    const bodyHash = createHash('sha256').update(canonical(event)).digest('hex');
    const invoiceId = invoiceIdFromPayPalEvent(event);
    const supported = isSupportedPayPalInvoiceEvent(event.event_type) && !!invoiceId;
    return this.repository.transact(ledger => {
      const state = ledger.webhooks;
      if (!state?.registration?.enabled || state.registration.id !== registration.id) throw new SandboxWebhookError('The sandbox webhook listener changed. Retry delivery.');
      const existing = state.events.find(receipt => receipt.id === event.id);
      if (existing && existing.bodyHash !== bodyHash) throw new SandboxWebhookError('The webhook event ID conflicts with an existing receipt.', 409);
      const at = new Date().toISOString();
      state.lastVerifiedAt = at;
      if (existing) return { accepted: true as const, duplicate: true };
      if (state.events.length >= 5000) throw new SandboxWebhookError('The sandbox webhook inbox is full. Preserve receipts for recovery.');
      state.events.push({ id: event.id as string, bodyHash, eventType: event.event_type as string, ...(invoiceId ? { invoiceId } : {}),
        receivedAt: at, verifiedAt: at, state: supported ? 'pending' : 'ignored', attempts: 0, nextAttemptAt: at,
        ...(!supported ? { processedAt: at } : {}),
      });
      return { accepted: true as const, duplicate: false };
    });
  }

  async setRegistration(registration: SandboxWebhookRegistration): Promise<void> {
    await this.repository.transact(ledger => {
      const state = ledger.webhooks ??= { events: [] };
      if (state.registration?.enabled && state.registration.ownerToken !== registration.ownerToken
        && state.workerHeartbeatAt && Date.now() - Date.parse(state.workerHeartbeatAt) < 30_000) {
        throw new SandboxWebhookError('Another sandbox webhook worker is active.');
      }
      state.registration = registration;
      state.workerHeartbeatAt = new Date().toISOString();
    });
  }
  async heartbeat(ownerToken: string): Promise<void> {
    await this.repository.transact(ledger => {
      if (!ledger.webhooks?.registration?.enabled || ledger.webhooks.registration.ownerToken !== ownerToken) throw new SandboxWebhookError('The sandbox webhook worker no longer owns the listener.');
      ledger.webhooks.workerHeartbeatAt = new Date().toISOString();
    });
  }
  async stop(ownerToken: string): Promise<void> {
    await this.repository.transact(ledger => {
      if (ledger.webhooks?.registration?.ownerToken === ownerToken) ledger.webhooks.registration.enabled = false;
    });
  }

  async drain(limit = 3): Promise<{ processed: number; pending: number }> {
    let processed = 0;
    for (let count = 0; count < Math.min(Math.max(limit, 0), 20); count++) {
      const claimed = await this.repository.transact(ledger => {
        if (!ledger.webhooks?.registration?.enabled) return null;
        const now = Date.now();
        const receipt = ledger.webhooks?.events.find(event => (event.state === 'pending' && Date.parse(event.nextAttemptAt) <= now)
          || (event.state === 'processing' && (!event.leaseUntil || Date.parse(event.leaseUntil) <= now)));
        if (!receipt) return null;
        receipt.state = 'processing'; receipt.attempts++;
        receipt.leaseToken = randomUUID(); receipt.leaseUntil = new Date(now + 90_000).toISOString();
        const invoice = ledger.invoices.find(item => item.provider?.id === receipt.invoiceId);
        return { receipt, localId: invoice?.id };
      });
      if (!claimed) break;
      let problem: string | undefined;
      let ignored = false;
      let applied = false;
      if (!claimed.localId) {
        // A CREATED notification can beat the local create response. Allow it to catch up.
        if (Date.now() - Date.parse(claimed.receipt.receivedAt) < 300_000) problem = 'Waiting for an existing sandbox invoice to match this event. No invoice was imported.';
        else ignored = true;
      } else {
        try {
          const result = await new SandboxBillingService(this.repository, this.provider).execute({ action: 'refresh', id: claimed.localId });
          if (!('invoice' in result) || !result.invoice.provider) throw new SandboxWebhookError('The original sandbox invoice is not available yet.');
          applied = true;
          const snapshot = result.invoice.provider;
          // PayPal notifications can precede read visibility. Keep unresolved changes queued;
          // a retry never treats the event as money proof or creates another invoice.
          const waiting = (claimed.receipt.eventType === 'INVOICING.INVOICE.SENT' && snapshot.status === 'DRAFT')
            || (claimed.receipt.eventType === 'INVOICING.INVOICE.PAID' && ['DRAFT', 'UNPAID', 'SENT', 'SCHEDULED'].includes(snapshot.status))
            || (claimed.receipt.eventType === 'INVOICING.INVOICE.REFUNDED' && snapshot.refundedCents === 0 && !snapshot.status.includes('REFUND'))
            || (claimed.receipt.eventType === 'INVOICING.INVOICE.CANCELLED' && !['CANCELLED', 'CANCELED', 'AUTO_CANCELLED'].includes(snapshot.status));
          if (waiting) problem = 'PayPal has not exposed the notified change yet. Retrying the original invoice.';
        } catch (error) {
          problem = error instanceof SandboxError || error instanceof PayPalProviderError || error instanceof SandboxWebhookError
            ? error.message : 'The original sandbox invoice could not be reconciled. The event remains queued.';
        }
      }
      const completed = await this.repository.transact(ledger => {
        const state = ledger.webhooks!;
        const receipt = state.events.find(event => event.id === claimed.receipt.id);
        if (!receipt || receipt.leaseToken !== claimed.receipt.leaseToken) return false;
        const at = new Date().toISOString();
        delete receipt.leaseToken; delete receipt.leaseUntil;
        if (applied) {
          state.lastAppliedAt = at;
          const invoice = ledger.invoices.find(item => item.id === claimed.localId);
          if (invoice) invoice.lastWebhook = { eventId: receipt.id, eventType: receipt.eventType, appliedAt: at };
        }
        if (problem) {
          receipt.state = 'pending'; receipt.lastError = problem.slice(0, 2000);
          receipt.nextAttemptAt = new Date(Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(receipt.attempts - 1, 5))).toISOString();
          return false;
        }
        receipt.state = ignored ? 'ignored' : 'processed'; receipt.processedAt = at; delete receipt.lastError;
        return true;
      });
      if (completed) processed++;
    }
    const state = await this.repository.read();
    return { processed, pending: sandboxWebhookStatus(state).pending };
  }
}
