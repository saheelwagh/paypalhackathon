import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SandboxLedger } from '../sandbox-contract';
import { sandboxTermsSchema } from '../sandbox-contract';
import { sandboxProjectBindingSchema, sandboxProjectSchema } from '../sandbox-project-contract';
import { validateSandboxProjects } from './sandbox-project-service';

/** Replace with PostgreSQL transactions later. Demo localStorage is never read here. */
export interface SandboxRepository {
  read(): Promise<SandboxLedger>;
  transact<T>(update: (ledger: SandboxLedger) => T | Promise<T>): Promise<T>;
}
export class SandboxRepositoryError extends Error {}
const fresh = (): SandboxLedger => ({ schemaVersion: 1, mode: 'paypal-sandbox', invoices: [] });
const cents = z.number().int().min(0).max(99_999_999);
const instant = z.iso.datetime();
const persisted = z.object({ schemaVersion: z.literal(1), mode: z.literal('paypal-sandbox'), invoices: z.array(z.object({
  id: z.string().regex(/^sbx_[a-f0-9-]{36}$/), version: z.number().int().positive(), terms: sandboxTermsSchema,
  state: z.enum(['draft', 'creating', 'sending', 'unknown', 'sent', 'paid', 'pending', 'partially-paid', 'canceled', 'refunded']),
  invoiceNumber: z.string().regex(/^FBD-[a-f0-9]{20}$/), createRequestId: z.uuid(), createdAt: instant, updatedAt: instant,
  confirmedCents: cents, pendingCents: cents,
  confirmedPayments: z.array(z.object({ id: z.string(), amountCents: cents, date: z.string().optional() }).strict()).optional(),
  approval: z.object({ version: z.number().int().positive(), termsHash: z.string().regex(/^[a-f0-9]{64}$/), approvedAt: instant, actor: z.literal('local-sandbox-owner') }).strict().optional(),
  operation: z.object({ kind: z.enum(['create','send']), requestId: z.uuid(), startedAt: instant, leaseUntil: instant }).strict().optional(),
  refreshLease: z.object({ token: z.uuid(), until: instant }).strict().optional(), lastError: z.string().max(2000).optional(),
  lastWebhook: z.object({ eventId: z.string().max(128), eventType: z.string().max(100), appliedAt: instant }).strict().optional(),
  projectBinding: sandboxProjectBindingSchema.optional(),
  provider: z.object({ provider: z.literal('paypal-sandbox'), id: z.string().regex(/^INV2-[A-Z0-9-]{8,25}$/), invoiceNumber: z.string(), status: z.string(), currency: z.literal('USD'), recipientEmail: z.string(), description: z.string(), reference: z.string().optional(), amountCents: cents, dueCents: cents, confirmedCents: cents, pendingCents: cents, refundedCents: cents, payments: z.array(z.object({ id: z.string(), amountCents: cents, date: z.string().optional() }).strict()), payerUrl: z.string().optional(), checkedAt: instant, warnings: z.array(z.string()) }).strict().optional(),
}).strict()).max(10_000), webhooks: z.object({
  registration: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), url: z.url(), enabled: z.boolean(), ownerToken: z.uuid() }).strict().optional(),
  workerHeartbeatAt: instant.optional(), lastVerifiedAt: instant.optional(), lastAppliedAt: instant.optional(),
  events: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), bodyHash: z.string().regex(/^[a-f0-9]{64}$/), eventType: z.string().max(100), invoiceId: z.string().regex(/^INV2-[A-Z0-9-]{8,25}$/).optional(),
    receivedAt: instant, verifiedAt: instant, state: z.enum(['pending','processing','processed','ignored']), attempts: z.number().int().min(0), nextAttemptAt: instant,
    leaseToken: z.uuid().optional(), leaseUntil: instant.optional(), processedAt: instant.optional(), lastError: z.string().max(2000).optional(),
  }).strict()).max(5000),
}).strict().optional(), projects: z.array(sandboxProjectSchema).max(1000).optional() }).strict();
function validate(value: unknown): SandboxLedger {
  const parsed = persisted.safeParse(value);
  if (!parsed.success) throw new SandboxRepositoryError('The sandbox ledger is invalid. Preserve it for recovery; it was not reset.');
  const ledger = parsed.data;
  for (const invoice of ledger.invoices) {
    if (!/^sbx_[a-f0-9-]{36}$/.test(invoice.id) || !Number.isSafeInteger(invoice.version) || invoice.version < 1 || !sandboxTermsSchema.safeParse(invoice.terms).success || !Number.isSafeInteger(invoice.confirmedCents) || invoice.confirmedCents < 0 || invoice.confirmedCents > invoice.terms.amountCents || (invoice.provider && invoice.provider.provider !== 'paypal-sandbox')) throw new SandboxRepositoryError('An invalid sandbox record requires recovery. Demo data cannot be imported as provider state.');
  }
  try { validateSandboxProjects(ledger); } catch { throw new SandboxRepositoryError('The sandbox project ledger is invalid. Existing agreements, invoices, and receipts were preserved for recovery.'); }
  return ledger;
}
export class FileSandboxRepository implements SandboxRepository {
  constructor(private readonly filename: string) {}
  async read(): Promise<SandboxLedger> {
    try { return validate(JSON.parse(await readFile(/* turbopackIgnore: true */ this.filename, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fresh();
      if (error instanceof SandboxRepositoryError) throw error;
      throw new SandboxRepositoryError('The sandbox ledger could not be read. Existing records were preserved.');
    }
  }
  async transact<T>(update: (ledger: SandboxLedger) => T | Promise<T>): Promise<T> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
    const lock = `${this.filename}.lock`;
    let owned = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await mkdir(lock, { mode: 0o700 }); owned = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new SandboxRepositoryError('The sandbox ledger cannot be locked.');
        // Never reap locks automatically: concurrent reapers could delete a new live lock.
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    if (!owned) throw new SandboxRepositoryError('The sandbox ledger is locked. Retry after the operation finishes; after an interrupted server, confirm it stopped before removing its stale .lock directory.');
    let temporary: string | undefined;
    try {
      const owner = await open(join(lock, 'pid'), 'wx', 0o600); await owner.writeFile(String(process.pid)); await owner.close();
      const ledger = await this.read();
      const result = await update(ledger);
      validate(ledger);
      temporary = `${this.filename}.${randomUUID()}.tmp`;
      // Runtime data, never a build input or an artifact to package for deployment.
      const file = await open(/* turbopackIgnore: true */ temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(ledger)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.filename);
      return structuredClone(result);
    } finally {
      if (temporary) await rm(temporary, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
export function sandboxRepository(): SandboxRepository {
  // A changed merchant app gets its own ledger. No secret or account ID is persisted.
  const account = createHash('sha256').update(process.env.PAYPAL_CLIENT_ID || 'unconfigured').digest('hex').slice(0, 20);
  return new FileSandboxRepository(join(process.cwd(), '.local', 'paypal-sandbox', `${account}.json`));
}
