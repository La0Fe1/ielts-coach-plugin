/** Shared domain types for the v2 realtime coach. */

export type Provider = 'qwen' | 'gemini' | 'openai';
export type PartMode = 'part1' | 'part2' | 'part3' | 'full_mock';
export type TurnMode = 'auto' | 'manual';
export type ExaminerStyle = 'friendly' | 'strict' | 'coach';

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
  serverProviders: Record<Provider | 'deepseek', boolean>;
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
  partMode: PartMode;
  targetBand: number;
  style: ExaminerStyle;
  turnMode: TurnMode;
}
