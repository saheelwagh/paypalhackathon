import { z } from 'zod';
import { getModelConfiguration } from './model-config';
const toolCallSchema = z.object({ id: z.string().min(1), type: z.literal('function'), function: z.object({ name: z.string().min(1), arguments: z.string() }) });
export type ModelToolCall = z.infer<typeof toolCallSchema>;
export type ModelMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_call_id?: string; tool_calls?: ModelToolCall[]; reasoning_content?: string | null };
export type ModelTool = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export class ModelProviderError extends Error {
  constructor(public code: 'configuration' | 'authentication' | 'credits' | 'rate-limit' | 'timeout' | 'unavailable' | 'invalid-response', message: string, public status?: number) { super(message); this.name = 'ModelProviderError'; }
}
const completionSchema = z.object({ id: z.string(), model: z.string().optional(), choices: z.array(z.object({ finish_reason: z.string().nullable().optional(), message: z.object({ role: z.literal('assistant'), content: z.string().nullable().optional(), tool_calls: z.array(toolCallSchema).max(8).optional(), reasoning_content: z.string().nullable().optional() }) })).min(1), usage: z.object({ prompt_tokens: z.number().nonnegative().optional(), completion_tokens: z.number().nonnegative().optional(), total_tokens: z.number().nonnegative().optional() }).optional() });
export class NebiusModel {
  private config;
  constructor(env: Record<string, string | undefined> = process.env, private fetcher: typeof fetch = fetch) { this.config = getModelConfiguration(env); }
  private async request(path: '/models' | '/chat/completions', body?: Record<string, unknown>) {
    if (!this.config.supported) throw new ModelProviderError('configuration', 'Select LLM_PROVIDER=nebius. No other provider is used as a fallback.');
    if (!this.config.apiKey) throw new ModelProviderError('configuration', 'Set NEBIUS_API_KEY in .env.local. A generic or AssemblyAI key is never reused for Nebius.');
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.baseUrl}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25_000), redirect: 'error', cache: 'no-store' });
    } catch (error) {
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new ModelProviderError('timeout', 'Nebius request timed out. No simulated response was substituted.');
      throw new ModelProviderError('unavailable', 'Nebius could not be reached. Check network access and retry explicitly.');
    }
    if (!response.ok) {
      // Do not log upstream bodies: they may echo inputs or sensitive request details.
      if ([401,403].includes(response.status)) throw new ModelProviderError('authentication', 'Nebius rejected this key or its project/model permissions.', response.status);
      if (response.status === 402) throw new ModelProviderError('credits', 'Nebius reports insufficient credits or billing access for this request.', 402);
      if (response.status === 429) throw new ModelProviderError('rate-limit', 'Nebius rate limit reached. Wait before an explicit retry.', 429);
      throw new ModelProviderError('unavailable', `Nebius request failed (HTTP ${response.status}). No provider fallback was attempted.`, response.status);
    }
    try { return await response.json() as unknown; } catch { throw new ModelProviderError('invalid-response', 'Nebius returned a response that was not valid JSON.'); }
  }
  async listModels() {
    const body = await this.request('/models');
    const parsed = z.object({ data: z.array(z.object({ id: z.string() })) }).safeParse(body);
    if (!parsed.success) throw new ModelProviderError('invalid-response', 'Nebius returned an invalid model catalog.');
    return { provider: 'nebius' as const, model: this.config.model, models: parsed.data.data.map(m => m.id), checkedAt: new Date().toISOString() };
  }
  async complete(input: { messages: ModelMessage[]; tools?: ModelTool[]; toolChoice?: 'auto' | { type: 'function'; function: { name: string } }; maxTokens?: number }) {
    const maxTokens = z.number().int().min(1).max(4096).parse(input.maxTokens ?? 1024);
    const messages = z.array(z.object({ role: z.enum(['system','user','assistant','tool']), content: z.string().max(100_000).nullable(), tool_call_id: z.string().optional(), tool_calls: z.array(toolCallSchema).max(8).optional(), reasoning_content: z.string().nullable().optional() })).min(1).max(32).parse(input.messages);
    const tools = input.tools?.map(t => z.object({ type: z.literal('function'), function: z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), description: z.string().max(4000), parameters: z.record(z.string(), z.unknown()) }) }).parse(t));
    if (tools && tools.length > 8) throw new ModelProviderError('configuration', 'At most eight tools may be exposed per request.');
    const body = await this.request('/chat/completions', { model: this.config.model, messages, max_tokens: maxTokens, stream: false, ...(tools?.length ? { tools, tool_choice: input.toolChoice ?? 'auto' } : {}) });
    const parsed = completionSchema.safeParse(body);
    if (!parsed.success) throw new ModelProviderError('invalid-response', 'Nebius returned an invalid chat completion.');
    const choice = parsed.data.choices[0];
    if (choice.finish_reason === 'length') throw new ModelProviderError('invalid-response', 'Nebius reached the output limit. The incomplete response was not accepted.');
    if (!choice.message.content?.trim() && !choice.message.tool_calls?.length) throw new ModelProviderError('invalid-response', 'Nebius returned no answer or tool call.');
    const names = new Set(tools?.map(t => t.function.name) ?? []);
    const ids = new Set<string>();
    for (const call of choice.message.tool_calls ?? []) {
      if (!names.has(call.function.name) || ids.has(call.id)) throw new ModelProviderError('invalid-response', 'Nebius returned an unregistered tool or duplicate tool-call ID.');
      ids.add(call.id);
    }
    return { provider: 'nebius' as const, id: parsed.data.id, model: parsed.data.model ?? this.config.model, message: choice.message, finishReason: choice.finish_reason, usage: parsed.data.usage };
  }
}
