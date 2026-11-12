import { FundingAgentService, FundingCommandError } from '@/lib/server/funding-agent';
import { LocalRequestError, readBoundedJson, requireLocalSameOrigin } from '@/lib/server/local-request';
import { ModelProviderError } from '@/lib/server/nebius';
import { sandboxRepository, SandboxRepositoryError } from '@/lib/server/sandbox-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 35;
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    requireLocalSameOrigin(request);
    const body = await readBoundedJson(request, 24_000);
    return Response.json(await new FundingAgentService(sandboxRepository()).execute(body), { headers });
  } catch (error) {
    if (error instanceof LocalRequestError || error instanceof FundingCommandError) return Response.json({ error: error.message }, { status: error.status, headers });
    if (error instanceof ModelProviderError) return Response.json({ error: error.message }, { status: error.code === 'configuration' ? 503 : error.code === 'timeout' ? 504 : 502, headers });
    const message = error instanceof SandboxRepositoryError ? error.message : 'Funding planning is unavailable. No fallback, approval, or PayPal operation was performed.';
    return Response.json({ error: message }, { status: 503, headers });
  }
}
