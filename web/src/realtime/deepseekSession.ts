/**
 * DeepSeek 纯语音模式的浏览器控制器。
 *
 * 它把三件事拼成和 `RealtimeClient` 完全一致的 `ServerEvent`：
 *   听 —— 浏览器原生 SpeechRecognition（Safari / Chrome 需要跨重启用拼接保证不断字）；
 *   想 —— POST /api/voice/deepseek-turn 的 SSE 流式文本（服务端代理 DeepSeek）；
 *   说 —— POST /api/voice/tts 的 Edge Neural TTS 音频，失败时回退 window.speechSynthesis。
 *
 * App.tsx 因此不需要为 deepseek 写第二套字幕 / Part 2 题卡 / 精批逻辑：
 * 只要把 `onEvent` 接到同一个 `handleServerEvent` 即可。
 */

import type {
  ClientEvent,
  DeepSeekTurnRequest,
  DeepSeekVoiceEvent,
  PauseTolerance,
  ServerEvent,
} from '@ielts/shared';
import { assessUtterance } from '@ielts/shared';

/* ------------------------------------------------------------------ */
/* lib.dom 里仍然没有 SpeechRecognition 类型：和 speechFallback.ts 一样 */
/* 在本地声明最小可用接口，避免引入新依赖。                             */
/* ------------------------------------------------------------------ */

interface RecognitionAlternative {
  transcript: string;
  confidence?: number;
}

interface RecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: RecognitionAlternative;
}

interface RecognitionResultList {
  length: number;
  [index: number]: RecognitionResult;
}

interface RecognitionErrorLike {
  error: string;
  message?: string;
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  start: () => void;
  stop: () => void;
  abort?: () => void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: { results: RecognitionResultList; resultIndex?: number }) => void) | null;
  onerror: ((event: RecognitionErrorLike) => void) | null;
}

type RecognitionCtor = new () => RecognitionLike;

/* ------------------------------------------------------------------ */
/* 对用户可见的提示（App 会把这些放进非阻塞的 notice 横幅，而不是弹窗） */
/* ------------------------------------------------------------------ */

export const SPEECH_UNSUPPORTED_NOTICE =
  '这个浏览器还不能识别语音：Mac / iPhone 请直接用 Safari 打开；其他环境可以在下方输入框直接打字回答，考官仍会正常朗读。';
export const SPEECH_NETWORK_NOTICE =
  '语音识别服务暂时连不上（国内 Chrome 常见）。建议改用 Mac / iPhone 的 Safari，或在下方直接打字回答；识别会自动重试。';
export const SPEECH_DENIED_NOTICE =
  '麦克风权限被拒绝：请在地址栏允许麦克风后重新开始；也可以直接在下方打字回答，考官仍会正常朗读。';
export const SPEECH_NO_MIC_NOTICE =
  '没有检测到可用的麦克风，已切换为打字作答模式；接上麦克风后重新开始即可恢复语音。';

const DEFAULT_MODEL = 'deepseek-chat';
const OUTPUT_SAMPLE_RATE = 24000;
const MAX_SENTENCE_CHARS = 180;
const TTS_PREFETCH = 2;
/** Manual-mode hint only: "你停下来了" pill; never auto-submits in manual mode. */
const SILENCE_NOTICE_MS = 1600;
const RESUME_AFTER_SPEECH_MS = 220;
const MAX_CONVERSATION_MESSAGES = 16;

/**
 * Auto-mode endpointing (v2.2.2).
 *
 * v2.2.1 only stretched the pause; a clean first sentence still looked
 * "finished" after ~3.5 s. A real IELTS answer is often two clauses and the
 * learner may still be phrasing the second one ("…well, and…", "…because…").
 * So now every auto pause is assessed with `assessUtterance`:
 *
 * - soft silence (`silence`): assess the whole utterance. If it ends with a
 *   hesitation/filler tail or an open-ended word, or it is just one short
 *   sentence, keep waiting up to the hard cap.
 * - clean, clearly finished answer: submit after the short `grace` window.
 * - hard silence (`hard`): submit whatever we have — the learner is stuck.
 *
 * Any new word during either window cancels the pending submit.
 */
const AUTO_COMMIT_PROFILES: Record<
  PauseTolerance,
  { silence: number; jitter: number; grace: number; hard: number }
> = {
  fast: { silence: 1900, jitter: 250, grace: 800, hard: 3500 },
  standard: { silence: 2600, jitter: 400, grace: 1100, hard: 5000 },
  patient: { silence: 3300, jitter: 450, grace: 1300, hard: 6500 },
};

const GREETING_INSTRUCTION =
  '(The lesson begins now. Greet me in one short English sentence, then ask question 1 exactly as written. Ask one question at a time and keep turns short.)';

export interface DeepSeekVoiceSessionOptions {
  accent: 'uk' | 'us';
  turnMode: 'auto' | 'manual';
  language: 'en' | 'zh';
  systemPrompt: string;
  /** deepseek-chat / deepseek-reasoner */
  model: string;
  apiKey?: string;
  accessCode?: string;
  endpointUrl?: string;
  /** How patient the auto-submit endpointing is (default: standard). */
  pauseTolerance?: PauseTolerance;
  /** 在 App 的点击事件里创建并 resume 过的 AudioContext（iOS 解锁要求）。 */
  audioContext: AudioContext;
}

interface TtsSlot {
  buffer?: AudioBuffer;
  error?: unknown;
}

/** 按句子切分，并把过短的句子合并到 <=180 字符，长句硬切。 */
function splitSentences(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const pieces = cleaned.match(/[^.!?;。！？]+[.!?;。！？]+|[^.!?;。！？]+$/g) || [cleaned];
  const sentences: string[] = [];
  let current = '';
  for (const raw of pieces) {
    const piece = raw.trim();
    if (!piece) continue;
    if ((current ? current + ' ' : '') .length + piece.length <= MAX_SENTENCE_CHARS) {
      current = current ? current + ' ' + piece : piece;
      continue;
    }
    if (current) sentences.push(current);
    current = '';
    if (piece.length <= MAX_SENTENCE_CHARS) {
      current = piece;
      continue;
    }
    let rest = piece;
    while (rest.length > MAX_SENTENCE_CHARS) {
      sentences.push(rest.slice(0, MAX_SENTENCE_CHARS).trim());
      rest = rest.slice(MAX_SENTENCE_CHARS).trim();
    }
    current = rest;
  }
  if (current) sentences.push(current);
  return sentences;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error instanceof Error ? error.name : error);
}

export class DeepSeekVoiceSession {
  onEvent: (event: ServerEvent) => void = () => undefined;
  onClose: (reason: string) => void = () => undefined;

  private readonly Ctor: RecognitionCtor | null;
  private readonly audioContext: AudioContext;
  private readonly systemPrompt: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly accessCode?: string;
  private readonly endpointUrl?: string;

  private accent: 'uk' | 'us';
  private turnMode: 'auto' | 'manual';
  private language: 'en' | 'zh';

  private recognition: RecognitionLike | null = null;
  private recognitionRunning = false;
  private recognitionPaused = false;
  private muted = false;
  private closed = false;
  private connected = false;

  /** Safari / Chrome 会在任意时刻结束识别：这三段保证重启后不丢词、不重复。 */
  private committedPrefix = '';
  private segmentFinal = '';
  private segmentInterim = '';
  private finalProcessed = 0;
  private itemId = '';
  private itemCounter = 0;
  private lecturerItemCounter = 0;
  private lastCaption = '';
  private speechActive = false;

  private silenceTimer: number | null = null;
  /** Auto-mode: silence detected, waiting out the "keep talking" grace window. */
  private pendingCommitTimer: number | null = null;
  /** Auto-mode: hard silence cap — submit even if the answer looks unfinished. */
  private hardCommitTimer: number | null = null;
  /** Timestamp of the last recognised word (used to measure the hard cap). */
  private lastVoiceAt = 0;
  private restartTimer: number | null = null;
  private resumeTimer: number | null = null;
  private errorBackoffUntil = 0;
  private readonly noticeAt = new Map<string, number>();
  private readonly autoProfile: { silence: number; jitter: number; grace: number; hard: number };

  private conversation: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  private examinerBusy = false;
  private turnSeq = 0;
  private abortController: AbortController | null = null;
  private currentExaminerItemId = '';
  private currentExaminerText = '';
  /** 本轮是否已经发过 examiner_transcript_final（打断时避免重复推一条字幕）。 */
  private currentExaminerFinalEmitted = false;
  private readonly activeSources = new Set<AudioBufferSourceNode>();

  constructor(options: DeepSeekVoiceSessionOptions) {
    const win = window as unknown as {
      SpeechRecognition?: RecognitionCtor;
      webkitSpeechRecognition?: RecognitionCtor;
    };
    this.Ctor = win.SpeechRecognition || win.webkitSpeechRecognition || null;
    this.audioContext = options.audioContext;
    this.systemPrompt = options.systemPrompt;
    this.model = (options.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    this.apiKey = options.apiKey;
    this.accessCode = options.accessCode;
    this.endpointUrl = options.endpointUrl;
    this.accent = options.accent === 'us' ? 'us' : 'uk';
    this.turnMode = options.turnMode === 'manual' ? 'manual' : 'auto';
    this.language = options.language === 'zh' ? 'zh' : 'en';
    this.autoProfile = AUTO_COMMIT_PROFILES[options.pauseTolerance || 'standard'] || AUTO_COMMIT_PROFILES.standard;
  }

  /** 浏览器是否具备 SpeechRecognition（没有时由 App 显示打字备用提示）。 */
  get supported(): boolean {
    return Boolean(this.Ctor);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;
    this.emit({ type: 'session_ready', provider: 'deepseek', model: this.model, outputSampleRate: OUTPUT_SAMPLE_RATE });
    if (!this.Ctor) {
      this.emit({
        type: 'error',
        code: 'speech_unsupported',
        message: SPEECH_UNSUPPORTED_NOTICE,
        retryable: false,
      });
      return;
    }
    // 永远不要 throw：识别失败只是降级为打字，不能把整节课卡死。
    try {
      this.ensureRecognition();
      if (!this.muted && !this.recognitionPaused) this.startRecognition();
    } catch {
      this.emit({
        type: 'error',
        code: 'speech_unsupported',
        message: SPEECH_UNSUPPORTED_NOTICE,
        retryable: false,
      });
    }
  }

  send(event: ClientEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case 'commit_turn':
        this.commitAccumulated();
        return;
      case 'interrupt':
        this.interrupt();
        return;
      case 'update_turn_mode':
        this.turnMode = event.turnMode === 'manual' ? 'manual' : 'auto';
        return;
      case 'trigger_greeting': {
        if (this.examinerBusy) return;
        const extra = (event.text || '').trim();
        const instruction = extra
          ? '(The lesson begins now. ' + extra + ' Ask one question at a time and keep turns short.)'
          : GREETING_INSTRUCTION;
        void this.runExaminerTurn(instruction);
        return;
      }
      case 'end_session':
        this.close();
        return;
      case 'start_session':
        // deepseek 模式不需要 start_session：鉴权/系统提示在构造时已经就位。
        return;
      default:
        return;
    }
  }

  setMuted(muted: boolean): void {
    if (this.closed || this.muted === muted) return;
    this.muted = muted;
    if (muted) {
      this.clearSilenceTimer();
      this.clearPendingCommit();
      this.clearHardCommit();
      this.stopRecognition();
      this.resetSegment();
      return;
    }
    if (!this.recognitionPaused) this.startRecognition();
  }

  setLanguage(language: 'en' | 'zh'): void {
    const next = language === 'zh' ? 'zh' : 'en';
    if (this.closed || this.language === next) return;
    this.language = next;
    this.resetUtterance();
    if (this.recognitionPaused || this.muted) return;
    this.stopRecognition();
    this.scheduleRestart(450);
  }

  /** 打字备用：行为和一次最终的语音作答完全一致（不受 auto/manual 影响）。 */
  submitTypedText(text: string): void {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    if (!clean || this.closed) return;
    if (this.examinerBusy) this.interrupt();
    this.resetUtterance();
    const itemId = this.newItemId();
    this.emit({ type: 'user_transcript_final', itemId, text: clean });
    void this.runExaminerTurn(clean);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.turnSeq += 1;
    const controller = this.abortController;
    this.abortController = null;
    try {
      controller?.abort();
    } catch {
      /* already aborted */
    }
    this.clearTimers();
    this.stopRecognition(true);
    this.stopAudioPlayback();
    this.resetUtterance();
    this.conversation = [];
    this.examinerBusy = false;
    this.currentExaminerItemId = '';
    this.currentExaminerText = '';
    this.currentExaminerFinalEmitted = false;
    try {
      void this.audioContext.close().catch(() => undefined);
    } catch {
      /* context already closed */
    }
  }

  /* ----------------------------- 识别 ----------------------------- */

  private recognitionLanguage(): string {
    if (this.language === 'zh') return 'zh-CN';
    return this.accent === 'uk' ? 'en-GB' : 'en-US';
  }

  private ensureRecognition(): void {
    if (this.recognition || !this.Ctor) return;
    const recognition = new this.Ctor();
    recognition.lang = this.recognitionLanguage();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      this.recognitionRunning = true;
    };
    recognition.onend = () => this.handleRecognitionEnd();
    recognition.onresult = (event) => this.handleRecognitionResult(event);
    recognition.onerror = (event) => this.handleRecognitionError(event);
    this.recognition = recognition;
  }

  private startRecognition(): void {
    if (this.closed || this.muted || this.recognitionPaused) return;
    const recognition = this.recognition;
    if (!recognition || this.recognitionRunning) return;
    recognition.lang = this.recognitionLanguage();
    try {
      recognition.start();
      this.recognitionRunning = true;
    } catch {
      // InvalidStateError 等：稍后软重试，绝不 tight loop。
      this.recognitionRunning = false;
      this.scheduleRestart(1500);
    }
  }

  private stopRecognition(discard = false): void {
    const recognition = this.recognition;
    this.recognitionRunning = false;
    if (!recognition) return;
    try {
      if (discard && typeof recognition.abort === 'function') recognition.abort();
      else recognition.stop();
    } catch {
      /* not running */
    }
  }

  private handleRecognitionEnd(): void {
    this.recognitionRunning = false;
    if (this.closed || this.muted || this.recognitionPaused) return;
    // 浏览器自动分段重启：先把当前段落的文字折进 committedPrefix，再重启。
    this.foldSegment();
    const backoff = Math.max(0, this.errorBackoffUntil - Date.now());
    this.scheduleRestart(backoff > 0 ? backoff + 200 : 300 + Math.round(Math.random() * 250));
  }

  private scheduleRestart(delayMs: number): void {
    if (this.closed || this.muted || this.recognitionPaused) return;
    if (this.restartTimer !== null) window.clearTimeout(this.restartTimer);
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      this.startRecognition();
    }, Math.max(250, delayMs));
  }

  private handleRecognitionResult(event: { results: RecognitionResultList }): void {
    if (this.closed || this.muted || this.recognitionPaused) return;
    const results = event.results;
    if (!results || results.length === 0) return;
    let interim = '';
    let changed = false;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (!result) continue;
      if (index < this.finalProcessed) {
        if (!result.isFinal) interim += result[0] ? result[0].transcript : '';
        continue;
      }
      const transcript = result[0] ? result[0].transcript : '';
      if (result.isFinal) {
        const piece = transcript.replace(/\s+/g, ' ').trim();
        if (piece) {
          this.segmentFinal = this.segmentFinal ? this.segmentFinal + ' ' + piece : piece;
          changed = true;
        }
        this.finalProcessed = index + 1;
      } else {
        interim += transcript;
      }
    }
    const nextInterim = interim.replace(/\s+/g, ' ').trim();
    if (nextInterim !== this.segmentInterim) {
      this.segmentInterim = nextInterim;
      changed = true;
    }
    if (!changed) return;

    // 任何新的词（interim 或 final）都算"用户还在说"：取消两种待提交，
    // 并把硬上限的计时起点刷新为这一秒。
    this.lastVoiceAt = Date.now();
    this.clearPendingCommit();
    this.clearHardCommit();
    this.resetSilenceTimer();
    const text = this.currentText();
    if (!text) return;
    if (!this.speechActive) {
      this.speechActive = true;
      this.emit({ type: 'user_speech_started' });
    }
    if (text !== this.lastCaption) {
      this.lastCaption = text;
      this.emit({ type: 'user_transcript_delta', itemId: this.ensureItemId(), text, mode: 'replace' });
    }
  }

  private handleRecognitionError(event: RecognitionErrorLike): void {
    if (this.closed) return;
    const code = event.error || '';
    if (!code || code === 'no-speech' || code === 'aborted') return;
    if (code === 'network') {
      this.emitNoticeOnce('speech_network', SPEECH_NETWORK_NOTICE);
      this.errorBackoffUntil = Date.now() + 1800;
      return;
    }
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      this.emitNoticeOnce('speech_denied', SPEECH_DENIED_NOTICE);
      this.errorBackoffUntil = Date.now() + 4000;
      return;
    }
    if (code === 'audio-capture') {
      this.emitNoticeOnce('speech_no_mic', SPEECH_NO_MIC_NOTICE);
      this.errorBackoffUntil = Date.now() + 3000;
      return;
    }
    this.emitNoticeOnce('speech_error', '语音识别出了点问题（' + code + '），可以继续打字作答；识别会自动重试。');
    this.errorBackoffUntil = Date.now() + 2000;
  }

  private emitNoticeOnce(code: string, message: string): void {
    const last = this.noticeAt.get(code) || 0;
    if (Date.now() - last < 6000) return;
    this.noticeAt.set(code, Date.now());
    this.emit({ type: 'error', code, message, retryable: true });
  }

  private resetSilenceTimer(): void {
    this.clearSilenceTimer();
    const delay =
      this.turnMode === 'auto'
        ? this.autoProfile.silence + Math.round(Math.random() * this.autoProfile.jitter)
        : SILENCE_NOTICE_MS;
    this.silenceTimer = window.setTimeout(() => {
      this.silenceTimer = null;
      this.onSilence();
    }, delay);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /** Clean answer: submit after a short "keep talking" grace window. */
  private scheduleGraceCommit(): void {
    this.clearPendingCommit();
    this.pendingCommitTimer = window.setTimeout(() => {
      this.pendingCommitTimer = null;
      this.maybeCommit('grace');
    }, this.autoProfile.grace);
  }

  /**
   * Unfinished-looking answer (filler/connector tail, single short sentence…):
   * keep listening until the hard silence cap, then submit what we have.
   */
  private scheduleHardCommit(): void {
    this.clearHardCommit();
    const elapsed = Date.now() - this.lastVoiceAt;
    const delay = Math.max(400, this.autoProfile.hard - elapsed);
    this.hardCommitTimer = window.setTimeout(() => {
      this.hardCommitTimer = null;
      this.maybeCommit('hard');
    }, delay);
  }

  private maybeCommit(_reason: 'grace' | 'hard'): void {
    if (this.closed || this.muted || this.recognitionPaused) return;
    if (this.turnMode !== 'auto' || this.examinerBusy) return;
    const text = this.currentText();
    if (text) this.commitText(text);
  }

  private clearPendingCommit(): void {
    if (this.pendingCommitTimer !== null) {
      window.clearTimeout(this.pendingCommitTimer);
      this.pendingCommitTimer = null;
    }
  }

  private clearHardCommit(): void {
    if (this.hardCommitTimer !== null) {
      window.clearTimeout(this.hardCommitTimer);
      this.hardCommitTimer = null;
    }
  }

  private onSilence(): void {
    if (this.closed || this.muted || this.recognitionPaused) return;
    const hadSpeech = this.speechActive;
    if (hadSpeech) {
      this.speechActive = false;
      this.emit({ type: 'user_speech_stopped' });
    }
    // manual / Part 2：绝不因为思考停顿而提前提交，等用户点「我说完了 / 我讲完了」。
    if (this.turnMode !== 'auto' || this.examinerBusy) return;
    const text = this.currentText();
    if (!text) return;

    // 整体性判断：两句话以上或足够长才算"像说完了"；带填充词 / 连接词尾巴、
    // 或只有一句短句，都说明还在组织语言 → 等到硬上限（默认 5 秒）再提交。
    const assessment = assessUtterance(text);
    if (assessment.likelyComplete) {
      this.scheduleGraceCommit();
      return;
    }
    this.scheduleHardCommit();
  }

  private commitAccumulated(): void {
    this.clearPendingCommit();
    this.clearHardCommit();
    const text = this.currentText();
    if (text) this.commitText(text);
  }

  private commitText(text: string): void {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean || this.closed) return;
    this.clearSilenceTimer();
    this.clearPendingCommit();
    this.clearHardCommit();
    this.speechActive = false;
    const itemId = this.ensureItemId();
    this.emit({ type: 'user_transcript_final', itemId, text: clean });
    this.resetUtterance();
    void this.runExaminerTurn(clean);
  }

  /** 把上一段识别会话的文字安全拼接起来（重启前调用）。 */
  private foldSegment(): void {
    const segment = (this.segmentFinal + ' ' + this.segmentInterim).replace(/\s+/g, ' ').trim();
    if (segment) {
      this.committedPrefix = this.committedPrefix ? this.committedPrefix + ' ' + segment : segment;
    }
    this.segmentFinal = '';
    this.segmentInterim = '';
    this.finalProcessed = 0;
  }

  private currentText(): string {
    const joined = [this.committedPrefix, this.segmentFinal, this.segmentInterim]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return joined;
  }

  private resetSegment(): void {
    this.segmentFinal = '';
    this.segmentInterim = '';
    this.finalProcessed = 0;
  }

  private resetUtterance(): void {
    this.committedPrefix = '';
    this.segmentFinal = '';
    this.segmentInterim = '';
    this.finalProcessed = 0;
    this.itemId = '';
    this.lastCaption = '';
    this.speechActive = false;
    this.clearSilenceTimer();
    this.clearPendingCommit();
    this.clearHardCommit();
  }

  private ensureItemId(): string {
    if (!this.itemId) this.itemId = this.newItemId();
    return this.itemId;
  }

  private newItemId(): string {
    this.itemCounter += 1;
    this.itemId = 'u-' + String(Date.now()) + '-' + String(this.itemCounter);
    return this.itemId;
  }

  private pauseRecognition(): void {
    this.recognitionPaused = true;
    this.clearSilenceTimer();
    this.clearPendingCommit();
    this.clearHardCommit();
    this.stopRecognition();
    this.resetSegment();
    this.speechActive = false;
  }

  private resumeRecognitionNow(): void {
    this.recognitionPaused = false;
    if (this.closed || this.muted) return;
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.startRecognition();
  }

  private scheduleResume(delayMs: number): void {
    if (this.closed) return;
    if (this.resumeTimer !== null) window.clearTimeout(this.resumeTimer);
    this.resumeTimer = window.setTimeout(() => {
      this.resumeTimer = null;
      this.resumeRecognitionNow();
    }, delayMs);
  }

  /* --------------------------- 考官这一轮 --------------------------- */

  private async runExaminerTurn(userText: string): Promise<void> {
    if (this.closed) return;
    if (this.examinerBusy) this.interrupt();
    const seq = this.turnSeq + 1;
    this.turnSeq = seq;
    this.examinerBusy = true;
    this.lecturerItemCounter += 1;
    const itemId = 'e-' + String(Date.now()) + '-' + String(this.lecturerItemCounter);
    this.currentExaminerItemId = itemId;
    this.currentExaminerText = '';
    this.currentExaminerFinalEmitted = false;
    this.pauseRecognition();

    const controller = new AbortController();
    this.abortController = controller;
    let finalEmitted = false;
    let fatalError: unknown = null;

    this.conversation.push({ role: 'user', text: userText });
    this.trimConversation();
    const messages = this.conversation.map((message) => ({ role: message.role, text: message.text }));

    try {
      const payload: DeepSeekTurnRequest = {
        model: this.model,
        systemPrompt: this.systemPrompt,
        messages,
        apiKey: this.apiKey,
        accessCode: this.accessCode,
        endpointUrl: this.endpointUrl,
      };
      const response = await fetch('/api/voice/deepseek-turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (seq !== this.turnSeq || this.closed) return;
      if (!response.ok) {
        const detail = (await response
          .json()
          .then((data: { error?: string; code?: string } | null) => data)
          .catch(() => null)) || {};
        const status = response.status;
        const authFailure = status === 401 || status === 403;
        this.emit({
          type: 'error',
          code: detail.code || (authFailure ? 'auth_failed' : 'examiner_http_' + String(status)),
          message: authFailure
            ? (detail.error || 'DeepSeek 鉴权失败。') +
              ' 请到「连接设置」里检查 DeepSeek API Key / 访问口令，填好后重新开始这一轮。'
            : detail.error || '考官这轮回复失败（HTTP ' + String(status) + '）。可以在下方打字继续，或点「打断」后再说一次。',
          retryable: status >= 500,
        });
      } else {
        await this.consumeSse(response, seq, (frame) => {
          if (frame.type === 'delta') {
            const delta = frame.delta || '';
            if (!delta) return;
            this.currentExaminerText += delta;
            this.emit({ type: 'examiner_transcript_delta', itemId, delta });
            return;
          }
          if (frame.type === 'done') {
            const done = (frame.text || '').trim();
            if (done) this.currentExaminerText = done;
            return;
          }
          if (frame.type === 'error') {
            throw new Error(frame.message || '考官回复中断');
          }
        });
        if (seq !== this.turnSeq || this.closed) return;
        const reply = this.currentExaminerText.trim();
        if (reply) {
          this.emit({ type: 'examiner_transcript_final', itemId, text: reply });
          finalEmitted = true;
          this.currentExaminerFinalEmitted = true;
          this.conversation.push({ role: 'assistant', text: reply });
          this.trimConversation();
          await this.speak(reply, seq);
        }
      }
    } catch (error) {
      if (seq !== this.turnSeq || this.closed) return;
      fatalError = error;
      try {
        controller.abort();
      } catch {
        /* already aborted */
      }
    } finally {
      if (seq === this.turnSeq && !this.closed) {
        if (fatalError) {
          this.emit({
            type: 'error',
            code: 'examiner_failed',
            message:
              '考官这轮回复失败了：' +
              errorMessage(fatalError) +
              '。可以直接在下方打字继续，或点「打断」后再说一次。',
            retryable: true,
          });
          const partial = this.currentExaminerText.trim();
          if (!finalEmitted && partial) {
            this.emit({ type: 'examiner_transcript_final', itemId, text: partial });
            this.currentExaminerFinalEmitted = true;
            this.conversation.push({ role: 'assistant', text: partial });
            this.trimConversation();
          }
        }
        this.currentExaminerItemId = '';
        this.currentExaminerText = '';
        this.currentExaminerFinalEmitted = false;
        this.abortController = null;
        this.emit({ type: 'examiner_turn_done', itemId });
        this.examinerBusy = false;
        this.scheduleResume(RESUME_AFTER_SPEECH_MS);
      }
    }
  }

  /** 用户点「打断」/ 新一轮作答抢占：停下 SSE、停音频、立刻恢复识别。 */
  private interrupt(): void {
    const wasBusy = this.examinerBusy;
    this.turnSeq += 1;
    this.clearSilenceTimer();
    this.clearPendingCommit();
    this.clearHardCommit();
    const controller = this.abortController;
    this.abortController = null;
    try {
      controller?.abort();
    } catch {
      /* already aborted */
    }
    const partial = this.currentExaminerText.trim();
    const finalAlreadyEmitted = this.currentExaminerFinalEmitted;
    const itemId = this.currentExaminerItemId || 'e-' + String(Date.now());
    this.examinerBusy = false;
    this.currentExaminerItemId = '';
    this.currentExaminerText = '';
    this.currentExaminerFinalEmitted = false;
    this.stopAudioPlayback();
    if (wasBusy && !this.closed) {
      if (partial && !finalAlreadyEmitted) this.emit({ type: 'examiner_transcript_final', itemId, text: partial });
      this.emit({ type: 'examiner_turn_done', itemId });
    }
    if (!this.closed) this.resumeRecognitionNow();
  }

  private trimConversation(): void {
    while (this.conversation.length > MAX_CONVERSATION_MESSAGES) this.conversation.splice(0, 2);
  }

  /* ----------------------------- SSE ----------------------------- */

  private async consumeSse(
    response: Response,
    seq: number,
    onFrame: (frame: DeepSeekVoiceEvent) => void,
  ): Promise<void> {
    const body = response.body;
    let finished = false;
    const handleFrame = (frame: DeepSeekVoiceEvent): void => {
      onFrame(frame);
      if (frame.type === 'done' || frame.type === 'error') finished = true;
    };
    const handleBlock = (block: string): void => {
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let parsed: DeepSeekVoiceEvent | null = null;
        try {
          parsed = JSON.parse(payload) as DeepSeekVoiceEvent;
        } catch {
          // 忽略坏帧，但绝不能把 onFrame 抛出的业务错误也吞掉。
          parsed = null;
        }
        if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') handleFrame(parsed);
      }
    };

    if (!body) {
      // 少数环境拿不到流式 body：退回一次性文本解析，行为保持一致。
      const text = await response.text();
      for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) {
        if (block.trim()) handleBlock(block);
        if (finished) break;
      }
      return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        if (seq !== this.turnSeq) {
          try {
            await reader.cancel();
          } catch {
            /* already closed */
          }
          return;
        }
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let splitAt = buffer.indexOf('\n\n');
        while (splitAt >= 0) {
          const block = buffer.slice(0, splitAt);
          buffer = buffer.slice(splitAt + 2);
          if (block.trim()) handleBlock(block);
          if (finished) {
            try {
              await reader.cancel();
            } catch {
              /* already closed */
            }
            return;
          }
          splitAt = buffer.indexOf('\n\n');
        }
      }
      buffer += decoder.decode();
      for (const block of buffer.replace(/\r\n/g, '\n').split('\n\n')) {
        if (block.trim()) handleBlock(block);
        if (finished) break;
      }
    } catch (error) {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      throw error;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }

  /* ----------------------------- 朗读 ----------------------------- */

  private async speak(text: string, seq: number): Promise<void> {
    const sentences = splitSentences(text);
    if (sentences.length === 0) {
      await this.delay(250);
      return;
    }
    try {
      await this.speakWithEdgeTts(sentences, seq);
    } catch {
      if (seq !== this.turnSeq || this.closed) return;
      await this.speakWithBrowser(text, seq);
    }
  }

  private async speakWithEdgeTts(sentences: string[], seq: number): Promise<void> {
    const slots: Array<Promise<TtsSlot> | undefined> = new Array(sentences.length);
    const startSlot = (index: number): void => {
      if (index < 0 || index >= sentences.length || slots[index]) return;
      const sentence = sentences[index];
      slots[index] = this.fetchTts(sentence)
        .then((buffer) => ({ buffer }))
        .catch((error: unknown) => ({ error }));
    };
    for (let index = 0; index <= TTS_PREFETCH && index < sentences.length; index += 1) startSlot(index);
    for (let index = 0; index < sentences.length; index += 1) {
      if (seq !== this.turnSeq || this.closed) return;
      startSlot(index + TTS_PREFETCH);
      const slot = await slots[index];
      if (seq !== this.turnSeq || this.closed) return;
      if (!slot) throw new Error('TTS unavailable');
      if (slot.error !== undefined || !slot.buffer) {
        throw slot.error !== undefined ? slot.error : new Error('TTS unavailable');
      }
      await this.playBuffer(slot.buffer);
    }
  }

  private async fetchTts(text: string): Promise<AudioBuffer> {
    try {
      await this.audioContext.resume();
    } catch {
      /* context already running */
    }
    const response = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, accent: this.accent }),
    });
    if (!response.ok) throw new Error('TTS HTTP ' + String(response.status));
    const audio = await response.arrayBuffer();
    if (audio.byteLength === 0) throw new Error('TTS empty audio');
    return await this.audioContext.decodeAudioData(audio);
  }

  private playBuffer(buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      this.activeSources.add(source);
      const finish = (): void => {
        this.activeSources.delete(source);
        resolve();
      };
      source.onended = finish;
      try {
        source.start();
      } catch {
        finish();
      }
    });
  }

  private async speakWithBrowser(text: string, seq: number): Promise<void> {
    const synth = window.speechSynthesis;
    const VoiceCtor = (window as unknown as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance })
      .SpeechSynthesisUtterance;
    if (!synth || typeof VoiceCtor !== 'function') {
      await this.delay(Math.min(6000, 700 + text.length * 35));
      return;
    }
    const lang = this.recognitionLanguage();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(guard);
        resolve();
      };
      const utterance = new VoiceCtor(text);
      utterance.lang = lang;
      utterance.rate = 0.98;
      try {
        const voices = synth.getVoices ? synth.getVoices() : [];
        const desired = lang.toLowerCase();
        const prefix = desired.slice(0, 2);
        const normalize = (value: string): string => (value || '').replace('_', '-').toLowerCase();
        const match =
          voices.find((voice) => normalize(voice.lang) === desired) ||
          voices.find((voice) => normalize(voice.lang).startsWith(prefix));
        if (match) utterance.voice = match;
      } catch {
        /* voice list is cosmetic */
      }
      utterance.onend = finish;
      utterance.onerror = finish;
      const guard = window.setTimeout(finish, Math.max(4000, Math.min(60000, 1800 + text.length * 120)));
      try {
        synth.speak(utterance);
      } catch {
        finish();
      }
    });
    if (seq !== this.turnSeq) return;
  }

  private stopAudioPlayback(): void {
    for (const source of Array.from(this.activeSources)) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.activeSources.clear();
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* speech synthesis unavailable */
    }
  }

  /* ----------------------------- 杂项 ----------------------------- */

  private emit(event: ServerEvent): void {
    try {
      this.onEvent(event);
    } catch {
      /* UI 的错误不能弄挂语音会话 */
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  private clearTimers(): void {
    this.clearSilenceTimer();
    this.clearPendingCommit();
    this.clearHardCommit();
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.resumeTimer !== null) {
      window.clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }
}
