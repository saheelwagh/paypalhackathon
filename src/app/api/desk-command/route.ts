import { deskCommandRequestSchema, DeskPlannerError, planDeskCommand } from '@/lib/server/desk-agent';
import { LocalRequestError, readBoundedJson, requireLocalSameOrigin } from '@/lib/server/local-request';
import { ModelProviderError } from '@/lib/server/nebius';

export const runtime = 'nodejs';
export const maxDuration = 35;
export async function POST(request: Request) {
  try {
    requireLocalSameOrigin(request);
    const body = deskCommandRequestSchema.safeParse(await readBoundedJson(request));
    if (!body.success) return Response.json({ error: 'The desk command or synthetic context is invalid.' }, { status: 400 });
    const result = await planDeskCommand(body.data.message, body.data.context);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof LocalRequestError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof ModelProviderError) return Response.json({ error: error.message }, { status: error.code === 'configuration' ? 503 : error.code === 'timeout' ? 504 : 502 });
    if (error instanceof DeskPlannerError) return Response.json({ error: error.message }, { status: error.code === 'invalid-input' ? 400 : 502 });
    return Response.json({ error: 'The desk command could not be completed. No fallback or commercial action was performed.' }, { status: 500 });
  }
}
