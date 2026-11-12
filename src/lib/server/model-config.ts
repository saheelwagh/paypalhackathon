/** Import only from server routes, server services, or local CLI checks. Never from client components. */
export const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
export const DEFAULT_NEBIUS_MODEL = 'Qwen/Qwen3-235B-A22B-Instruct-2507';
export function getModelConfiguration(env: Record<string, string | undefined> = process.env) {
  const provider = env.LLM_PROVIDER?.trim() || 'nebius';
  const supported = provider === 'nebius';
  const model = env.LLM_MODEL?.trim() || DEFAULT_NEBIUS_MODEL;
  // Never reuse an AssemblyAI/OpenAI key for a different upstream host.
  const apiKey = supported ? env.NEBIUS_API_KEY?.trim() || '' : '';
  return { provider, model, baseUrl: NEBIUS_BASE_URL, apiKey, supported, configured: supported && !!apiKey };
}
export function publicModelConfiguration(env: Record<string, string | undefined> = process.env) {
  const { provider, model, baseUrl, configured, supported } = getModelConfiguration(env);
  return { provider, model, baseUrl, configured, status: !supported ? 'Unsupported provider' : configured ? 'Configured, not tested' : 'Not configured' };
}
