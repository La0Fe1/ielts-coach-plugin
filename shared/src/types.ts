/** Shared domain types for the v2 realtime coach. */

/**
 * Real-time voice providers. `deepseek` is the v2.2.0 pure-voice mode: the
 * browser's SpeechRecognition does the listening, the server streams DeepSeek
 * text turns and Edge Neural TTS reads the examiner aloud. No realtime key needed.
 */
export type Provider = 'deepseek' | 'qwen' | 'gemini' | 'openai';
export type PartMode = 'part1' | 'part2' | 'part3' | 'full_mock';
export type TurnMode = 'auto' | 'manual';
export type ExaminerStyle = 'friendly' | 'strict' | 'coach';
/** Where per-turn grammar coaching comes from: the web app or an external AI client. */
export type ReviewMode = 'auto' | 'external' | 'deepseek' | 'custom';

export interface PlanQuestion {
  part: 'part1' | 'part2' | 'part3';
  kind: 'question' | 'cue_card' | 'follow_up';
  text: string;
  ref?: string;
}

export interface LessonPlan {
  partMode: PartMode;
  topic: string;
  topicZh: string;
  questions: PlanQuestion[];
  targetBand: number;
}

export interface GrammarMistake {
  original: string;
  corrected: string;
  category: string;
  explanation_zh: string;
}

export interface LexicalTip {
  basic: string;
  upgraded: string;
  usage_zh: string;
}

export interface TurnFeedback {
  corrected_text: string;
  upgraded_text: string;
  grammar_mistakes: GrammarMistake[];
  lexical_tips: LexicalTip[];
  coach_note_zh: string;
}

export interface MemoryNote {
  id: string;
  kind: 'weakness' | 'fact' | 'phrase';
  title: string;
  content: string;
  createdAt: number;
}

export interface TranscriptLine {
  id: string;
  role: 'user' | 'examiner';
  text: string;
  final: boolean;
  at: number;
}

export interface LessonRecord {
  id: string;
  startedAt: number;
  endedAt: number | null;
  partMode: PartMode;
  topic: string;
  provider: Provider;
  lines: TranscriptLine[];
  feedback: Record<string, TurnFeedback>;
  report: LessonReport | null;
  /** planned = created by an MCP client, live = opened in the browser, completed = report saved. */
  status?: 'planned' | 'live' | 'completed';
  /** Custom plan handed over by the AI client (null = browser planned it). */
  plan?: LessonPlan | null;
  /** What the external coach wanted this lesson to focus on. */
  reviewFocus?: string;
}

export interface BandScores {
  overall: number;
  fc: number;
  lr: number;
  gra: number;
  pr: number;
}

export interface LessonReport {
  bands: BandScores;
  summary_zh: string;
  top_mistakes: GrammarMistake[];
  upgraded_sentences: string[];
  memory_updates: MemoryNote[];
}

export interface PublicConfig {
  hasAccessCode: boolean;
  serverProviders: Record<Provider, boolean>;
}

/** One SSE frame produced by POST /api/voice/deepseek-turn. */
export type DeepSeekVoiceEvent =
  | { type: 'delta'; delta: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

export interface DeepSeekTurnRequest {
  model?: string;
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  apiKey?: string;
  accessCode?: string;
  endpointUrl?: string;
  maxTokens?: number;
}

export interface RealtimeSettings {
  provider: Provider;
  model: string;
  voice?: string;
  endpointUrl?: string;
  workspaceId?: string;
  apiKey?: string;
  accessCode?: string;
  /** Optional dedicated text-coach credentials (cheaper than reusing the voice key). */
  coachApiKey?: string;
  coachBaseUrl?: string;
  coachModel?: string;
  /** auto = web app reuses the current provider for review;
   * deepseek = dedicated DeepSeek preset; custom = user-supplied OpenAI-compatible endpoint;
   * external = no per-turn API calls; the transcript is reviewed in 豆包 / dsh / Codex.
   */
  reviewMode?: ReviewMode;
  /** Examiner voice used by the DeepSeek pure-voice mode (Edge Neural TTS). */
  voiceAccent?: 'uk' | 'us';
  partMode: PartMode;
  targetBand: number;
  style: ExaminerStyle;
  turnMode: TurnMode;
}
