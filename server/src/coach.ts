/** Async side-track: correction card + end-of-lesson report (never blocks audio). */

import {
  buildAnalyzeTurnPrompt,
  buildReportPrompt,
  normalizeFeedback,
  parseJsonLoose,
  type GrammarMistake,
  type LessonReport,
  type Provider,
  type TurnFeedback,
} from '@ielts/shared';
import { coachConfig } from './auth';

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

async function chatJson(
  provider: Provider,
  system: string,
  user: string,
  timeoutMs = 40000,
): Promise<Record<string, unknown> | null> {
  const cfg = coachConfig(provider);
  if (!cfg.apiKey) return null;
  const response = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ] satisfies ChatMessage[],
      temperature: 0.4,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('coach 模型返回 ' + response.status + ': ' + detail.slice(0, 200));
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content || '';
  return parseJsonLoose(text);
}

export async function analyzeTurn(input: {
  provider: Provider;
  part: string;
  examinerQuestion: string;
  learnerTranscript: string;
  targetBand: number;
  recentHistory?: Array<{ role: 'user' | 'examiner'; text: string }>;
}): Promise<TurnFeedback> {
  const prompt = buildAnalyzeTurnPrompt(input);
  const raw = await chatJson(input.provider, prompt.system, prompt.user);
  return normalizeFeedback(raw);
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(9, Math.round(parsed * 2) / 2));
}

export async function generateReport(input: {
  provider: Provider;
  partMode: string;
  targetBand: number;
  turns: Array<{ examinerQuestion: string; learnerTranscript: string }>;
  memory?: string[];
}): Promise<LessonReport> {
  const prompt = buildReportPrompt(input);
  const raw = (await chatJson(input.provider, prompt.system, prompt.user, 90000)) || {};
  const bandsRaw = (raw.bands && typeof raw.bands === 'object' ? raw.bands : {}) as Record<string, unknown>;
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
      kind: (String(item.kind || 'weakness') as 'weakness' | 'fact' | 'phrase'),
      title: String(item.title || '课堂记忆'),
      content: String(item.content || ''),
      createdAt: Date.now(),
    }));
  return {
    bands: {
      overall: asNumber(bandsRaw.overall, 6),
      fc: asNumber(bandsRaw.fc, 6),
      lr: asNumber(bandsRaw.lr, 6),
      gra: asNumber(bandsRaw.gra, 6),
      pr: asNumber(bandsRaw.pr, 6),
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
