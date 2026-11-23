/** Credential resolution: BYOK first, then the host's own keys (never open by accident). */

import type { Provider } from '@ielts/shared';

export interface CredentialInput {
  provider: Provider;
  apiKey?: string;
  accessCode?: string;
}

export interface CoachCredentialInput {
  provider: Provider;
  /** Dedicated text-coach key (cheapest option). */
  coachApiKey?: string;
  coachBaseUrl?: string;
  coachModel?: string;
  /** Main realtime key reused for text when no dedicated one is given. */
  apiKey?: string;
  accessCode?: string;
}

export interface CoachConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
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
  const primary = (process.env[ENV_KEY[provider]] || '').trim();
  if (provider === 'qwen' && !primary) return (process.env.DASHSCOPE_WORKSPACE_API_KEY || '').trim();
  return primary;
}

export function serverProviders(): Record<Provider | 'deepseek', boolean> {
  return {
    qwen: Boolean(envKey('qwen')),
    gemini: Boolean(envKey('gemini')),
    openai: Boolean(envKey('openai')),
    deepseek: Boolean((process.env.DEEPSEEK_API_KEY || '').trim()),
  };
}

export function accessCodeRequired(): boolean {
  return Boolean((process.env.ACCESS_CODE || '').trim());
}

export function verifyAccessCode(code: string | undefined): boolean {
  const expected = (process.env.ACCESS_CODE || '').trim();
  if (!expected) return false;
  return String(code || '').trim() === expected;
}

/** Host keys may only be used when a code is set, or the host opted into public use. */
export function hostKeyAllowed(code?: string): boolean {
  if (!accessCodeRequired()) return (process.env.ALLOW_PUBLIC_HOST_KEY || '').toLowerCase() === 'true';
  return verifyAccessCode(code);
}

/** Resolve the key for this realtime connection without ever logging or echoing it. */
export function resolveCredential(input: CredentialInput): ResolvedCredential {
  const provided = (input.apiKey || '').trim();
  if (provided) return { apiKey: provided, source: 'byok' };

  const hostKey = envKey(input.provider);
  if (!hostKey) {
    throw new AuthError(
      'no_credentials',
      '没有可用的 API Key：请在设置里填写自己的 Key，或让站长配置访问口令。',
    );
  }
  if (!accessCodeRequired()) {
    throw new AuthError(
      'access_code_not_configured',
      '站长还没有设置访问口令，服务端 Key 暂不对外开放。请填自己的 API Key，或联系站长。',
      401,
    );
  }
  if (!verifyAccessCode(input.accessCode)) {
    throw new AuthError('bad_access_code', '访问口令不正确。', 401);
  }
  return { apiKey: hostKey, source: 'server' };
}

function providerCoachDefault(provider: Provider): CoachConfig {
  if (provider === 'qwen') {
    return {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      apiKey: '',
    };
  }
  if (provider === 'gemini') {
    return {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.5-flash',
      apiKey: '',
    };
  }
  return {
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: 'gpt-4o-mini',
    apiKey: '',
  };
}

/**
 * Text-coach credentials, in priority order:
 * dedicated coach key -> the learner's realtime key -> server DeepSeek -> host key
 * (only with a valid access code). No silent fallback: callers get an error.
 */
export function resolveCoachConfig(input: CoachCredentialInput): CoachConfig {
  const dedicated = (input.coachApiKey || '').trim();
  if (dedicated) {
    const fallback = providerCoachDefault(input.provider);
    return {
      baseUrl: (input.coachBaseUrl || fallback.baseUrl).replace(/\/$/, ''),
      model: (input.coachModel || fallback.model).trim(),
      apiKey: dedicated,
    };
  }

  const realtimeKey = (input.apiKey || '').trim();
  if (realtimeKey) {
    const fallback = providerCoachDefault(input.provider);
    return {
      baseUrl: (input.coachBaseUrl || fallback.baseUrl).replace(/\/$/, ''),
      model: (input.coachModel || fallback.model).trim(),
      apiKey: realtimeKey,
    };
  }

  const deepseek = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (deepseek && hostKeyAllowed(input.accessCode)) {
    return { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: deepseek };
  }

  const host = envKey(input.provider);
  if (host && hostKeyAllowed(input.accessCode)) {
    const fallback = providerCoachDefault(input.provider);
    return { ...fallback, apiKey: host };
  }

  if (host && !accessCodeRequired()) {
    throw new AuthError(
      'access_code_not_configured',
      '站长还没有设置访问口令，服务端 Key 暂不对外开放。请填自己的 API Key。',
      401,
    );
  }
  throw new AuthError('no_credentials', '精批需要文本模型：请填写自己的 API Key，或使用访问口令。', 401);
}
