import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { NebiusModel } from '../src/lib/server/nebius';
if (existsSync('.env.local')) loadEnvFile('.env.local');
async function main() {
const client = new NebiusModel();
try {
  const catalog = await client.listModels();
  const available = catalog.models.includes(catalog.model);
  console.log(JSON.stringify({ provider: catalog.provider, endpoint: 'https://api.tokenfactory.nebius.com/v1', model: catalog.model, modelAvailable: available, checkedAt: catalog.checkedAt, verification: 'Model catalog access only; generation and tool calling not yet verified.' }, null, 2));
  if (!available) { console.error('Configured model is not in this key’s catalog. Choose an available text/tool-capable model.'); process.exitCode = 1; }
  else if (process.argv.includes('--smoke')) {
    const tools = [{ type: 'function' as const, function: { name: 'read_demo_total', description: 'Read an exact, synthetic USD total from application code.', parameters: { type: 'object', properties: { projectId: { type: 'string', enum: ['demo_acme'] } }, required: ['projectId'], additionalProperties: false } } }];
    const first = await client.complete({ messages: [{ role: 'system', content: 'This is a connection test using synthetic data. Call read_demo_total once with projectId demo_acme, then use its result. Do not invent amounts.' }, { role: 'user', content: 'What is the synthetic confirmed total?' }], tools, toolChoice: 'auto', maxTokens: 1024 });
    console.log('First Nebius completion returned; validating its registered tool call.');
    const calls = first.message.tool_calls;
    if (calls?.length !== 1 || calls[0].function.name !== 'read_demo_total' || JSON.stringify(JSON.parse(calls[0].function.arguments)) !== '{"projectId":"demo_acme"}') throw new Error('The smoke test did not receive exactly the expected read-only tool call.');
    const second = await client.complete({ messages: [{ role: 'system', content: 'Reply with one short sentence containing the exact synthetic USD total from the tool result. No explanation. This is not a real payment.' }, { role: 'user', content: 'What is the synthetic confirmed total?' }, { ...first.message, content: first.message.content ?? null }, { role: 'tool', tool_call_id: calls[0].id, content: JSON.stringify({ currency: 'USD', confirmedCents: 125000, simulated: true }) }], maxTokens: 1024 });
    if (!second.message.content?.trim()) throw new Error('The smoke test did not receive a final answer.');
    console.log(JSON.stringify({ verification: 'Two real Nebius completions and one synthetic read-only tool/result roundtrip succeeded.', provider: second.provider, model: second.model, requestIds: [first.id, second.id], totalTokens: (first.usage?.total_tokens ?? 0) + (second.usage?.total_tokens ?? 0), financialOperations: 0 }, null, 2));
  }
} catch (error) {
  // Only print our sanitized provider errors; never raw response bodies, credentials, or model reasoning.
  const { ModelProviderError } = await import('../src/lib/server/nebius');
  console.error(error instanceof ModelProviderError ? `${error.code}: ${error.message}` : 'Model check failed: invalid tool output or unexpected local error.');
  process.exitCode = 1;
}

}
void main();
