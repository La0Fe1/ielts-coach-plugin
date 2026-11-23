import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerEvent } from '@ielts/shared';
import { GeminiAdapter } from '../src/adapters/gemini';
import { OpenAIAdapter } from '../src/adapters/openai';
import { QwenAdapter } from '../src/adapters/qwen';
import { upsample16to24 } from '../src/adapters/base';
import { AuthError, resolveCredential, serverProviders, verifyAccessCode } from '../src/auth';

async function fakeUpstream() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const received: unknown[] = [];
  const sockets: WebSocket[] = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (raw) => {
      try {
        received.push(JSON.parse(raw.toString()));
      } catch {
        received.push(raw.toString());
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

describe('auth', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers a BYOK key and never needs the access code', () => {
    vi.stubEnv('ACCESS_CODE', 'ielts2026');
    const resolved = resolveCredential({ provider: 'qwen', apiKey: 'sk-user' });
    expect(resolved).toEqual({ apiKey: 'sk-user', source: 'byok' });
  });

  it('falls back to the server key only with the right access code', () => {
    vi.stubEnv('ACCESS_CODE', 'ielts2026');
    vi.stubEnv('DASHSCOPE_API_KEY', 'sk-server');
    expect(verifyAccessCode('wrong')).toBe(false);
    expect(resolveCredential({ provider: 'qwen', accessCode: 'ielts2026' })).toEqual({
      apiKey: 'sk-server',
      source: 'server',
    });
    expect(() => resolveCredential({ provider: 'qwen', accessCode: 'wrong' })).toThrow(AuthError);
  });

  it('reports which server providers exist without leaking keys', () => {
    vi.stubEnv('GEMINI_API_KEY', 'sk-secret-gemini');
    const providers = serverProviders();
    expect(providers.gemini).toBe(true);
    expect(JSON.stringify(providers)).not.toContain('sk-secret-gemini');
  });
});

describe('audio helpers', () => {
  it('upsamples 16 kHz PCM16 to 24 kHz with 1.5x samples', () => {
    const input = Buffer.alloc(320 * 2);
    for (let i = 0; i < 320; i += 1) input.writeInt16LE(i, i * 2);
    const output = upsample16to24(input);
    expect(output.length).toBe(480 * 2);
    expect(output.readInt16LE(0)).toBe(0);
    expect(output.readInt16LE(478 * 2)).toBeGreaterThan(0);
  });
});

describe('qwen adapter mapping', () => {
  it('sends session.update with pcm16 and maps transcripts as replace', async () => {
    const upstream = await fakeUpstream();
    const events: ServerEvent[] = [];
    const adapter = new QwenAdapter();
    const handle = await adapter.start(
      {
        provider: 'qwen',
        model: 'qwen3-omni-flash-realtime',
        apiKey: 'test-key',
        systemPrompt: 'You are an examiner',
        turnMode: 'auto',
        endpointUrl: upstream.url,
      },
      { emit: (event) => events.push(event), audio: () => undefined, failed: () => undefined },
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const update = upstream.received.find((item) => (item as { type?: string }).type === 'session.update') as {
      session?: { input_audio_format?: string; instructions?: string };
    };
    expect(update?.session?.input_audio_format).toBe('pcm16');
    expect(update?.session?.instructions).toBe('You are an examiner');

    upstream.sockets[0].send(
      JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'u1', text: 'I live in', stash: ' Shanghai' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    const delta = events.find((event) => event.type === 'user_transcript_delta') as {
      text?: string;
      mode?: string;
    };
    expect(delta?.text).toBe('I live in Shanghai');
    expect(delta?.mode).toBe('replace');

    upstream.sockets[0].send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events.some((event) => event.type === 'user_speech_started')).toBe(true);

    handle.close();
    await upstream.close();
  });
});

describe('gemini adapter mapping', () => {
  it('uses AUDIO-only modalities and top-level transcription', async () => {
    const upstream = await fakeUpstream();
    const adapter = new GeminiAdapter();
    const handle = await adapter.start(
      {
        provider: 'gemini',
        model: 'gemini-2.5-flash-native-audio',
        apiKey: 'test-key',
        systemPrompt: 'You are an examiner',
        turnMode: 'manual',
        endpointUrl: upstream.url,
      },
      { emit: () => undefined, audio: () => undefined, failed: () => undefined },
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const frame = upstream.received[0] as {
      setup?: {
        generationConfig?: { responseModalities?: string[] };
        inputAudioTranscription?: unknown;
        outputAudioTranscription?: unknown;
      };
    };
    expect(frame.setup?.generationConfig?.responseModalities).toEqual(['AUDIO']);
    expect(frame.setup?.inputAudioTranscription).toBeDefined();
    expect(frame.setup?.outputAudioTranscription).toBeDefined();
    handle.close();
    await upstream.close();
  });
});

describe('openai adapter mapping', () => {
  it('upsamples audio before append and forwards speech_started', async () => {
    const upstream = await fakeUpstream();
    const events: ServerEvent[] = [];
    const adapter = new OpenAIAdapter();
    const handle = await adapter.start(
      {
        provider: 'openai',
        model: 'gpt-realtime',
        apiKey: 'test-key',
        systemPrompt: 'prompt',
        turnMode: 'auto',
        endpointUrl: upstream.url,
      },
      { emit: (event) => events.push(event), audio: () => undefined, failed: () => undefined },
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    handle.sendAudio(Buffer.alloc(320 * 2, 1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const append = upstream.received.find((item) => (item as { type?: string }).type === 'input_audio_buffer.append') as {
      audio?: string;
    };
    expect(append?.audio).toBeTruthy();
    const decoded = Buffer.from(String(append?.audio), 'base64');
    expect(decoded.length).toBe(480 * 2);

    upstream.sockets[0].send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events.some((event) => event.type === 'user_speech_started')).toBe(true);

    handle.close();
    await upstream.close();
  });
});
