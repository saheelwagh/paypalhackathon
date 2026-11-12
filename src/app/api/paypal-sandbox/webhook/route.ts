import { NextResponse } from 'next/server';
import { LocalRequestError, readBoundedJson } from '@/lib/server/local-request';
import { PayPalSandbox } from '@/lib/server/paypal';
import { PayPalSandboxWebhooks, PayPalWebhookError, PAYPAL_WEBHOOK_MAX_EVENT_BYTES } from '@/lib/server/paypal-webhook-provider';
import { sandboxRepository } from '@/lib/server/sandbox-repository';
import { SandboxWebhookError, SandboxWebhookService } from '@/lib/server/sandbox-webhooks';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const verifier = new PayPalSandboxWebhooks();
const provider = new PayPalSandbox();
let inFlight = 0;
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  if (inFlight >= 4) return NextResponse.json({ error: 'Webhook receiver busy; retry delivery.' }, { status: 503, headers });
  inFlight++;
  try {
    // Deliberately public: PayPal signature verification replaces the local-browser origin guard.
    const event = await readBoundedJson(request, PAYPAL_WEBHOOK_MAX_EVENT_BYTES);
    const receipt = await new SandboxWebhookService(sandboxRepository(), provider, verifier).receive(request.headers, event);
    // Acknowledge only after durable acceptance. The owned worker processes the inbox, including after restarts.
    return NextResponse.json(receipt, { status: 202, headers });
  } catch (error) {
    const status = error instanceof LocalRequestError || error instanceof SandboxWebhookError ? error.status
      : error instanceof PayPalWebhookError && error.code === 'invalid-input' ? 400 : 503;
    return NextResponse.json({ error: status < 500 ? 'Invalid or unverified sandbox webhook.' : 'Sandbox webhook not accepted; retry delivery.' }, { status, headers });
  } finally { inFlight--; }
}
