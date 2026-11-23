/** Credential resolution: BYOK first, then the host's own keys, gated by ACCESS_CODE. */

import type { Provider } from '@ielts/shared';

export interface CredentialInput {
  provider: Provider;
  apiKey?: string;
  accessCode?: string;
}

export interface ResolvedCredential {
  apiKey: string;
  source: 'byok' | 'server';
}

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const ENV_KEY: Record<Provider, string> = {
  qwen: 'DASHSCOPE_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
};

function envKey(provider: Provider): string {
  const primary = process.env[ENV_KEY[provider]] || '';
  if (provider === 'qwen' && !primary) return process.env.DASHSCOPE_WORKSPACE_API_KEY || '';
  return primary;
}

export function serverProviders(): Record<Provider | 'deepseek', boolean> {
  return {
    qwen: Boolean(envKey('qwen')),
    gemini: Boolean(envKey('gemini')),
    openai: Boolean(envKey('openai')),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
  };
}

export function accessCodeRequired(): boolean {
  return Boolean((process.env.ACCESS_CODE || '').trim());
}

export function verifyAccessCode(code: string | undefined): boolean {
  const expected = (process.env.ACCESS_CODE || '').trim();
  if (!expected) return true;
  return String(code || '').trim() === expected;
}

/** Resolve the key for this connection without ever logging or echoing it. */
export function resolveCredential(input: CredentialInput): ResolvedCredential {
  const provided = (input.apiKey || '').trim();
  if (provided) return { apiKey: provided, source: 'byok' };

  const hostKey = envKey(input.provider);
  if (!hostKey) {
    throw new AuthError(
      'no_credentials',
      '没有可用的 API Key：请填写自己的 Key，或让站长在服务器配置 ' + ENV_KEY[input.provider] + '。',
    );
  }
  if (!verifyAccessCode(input.accessCode)) {
    throw new AuthError('bad_access_code', '访问口令不正确。', 401);
  }
  return { apiKey: hostKey, source: 'server' };
}

/** Text-coach key: explicit DEEPSEEK key, else the same provider's key. */
export function coachConfig(provider: Provider): { baseUrl: string; model: string; apiKey: string } {
  const deepseek = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (deepseek) {
    return { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: deepseek };
  }
  if (provider === 'qwen') {
    return {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      apiKey: envKey('qwen'),
    };
  }
  if (provider === 'gemini') {
    return {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.5-flash',
      apiKey: envKey('gemini'),
    };
  }
  return {
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: 'gpt-4o-mini',
    apiKey: envKey('openai'),
  };
}
