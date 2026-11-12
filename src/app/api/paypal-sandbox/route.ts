import { NextResponse } from 'next/server';
import { LocalRequestError, readBoundedJson, requireLocalSameOrigin } from '@/lib/server/local-request';
import { PayPalProviderError, PayPalSandbox } from '@/lib/server/paypal';
import { sandboxRepository, SandboxRepositoryError } from '@/lib/server/sandbox-repository';
import { SandboxBillingService, SandboxError } from '@/lib/server/sandbox-service';
import { sandboxWebhookStatus } from '@/lib/server/sandbox-webhooks';
import { SandboxProjectError } from '@/lib/server/sandbox-project-service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const provider = new PayPalSandbox();
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    requireLocalSameOrigin(request);
    const command = await readBoundedJson(request, 12_000);
    const repository = sandboxRepository();
    const result = await new SandboxBillingService(repository, provider).execute(command);
    const ledger = await repository.read();
    return NextResponse.json({ ...result, ...('invoices' in result ? { invoices: ledger.invoices } : {}), projectLabels: Object.fromEntries((ledger.projects ?? []).map(project => [project.id, project.terms.title])), webhooks: sandboxWebhookStatus(ledger), ledgerReadAt: new Date().toISOString(), mode: 'paypal-sandbox', configured: !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET }, { headers });
  } catch (error) {
    const status = error instanceof LocalRequestError || error instanceof SandboxError || error instanceof SandboxProjectError ? error.status : error instanceof PayPalProviderError ? 502 : 503;
    const message = error instanceof LocalRequestError || error instanceof SandboxError || error instanceof SandboxProjectError || error instanceof PayPalProviderError || error instanceof SandboxRepositoryError ? error.message : 'The sandbox ledger is unavailable. Existing records have been preserved.';
    return NextResponse.json({ error: message }, { status, headers });
  }
}
