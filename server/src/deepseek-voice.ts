/** DeepSeek pure-voice mode (v2.2.0): streamed text turns + free Edge Neural TTS.
 *
 * The browser does the listening (SpeechRecognition), this module does the two
 * server-side pieces that need a secret or a third-party service:
 *
 * - `streamDeepSeekTurn`  : relays DeepSeek's OpenAI-compatible chat stream to the
 *   browser as our own tiny SSE protocol (`delta` / `done` / `error`).
 * - `synthesizeSpeech`    : cleans Markdown from the examiner reply and renders it
 *   to MP3 with Microsoft Edge Neural TTS (`@andresaya/edge-tts`, no API key).
 *
 * Rules for this module: never log API keys, never write to stdout (diagnostics
 * belong to the route), and every network call must be abortable by the client.
 */

import type { Request, Response } from 'express';
import type { DeepSeekTurnRequest, DeepSeekVoiceEvent } from '@ielts/shared';
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL } from './auth';

/** Default upstream for the pure-voice mode (BYOK / shared host key). */
export const DEEPSEEK_CHAT_URL = DEEPSEEK_BASE_URL + '/chat/completions';

const TEMPERATURE = 0.65;
const DEFAULT_MAX_TOKENS = 260;
/** Edge TTS is per-request happy; the browser already splits long replies. */
const TTS_MAX_CHARS = 600;
const TTS_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Upstream request helpers
// ---------------------------------------------------------------------------

/**
 * Accept either a full `/chat/completions` URL (custom relay configured by the
 * learner) or a base URL such as `https://api.deepseek.com/v1`, appending the
 * documented path only when it is missing.
 */
export function resolveChatCompletionsUrl(endpointUrl?: string): string {
  const raw = (endpointUrl || '').trim();
  if (!raw) return DEEPSEEK_CHAT_URL;
  try {
    const url = new URL(raw);
    let pathname = url.pathname.replace(/\/+$/, '');
    if (!/\/chat\/completions$/i.test(pathname)) pathname = pathname + '/chat/completions';
    return url.origin + pathname + url.search;
  } catch {
    // Not an absolute URL: best effort, fetch will surface a clear error.
    return raw.replace(/\/+$/, '') + '/chat/completions';
  }
}

function buildMessages(input: DeepSeekTurnRequest): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: input.systemPrompt || '' },
  ];
  for (const message of input.messages || []) {
    const content = typeof message?.text === 'string' ? message.text : '';
    if (!content.trim()) continue;
    messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content });
  }
  return messages;
}

function maxTokensOf(input: DeepSeekTurnRequest): number {
  const value = input.maxTokens;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_TOKENS;
  return Math.floor(value);
}

function parseDataLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return null;
  return trimmed.slice(5).trim();
}

function extractDelta(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as { delta?: { content?: unknown } } | null;
  const content = first?.delta?.content;
  return typeof content === 'string' ? content : '';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '未知错误');
}

// ---------------------------------------------------------------------------
// SSE response helpers
// ---------------------------------------------------------------------------

function openEventStream(res: Response): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/** Write one protocol frame; returns false when the client is already gone. */
function sendEvent(res: Response, event: DeepSeekVoiceEvent): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write('data: ' + JSON.stringify(event) + '\n\n');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Streaming turn
// ---------------------------------------------------------------------------

/**
 * Stream one examiner turn from DeepSeek to the browser.
 *
 * `input.apiKey` must already be resolved by the caller (`resolveCredential`),
 * so an auth failure can still be answered with a normal JSON 401 before any
 * streaming starts. Upstream/network failures are reported as an `error` frame
 * because the SSE headers are sent before the upstream round-trip.
 */
export async function streamDeepSeekTurn(
  input: DeepSeekTurnRequest & { signal?: AbortSignal },
  req: Request,
  res: Response,
): Promise<void> {
  const apiKey = (input.apiKey || '').trim();
  if (!apiKey) {
    if (!res.headersSent) {
      res.status(401).json({ error: '缺少 DeepSeek API Key', code: 'no_credentials' });
    } else if (!res.writableEnded) {
      res.end();
    }
    return;
  }

  const upstreamUrl = resolveChatCompletionsUrl(input.endpointUrl);
  const payload = {
    model: (input.model || '').trim() || DEEPSEEK_MODEL,
    messages: buildMessages(input),
    stream: true,
    temperature: TEMPERATURE,
    max_tokens: maxTokensOf(input),
  };

  const controller = new AbortController();
  let clientGone = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const abortUpstream = (): void => {
    clientGone = true;
    try {
      controller.abort();
    } catch {
      /* already aborted */
    }
  };
  // `res` closes when the browser navigates away / aborts the fetch (and
  // harmlessly after res.end()). Node also emits 'close' on a server request as
  // soon as its body is fully read — which is immediate here because
  // express.json() already consumed it — so only a body-incomplete request
  // close is a real client disconnect.
  const onRequestClose = (): void => {
    if (!req.complete) abortUpstream();
  };
  req.on('close', onRequestClose);
  res.on('close', abortUpstream);
  const forwardAbort = (): void => {
    try {
      controller.abort();
    } catch {
      /* already aborted */
    }
  };
  if (input.signal) {
    if (input.signal.aborted) forwardAbort();
    else input.signal.addEventListener('abort', forwardAbort, { once: true });
  }

  openEventStream(res);

  let fullText = '';
  let finished = false;

  try {
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const hint = detail.replace(/\s+/g, ' ').trim().slice(0, 200);
      throw new Error('DeepSeek 返回 ' + response.status + (hint ? '：' + hint : ''));
    }
    if (!response.body) throw new Error('DeepSeek 没有返回可读的数据流');

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!finished && !clientGone) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        const data = parseDataLine(line);
        if (data !== null) {
          if (data === '[DONE]') {
            finished = true;
            break;
          }
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = null;
          }
          const delta = extractDelta(parsed);
          if (delta) {
            fullText += delta;
            if (!sendEvent(res, { type: 'delta', delta })) {
              abortUpstream();
              break;
            }
          }
        }
        newline = buffer.indexOf('\n');
      }
    }

    // A final `data:` line may arrive without a trailing newline.
    if (!finished && !clientGone) {
      const data = parseDataLine(buffer.replace(/\r$/, ''));
      if (data !== null && data !== '[DONE]') {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = null;
        }
        const delta = extractDelta(parsed);
        if (delta) {
          fullText += delta;
          if (!sendEvent(res, { type: 'delta', delta })) abortUpstream();
        }
      }
    }

    if (!clientGone) {
      sendEvent(res, { type: 'done', text: fullText });
    }
  } catch (error) {
    if (!clientGone) {
      sendEvent(res, { type: 'error', message: 'DeepSeek 连接失败：' + errorMessage(error) });
    }
  } finally {
    req.off('close', onRequestClose);
    res.off('close', abortUpstream);
    if (input.signal) input.signal.removeEventListener('abort', forwardAbort);
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* client already gone */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Text preparation
// ---------------------------------------------------------------------------

const SENTENCE_END = /[.!?。！？]/;

/** Cut to a TTS-friendly length without splitting a sentence in the middle. */
function limitForTts(text: string, max = TTS_MAX_CHARS): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  let cut = -1;
  for (let i = slice.length - 1; i > 0; i -= 1) {
    if (SENTENCE_END.test(slice[i])) {
      cut = i + 1;
      break;
    }
  }
  if (cut >= max * 0.4) return slice.slice(0, cut).trim();
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim();
}

/**
 * Strip Markdown / HTML so the neural voice never reads `**`, `#` or a URL out
 * loud, then collapse whitespace and keep whole sentences (<= ~600 chars).
 */
export function cleanTextForTts(text: string): string {
  let value = String(text || '');
  value = value.replace(/```[\s\S]*?```/g, ' ');            // fenced code blocks
  value = value.replace(/`([^`]*)`/g, '$1');                // inline code
  value = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');   // images -> alt text
  value = value.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');    // links -> anchor text
  value = value.replace(/<[^>]*>/g, ' ');                   // HTML tags
  value = value.replace(/^[ \t]*#{1,6}[ \t]*/gm, '');       // ATX headings
  value = value.replace(/^[ \t]*>+[ \t]?/gm, '');           // block quotes
  value = value.replace(/^[ \t]*[-*+][ \t]+/gm, '');        // bullet lists
  value = value.replace(/^[ \t]*\d+[.)][ \t]+/gm, '');      // ordered lists
  value = value.replace(/^[ \t]*[-=]{3,}[ \t]*$/gm, ' ');   // horizontal rules
  value = value.replace(/[*_~]{1,3}/g, '');                 // emphasis markers
  value = value.replace(/\|/g, ' ');                        // table pipes
  value = value.replace(/\s+/g, ' ').trim();
  return limitForTts(value);
}

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/** Chinese share of the text (ignoring whitespace); > 15% switches voice. */
function cjkRatio(text: string): number {
  const visible = text.replace(/\s+/g, '');
  if (!visible) return 0;
  const matches = visible.match(CJK_PATTERN);
  return (matches ? matches.length : 0) / visible.length;
}

/** Pick the Edge Neural voice: Chinese text always wins, else the chosen accent. */
export function pickEdgeVoice(text: string, accent: 'uk' | 'us'): string {
  if (cjkRatio(String(text || '')) > 0.15) return 'zh-CN-XiaoxiaoNeural';
  return accent === 'us' ? 'en-US-JennyNeural' : 'en-GB-SoniaNeural';
}

// ---------------------------------------------------------------------------
// Edge Neural TTS
// ---------------------------------------------------------------------------

type EdgeTtsModule = typeof import('@andresaya/edge-tts');

let edgeTtsModule: Promise<EdgeTtsModule> | null = null;

/** Lazy ESM import of the CJS package (kept out of the hot path and tests). */
function loadEdgeTts(): Promise<EdgeTtsModule> {
  if (!edgeTtsModule) edgeTtsModule = import('@andresaya/edge-tts');
  return edgeTtsModule;
}

/**
 * v2.2.3 resilience: Microsoft Edge throttles bursts of syntheses with HTTP 429
 * ("Unexpected server response: 429") and the learner then heard nothing.
 *
 * - A tiny LRU cache makes repeated examiner lines free.
 * - All syntheses are serialized through one chain so the browser's sentence
 *   pipeline can never fire a burst of parallel requests.
 * - 429/rate-limit failures are retried with backoff before we give up and let
 *   the route answer 503 (the browser then falls back to speechSynthesis).
 */
const TTS_CACHE_LIMIT = 128;
const ttsCache = new Map<string, Buffer>();
let ttsChain: Promise<unknown> = Promise.resolve();

function cacheGet(key: string): Buffer | undefined {
  return ttsCache.get(key);
}

function cachePut(key: string, audio: Buffer): void {
  if (ttsCache.size >= TTS_CACHE_LIMIT) {
    const oldest = ttsCache.keys().next().value;
    if (oldest !== undefined) ttsCache.delete(oldest);
  }
  ttsCache.set(key, audio);
}

function enqueueTts<T>(job: () => Promise<T>): Promise<T> {
  const run = ttsChain.then(job, job);
  ttsChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isThrottled(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '');
  return /429|too many|rate.?limit|forbidden|throttl/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateEdgeAudio(cleaned: string, voice: string): Promise<Buffer> {
  const { EdgeTTS, Constants } = await loadEdgeTts();
  const engine = new EdgeTTS({ timeout: TTS_TIMEOUT_MS });
  const result = await engine.generate(cleaned, voice, {
    rate: '0%',
    pitch: '+0Hz',
    outputFormat: Constants.OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3,
  });
  const audio = result.audio;
  if (!audio || audio.length === 0) throw new Error('Edge TTS 没有返回音频');
  return Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
}

/**
 * Render text to MP3 with Microsoft Edge Neural TTS.
 *
 * Serialized + cached + retried on throttling; throws only after the retries so
 * the route can answer 503 and the browser can fall back to speechSynthesis.
 */
export async function synthesizeSpeech(text: string, accent: 'uk' | 'us', voiceOverride?: string): Promise<Buffer> {
  const cleaned = cleanTextForTts(text);
  if (!cleaned) throw new Error('没有可朗读的文本');
  const override = (voiceOverride || '').trim();
  const voice = override || pickEdgeVoice(cleaned, accent);
  const cacheKey = voice + '|' + cleaned;

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const audio = await enqueueTts(async () => {
    const again = cacheGet(cacheKey);
    if (again) return again;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await generateEdgeAudio(cleaned, voice);
      } catch (error) {
        lastError = error;
        if (!isThrottled(error) || attempt === 2) throw error;
        await sleep(700 * (attempt + 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Edge TTS 失败'));
  });

  cachePut(cacheKey, audio);
  return audio;
}
