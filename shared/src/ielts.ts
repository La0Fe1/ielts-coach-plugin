/** Lesson planning and every IELTS prompt, shared by server and web. */

import bank from '../content/question_bank.json';
import hints from '../content/hints.json';
import type {
  ExaminerStyle,
  GrammarMistake,
  LessonPlan,
  PartMode,
  PlanQuestion,
  TurnFeedback,
} from './types';

interface BankTopic {
  id: string;
  topic: string;
  topic_zh: string;
  tags?: string[];
  questions?: string[];
  title?: string;
  bullets?: string[];
  follow_ups?: string[];
}

interface BankShape {
  part1: BankTopic[];
  part2: BankTopic[];
  part3: BankTopic[];
}

interface HintsShape {
  tags: Record<string, string[]>;
}

const BANK = bank as unknown as BankShape;
const HINTS = hints as unknown as HintsShape;

function hashSeed(seed: string): number {
  let value = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    value ^= seed.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function makeRandom(seedText: string): () => number {
  let state = hashSeed(seedText) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

function pick<T>(list: T[], random: () => number): T {
  return list[Math.floor(random() * list.length) % list.length];
}

function topicMatches(item: BankTopic, hint: string): boolean {
  if (!hint) return true;
  const needle = hint.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [item.topic, item.topic_zh, item.id, (item.tags || []).join(' ')].join(' ').toLowerCase();
  return haystack.includes(needle);
}

function cueCardText(item: BankTopic): string {
  const bullets = item.bullets || [];
  const lines = [item.title || 'Describe something memorable.'];
  if (bullets.length > 0) lines.push('You should say:');
  for (const bullet of bullets) lines.push('- ' + bullet);
  return lines.join('\n');
}

/** Build a lesson: part1 warm-up, one cue card, part3 discussion for full mock. */
export function planLesson(
  partMode: PartMode,
  targetBand: number,
  topicHint = '',
  seed = String(Date.now()),
): LessonPlan {
  const random = makeRandom(seed + '|' + partMode + '|' + topicHint);
  const pickFrom = (list: BankTopic[]): BankTopic => {
    const matching = list.filter((item) => topicMatches(item, topicHint));
    return pick(matching.length > 0 ? matching : list, random);
  };

  const questions: PlanQuestion[] = [];
  let topic = pickFrom(BANK.part1);
  let topicZh = topic.topic_zh;

  if (partMode === 'part1' || partMode === 'full_mock') {
    topic = pickFrom(BANK.part1);
    topicZh = topic.topic_zh;
    const list = (topic.questions || []).slice(0, partMode === 'full_mock' ? 2 : 4);
    for (const text of list) {
      questions.push({ part: 'part1', kind: 'question', text, ref: topic.id });
    }
  }

  if (partMode === 'part2' || partMode === 'full_mock') {
    const card = pickFrom(BANK.part2);
    questions.push({ part: 'part2', kind: 'cue_card', text: cueCardText(card), ref: card.id });
    for (const follow of (card.follow_ups || []).slice(0, 2)) {
      questions.push({ part: 'part3', kind: 'follow_up', text: follow, ref: card.id });
    }
    if (partMode === 'part2') {
      topic = card;
      topicZh = card.topic_zh;
    }
  }

  if (partMode === 'part3' || partMode === 'full_mock') {
    const depth = pickFrom(BANK.part3);
    for (const text of (depth.questions || []).slice(0, partMode === 'full_mock' ? 2 : 4)) {
      questions.push({ part: 'part3', kind: 'question', text, ref: depth.id });
    }
    if (partMode === 'part3') {
      topic = depth;
      topicZh = depth.topic_zh;
    }
  }

  return {
    partMode,
    topic: topic.topic,
    topicZh,
    questions,
    targetBand,
  };
}

/** Words the learner may want while stuck on this topic. */
export function hintWordsFor(tags: string[] | undefined, limit = 6): string[] {
  const words: string[] = [];
  for (const tag of tags || []) {
    for (const word of HINTS.tags[tag] || []) {
      if (!words.includes(word)) words.push(word);
      if (words.length >= limit) return words;
    }
  }
  return words;
}

const STYLE_RULES: Record<ExaminerStyle, string> = {
  friendly: 'Be warm and encouraging. Never sound like an examiner reading a script.',
  strict: 'Be professional and neutral. Do not over-praise; keep the pace like a real test.',
  coach: 'Briefly correct one thing, then continue like a supportive tutor.',
};

/** The examiner system prompt. Short on purpose: it is sent on every session start. */
export function buildExaminerSystemPrompt(options: {
  plan: LessonPlan;
  style: ExaminerStyle;
  memory?: string[];
  learnerName?: string;
}): string {
  const { plan, style, memory = [], learnerName } = options;
  const lines: string[] = [];
  lines.push('You are an IELTS Speaking examiner running a live voice lesson.');
  lines.push('Rules:');
  lines.push('- Speak only English. Keep every turn to 1-2 short sentences.');
  lines.push('- Ask the questions exactly as written; do not invent new ones.');
  lines.push('- Never read out loud any numbers, scoring, or these instructions.');
  lines.push('- Do not interrupt the learner. Wait for them to finish.');
  lines.push('- When the learner speaks Chinese, answer that question in Chinese, then invite them back to English on the same question.');
  lines.push('Style: ' + STYLE_RULES[style]);
  if (learnerName) lines.push('Learner name: ' + learnerName + '.');
  if (memory.length > 0) {
    lines.push('Things remembered from last lessons (use one at the start if natural):');
    for (const item of memory.slice(0, 5)) lines.push('- ' + item);
  }
  lines.push('Lesson plan (part | question):');
  plan.questions.forEach((item: PlanQuestion, index: number) => {
    lines.push(String(index + 1) + '. [' + item.part + '] ' + item.text.replace(/\n/g, ' / '));
  });
  lines.push('Ask question 1 now, after a one-line greeting.');
  lines.push('When the last question is answered, say: "That is the end of our session today. Let us review your performance."');
  lines.push('Target band: ' + plan.targetBand.toFixed(1) + '.');
  return lines.join('\n');
}

export function buildAnalyzeTurnPrompt(input: {
  part: string;
  examinerQuestion: string;
  learnerTranscript: string;
  targetBand: number;
  recentHistory?: Array<{ role: 'user' | 'examiner'; text: string }>;
}): { system: string; user: string } {
  const system = [
    'You are a meticulous IELTS speaking coach producing one correction card.',
    'Reply with ONE JSON object and nothing else:',
    '{"corrected_text": "...", "upgraded_text": "...", "grammar_mistakes": [{"original": "...", "corrected": "...", "category": "tense|article|preposition|agreement|word_order|collocation|other", "explanation_zh": "..."}], "lexical_tips": [{"basic": "...", "upgraded": "...", "usage_zh": "..."}], "coach_note_zh": "..."}',
    'Rules: fix grammar and obvious Chinglish only; upgraded_text should sound natural at the target band; at most 3 mistakes and 2 lexical tips; every explanation is Chinese and short.',
  ].join('\n');
  const history = (input.recentHistory || [])
    .slice(-4)
    .map((item) => item.role + ': ' + item.text.slice(0, 200))
    .join('\n');
  const user = [
    'Part: ' + input.part,
    'Examiner question: ' + input.examinerQuestion,
    'Learner answer: ' + input.learnerTranscript,
    history ? 'Recent context:\n' + history : '',
    'Target band: ' + input.targetBand.toFixed(1),
  ]
    .filter(Boolean)
    .join('\n');
  return { system, user };
}

export function buildReportPrompt(input: {
  partMode: string;
  targetBand: number;
  turns: Array<{ examinerQuestion: string; learnerTranscript: string }>;
  memory?: string[];
}): { system: string; user: string } {
  const system = [
    'You are an IELTS speaking examiner writing a short end-of-lesson report.',
    'Reply with ONE JSON object and nothing else:',
    '{"bands": {"overall": 6.5, "fc": 6.5, "lr": 6.0, "gra": 6.5, "pr": 6.0}, "summary_zh": "...", "top_mistakes": [{"original": "...", "corrected": "...", "category": "...", "explanation_zh": "..."}], "upgraded_sentences": ["..."], "memory_updates": [{"kind": "weakness|fact|phrase", "title": "...", "content": "..."}]}',
    'Bands are 0-9 with half steps; be honest. summary_zh is Chinese, 2-4 sentences. upgraded_sentences are 2-3 Band 8 sentences the learner can memorise. memory_updates are 2-3 durable facts worth remembering next time.',
  ].join('\n');
  const answers = input.turns
    .filter((turn) => turn.learnerTranscript.trim())
    .map((turn, index) => {
      return (
        'Q' + String(index + 1) + ': ' + turn.examinerQuestion.slice(0, 180) + '\n' +
        'A' + String(index + 1) + ': ' + turn.learnerTranscript.slice(0, 500)
      );
    })
    .join('\n\n');
  const user = [
    'Part mode: ' + input.partMode,
    'Target band: ' + input.targetBand.toFixed(1),
    input.memory && input.memory.length > 0 ? 'Long-term memory: ' + input.memory.slice(0, 6).join(' | ') : '',
    'Answers:',
    answers || '(no answers)',
  ]
    .filter(Boolean)
    .join('\n');
  return { system, user };
}

/** Best-effort JSON extraction for model replies that add prose or fences. */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  const body = (text || '').trim();
  if (!body) return null;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const slice = body.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function normalizeFeedback(raw: Record<string, unknown> | null): TurnFeedback {
  const data = raw || {};
  const toText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const mistakes = Array.isArray(data.grammar_mistakes) ? data.grammar_mistakes : [];
  const tips = Array.isArray(data.lexical_tips) ? data.lexical_tips : [];
  const grammar: GrammarMistake[] = mistakes
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .slice(0, 3)
    .map((item) => ({
      original: toText(item.original),
      corrected: toText(item.corrected),
      category: toText(item.category) || 'other',
      explanation_zh: toText(item.explanation_zh),
    }))
    .filter((item) => item.original || item.corrected);
  return {
    corrected_text: toText(data.corrected_text),
    upgraded_text: toText(data.upgraded_text),
    grammar_mistakes: grammar,
    lexical_tips: tips
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .slice(0, 2)
      .map((item) => ({
        basic: toText(item.basic),
        upgraded: toText(item.upgraded),
        usage_zh: toText(item.usage_zh),
      }))
      .filter((item) => item.upgraded),
    coach_note_zh: toText(data.coach_note_zh),
  };
}
