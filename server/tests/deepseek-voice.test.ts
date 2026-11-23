/**
 * DeepSeek pure-voice mode (v2.2.0) — no real network in CI.
 *
 * The streaming turn is exercised end-to-end against a local fake
 * OpenAI-compatible SSE upstream; Edge TTS is mocked so tests are deterministic
 * (a real synthesis was verified manually from this machine for v2.2.0).
 */

import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateway } from '../src/index';
import { cleanTextForTts, pickEdgeVoice, resolveChatCompletionsUrl, synthesizeSpeech } from '../src/deepseek-voice';

vi.mock('@andresaya/edge-tts', () => ({
  EdgeTTS: class {
    async generate(): Promise<{ audio: Buffer }> {
      throw new Error('mock Edge TTS is down');
    }
  },
  Constants: {
    OUTPUT_FORMAT: {
      AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3',
      AUDIO_24KHZ_96KBITRATE_MONO_MP3: 'audio-24khz-96kbitrate-mono-mp3',
      WEBM_24KHZ_16BIT_MONO_OPUS: 'webm-24khz-16bit-mono-opus',
    },
  },
}));

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

function clearCredentialEnv(): void {
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  vi.stubEnv('ACCESS_CODE', '');
  vi.stubEnv('ALLOW_PUBLIC_HOST_KEY', '');
}

async function startGateway() {
  const { server } = createGateway();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    httpUrl: 'http://127.0.0.1:' + String(port),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface FakeUpstream {
  url: string;
  requests: Array<{ url?: string; authorization?: string; body: Record<string, unknown> | null }>;
  close: () => Promise<void>;
}

interface FakeUpstreamOptions {
  status?: number;
  body?: string;
}

/**
 * Minimal OpenAI-compatible SSE endpoint. The second `delta` frame is split
 * across two TCP writes on purpose to cover the stream buffer, and one frame
 * carries only `reasoning_content` (deepseek-reasoner) which must be ignored.
 */
async function fakeSseUpstream(options: FakeUpstreamOptions = {}): Promise<FakeUpstream> {
  const requests: FakeUpstream['requests'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      requests.push({ url: req.url, authorization: req.headers.authorization, body });

      const status = options.status ?? 200;
      if (status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(options.body || JSON.stringify({ error: { message: 'mock upstream rejected the request' } }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': keep-alive comment\n\n');
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" the');
      res.write('re"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":""}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"reasoning_content":"internal thinking"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: 'http://127.0.0.1:' + String(port),
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** An address that definitely refuses connections (listen, read port, close). */
async function closedLocalUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 'http://127.0.0.1:' + String(port);
}

function parseSseFrames(raw: string): Array<Record<string, unknown>> {
  return raw
    .split('\n\n')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('data:'))
    .map((part) => JSON.parse(part.slice(5).trim()) as Record<string, unknown>);
}

function postDeepSeekTurn(httpUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(httpUrl + '/api/voice/deepseek-turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postTts(httpUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(httpUrl + '/api/voice/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Pure text helpers
// ---------------------------------------------------------------------------

describe('cleanTextForTts', () => {
  it('strips Markdown / HTML and collapses whitespace', () => {
    const cleaned = cleanTextForTts(
      '# Heading\n\n**Hello** _there_, [click here](https://example.com/page)!\n' +
        '- first item\n- second item\n\n' +
        '```js\nconst x = 1;\n```\n' +
        '`inline code` <b>bold</b>',
    );
    expect(cleaned).not.toContain('#');
    expect(cleaned).not.toContain('*');
    expect(cleaned).not.toContain('_');
    expect(cleaned).not.toContain('`');
    expect(cleaned).not.toContain('https://');
    expect(cleaned).not.toContain('<b>');
    expect(cleaned).not.toContain('const x');
    expect(cleaned).toContain('Hello');
    expect(cleaned).toContain('there');
    expect(cleaned).toContain('click here');
    expect(cleaned).toContain('first item');
    expect(cleaned).toContain('second item');
    expect(cleaned).toContain('inline code');
    expect(cleaned).toContain('bold');
    expect(cleaned).not.toContain('\n');
    expect(cleaned).not.toMatch(/\s{2,}/);
  });

  it('keeps sentence punctuation and cuts long text to whole sentences', () => {
    const long = 'This is a full sentence about my hometown. '.repeat(40);
    const cleaned = cleanTextForTts(long);
    expect(cleaned.length).toBeLessThanOrEqual(600);
    expect(cleaned.length).toBeGreaterThan(300);
    expect(cleaned.endsWith('.')).toBe(true);
    const sentences = cleaned.split(/(?<=[.!?])\s+/);
    expect(sentences.length).toBeGreaterThan(3);
    expect(sentences[sentences.length - 1]).toMatch(/[.!?]$/);
  });

  it('returns an empty string when nothing speakable is left', () => {
    expect(cleanTextForTts('')).toBe('');
    expect(cleanTextForTts('   \n\t ')).toBe('');
    expect(cleanTextForTts('```\ncode only\n```')).toBe('');
  });
});

describe('pickEdgeVoice', () => {
  it('uses Sonia (British) and Jenny (American) for English text', () => {
    expect(pickEdgeVoice('How are you today?', 'uk')).toBe('en-GB-SoniaNeural');
    expect(pickEdgeVoice('How are you today?', 'us')).toBe('en-US-JennyNeural');
  });

  it('switches to Xiaoxiao for Chinese text', () => {
    expect(pickEdgeVoice('请用英语回答我的问题。', 'uk')).toBe('zh-CN-XiaoxiaoNeural');
    expect(pickEdgeVoice('你好，今天的天气怎么样？', 'us')).toBe('zh-CN-XiaoxiaoNeural');
  });

  it('keeps the accent while the Chinese share stays under 15%', () => {
    expect(pickEdgeVoice('What does 你好 mean in this sentence please?', 'uk')).toBe('en-GB-SoniaNeural');
  });
});

describe('resolveChatCompletionsUrl', () => {
  it('defaults to the official DeepSeek chat endpoint', () => {
    expect(resolveChatCompletionsUrl(undefined)).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(resolveChatCompletionsUrl('   ')).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('appends /chat/completions to a base URL and keeps a full URL as-is', () => {
    expect(resolveChatCompletionsUrl('https://relay.example.com/v1')).toBe(
      'https://relay.example.com/v1/chat/completions',
    );
    expect(resolveChatCompletionsUrl('https://relay.example.com/v1/')).toBe(
      'https://relay.example.com/v1/chat/completions',
    );
    expect(resolveChatCompletionsUrl('https://relay.example.com/chat/completions')).toBe(
      'https://relay.example.com/chat/completions',
    );
  });
});

// ---------------------------------------------------------------------------
// Streaming turn over the real gateway route
// ---------------------------------------------------------------------------

describe('POST /api/voice/deepseek-turn: streaming', () => {
  it('streams delta frames then done and forwards model/temperature/max_tokens (BYOK)', async () => {
    clearCredentialEnv();
    const upstream = await fakeSseUpstream();
    const gateway = await startGateway();
    cleanups.push(gateway.close, upstream.close);

    const response = await postDeepSeekTurn(gateway.httpUrl, {
      apiKey: 'sk-byok-test',
      systemPrompt: 'You are a friendly IELTS examiner.',
      model: 'deepseek-chat',
      maxTokens: 123,
      endpointUrl: upstream.url,
      messages: [
        { role: 'user', text: 'Hello' },
        { role: 'assistant', text: 'Hi there.' },
        { role: 'user', text: 'Ask me question 2.' },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type') || '').toContain('text/event-stream');
    const frames = parseSseFrames(await response.text());
    expect(frames.map((frame) => frame.type)).toEqual(['delta', 'delta', 'done']);
    expect(frames[0]).toEqual({ type: 'delta', delta: 'Hello' });
    expect(frames[1]).toEqual({ type: 'delta', delta: ' there' });
    expect(frames[2]).toEqual({ type: 'done', text: 'Hello there' });

    expect(upstream.requests).toHaveLength(1);
    const request = upstream.requests[0];
    expect(request.url).toBe('/chat/completions');
    expect(request.authorization).toBe('Bearer sk-byok-test');
    expect(request.body).toMatchObject({
      model: 'deepseek-chat',
      stream: true,
      temperature: 0.65,
      max_tokens: 123,
    });
    expect(request.body?.messages).toEqual([
      { role: 'system', content: 'You are a friendly IELTS examiner.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there.' },
      { role: 'user', content: 'Ask me question 2.' },
    ]);
  });

  it('uses the host DEEPSEEK_API_KEY with the official endpoint and ignores a client relay (v2.2.5)', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-host-deepseek');
    vi.stubEnv('ACCESS_CODE', 'ielts2026');
    vi.stubEnv('ALLOW_PUBLIC_HOST_KEY', '');
    const upstream = await fakeSseUpstream();
    const gateway = await startGateway();
    cleanups.push(gateway.close, upstream.close);

    // v2.2.5: the deployment key may only reach the official DeepSeek endpoint.
    const realFetch = globalThis.fetch.bind(globalThis);
    const captured: Array<{ url: string; authorization: string }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
      const target =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input?.url || '');
      if (target.startsWith('https://api.deepseek.com/')) {
        captured.push({
          url: target,
          authorization: new Headers(init?.headers).get('authorization') || '',
        });
        return new Response('data: {"choices":[{"delta":{"content":"Hello there"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return realFetch(input, init);
    }) as typeof fetch);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    cleanups.push(() => fetchSpy.mockRestore(), () => warnSpy.mockRestore());

    const response = await postDeepSeekTurn(gateway.httpUrl, {
      accessCode: 'ielts2026',
      systemPrompt: 'prompt',
      endpointUrl: upstream.url,
      messages: [{ role: 'user', text: 'hi' }],
    });
    expect(response.status).toBe(200);
    const frames = parseSseFrames(await response.text());
    expect(frames[frames.length - 1]).toEqual({ type: 'done', text: 'Hello there' });
    // The client-chosen relay must never be contacted...
    expect(upstream.requests).toHaveLength(0);
    // ...and the host key only goes to the official endpoint.
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(captured[0].authorization).toBe('Bearer sk-host-deepseek');
  });

  it('sends an error frame when the upstream is unreachable', async () => {
    clearCredentialEnv();
    const unreachable = await closedLocalUrl();
    const gateway = await startGateway();
    cleanups.push(gateway.close);

    const response = await postDeepSeekTurn(gateway.httpUrl, {
      apiKey: 'sk-byok-test',
      systemPrompt: 'prompt',
      endpointUrl: unreachable,
      messages: [{ role: 'user', text: 'hi' }],
    });
    // SSE headers are already sent, so the failure arrives as a protocol frame.
    expect(response.status).toBe(200);
    const frames = parseSseFrames(await response.text());
    const errorFrame = frames.find((frame) => frame.type === 'error');
    expect(errorFrame).toBeTruthy();
    expect(String(errorFrame?.message)).toContain('DeepSeek');
  });

  it('sends an error frame when the upstream rejects the key', async () => {
    clearCredentialEnv();
    const upstream = await fakeSseUpstream({ status: 401 });
    const gateway = await startGateway();
    cleanups.push(gateway.close, upstream.close);

    const response = await postDeepSeekTurn(gateway.httpUrl, {
      apiKey: 'sk-bad-key',
      systemPrompt: 'prompt',
      endpointUrl: upstream.url,
      messages: [{ role: 'user', text: 'hi' }],
    });
    expect(response.status).toBe(200);
    const frames = parseSseFrames(await response.text());
    const errorFrame = frames.find((frame) => frame.type === 'error');
    expect(errorFrame).toBeTruthy();
    expect(String(errorFrame?.message)).toContain('401');
  });
});

describe('POST /api/voice/deepseek-turn: validation and auth', () => {
  it('rejects a body without systemPrompt or messages with 400', async () => {
    const gateway = await startGateway();
    cleanups.push(gateway.close);

    const missingPrompt = await postDeepSeekTurn(gateway.httpUrl, {
      messages: [{ role: 'user', text: 'hi' }],
    });
    expect(missingPrompt.status).toBe(400);
    expect((await missingPrompt.json()) as { error?: string }).toHaveProperty('error');

    const missingMessages = await postDeepSeekTurn(gateway.httpUrl, { systemPrompt: 'prompt' });
    expect(missingMessages.status).toBe(400);
  });

  it('returns 401 no_credentials without a BYOK key or host key', async () => {
    clearCredentialEnv();
    const gateway = await startGateway();
    cleanups.push(gateway.close);

    const response = await postDeepSeekTurn(gateway.httpUrl, {
      systemPrompt: 'prompt',
      messages: [{ role: 'user', text: 'hi' }],
    });
    expect(response.status).toBe(401);
    const data = (await response.json()) as { code?: string };
    expect(data.code).toBe('no_credentials');
  });

  it('returns 401 access_code_not_configured when the host key is protected', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-host-deepseek');
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('ALLOW_PUBLIC_HOST_KEY', '');
    const gateway = await startGateway();
    cleanups.push(gateway.close);

    const response = await postDeepSeekTurn(gateway.httpUrl, {
      systemPrompt: 'prompt',
      messages: [{ role: 'user', text: 'hi' }],
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code?: string }).code).toBe('access_code_not_configured');
  });

  it('returns 401 bad_access_code for a wrong access code', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-host-deepseek');
    vi.stubEnv('ACCESS_CODE', 'ielts2026');
    const gateway = await startGateway();
    cleanups.push(gateway.close);

    const response = await postDeepSeekTurn(gateway.httpUrl, {
      accessCode: 'wrong-code',
      systemPrompt: 'prompt',
      messages: [{ role: 'user', text: 'hi' }],
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code?: string }).code).toBe('bad_access_code');
  });
});

// ---------------------------------------------------------------------------
// TTS route contract (Edge TTS mocked to fail; the real call was verified manually)
// ---------------------------------------------------------------------------

describe('POST /api/voice/tts', () => {
  it('rejects blank text with 400', async () => {
    const gateway = await startGateway();
    cleanups.push(gateway.close);
    const response = await postTts(gateway.httpUrl, { text: '   ', accent: 'uk' });
    expect(response.status).toBe(400);
  });

  it('answers 503 JSON so the browser can fall back to speechSynthesis', async () => {
    const gateway = await startGateway();
    cleanups.push(gateway.close);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cleanups.push(() => spy.mockRestore());

    const response = await postTts(gateway.httpUrl, { text: '**Hello** there.', accent: 'us' });
    expect(response.status).toBe(503);
    const data = (await response.json()) as { error?: string };
    expect(String(data.error)).toContain('TTS');
  });

  it('synthesizeSpeech rejects empty speakable text before touching the network', async () => {
    await expect(synthesizeSpeech('   ', 'uk')).rejects.toThrow();
    await expect(synthesizeSpeech('```code only```', 'us')).rejects.toThrow();
  });
});
