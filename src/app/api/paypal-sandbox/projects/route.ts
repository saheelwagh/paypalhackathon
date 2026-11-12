import { NextResponse } from 'next/server';
import { LocalRequestError, readBoundedJson, requireLocalSameOrigin } from '@/lib/server/local-request';
import { sandboxRepository, SandboxRepositoryError } from '@/lib/server/sandbox-repository';
import { SandboxProjectError, SandboxProjectService } from '@/lib/server/sandbox-project-service';
import { projectViews } from '@/lib/sandbox-project-contract';
import { sandboxWebhookStatus } from '@/lib/server/sandbox-webhooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    requireLocalSameOrigin(request);
    const command = await readBoundedJson(request, 16_000);
    const repository = sandboxRepository();
    const result = await new SandboxProjectService(repository).execute(command);
    const ledger = await repository.read();
    return NextResponse.json({ ...result, ...('projects' in result ? { projects: projectViews(ledger) } : {}),
      mode: 'paypal-sandbox', configured: !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET,
      ledgerReadAt: new Date().toISOString(), webhooks: sandboxWebhookStatus(ledger),
    }, { headers });
  } catch (error) {
    const status = error instanceof LocalRequestError || error instanceof SandboxProjectError ? error.status : 503;
    const message = error instanceof LocalRequestError || error instanceof SandboxProjectError || error instanceof SandboxRepositoryError
      ? error.message : 'The sandbox project ledger is unavailable. Existing agreements and payment records were preserved.';
    return NextResponse.json({ error: message }, { status, headers });
  }
}
