/** Gateway: static web app, HTTP coach API, and the /ws/realtime bridge. */

import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  isClientEvent,
  type ClientEvent,
  type Provider,
  type ServerEvent,
} from '@ielts/shared';
import { GeminiAdapter } from './adapters/gemini';
import { OpenAIAdapter } from './adapters/openai';
import { QwenAdapter } from './adapters/qwen';
import type { AdapterHandle, RealtimeAdapter, StartSettings } from './adapters/base';
import {
  AuthError,
  accessCodeRequired,
  resolveCoachConfig,
  resolveCredential,
  serverProviders,
} from './auth';
import { analyzeTurn, generateReport, pingCoach } from './coach';

const PORT = Number(process.env.PORT || 3000);
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../../web/dist');

const ADAPTERS: Record<Provider, RealtimeAdapter> = {
  qwen: new QwenAdapter(),
  gemini: new GeminiAdapter(),
  openai: new OpenAIAdapter(),
};

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ielts-coach-v2', version: '2.0.1', uptime: process.uptime() });
});

app.get('/api/config/public', (_req, res) => {
  res.json({ hasAccessCode: accessCodeRequired(), serverProviders: serverProviders() });
});

function coachInput(body: Record<string, unknown>): {
  provider: Provider;
  coachApiKey?: string;
  coachBaseUrl?: string;
  coachModel?: string;
  apiKey?: string;
  accessCode?: string;
} {
  return {
    provider: (body.provider || 'qwen') as Provider,
    coachApiKey: body.coachApiKey ? String(body.coachApiKey) : undefined,
    coachBaseUrl: body.coachBaseUrl ? String(body.coachBaseUrl) : undefined,
    coachModel: body.coachModel ? String(body.coachModel) : undefined,
    apiKey: body.apiKey ? String(body.apiKey) : undefined,
    accessCode: body.accessCode ? String(body.accessCode) : undefined,
  };
}

function coachError(res: express.Response, error: unknown): void {
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(502).json({ error: String((error as Error).message || error) });
}

app.post('/api/coach/analyze-turn', async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  if (!body.learnerTranscript || String(body.learnerTranscript).trim().length < 3) {
    res.json({ feedback: null, skipped: 'too_short' });
    return;
  }
  try {
    const config = resolveCoachConfig(coachInput(body));
    const feedback = await analyzeTurn(config, {
      part: String(body.part || 'part1'),
      examinerQuestion: String(body.examinerQuestion || ''),
      learnerTranscript: String(body.learnerTranscript),
      targetBand: Number(body.targetBand || 7),
      recentHistory: Array.isArray(body.recentHistory) ? body.recentHistory : [],
    });
    res.json({ feedback });
  } catch (error) {
    coachError(res, error);
  }
});

app.post('/api/coach/report', async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    const config = resolveCoachConfig(coachInput(body));
    const report = await generateReport(config, {
      partMode: String(body.partMode || 'part1'),
      targetBand: Number(body.targetBand || 7),
      turns: Array.isArray(body.turns) ? body.turns : [],
      memory: Array.isArray(body.memory) ? body.memory : [],
    });
    res.json({ report });
  } catch (error) {
    coachError(res, error);
  }
});

app.post('/api/coach/test', async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    const config = resolveCoachConfig(coachInput(body));
    const result = await pingCoach(config);
    res.status(result.ok ? 200 : 502).json({ ...result, model: config.model });
  } catch (error) {
    coachError(res, error);
  }
});

app.use(express.static(webDist, { index: 'index.html' }));
app.get('*', (_req, res) => {
  res.sendFile(path.join(webDist, 'index.html'), (error) => {
    if (error) res.status(404).json({ error: 'web build missing: run npm run build' });
  });
});

export function createGateway(): { app: express.Express; server: http.Server; wss: WebSocketServer } {
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (url.pathname !== '/ws/realtime') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

function sendJson(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
}

wss.on('connection', (ws: WebSocket) => {
  let handle: AdapterHandle | null = null;
  let starting = false;
  // Control frames that arrived while the upstream handshake was still running.
  const pendingControls: ClientEvent[] = [];

  const fail = (message: string, retryable = true): void => {
    sendJson(ws, { type: 'error', code: 'upstream', message, retryable });
  };

  const applyControl = (event: ClientEvent): void => {
    if (!handle) return;
    if (event.type === 'update_turn_mode') handle.setTurnMode(event.turnMode === 'manual' ? 'manual' : 'auto');
    else if (event.type === 'commit_turn') handle.commit();
    else if (event.type === 'interrupt') handle.interrupt();
    else if (event.type === 'trigger_greeting') handle.greet(event.text);
    else if (event.type === 'end_session') {
      handle.close();
      handle = null;
    }
  };

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) {
      if (!handle) return;
      handle.sendAudio(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      fail('消息不是合法 JSON', false);
      return;
    }
    if (!isClientEvent(parsed)) {
      fail('未知的控制帧', false);
      return;
    }
    const event = parsed as ClientEvent;

    if (event.type === 'start_session') {
      if (handle || starting) return;
      starting = true;
      const provider = event.provider;
      const adapter = ADAPTERS[provider];
      if (!adapter) {
        fail('不支持的实时语音服务商', false);
        return;
      }
      let apiKey = '';
      try {
        apiKey = resolveCredential({
          provider,
          apiKey: event.apiKey,
          accessCode: event.accessCode,
        }).apiKey;
      } catch (error) {
        const authError = error as AuthError;
        sendJson(ws, {
          type: 'error',
          code: authError.code || 'auth_failed',
          message: authError.message || '鉴权失败',
          retryable: false,
        });
        return;
      }
      const settings: StartSettings = {
        provider,
        model: event.model,
        voice: event.voice,
        endpointUrl: event.endpointUrl,
        workspaceId: event.workspaceId,
        apiKey,
        systemPrompt: event.systemPrompt,
        turnMode: event.turnMode === 'manual' ? 'manual' : 'auto',
      };
      try {
        handle = await adapter.start(settings, {
          emit: (payload) => sendJson(ws, payload),
          audio: (pcm, rate) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(pcm);
            void rate;
          },
          failed: (message, retryable) => fail(message, retryable),
        });
        // Replay anything the browser sent during the handshake (usually the
        // opening greeting, which used to be dropped on slow networks).
        while (pendingControls.length > 0) {
          const queued = pendingControls.shift();
          if (queued) applyControl(queued);
        }
      } catch (error) {
        fail('连接实时语音失败: ' + String((error as Error).message || error));
      } finally {
        starting = false;
      }
      return;
    }

    if (!handle) {
      if (starting) {
        pendingControls.push(event);
        return;
      }
      fail('还没有建立实时会话', false);
      return;
    }
    applyControl(event);
  });

  ws.on('close', () => {
    handle?.close();
    handle = null;
  });
  ws.on('error', () => {
    handle?.close();
    handle = null;
  });
  });

  return { app, server, wss };
}

const isDirectRun = (() => {
  const entry = process.argv[1] || '';
  return entry.endsWith('index.ts') || entry.endsWith('index.js');
})();

if (isDirectRun) {
  const { server } = createGateway();
  server.listen(PORT, () => {
    const providers = serverProviders();
    const enabled = Object.entries(providers)
      .filter(([, on]) => on)
      .map(([name]) => name)
      .join(', ') || 'none (BYOK only)';
    console.log('[ielts-v2] listening on http://localhost:' + PORT);
    console.log('[ielts-v2] server-side keys: ' + enabled);
    if (accessCodeRequired()) console.log('[ielts-v2] ACCESS_CODE 已启用');
  });
}
