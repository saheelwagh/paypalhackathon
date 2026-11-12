import { z } from 'zod';
import type { PayPalInvoiceSnapshot, PayPalPayment } from './server/paypal';
import type { SandboxProject, SandboxProjectBinding } from './sandbox-project-contract';

export const sandboxTermsSchema = z.object({
  projectReference: z.string().trim().min(1).max(100),
  coverageReference: z.string().trim().min(1).max(100),
  recipientEmail: z.email().max(254).transform(value => value.toLowerCase()),
  description: z.string().trim().min(1).max(1000),
  amountCents: z.number().int().min(1).max(99_999_999),
  currency: z.literal('USD'),
}).strict();
export type SandboxTerms = z.infer<typeof sandboxTermsSchema>;
export type SandboxInvoiceState = 'draft' | 'creating' | 'sending' | 'unknown' | 'sent' | 'paid' | 'pending' | 'partially-paid' | 'canceled' | 'refunded';
export type SandboxInvoice = {
  id: string; version: number; terms: SandboxTerms; state: SandboxInvoiceState;
  invoiceNumber: string; createRequestId: string;
  createdAt: string; updatedAt: string; confirmedCents: number; pendingCents: number;
  provider?: PayPalInvoiceSnapshot;
  confirmedPayments?: PayPalPayment[];
  approval?: { version: number; termsHash: string; approvedAt: string; actor: 'local-sandbox-owner' };
  operation?: { kind: 'create' | 'send'; requestId: string; startedAt: string; leaseUntil: string };
  refreshLease?: { token: string; until: string };
  lastError?: string;
  lastWebhook?: { eventId: string; eventType: string; appliedAt: string };
  projectBinding?: SandboxProjectBinding;
};
export type SandboxWebhookReceipt = {
  id: string; bodyHash: string; eventType: string; invoiceId?: string; receivedAt: string; verifiedAt: string;
  state: 'pending' | 'processing' | 'processed' | 'ignored'; attempts: number; nextAttemptAt: string;
  leaseToken?: string; leaseUntil?: string; processedAt?: string; lastError?: string;
};
export type SandboxWebhookRegistration = { id: string; url: string; enabled: boolean; ownerToken: string };
export type SandboxWebhookState = {
  registration?: SandboxWebhookRegistration; workerHeartbeatAt?: string;
  lastVerifiedAt?: string; lastAppliedAt?: string; events: SandboxWebhookReceipt[];
};
export type SandboxWebhookStatus = {
  configured: boolean; listenerState: 'active' | 'offline' | 'not-configured'; workerHeartbeatAt?: string;
  lastVerifiedAt?: string; lastAppliedAt?: string; pending: number; lastError?: string;
};
export type SandboxLedger = { schemaVersion: 1; mode: 'paypal-sandbox'; invoices: SandboxInvoice[]; webhooks?: SandboxWebhookState; projects?: SandboxProject[] };
const identity = { id: z.string().regex(/^sbx_[a-f0-9-]{36}$/), version: z.number().int().positive() };
export const sandboxCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('create'), requestId: z.uuid(), terms: sandboxTermsSchema }).strict(),
  z.object({ action: z.literal('edit'), ...identity, terms: sandboxTermsSchema }).strict(),
  z.object({ action: z.literal('send'), ...identity, confirmSandbox: z.literal(true) }).strict(),
  z.object({ action: z.literal('refresh'), id: identity.id }).strict(),
]);
export type SandboxCommand = z.infer<typeof sandboxCommandSchema>;
