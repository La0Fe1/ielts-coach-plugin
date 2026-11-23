/** Async side-track: correction card + end-of-lesson report. No fake results. */

import {
  buildAnalyzeTurnPrompt,
  buildReportPrompt,
  normalizeFeedback,
  parseJsonLoose,
  type GrammarMistake,
  type LessonReport,
  type TurnFeedback,
} from '@ielts/shared';
import type { CoachConfig } from './auth';

async function chatJson(
  config: CoachConfig,
  system: string,
  user: string,
  timeoutMs = 40000,
): Promise<Record<string, unknown>> {
  const response = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.4,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('精批模型返回 ' + response.status + ': ' + detail.slice(0, 200));
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content || '';
  const parsed = parseJsonLoose(text);
  if (!parsed) throw new Error('精批模型没有返回 JSON');
  return parsed;
}

export async function analyzeTurn(
  config: CoachConfig,
  input: {
    part: string;
    examinerQuestion: string;
    learnerTranscript: string;
    targetBand: number;
    recentHistory?: Array<{ role: 'user' | 'examiner'; text: string }>;
  },
): Promise<TurnFeedback> {
  const prompt = buildAnalyzeTurnPrompt(input);
  const raw = await chatJson(config, prompt.system, prompt.user);
  return normalizeFeedback(raw);
}

function asBand(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 9) return null;
  return Math.round(parsed * 2) / 2;
}

export async function generateReport(
  config: CoachConfig,
  input: {
    partMode: string;
    targetBand: number;
    turns: Array<{ examinerQuestion: string; learnerTranscript: string }>;
    memory?: string[];
  },
): Promise<LessonReport> {
  const prompt = buildReportPrompt(input);
  const raw = await chatJson(config, prompt.system, prompt.user, 90000);
  const bandsRaw = (raw.bands && typeof raw.bands === 'object' ? raw.bands : {}) as Record<string, unknown>;
  const bands = {
    overall: asBand(bandsRaw.overall),
    fc: asBand(bandsRaw.fc),
    lr: asBand(bandsRaw.lr),
    gra: asBand(bandsRaw.gra),
    pr: asBand(bandsRaw.pr),
  };
  if (Object.values(bands).some((value) => value === null)) {
    throw new Error('报告缺少有效的四维分数，请重试一次');
  }
  const mistakes: GrammarMistake[] = (Array.isArray(raw.top_mistakes) ? raw.top_mistakes : [])
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .slice(0, 3)
    .map((item) => ({
      original: String(item.original || ''),
      corrected: String(item.corrected || ''),
      category: String(item.category || 'other'),
      explanation_zh: String(item.explanation_zh || ''),
    }));
  const updates = (Array.isArray(raw.memory_updates) ? raw.memory_updates : [])
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .slice(0, 4)
    .map((item) => ({
      id: 'm-' + Math.random().toString(36).slice(2, 10),
      kind: String(item.kind || 'weakness') as 'weakness' | 'fact' | 'phrase',
      title: String(item.title || '课堂记忆'),
      content: String(item.content || ''),
      createdAt: Date.now(),
    }));
  return {
    bands: {
      overall: bands.overall as number,
      fc: bands.fc as number,
      lr: bands.lr as number,
      gra: bands.gra as number,
      pr: bands.pr as number,
    },
    summary_zh: String(raw.summary_zh || ''),
    top_mistakes: mistakes,
    upgraded_sentences: (Array.isArray(raw.upgraded_sentences) ? raw.upgraded_sentences : [])
      .map((item) => String(item))
      .filter(Boolean)
      .slice(0, 3),
    memory_updates: updates,
  };
}

/** Cheapest possible round-trip to prove the text model works. */
export async function pingCoach(config: CoachConfig): Promise<{ ok: boolean; latency_ms: number; message: string }> {
  const started = Date.now();
  const response = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: 'Reply with the single word: ok' },
        { role: 'user', content: 'ping' },
      ],
      max_tokens: 8,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const latency = Date.now() - started;
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return { ok: false, latency_ms: latency, message: '模型返回 ' + response.status + ': ' + detail.slice(0, 160) };
  }
  return { ok: true, latency_ms: latency, message: '连接正常' };
}
