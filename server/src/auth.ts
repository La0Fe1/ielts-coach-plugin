/** Credential resolution: BYOK first, then the host's own keys (never open by accident). */

import type { Provider, ReviewMode } from '@ielts/shared';

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
  /**
   * v2.1.0 review routing chosen in the web settings sheet.
   * auto = reuse the current voice provider; deepseek = dedicated DeepSeek preset;
   * custom = user-supplied OpenAI-compatible endpoint; external = caller never
   * reaches this module (the web app skips per-turn API calls).
   */
  reviewMode?: ReviewMode;
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

/** DeepSeek is OpenAI-compatible; these are the only default values ever sent there. */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEEPSEEK_MODEL = 'deepseek-chat';

const ENV_KEY: Record<Provider, string> = {
  // v2.2.0 DeepSeek pure-voice mode: the same key powers streamed text turns,
  // per-turn review and the end-of-lesson report (Edge TTS needs no key).
  deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
};

function envKey(provider: Provider): string {
  const primary = (process.env[ENV_KEY[provider]] || '').trim();
  if (provider === 'qwen' && !primary) return (process.env.DASHSCOPE_WORKSPACE_API_KEY || '').trim();
  return primary;
}

export function serverProviders(): Record<Provider, boolean> {
  return {
    deepseek: Boolean(envKey('deepseek')),
    qwen: Boolean(envKey('qwen')),
    gemini: Boolean(envKey('gemini')),
    openai: Boolean(envKey('openai')),
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
      401,
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
  if (provider === 'deepseek') {
    // Pure-voice mode: text review/report reuse the very same DeepSeek key.
    return { baseUrl: DEEPSEEK_BASE_URL, model: DEEPSEEK_MODEL, apiKey: '' };
  }
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

function isDeepSeekBase(url: string): boolean {
  const clean = (url || '').toLowerCase();
  if (!clean) return false;
  try {
    return new URL(clean).hostname.includes('deepseek');
  } catch {
    return clean.includes('deepseek');
  }
}

function looksDeepSeekModel(model: string): boolean {
  return (model || '').trim().toLowerCase().startsWith('deepseek');
}

/**
 * Build the coach config for the "auto / external" modes.
 *
 * v2.0.1 bug fix: a dedicated coach key must never be sent to the wrong provider
 * domain. When the learner gave no baseUrl but the model name is a DeepSeek one
 * (`deepseek-*`), the DeepSeek endpoint is used; likewise a DeepSeek baseUrl with
 * no model falls back to `deepseek-chat` instead of the voice provider's model.
 */
function autoCoachConfig(
  provider: Provider,
  coachBaseUrl: string | undefined,
  coachModel: string | undefined,
  apiKey: string,
): CoachConfig {
  const fallback = providerCoachDefault(provider);
  const baseHint = (coachBaseUrl || '').trim();
  const modelHint = (coachModel || '').trim();
  const baseUrl = (
    baseHint || (looksDeepSeekModel(modelHint) ? DEEPSEEK_BASE_URL : fallback.baseUrl)
  ).replace(/\/$/, '');
  const model = modelHint || (isDeepSeekBase(baseUrl) ? DEEPSEEK_MODEL : fallback.model);
  return { baseUrl, model, apiKey };
}

function deepseekCoachConfig(input: CoachCredentialInput): CoachConfig {
  const baseUrl = ((input.coachBaseUrl || '').trim() || DEEPSEEK_BASE_URL).replace(/\/$/, '');
  const model = (input.coachModel || '').trim() || DEEPSEEK_MODEL;
  const dedicated = (input.coachApiKey || '').trim();
  if (dedicated) return { baseUrl, model, apiKey: dedicated };

  const serverKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (!serverKey) {
    throw new AuthError(
      'no_credentials',
      '独立 DeepSeek 精批需要 DeepSeek API Key：请在「精批方式」里选择「独立 DeepSeek」并填写自己的 Key（或让站长配置 DEEPSEEK_API_KEY + 访问口令）。',
      401,
    );
  }
  if (!hostKeyAllowed(input.accessCode)) {
    if (!accessCodeRequired()) {
      throw new AuthError(
        'access_code_not_configured',
        '站长还没有设置访问口令，服务端 DeepSeek Key 暂不对外开放。请在「精批方式」里填写自己的 DeepSeek API Key。',
        401,
      );
    }
    throw new AuthError(
      'bad_access_code',
      '访问口令不正确，无法使用服务端 DeepSeek Key。请填写自己的 DeepSeek API Key 或重试口令。',
      401,
    );
  }
  return { baseUrl, model, apiKey: serverKey };
}

function customCoachConfig(input: CoachCredentialInput): CoachConfig {
  const apiKey = (input.coachApiKey || input.apiKey || '').trim();
  if (!apiKey) {
    throw new AuthError(
      'no_credentials',
      '自定义精批需要 API Key：请填写自定义模型的 Key，或把「精批方式」切回「网页自动 / 独立 DeepSeek」。',
      401,
    );
  }
  const baseUrl = (input.coachBaseUrl || '').trim();
  const model = (input.coachModel || '').trim();
  if (!baseUrl || !model) {
    throw new AuthError(
      'custom_endpoint_missing',
      '自定义精批需要同时填写 Base URL 与模型名；如果用的是 DeepSeek，请把「精批方式」改为「独立 DeepSeek」让它自动带出地址。',
      400,
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), model, apiKey };
}

/**
 * Text-coach credentials, in priority order (auto mode):
 * dedicated coach key -> the learner's realtime key -> server DeepSeek -> host key
 * (only with a valid access code). No silent fallback: callers get an error.
 *
 * v2.1.0 modes:
 * - `deepseek` always targets the DeepSeek OpenAI-compatible endpoint.
 * - `custom` always targets the learner's own baseUrl/model (both required).
 * - `auto` / `external` / unset keep the legacy fallback chain above; `external`
 *   normally never reaches this function because the web app skips API calls.
 */
export function resolveCoachConfig(input: CoachCredentialInput): CoachConfig {
  if (input.reviewMode === 'deepseek') return deepseekCoachConfig(input);
  if (input.reviewMode === 'custom') return customCoachConfig(input);

  const dedicated = (input.coachApiKey || '').trim();
  if (dedicated) {
    return autoCoachConfig(input.provider, input.coachBaseUrl, input.coachModel, dedicated);
  }

  const realtimeKey = (input.apiKey || '').trim();
  if (realtimeKey) {
    return autoCoachConfig(input.provider, input.coachBaseUrl, input.coachModel, realtimeKey);
  }

  const deepseek = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (deepseek && hostKeyAllowed(input.accessCode)) {
    return { baseUrl: DEEPSEEK_BASE_URL, model: DEEPSEEK_MODEL, apiKey: deepseek };
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
