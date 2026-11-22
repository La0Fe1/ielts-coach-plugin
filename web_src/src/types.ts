export type FeedbackStyle = 'instant_card_plus_voice' | 'instant_card_only'
export type Accent = 'uk' | 'us'
export type PartMode = 'part1' | 'part2' | 'part3' | 'full_mock' | 'free_drill'
export type MicMode = 'free' | 'manual'
export type DriveMode = 'standalone' | 'mcp'
export type ThemeName = 'light' | 'dark'
export type Part2Stage = 'idle' | 'prep' | 'speak'
export type Phase = 'gate' | 'idle' | 'examiner_speaking' | 'listening' | 'submitting' | 'thinking' | 'ended'

export interface Profile {
  id?: number
  name?: string
  target_band: number
  accent_preference: Accent
  feedback_style?: FeedbackStyle
  native_language?: string
  voice_speed?: number
  llm_mode?: DriveMode
  llm_provider?: string
  llm_base_url?: string
  llm_model?: string
  has_api_key?: boolean
  api_key_masked?: string
}

export interface Session {
  id: number
  part_mode: PartMode
  topic_title: string
  feedback_style: FeedbackStyle
  status: 'active' | 'completed' | 'abandoned'
  started_at: string
  ended_at?: string | null
  target_band?: number | null
  estimated_band_overall?: number | null
  band_fc?: number | null
  band_lr?: number | null
  band_gra?: number | null
  band_pr?: number | null
}

export interface GrammarMistake {
  error_category: string
  error_pattern?: string
  original_excerpt: string
  corrected_excerpt: string
  upgraded_excerpt?: string
  explanation: string
}

export interface FeedbackCard {
  turn_id?: number
  turn_index?: number
  quick_praise?: string
  corrected_text?: string
  upgraded_text?: string
  grammar_mistakes?: GrammarMistake[]
  pronunciation_tips?: unknown
}

export interface PronunciationIssue {
  phoneme: string
  likely_pronounced_as?: string
  gop_score?: number
  issue_type?: string
  start_sec?: number
  end_sec?: number
}

export interface PronWordPhoneme {
  phoneme: string
  score: number
  gop?: number
  competitor?: string
  start_sec?: number
  end_sec?: number
}

export interface PronWord {
  word: string
  index?: number
  score: number | null
  ipa: string | null
  start_sec: number | null
  end_sec: number | null
  color: 'green' | 'amber' | 'red' | 'gray'
  issues: PronunciationIssue[]
  phonemes?: PronWordPhoneme[]
}

export interface WeakPhoneme {
  phoneme: string
  avg_score: number
  count: number
  examples?: string[]
}

export interface PronunciationResult {
  overall_score: number | null
  words: PronWord[]
  flagged_words?: PronWord[]
  weak_phonemes: WeakPhoneme[]
  model?: string
  device?: string
  elapsed_sec?: number
  alignment_ok?: boolean
  reason?: string
  stub?: boolean
}

export interface PauseInfo {
  after_word?: string
  duration_sec?: number
}

export interface StuckInfo {
  detected?: boolean
  longest_pause_sec?: number
  at_word?: string | null
  hint_words?: string[]
}

export interface LongPauses {
  pauses?: PauseInfo[]
  stuck?: StuckInfo | null
  filler_words?: Record<string, number>
  filler_total?: number
  effective_duration_sec?: number
  word_count?: number
  asr_elapsed_sec?: number
}

export interface Turn {
  id: number
  session_id?: number
  turn_index: number
  part: string
  examiner_question: string
  examiner_tts_path?: string | null
  examiner_audio_url?: string | null
  learner_audio_path?: string | null
  learner_audio_url?: string | null
  learner_duration_sec?: number | null
  learner_transcript?: string | null
  wpm?: number | null
  pause_count?: number | null
  long_pauses_json?: LongPauses | null
  corrected_text?: string | null
  upgraded_text?: string | null
  grammar_feedback_json?: FeedbackCard | null
  pronunciation_json?: PronunciationResult | null
  pronunciation_score?: number | null
  created_at?: string
}

export interface StateSnapshot {
  session_id?: number
  status: string
  mcp_status?: string
  current_turn_id?: number | null
  current_part: string
  examiner_text: string | null
  examiner_audio_url: string | null
  examiner_audio_duration?: number | null
  has_pending_reply?: boolean
  ended?: boolean
  turn_count?: number
  last_error?: string | null
}

export interface MemoryNote {
  id: number
  memory_type: string
  memory_key?: string
  title: string
  content: string
  frequency_count?: number
  mastery_score?: number
  last_seen_at?: string
}

export interface BandHistoryItem {
  session_id: number
  estimated_band_overall: number
  band_fc?: number | null
  band_lr?: number | null
  band_gra?: number | null
  band_pr?: number | null
  created_at?: string
}

export interface LearnerContext {
  profile: Profile
  top_grammar_weaknesses: { error_pattern: string; error_category: string; count: number; explanation?: string }[]
  top_weak_phonemes: WeakPhoneme[]
  part2_stories: MemoryNote[]
  personal_facts: MemoryNote[]
  last_lesson_plan: MemoryNote | null
  band_history: BandHistoryItem[]
  has_history: boolean
}

export interface ReportPayload {
  bands?: Record<string, number | null>
  next_lesson_plan?: string
  [key: string]: unknown
}

export interface LessonReport {
  id: number
  session_id: number
  report_markdown: string
  report_json: ReportPayload | null
  markdown_file_path: string
  created_at: string
}

export interface PlanQuestion {
  part: string
  text: string
  ref?: string
  kind: 'question' | 'cue_card' | 'revisit' | 'follow_up' | string
}

export interface GrammarPattern {
  pattern: string
  category?: string
  count?: number
}

export interface LessonPlan {
  plan_id?: string
  part_mode?: string
  topic: { id?: string | null; title: string | null; title_zh: string | null; tags?: string[] }
  questions: PlanQuestion[]
  review: {
    grammar_patterns: Array<GrammarPattern | string>
    weak_phonemes: WeakPhoneme[]
    revisit_questions: Array<{ question: string; session_id?: number; mistakes?: number } | string>
    story_to_polish: { title: string; content: string } | null
    last_plan?: string | null
  }
  focus: string[]
  is_first_lesson: boolean
  rationale: string
  question_count?: number
}

export interface Bootstrap {
  session: Session
  state: StateSnapshot
  turns: Turn[]
  profile: Profile
  context: LearnerContext
  report: LessonReport | null
  plan: LessonPlan | null
  audio_base?: string
}

export interface TurnReply {
  status?: string
  session_id?: number
  turn_id?: number
  turn?: Record<string, unknown>
  transcript?: string
  wpm?: number | null
  pauses?: PauseInfo[]
  pronunciation?: PronunciationResult | null
  stuck?: StuckInfo | null
  language?: string
  intent?: string
  [key: string]: unknown
}

export interface CreateSessionInput {
  part_mode: PartMode
  topic_hint?: string
  feedback_style?: FeedbackStyle
  target_band?: number
  accent?: Accent
  auto_plan: true
  drive_mode?: DriveMode
}

export interface CreateSessionResult {
  session: Session
  session_id: number
  companion_url: string
  plan: LessonPlan | null
  drive_mode?: DriveMode
}

export interface LlmTestInput {
  llm_provider?: string
  llm_base_url?: string
  llm_model?: string
  llm_api_key?: string
}

export interface LlmTestResult {
  ok: boolean
  message: string
  latency_ms?: number
}

export interface PracticeResult {
  ok: boolean
  target_text: string
  transcript: string
  audio_url: string
  pronunciation: PronunciationResult | null
  wpm: number | null
}

export interface PracticeState {
  targetText: string | null
  status: 'idle' | 'recording' | 'uploading'
  elapsed: number
  previousScore?: number | null
  result: PracticeResult | null
  error: string | null
}

export interface SendProgress {
  active: boolean
  progress: number
  remainingSec: number
  thresholdSec: number
}

export interface VadEvent {
  type: 'vad' | 'ready' | 'reset' | 'config'
  prob?: number
  speech?: boolean
  speech_started?: boolean
  speech_sec?: number
  trailing_silence?: number
  elapsed_sec?: number
  should_stop?: boolean
  stop_reason?: string | null
  enough_speech?: boolean
  available?: boolean
  fallback?: string | null
  frame_samples?: number
  silence_sec?: number
  cut_on_silence?: boolean
  stuck?: boolean
}

export type WsEvent =
  | { type: 'hello'; state: StateSnapshot }
  | { type: 'ping'; ts: number }
  | { type: 'state'; status: string; message?: string }
  | { type: 'examiner_turn'; turn_id: number; text: string; audio_url: string | null; audio_duration: number | null; part: string }
  | { type: 'feedback'; feedback: FeedbackCard & { turn_id?: number } }
  | { type: 'turn_ready'; payload: Record<string, unknown> }
  | { type: 'lesson_ended'; status: string; reason?: string }
  | { type: 'report'; report: { markdown: string; bands: Record<string, number | null>; markdown_file_path?: string } }
