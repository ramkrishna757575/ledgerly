import { DomainError } from '../errors.ts';

export const AI_PROVIDERS = ['anthropic', 'bedrock', 'openai'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export type AiConfig = {
  provider: AiProvider;
  model: string;
  apiKey?: string;
  // Anthropic and OpenAI-compatible servers (Ollama, llama.cpp, vLLM, LM Studio).
  baseUrl?: string;
  // Bedrock only.
  region?: string;
};

const DEFAULT_BASE = { anthropic: 'https://api.anthropic.com', openai: 'http://localhost:11434/v1' } as const;

function endpoint(config: AiConfig) {
  if (config.provider === 'bedrock') {
    const base = config.baseUrl ?? `https://bedrock-runtime.${config.region ?? 'us-east-1'}.amazonaws.com`;
    return `${base.replace(/\/$/, '')}/model/${encodeURIComponent(config.model)}/converse`;
  }
  const base = (config.baseUrl ?? DEFAULT_BASE[config.provider]).replace(/\/$/, '');
  return config.provider === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`;
}

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|host\.docker\.internal)$/i;
// Your own network counts as yours for choosing request options, though not as this machine.
const PRIVATE_NET = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local)$/i;

// Where a request goes, so it can be shown before anything is sent.
export function describeDestination(config: AiConfig) {
  const host = new URL(endpoint(config)).host;
  const name = host.replace(/:\d+$/, '');
  return { host, local: LOCAL.test(name) };
}

function ownServer(config: AiConfig): boolean {
  const host = new URL(endpoint(config)).hostname;
  return LOCAL.test(host) || PRIVATE_NET.test(host);
}

export type LlmImage = { mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string };
type Request = { system: string; user: string; images?: LlmImage[]; maxTokens?: number; signal?: AbortSignal };
type Fetch = typeof fetch;

function build(config: AiConfig, { system, user, images = [], maxTokens = 3000 }: Request) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.provider === 'anthropic') {
    if (config.apiKey) headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    return { headers, body: { model: config.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: images.length === 0 ? user : [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.base64 } })), { type: 'text', text: user }] }] } };
  }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  if (config.provider === 'bedrock') {
    return {
      headers,
      body: { system: [{ text: system }], messages: [{ role: 'user', content: [...images.map((i) => ({ image: { format: i.mediaType.split('/')[1], source: { bytes: i.base64 } } })), { text: user }] }], inferenceConfig: { maxTokens } },
    };
  }
  return {
    headers,
    body: {
      model: config.model,
      max_tokens: maxTokens,
      // Local servers (llama.cpp, vLLM) run "thinking" models that can spend the
      // whole budget reasoning and return no answer. Hosted APIs reject the
      // extra field, so it is only sent to a server on your own machine or network.
      ...(ownServer(config) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: images.length === 0 ? user : [{ type: 'text', text: user }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.base64}` } }))] }],
    },
  };
}

function textOf(config: AiConfig, data: any): string {
  if (config.provider === 'anthropic') {
    return (data?.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('');
  }
  if (config.provider === 'bedrock') {
    return (data?.output?.message?.content ?? []).map((b: any) => b?.text ?? '').join('');
  }
  return data?.choices?.[0]?.message?.content ?? '';
}

// One question, one answer. The key goes in a header and is never logged or
// echoed back in an error.
export async function complete(config: AiConfig, request: Request, fetcher: Fetch = fetch): Promise<string> {
  const { headers, body } = build(config, request);
  let response: Response;
  try {
    response = await fetcher(endpoint(config), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal ?? AbortSignal.timeout(180_000),
    });
  } catch {
    const { host } = describeDestination(config);
    throw new DomainError('invalid', `Couldn't reach the AI provider at ${host}. Check that it is running and the address is right.`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const data: any = await response.json();
      detail = String(data?.error?.message ?? data?.message ?? '').slice(0, 200);
    } catch {
      // not JSON
    }
    const hint = response.status === 401 || response.status === 403 ? ' Check the API key.' : '';
    throw new DomainError('invalid', `The AI provider answered ${response.status}${detail ? `: ${detail}` : ''}.${hint}`);
  }

  const text = textOf(config, await response.json().catch(() => null)).trim();
  if (!text) throw new DomainError('invalid', 'The AI provider returned an empty answer.');
  return text;
}
