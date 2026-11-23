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
  type DeepSeekTurnRequest,
  type Provider,
  type ReviewMode,
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
import { streamDeepSeekTurn, synthesizeSpeech } from './deepseek-voice';
import { allowMcpRequest, isLoopback, mcpToken } from './mcp-core';
import { mountMcp } from './mcp-http';
import {
  deleteMemory,
  getLesson,
  listLessons,
  listMemory,
  syncLesson,
  upsertLesson,
  upsertMemory,
} from './store';

const APP_VERSION = '2.2.2';
const PORT = Number(process.env.PORT || 3000);
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../../web/dist');

/** Default deployment is single-user local; MULTI_USER_MODE=true exposes it publicly. */
function isMultiUserMode(): boolean {
  return (process.env.MULTI_USER_MODE || '').toLowerCase() === 'true';
}

/** `?token=` fallback for sync clients that cannot set an Authorization header. */
function queryToken(req: express.Request): string | undefined {
  const value = req.query.token;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** `/health` and `/api/status` are the create_lesson probe; they never require auth. */
function serverStatus(): {
  ok: boolean;
  service: string;
  version: string;
  port: number;
  uptime: number;
  hasMcpToken: boolean;
  multiUserMode: boolean;
} {
  return {
    ok: true,
    service: 'ielts-coach-v2',
    version: APP_VERSION,
    port: PORT,
    uptime: process.uptime(),
    hasMcpToken: Boolean(mcpToken()),
    multiUserMode: isMultiUserMode(),
  };
}

/**
 * Real-time WebSocket providers. `deepseek` (v2.2.0 pure-voice mode) has no
 * upstream websocket at all: the browser records locally and calls
 * POST /api/voice/deepseek-turn, so a missing adapter here is expected.
 */
const ADAPTERS: Partial<Record<Provider, RealtimeAdapter>> = {
  qwen: new QwenAdapter(),
  gemini: new GeminiAdapter(),
  openai: new OpenAIAdapter(),
};

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json(serverStatus());
});

// Lightweight readiness/version probe used by the MCP create_lesson flow.
app.get('/api/status', (_req, res) => {
  res.json(serverStatus());
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
  reviewMode?: ReviewMode;
} {
  return {
    provider: (body.provider || 'qwen') as Provider,
    coachApiKey: body.coachApiKey ? String(body.coachApiKey) : undefined,
    coachBaseUrl: body.coachBaseUrl ? String(body.coachBaseUrl) : undefined,
    coachModel: body.coachModel ? String(body.coachModel) : undefined,
    apiKey: body.apiKey ? String(body.apiKey) : undefined,
    accessCode: body.accessCode ? String(body.accessCode) : undefined,
    reviewMode: body.reviewMode ? (String(body.reviewMode) as ReviewMode) : undefined,
  };
}

function coachError(res: express.Response, error: unknown): void {
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(502).json({ error: String((error as Error).message || error) });
}

/**
 * Validate POST /api/voice/deepseek-turn (v2.2.0 pure-voice mode).
 * Only the shape is enforced here; credentials are resolved separately so an
 * auth failure can still answer with a plain JSON 401 before any SSE starts.
 */
function deepSeekTurnInput(body: Record<string, unknown>): DeepSeekTurnRequest | null {
  if (typeof body.systemPrompt !== 'string') return null;
  if (!Array.isArray(body.messages)) return null;
  const messages: DeepSeekTurnRequest['messages'] = [];
  for (const raw of body.messages) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
    if (!role) continue;
    const text =
      typeof item.text === 'string' ? item.text : typeof item.content === 'string' ? item.content : '';
    if (!text.trim()) continue;
    messages.push({ role, text });
  }
  return {
    systemPrompt: body.systemPrompt,
    messages,
    model: typeof body.model === 'string' ? body.model : undefined,
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
    accessCode: typeof body.accessCode === 'string' ? body.accessCode : undefined,
    endpointUrl: typeof body.endpointUrl === 'string' ? body.endpointUrl : undefined,
    maxTokens:
      typeof body.maxTokens === 'number' && Number.isFinite(body.maxTokens) ? body.maxTokens : undefined,
  };
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

/**
 * Store-sync privacy rules (v2.1.0). The JSON store is a single shared file, so
 * when the gateway is exposed publicly (MULTI_USER_MODE=true) we must not leak
 * one learner's data to another:
 *
 * - Local mode (MULTI_USER_MODE unset, the default): every sync route keeps
 *   working exactly as before; the store belongs to this one machine/user.
 * - Public mode: loopback clients and clients carrying a valid MCP_TOKEN /
 *   ACCESS_CODE (`Authorization: Bearer <token>` or `?token=<token>`) may sync
 *   everything.
 * - Public mode without a token: generic listings are denied (401) because
 *   GET /api/lessons and every /api/memory* endpoint expose other learners'
 *   data. A single lesson may still be touched through its unguessable id —
 *   the `/?lesson=<id>` deep link acts as a capability token: GET
 *   /api/lessons/:id, POST /api/lessons/:id/sync, and POST /api/lessons when the
 *   body carries that explicit id. No arbitrary listing or memory access.
 * - /health and /api/status never require auth (create_lesson probes them).
 */
export type SyncScope = 'global' | 'lesson';

export interface SyncRequestInfo {
  remoteAddress?: string;
  authorization?: string;
  token?: string;
}

export function syncAccessAllowed(info: SyncRequestInfo, scope: SyncScope): boolean {
  if (!isMultiUserMode()) return true;
  if (isLoopback(info.remoteAddress)) return true;
  if (allowMcpRequest(info.remoteAddress, info.authorization, info.token)) return true;
  // Tokenless public visitor: may only address one specific unguessable lesson.
  return scope === 'lesson';
}

function syncGuard(req: express.Request, res: express.Response, scope: SyncScope = 'global'): boolean {
  const allowed = syncAccessAllowed(
    {
      remoteAddress: req.socket.remoteAddress,
      authorization: req.headers.authorization,
      token: queryToken(req),
    },
    scope,
  );
  if (allowed) return true;
  res.status(401).json({
    error: '多用户模式：课程列表与长期记忆需要 MCP Token / 访问口令；单节课程可凭 ?lesson=<id> 链接按 id 访问',
  });
  return false;
}

app.get('/api/lessons', (req, res) => {
  if (!syncGuard(req, res)) return;
  const limit = Number(req.query.limit || 20);
  res.json({ lessons: listLessons(Number.isFinite(limit) ? limit : 20) });
});

app.get('/api/lessons/:id', (req, res) => {
  if (!syncGuard(req, res, 'lesson')) return;
  const lesson = getLesson(String(req.params.id));
  if (!lesson) {
    res.status(404).json({ error: '课程不存在' });
    return;
  }
  res.json({ lesson });
});

app.post('/api/lessons', (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  if (!body.id) {
    res.status(400).json({ error: '缺少课程 id' });
    return;
  }
  // The explicit body id is the capability: a tokenless public client may create
  // or update only that one lesson, never list the store.
  if (!syncGuard(req, res, 'lesson')) return;
  res.json({ lesson: upsertLesson(body as never) });
});

app.post('/api/lessons/:id/sync', (req, res) => {
  if (!syncGuard(req, res, 'lesson')) return;
  const body = (req.body || {}) as Record<string, unknown>;
  res.json({ lesson: syncLesson({ ...body, id: String(req.params.id) } as never) });
});

app.get('/api/memory', (req, res) => {
  if (!syncGuard(req, res)) return;
  res.json({ memory: listMemory() });
});

app.post('/api/memory', (req, res) => {
  if (!syncGuard(req, res)) return;
  const body = (req.body || {}) as { items?: unknown[]; memory?: unknown[] };
  const items = Array.isArray(body.items) ? body.items : Array.isArray(body.memory) ? body.memory : [];
  res.json({ memory: upsertMemory(items as never) });
});

app.delete('/api/memory/:id', (req, res) => {
  if (!syncGuard(req, res)) return;
  res.json({ removed: deleteMemory([String(req.params.id)]) });
});

/**
 * v2.2.0 DeepSeek pure-voice mode. Registered before express.static / app.get('*')
 * so these API routes always win over the SPA fallback.
 *
 * - POST /api/voice/deepseek-turn : SSE stream of one examiner turn
 *   (same BYOK / ACCESS_CODE rules as every other provider).
 * - POST /api/voice/tts : Edge Neural TTS MP3. No key of its own; on failure the
 *   browser falls back to window.speechSynthesis (503 lets it detect that).
 */
app.post('/api/voice/deepseek-turn', async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const input = deepSeekTurnInput(body);
  if (!input) {
    res.status(400).json({ error: '请求格式不正确：需要 systemPrompt 字符串与 messages 数组' });
    return;
  }
  let apiKey = '';
  try {
    apiKey = resolveCredential({
      provider: 'deepseek',
      apiKey: input.apiKey,
      accessCode: input.accessCode,
    }).apiKey;
  } catch (error) {
    coachError(res, error);
    return;
  }
  try {
    await streamDeepSeekTurn({ ...input, apiKey }, req, res);
  } catch (error) {
    // streamDeepSeekTurn reports its own failures as SSE `error` frames; this
    // only catches truly unexpected wiring errors.
    if (!res.headersSent) coachError(res, error);
    else if (!res.writableEnded) res.end();
  }
});

app.post('/api/voice/tts', async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
  if (!text) {
    res.status(400).json({ error: '缺少要朗读的文本' });
    return;
  }
  const accent: 'uk' | 'us' = body.accent === 'us' ? 'us' : 'uk';
  const voice = typeof body.voice === 'string' ? body.voice.trim() : '';
  try {
    const audio = voice ? await synthesizeSpeech(text, accent, voice) : await synthesizeSpeech(text, accent);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(audio.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(audio);
  } catch (error) {
    console.error('[ielts-v2] Edge TTS 失败: ' + String((error as Error).message || error));
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(503).json({ error: 'TTS 暂不可用，请使用浏览器朗读' });
  }
});

mountMcp(app);

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
      try {
        const provider = event.provider;
        const adapter = ADAPTERS[provider];
        if (!adapter) {
          fail('不支持的实时语音服务商', false);
          return;
        }
        // Adapters exist only for qwen / gemini / openai (deepseek is HTTP SSE).
        const realtimeProvider = provider as StartSettings['provider'];
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
          provider: realtimeProvider,
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
        }
      } finally {
        // Reset on every path (missing adapter, auth failure, upstream failure):
        // a stuck `starting` flag would silently swallow all later start_session
        // frames and leave the socket dead until reconnect.
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
