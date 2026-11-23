import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { ServerEvent } from '@ielts/shared';
import { createGateway } from '../src/index';
import { GeminiAdapter } from '../src/adapters/gemini';

async function startGateway() {
  const { server } = createGateway();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: 'ws://127.0.0.1:' + String(port),
    httpUrl: 'http://127.0.0.1:' + String(port),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function fakeUpstream() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const received: Array<Record<string, unknown>> = [];
  const sockets: WebSocket[] = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (raw) => {
      try {
        received.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch {
        received.push({ raw: raw.toString() });
      }
    });
  });
  return {
    url: 'ws://127.0.0.1:' + String(port),
    received,
    sockets,
    close: async () => {
      for (const socket of sockets) socket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function fakeTextModel(reply: unknown) {
  const requests: Array<{ auth?: string; body?: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      requests.push({ auth: req.headers.authorization, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      const content = JSON.stringify(reply);
      const payload = JSON.stringify({ choices: [{ message: { content } }] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: 'http://127.0.0.1:' + String(port) + '/v1',
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function waitFor<T>(fn: () => T | null, timeout = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = fn();
      if (value) return resolve(value);
      if (Date.now() - started > timeout) return reject(new Error('timeout'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    if (fn) await fn();
  }
});

describe('greeting race', () => {
  it('delivers the opening greeting even when sent immediately after start_session', async () => {
    const gateway = await startGateway();
    const upstream = await fakeUpstream();
    cleanup.push(gateway.close, upstream.close);

    const client = new WebSocket(gateway.url + '/ws/realtime');
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve());
      client.on('error', reject);
    });

    client.send(
      JSON.stringify({
        type: 'start_session',
        provider: 'qwen',
        model: 'fake',
        apiKey: 'sk-test',
        endpointUrl: upstream.url,
        systemPrompt: 'prompt',
        turnMode: 'auto',
        inputSampleRate: 16000,
      }),
    );
    // Sent in the same tick, before the upstream handshake finished.
    client.send(JSON.stringify({ type: 'trigger_greeting', text: 'Begin the lesson now.' }));

    const created = await waitFor(() =>
      upstream.received.find((item) => item.type === 'conversation.item.create') || null,
    );
    const item = created as { item?: { content?: Array<{ text?: string }> } };
    expect(item.item?.content?.[0]?.text).toBe('Begin the lesson now.');
    client.close();
  });
});

describe('coach credentials', () => {
  it('uses a dedicated coach key passed from the browser', async () => {
    const gateway = await startGateway();
    const model = await fakeTextModel({
      corrected_text: 'I went there.',
      upgraded_text: 'I paid a visit there.',
      grammar_mistakes: [],
      lexical_tips: [],
      coach_note_zh: '不错',
    });
    cleanup.push(gateway.close, model.close);

    const response = await fetch(gateway.httpUrl + '/api/coach/analyze-turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        learnerTranscript: 'I go there yesterday',
        coachApiKey: 'sk-coach',
        coachBaseUrl: model.url,
        coachModel: 'fake-model',
      }),
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { feedback?: { corrected_text?: string } };
    expect(data.feedback?.corrected_text).toBe('I went there.');
    expect(model.requests[0].auth).toBe('Bearer sk-coach');
    expect(model.requests[0].body?.model).toBe('fake-model');
  });

  it('rejects host-key use when ACCESS_CODE is not configured', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'sk-host');
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('ALLOW_PUBLIC_HOST_KEY', '');
    const gateway = await startGateway();
    cleanup.push(gateway.close);

    const response = await fetch(gateway.httpUrl + '/api/coach/analyze-turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'qwen', learnerTranscript: 'I live in a city near the sea.' }),
    });
    expect(response.status).toBe(401);
    const data = (await response.json()) as { code?: string };
    expect(data.code).toBe('access_code_not_configured');
  });

  it('never fabricates a 6.0 report without credentials', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    vi.stubEnv('ACCESS_CODE', '');
    const gateway = await startGateway();
    cleanup.push(gateway.close);

    const response = await fetch(gateway.httpUrl + '/api/coach/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'qwen', turns: [{ examinerQuestion: 'Q', learnerTranscript: 'A' }] }),
    });
    expect(response.status).toBe(401);
    const data = (await response.json()) as { report?: unknown; code?: string };
    expect(data.report).toBeUndefined();
    expect(data.code).toBe('no_credentials');
  });
});

describe('gemini transcript ordering', () => {
  it('finalizes the user turn before the non-empty examiner transcript', async () => {
    const upstream = await fakeUpstream();
    cleanup.push(upstream.close);
    const events: ServerEvent[] = [];
    const adapter = new GeminiAdapter();
    const handle = await adapter.start(
      {
        provider: 'gemini',
        model: 'gemini-2.5-flash-native-audio',
        apiKey: 'sk-test',
        systemPrompt: 'prompt',
        turnMode: 'auto',
        endpointUrl: upstream.url,
      },
      { emit: (event) => events.push(event), audio: () => undefined, failed: () => undefined },
    );
    const socket = upstream.sockets[0];
    socket.send(JSON.stringify({ setupComplete: {} }));
    socket.send(
      JSON.stringify({ serverContent: { inputTranscription: { text: 'I live in Shanghai.' } } }),
    );
    socket.send(
      JSON.stringify({ serverContent: { outputTranscription: { text: 'Nice.' } } }),
    );
    socket.send(JSON.stringify({ serverContent: { turnComplete: true } }));
    await new Promise((resolve) => setTimeout(resolve, 120));

    const types = events.map((event) => event.type);
    const userIndex = types.indexOf('user_transcript_final');
    const examinerIndex = types.indexOf('examiner_transcript_final');
    expect(userIndex).toBeGreaterThan(-1);
    expect(examinerIndex).toBeGreaterThan(userIndex);
    const examinerFinal = events[examinerIndex] as { text?: string };
    expect(examinerFinal.text).toBe('Nice.');
    handle.close();
  });
});
