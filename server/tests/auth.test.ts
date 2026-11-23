import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  resolveCoachConfig,
  resolveCredential,
  serverProviders,
} from '../src/auth';
import { pingCoach } from '../src/coach';

const ENV_KEYS = [
  'DEEPSEEK_API_KEY',
  'DASHSCOPE_API_KEY',
  'DASHSCOPE_WORKSPACE_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ACCESS_CODE',
  'ALLOW_PUBLIC_HOST_KEY',
];

function resetEnv(): void {
  for (const key of ENV_KEYS) vi.stubEnv(key, '');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function catchAuthError(fn: () => unknown): AuthError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    return error as AuthError;
  }
  throw new Error('expected AuthError to be thrown');
}

describe('resolveCoachConfig: reviewMode=deepseek', () => {
  it('never sends a dedicated DeepSeek key to the main provider domain', () => {
    resetEnv();
    vi.stubEnv('DASHSCOPE_API_KEY', 'sk-qwen-host');
    const config = resolveCoachConfig({
      provider: 'qwen',
      reviewMode: 'deepseek',
      coachApiKey: 'sk-my-deepseek',
    });
    expect(config.baseUrl).toBe(DEEPSEEK_BASE_URL);
    expect(config.model).toBe(DEEPSEEK_MODEL);
    expect(config.apiKey).toBe('sk-my-deepseek');
  });

  it('respects an explicit DeepSeek base/model coming from the settings sheet', () => {
    resetEnv();
    const config = resolveCoachConfig({
      provider: 'qwen',
      reviewMode: 'deepseek',
      coachApiKey: 'sk-my-deepseek',
      coachBaseUrl: 'https://api.deepseek.com/v1/',
      coachModel: 'deepseek-reasoner',
    });
    expect(config.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(config.model).toBe('deepseek-reasoner');
  });

  it('uses the server DEEPSEEK_API_KEY with a valid access code', () => {
    resetEnv();
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-server-deepseek');
    vi.stubEnv('ACCESS_CODE', 'ielts2026');
    const config = resolveCoachConfig({ provider: 'qwen', reviewMode: 'deepseek', accessCode: 'ielts2026' });
    expect(config.baseUrl).toBe(DEEPSEEK_BASE_URL);
    expect(config.model).toBe(DEEPSEEK_MODEL);
    expect(config.apiKey).toBe('sk-server-deepseek');
  });

  it('rejects a wrong access code for the server DeepSeek key', () => {
    resetEnv();
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-server-deepseek');
    vi.stubEnv('ACCESS_CODE', 'ielts2026');
    const error = catchAuthError(() =>
      resolveCoachConfig({ provider: 'qwen', reviewMode: 'deepseek', accessCode: 'wrong' }),
    );
    expect(error.code).toBe('bad_access_code');
    expect(error.status).toBe(401);
  });

  it('asks for a DeepSeek key when nothing is configured', () => {
    resetEnv();
    const error = catchAuthError(() => resolveCoachConfig({ provider: 'qwen', reviewMode: 'deepseek' }));
    expect(error.code).toBe('no_credentials');
    expect(error.status).toBe(401);
    expect(error.message).toContain('DeepSeek');
  });
});

describe('resolveCoachConfig: reviewMode=custom', () => {
  it('uses the learner-supplied base URL and model', () => {
    resetEnv();
    const config = resolveCoachConfig({
      provider: 'qwen',
      reviewMode: 'custom',
      coachApiKey: 'sk-custom',
      coachBaseUrl: 'https://example.test/v1',
      coachModel: 'my-model',
    });
    expect(config).toEqual({ baseUrl: 'https://example.test/v1', model: 'my-model', apiKey: 'sk-custom' });
  });

  it('falls back to the realtime key when no dedicated coach key is given', () => {
    resetEnv();
    const config = resolveCoachConfig({
      provider: 'openai',
      reviewMode: 'custom',
      apiKey: 'sk-realtime',
      coachBaseUrl: 'https://example.test/v1',
      coachModel: 'my-model',
    });
    expect(config.apiKey).toBe('sk-realtime');
  });

  it('fails clearly when a key is present but base/model are missing', () => {
    resetEnv();
    const error = catchAuthError(() =>
      resolveCoachConfig({ provider: 'qwen', reviewMode: 'custom', coachApiKey: 'sk-custom' }),
    );
    expect(error.code).toBe('custom_endpoint_missing');
    expect(error.status).toBe(400);
    expect(error.message).toContain('Base URL');
  });

  it('fails clearly when no key is present at all', () => {
    resetEnv();
    const error = catchAuthError(() =>
      resolveCoachConfig({
        provider: 'qwen',
        reviewMode: 'custom',
        coachBaseUrl: 'https://example.test/v1',
        coachModel: 'my-model',
      }),
    );
    expect(error.code).toBe('no_credentials');
    expect(error.status).toBe(401);
  });
});

describe('resolveCoachConfig: auto mode', () => {
  it('keeps the provider default for a dedicated key without hints', () => {
    resetEnv();
    const qwen = resolveCoachConfig({ provider: 'qwen', coachApiKey: 'sk-my-key' });
    expect(qwen.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(qwen.model).toBe('qwen-plus');

    const openai = resolveCoachConfig({ provider: 'openai', coachApiKey: 'sk-my-key' });
    expect(openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(openai.model).toBe('gpt-4o-mini');
  });

  it('routes a deepseek-* coach model to the DeepSeek endpoint (v2.0.1 bug fix)', () => {
    resetEnv();
    const config = resolveCoachConfig({ provider: 'qwen', coachApiKey: 'sk-ds', coachModel: 'deepseek-chat' });
    expect(config.baseUrl).toBe(DEEPSEEK_BASE_URL);
    expect(config.model).toBe('deepseek-chat');
  });

  it('uses deepseek-chat when only a DeepSeek base URL is given', () => {
    resetEnv();
    const config = resolveCoachConfig({
      provider: 'qwen',
      coachApiKey: 'sk-ds',
      coachBaseUrl: 'https://api.deepseek.com/v1',
    });
    expect(config.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(config.model).toBe(DEEPSEEK_MODEL);
  });

  it('still supports server keys behind a valid access code', () => {
    resetEnv();
    vi.stubEnv('DASHSCOPE_API_KEY', 'sk-host-qwen');
    vi.stubEnv('ACCESS_CODE', 'ielts2026');
    expect(serverProviders().qwen).toBe(true);
    const config = resolveCoachConfig({ provider: 'qwen', accessCode: 'ielts2026' });
    expect(config.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(config.model).toBe('qwen-plus');
    expect(config.apiKey).toBe('sk-host-qwen');
  });

  it('never fabricates a config without credentials', () => {
    resetEnv();
    const error = catchAuthError(() => resolveCoachConfig({ provider: 'qwen' }));
    expect(error.code).toBe('no_credentials');
    expect(error.status).toBe(401);
  });
});

describe('resolveCredential: deepseek pure-voice mode', () => {
  it('accepts a BYOK DeepSeek key without any server env', () => {
    resetEnv();
    expect(resolveCredential({ provider: 'deepseek', apiKey: 'sk-ds-byok' })).toEqual({
      apiKey: 'sk-ds-byok',
      source: 'byok',
    });
  });

  it('uses the host DEEPSEEK_API_KEY with a valid access code', () => {
    resetEnv();
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-ds-server');
    vi.stubEnv('ACCESS_CODE', 'ielts2026');
    expect(resolveCredential({ provider: 'deepseek', accessCode: 'ielts2026' })).toEqual({
      apiKey: 'sk-ds-server',
      source: 'server',
    });
  });

  it('refuses the host key when no access code is configured', () => {
    resetEnv();
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-ds-server');
    const error = catchAuthError(() => resolveCredential({ provider: 'deepseek' }));
    expect(error.code).toBe('access_code_not_configured');
    expect(error.status).toBe(401);
  });

  it('refuses a wrong access code and reports missing credentials clearly', () => {
    resetEnv();
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-ds-server');
    vi.stubEnv('ACCESS_CODE', 'ielts2026');
    const wrong = catchAuthError(() => resolveCredential({ provider: 'deepseek', accessCode: 'nope' }));
    expect(wrong.code).toBe('bad_access_code');
    expect(wrong.status).toBe(401);

    resetEnv();
    const none = catchAuthError(() => resolveCredential({ provider: 'deepseek' }));
    expect(none.code).toBe('no_credentials');
    expect(none.status).toBe(401);
  });

  it('reports deepseek in serverProviders only when DEEPSEEK_API_KEY is set', () => {
    resetEnv();
    expect(serverProviders().deepseek).toBe(false);
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-ds-server');
    expect(serverProviders()).toEqual({
      deepseek: true,
      qwen: false,
      gemini: false,
      openai: false,
    });
  });
});

describe('resolveCoachConfig: provider=deepseek pure-voice mode', () => {
  it('reuses a BYOK DeepSeek key on the DeepSeek endpoint for review', () => {
    resetEnv();
    const config = resolveCoachConfig({ provider: 'deepseek', apiKey: 'sk-ds-byok' });
    expect(config).toEqual({ baseUrl: DEEPSEEK_BASE_URL, model: DEEPSEEK_MODEL, apiKey: 'sk-ds-byok' });
  });

  it('reuses the host DeepSeek key with a valid access code', () => {
    resetEnv();
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-ds-server');
    vi.stubEnv('ACCESS_CODE', 'ielts2026');
    const config = resolveCoachConfig({ provider: 'deepseek', accessCode: 'ielts2026' });
    expect(config).toMatchObject({
      baseUrl: DEEPSEEK_BASE_URL,
      model: DEEPSEEK_MODEL,
      apiKey: 'sk-ds-server',
    });
  });

  it('keeps the DeepSeek endpoint for a dedicated coach key', () => {
    resetEnv();
    const config = resolveCoachConfig({ provider: 'deepseek', coachApiKey: 'sk-coach-ds' });
    expect(config).toEqual({ baseUrl: DEEPSEEK_BASE_URL, model: DEEPSEEK_MODEL, apiKey: 'sk-coach-ds' });
  });

  it('test-connection for deepseek pings DeepSeek with the resolved key (local fake upstream)', async () => {
    resetEnv();
    const requests: Array<{ authorization?: string; body?: Record<string, unknown> }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        requests.push({
          authorization: req.headers.authorization,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const config = resolveCoachConfig({
        provider: 'deepseek',
        coachApiKey: 'sk-coach-ds',
        coachBaseUrl: 'http://127.0.0.1:' + String(port) + '/v1',
      });
      const result = await pingCoach(config);
      expect(result.ok).toBe(true);
      expect(requests[0].authorization).toBe('Bearer sk-coach-ds');
      expect(requests[0].body?.model).toBe(DEEPSEEK_MODEL);
      expect(requests[0].body?.messages).toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
