import { NextResponse } from 'next/server';
import { FundingCommandError, FundingCommandService } from '@/lib/server/funding-command-service';
import { LocalRequestError, readBoundedJson, requireLocalSameOrigin } from '@/lib/server/local-request';
import { sandboxRepository, SandboxRepositoryError } from '@/lib/server/sandbox-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    requireLocalSameOrigin(request);
    const command = await readBoundedJson(request, 16_000);
    return NextResponse.json(await new FundingCommandService(sandboxRepository()).execute(command), { headers });
  } catch (error) {
    const status = error instanceof LocalRequestError || error instanceof FundingCommandError ? error.status : 503;
    const message = error instanceof LocalRequestError || error instanceof FundingCommandError || error instanceof SandboxRepositoryError
      ? error.message : 'The Funding command is unavailable. Existing sandbox agreements, invoices, and payments were preserved.';
    return NextResponse.json({ error: message }, { status, headers });
  }
}
