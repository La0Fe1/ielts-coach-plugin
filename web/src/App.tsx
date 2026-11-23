import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildExaminerSystemPrompt,
  planLesson,
  type ClientEvent,
  type LessonPlan,
  type LessonRecord,
  type LessonReport,
  type MemoryNote,
  type PublicConfig,
  type RealtimeSettings,
  type ServerEvent,
  type TranscriptLine,
  type TurnFeedback,
} from '@ielts/shared';
import { startCapture, type CaptureHandle } from './audio/capture';
import { PcmPlayer } from './audio/player';
import { RealtimeClient } from './realtime/client';
import { DeepSeekVoiceSession, SPEECH_UNSUPPORTED_NOTICE } from './realtime/deepseekSession';
import { DraftCaption } from './realtime/speechFallback';
import {
  deleteMemoryNote,
  exportArchive,
  importArchive,
  listLessons,
  listMemory,
  saveLesson,
  saveMemory,
  saveReport,
} from './storage/db';
import { HistorySheet } from './components/HistorySheet';
import { LiveStage, type CueState } from './components/LiveStage';
import { ReportView } from './components/ReportView';
import { SettingsSheet } from './components/SettingsSheet';
import { SetupCard, type CoachBanner } from './components/SetupCard';

const STORAGE_KEY = 'ielts-v2-settings';

const DEFAULT_SETTINGS: RealtimeSettings = {
  provider: 'qwen',
  model: 'qwen3-omni-flash-realtime',
  partMode: 'part1',
  targetBand: 7,
  style: 'friendly',
  turnMode: 'auto',
  reviewMode: 'auto',
};

function loadSettings(): RealtimeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<RealtimeSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const PART_LABEL: Record<string, string> = {
  part1: 'Part 1 日常问答',
  part2: 'Part 2 题卡独白',
  part3: 'Part 3 深度思辨',
  full_mock: '全真模考',
};

/** Copy/paste prompt that turns an external AI client (豆包 / dsh / Codex) into the coach. */
function buildExternalPrompt(lessonId: string): string {
  const id = lessonId || '（lessonId 未生成，请刷新页面后重试）';
  return [
    '请复盘我刚练完的这节雅思口语课（lessonId: ' + id + '）。',
    '请按顺序完成：',
    '1) 调用 get_lesson_transcript（lessonId: ' + id + '）读取完整对话字幕；',
    '2) 逐句做红绿对比改正：有问题的原句标红、正确版本标绿，并用中文解释关键语法问题；',
    '3) 给出 Band 8 升级表达，替换原句里最普通的地方；',
    '4) 调用 save_turn_feedback 把逐句精批写回这节课；',
    '5) 调用 save_lesson_report 写回四维分数（FC / LR / GRA / PR）、总评和升级句；',
    '6) 调用 upsert_memory 记下 2-3 条长期记忆，下次开课网页考官会自动带上。',
  ].join('\n');
}

export default function App() {
  const [settings, setSettings] = useState<RealtimeSettings>(loadSettings);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [stage, setStage] = useState<'setup' | 'live' | 'report'>('setup');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<LessonRecord[]>([]);
  const [memory, setMemory] = useState<MemoryNote[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [draftUser, setDraftUser] = useState('');
  const [draftExaminer, setDraftExaminer] = useState('');
  const [orb, setOrb] = useState<'idle' | 'listening' | 'speaking' | 'thinking'>('idle');
  const [muted, setMuted] = useState(false);
  const [speakerMode, setSpeakerMode] = useState(true);
  const [captionsVisible, setCaptionsVisible] = useState(true);
  const [mobileSide, setMobileSide] = useState(false);
  const [feedbackMap, setFeedbackMap] = useState<Record<string, TurnFeedback>>({});
  const [currentFeedbackId, setCurrentFeedbackId] = useState<string | null>(null);
  const [cue, setCue] = useState<CueState | null>(null);
  const [report, setReport] = useState<LessonReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [coachLesson, setCoachLesson] = useState<LessonRecord | null>(null);
  const [externalPrompt, setExternalPrompt] = useState<string | null>(null);
  /** DeepSeek 纯语音：识别语言可随时切换（en / zh）。 */
  const [recognitionLanguage, setRecognitionLanguage] = useState<'en' | 'zh'>('en');
  /** 非阻塞友好提示（SpeechRecognition 不可用 / 网络受限 / 权限被拒）。 */
  const [deepseekNotice, setDeepseekNotice] = useState<string | null>(null);
  /** 「获取 API Key」按钮：打开设置并自动展开获取指南。 */
  const [guideRequested, setGuideRequested] = useState(false);

  const clientRef = useRef<RealtimeClient | null>(null);
  const deepseekRef = useRef<DeepSeekVoiceSession | null>(null);
  const captureRef = useRef<CaptureHandle | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const draftCaptionRef = useRef<DraftCaption | null>(null);
  const draftTimerRef = useRef<number | null>(null);
  const planRef = useRef<LessonPlan | null>(null);
  const lessonIdRef = useRef<string>('');
  /** Fixed once in start(): every persisted snapshot reuses it (no Date.now() overwrite). */
  const lessonStartedAtRef = useRef<number>(0);
  const lessonEndedAtRef = useRef<number | null>(null);
  const reportRef = useRef<LessonReport | null>(null);
  const reviewFocusRef = useRef<string | undefined>(undefined);
  /** A ?lesson=<id> hand-off from an AI client, consumed by the next start(). */
  const deepLinkRef = useRef<{ lesson: LessonRecord; plan: LessonPlan | null } | null>(null);
  const linesRef = useRef<TranscriptLine[]>([]);
  const userTurnsRef = useRef(0);
  const cueTimerRef = useRef<number | null>(null);
  /** True during the 60 s Part 2 prep: the mic must stay off even after examiner audio ends. */
  const cueLockRef = useRef(false);
  const partRef = useRef<string>('part1');
  const analyzingRef = useRef<Set<string>>(new Set());
  const draftUserRef = useRef('');
  const greetedRef = useRef(false);
  const pendingUnmuteRef = useRef(false);
  const memoryRef = useRef<MemoryNote[]>([]);
  /** Serialises lesson writes so snapshots are stored in creation order. */
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Every callback below reads state through refs: React closures captured at
  // connect time must never decide mute/echo/断线 behaviour later.
  const settingsRef = useRef(settings);
  const stageRef = useRef(stage);
  const speakerModeRef = useRef(speakerMode);
  const feedbackMapRef = useRef(feedbackMap);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);
  useEffect(() => {
    speakerModeRef.current = speakerMode;
  }, [speakerMode]);
  useEffect(() => {
    feedbackMapRef.current = feedbackMap;
  }, [feedbackMap]);

  const handsFree = settings.turnMode === 'auto';
  const externalMode = (settings.reviewMode || 'auto') === 'external';
  const isDeepSeek = settings.provider === 'deepseek';

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  /**
   * Headers for every browser↔server lesson/memory call. In MULTI_USER_MODE
   * deployments the entered access code must be sent as a Bearer token,
   * otherwise history/memory sync is rejected with 401. Never send the raw
   * provider API key here — only the shared access code.
   */
  const syncHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settingsRef.current.accessCode) headers.Authorization = 'Bearer ' + settingsRef.current.accessCode;
    return headers;
  }, []);

  const refreshMemory = useCallback(async () => {
    const [local, remote] = await Promise.all([
      listMemory().catch(() => [] as MemoryNote[]),
      fetch('/api/memory', { headers: syncHeaders() })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { memory?: MemoryNote[] } | null) => data?.memory || [])
        .catch(() => [] as MemoryNote[]),
    ]);
    const merged = [...local];
    for (const note of remote) {
      if (!merged.some((item) => item.id === note.id)) merged.push(note);
    }
    merged.sort((a, b) => b.createdAt - a.createdAt);
    memoryRef.current = merged;
    setMemory(merged);
  }, [syncHeaders]);

  const refreshLocal = useCallback(() => {
    listLessons()
      .then((items) => {
        setHistory(items);
        return fetch('/api/lessons?limit=20', { headers: syncHeaders() })
          .then((response) => (response.ok ? response.json() : null))
          .then((data: { lessons?: LessonRecord[] } | null) => {
            const merged = new Map<string, LessonRecord>(items.map((item) => [item.id, item]));
            for (const lesson of data?.lessons || []) {
              const local = merged.get(lesson.id);
              if (!local) {
                merged.set(lesson.id, lesson);
                continue;
              }
              // An external AI client can add feedback/report to the server copy
              // long after the browser saved the raw transcript: prefer the richer one.
              const preferServer =
                (lesson.report && !local.report) ||
                (lesson.lines?.length || 0) > (local.lines?.length || 0) ||
                Object.keys(lesson.feedback || {}).length > Object.keys(local.feedback || {}).length ||
                (lesson.status === 'completed' && local.status !== 'completed');
              if (preferServer) {
                merged.set(lesson.id, {
                  ...local,
                  ...lesson,
                  feedback: { ...local.feedback, ...lesson.feedback },
                });
              }
            }
            setHistory([...merged.values()].sort((a, b) => b.startedAt - a.startedAt));
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
    void refreshMemory();
  }, [refreshMemory, syncHeaders]);

  /** ?lesson=<id>: an AI client planned this lesson and handed the browser a deep link. */
  useEffect(() => {
    const lessonParam = new URLSearchParams(location.search).get('lesson');
    if (!lessonParam) return;
    let cancelled = false;
    fetch('/api/lessons/' + encodeURIComponent(lessonParam), { headers: syncHeaders() })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { lesson?: LessonRecord } | null) => {
        const lesson = data?.lesson;
        if (cancelled) return;
        if (!lesson) {
          setError('链接里的 AI 定制课表没有载入成功：可能链接已失效，或当前环境不允许读取服务器课表。也可以直接在下面随机抽题开始。');
          return;
        }
        deepLinkRef.current = { lesson, plan: lesson.plan || null };
        setCoachLesson(lesson);
        setSettings((current) => ({
          ...current,
          partMode: lesson.partMode,
          targetBand: lesson.plan?.targetBand ?? current.targetBand,
        }));
        setHistory((current) =>
          [lesson, ...current.filter((item) => item.id !== lesson.id)].sort((a, b) => b.startedAt - a.startedAt),
        );
        setError(null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [syncHeaders]);

  useEffect(() => {
    fetch('/api/config/public')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: PublicConfig | null) => setConfig(data))
      .catch(() => undefined);
    refreshLocal();
  }, [refreshLocal]);

  const patchSettings = useCallback((patch: Partial<RealtimeSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  /** Build the full LessonRecord for the current in-memory snapshot. */
  const buildLessonRecord = useCallback((extra?: Partial<LessonRecord>): LessonRecord | null => {
    const id = lessonIdRef.current;
    if (!id) return null;
    const current = settingsRef.current;
    const plan = planRef.current;
    return {
      id,
      startedAt: lessonStartedAtRef.current || Date.now(),
      endedAt: lessonEndedAtRef.current,
      partMode: plan?.partMode || current.partMode,
      topic: plan?.topic || '',
      provider: current.provider,
      lines: linesRef.current,
      feedback: feedbackMapRef.current,
      report: reportRef.current,
      status: 'live',
      plan,
      reviewFocus: reviewFocusRef.current,
      ...extra,
    };
  }, []);

  /**
   * Persist the current lesson to IndexedDB and the shared server store.
   * Called after every final subtitle line, every feedback card and on end.
   * Local writes are chained so an older snapshot can never overwrite a newer one;
   * the server sync is best-effort and aborted if the local gateway stalls.
   */
  const persistLesson = useCallback(
    (extra?: Partial<LessonRecord>) => {
      const record = buildLessonRecord(extra);
      if (!record) return;
      persistQueueRef.current = persistQueueRef.current
        .then(() => saveLesson(record).catch(() => undefined))
        .then(
          () => undefined,
          () => undefined,
        );
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 8000);
      void fetch('/api/lessons/' + encodeURIComponent(record.id) + '/sync', {
        method: 'POST',
        headers: syncHeaders(),
        body: JSON.stringify(record),
        signal: controller.signal,
      })
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => window.clearTimeout(timer));
    },
    [buildLessonRecord, syncHeaders],
  );

  const wsUrl = useMemo(() => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    return protocol + '://' + location.host + '/ws/realtime';
  }, []);

  const coachPayload = useCallback(() => {
    const current = settingsRef.current;
    return {
      provider: current.provider,
      apiKey: current.apiKey,
      accessCode: current.accessCode,
      reviewMode: current.reviewMode || 'auto',
      coachApiKey: current.coachApiKey,
      coachBaseUrl: current.coachBaseUrl,
      coachModel: current.coachModel,
    };
  }, []);

  const pushLine = useCallback((line: TranscriptLine) => {
    linesRef.current = [...linesRef.current, line];
    setLines(linesRef.current);
  }, []);

  /** 控制面事件（提交 / 打断 / 切模式 / 开场 / 挂断）：deepseek 走浏览器控制器，其余走 WebSocket。 */
  const sendControl = useCallback((event: ClientEvent) => {
    const deepseek = deepseekRef.current;
    if (deepseek) {
      deepseek.send(event);
      return;
    }
    clientRef.current?.send(event);
  }, []);

  /** 麦克风开关：deepseek 暂停/恢复浏览器识别，其余模式静音 PCM 采集。 */
  const setMicMuted = useCallback((mutedNow: boolean) => {
    const deepseek = deepseekRef.current;
    if (deepseek) {
      deepseek.setMuted(mutedNow);
      return;
    }
    captureRef.current?.setMuted(mutedNow);
  }, []);

  const analyzeTurn = useCallback(
    async (turnId: string, learnerText: string, examinerQuestion: string) => {
      // External review mode: no per-turn API calls at all, the transcript is corrected later.
      if ((settingsRef.current.reviewMode || 'auto') === 'external') return;
      if (analyzingRef.current.has(turnId)) return;
      if (learnerText.trim().split(/\s+/).length < 3) return;
      if (/^[\u4e00-\u9fa5]+$/.test(learnerText.trim())) return;
      analyzingRef.current.add(turnId);
      const current = settingsRef.current;
      try {
        const response = await fetch('/api/coach/analyze-turn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...coachPayload(),
            part: partRef.current,
            examinerQuestion,
            learnerTranscript: learnerText,
            targetBand: current.targetBand,
            recentHistory: linesRef.current.slice(-6).map((line) => ({ role: line.role, text: line.text })),
          }),
        });
        if (!response.ok) {
          analyzingRef.current.delete(turnId);
          return;
        }
        const data = (await response.json()) as { feedback: TurnFeedback | null };
        if (!data.feedback) return;
        const nextMap = { ...feedbackMapRef.current, [turnId]: data.feedback };
        feedbackMapRef.current = nextMap;
        setFeedbackMap(nextMap);
        setCurrentFeedbackId(turnId);
        persistLesson();
      } catch {
        /* the card is best-effort */
      }
    },
    [coachPayload, persistLesson],
  );

  const releaseMicAfterTail = useCallback(() => {
    // Part 2 prep owns the mic: never unmute just because examiner audio finished.
    if (cueLockRef.current) {
      pendingUnmuteRef.current = false;
      return;
    }
    pendingUnmuteRef.current = true;
    const player = playerRef.current;
    if (!player) {
      // DeepSeek 纯语音没有 PCM 尾巴：控制器自己的 TTS 已经播完，直接恢复识别。
      if (deepseekRef.current) {
        pendingUnmuteRef.current = false;
        if (!cueLockRef.current) setMicMuted(false);
      }
      return;
    }
    player.onIdle = () => {
      if (!pendingUnmuteRef.current) return;
      pendingUnmuteRef.current = false;
      if (!cueLockRef.current) setMicMuted(false);
    };
  }, [setMicMuted]);

  const startSpeakCountdown = useCallback(() => {
    if (cueTimerRef.current) window.clearInterval(cueTimerRef.current);
    let remaining = 120;
    cueTimerRef.current = window.setInterval(() => {
      remaining -= 1;
      setCue((current) => (current ? { ...current, remaining: Math.max(0, remaining) } : current));
      if (remaining <= 0) {
        if (cueTimerRef.current) window.clearInterval(cueTimerRef.current);
        cueTimerRef.current = null;
      }
    }, 1000);
  }, []);

  /** Part 2: 60 s prep (mic muted) then 120 s speaking. */
  const beginCue = useCallback(
    (text: string) => {
      cueLockRef.current = true;
      setCue({ text, stage: 'prep', remaining: 60 });
      setMicMuted(true);
      sendControl({ type: 'update_turn_mode', turnMode: 'manual' });
      if (cueTimerRef.current) window.clearInterval(cueTimerRef.current);
      let remaining = 60;
      cueTimerRef.current = window.setInterval(() => {
        remaining -= 1;
        if (remaining > 0) {
          setCue((current) => (current ? { ...current, remaining } : current));
          return;
        }
        if (cueTimerRef.current) window.clearInterval(cueTimerRef.current);
        cueTimerRef.current = null;
        cueLockRef.current = false;
        setCue((current) => (current ? { ...current, stage: 'speak', remaining: 120 } : current));
        setMicMuted(false);
        startSpeakCountdown();
      }, 1000);
    },
    [sendControl, setMicMuted, startSpeakCountdown],
  );

  const startCueSpeaking = useCallback(() => {
    cueLockRef.current = false;
    setCue((current) => (current ? { ...current, stage: 'speak', remaining: 120 } : current));
    setMicMuted(false);
    sendControl({ type: 'update_turn_mode', turnMode: 'manual' });
    startSpeakCountdown();
  }, [sendControl, setMicMuted, startSpeakCountdown]);

  const finishCue = useCallback(() => {
    if (cueTimerRef.current) window.clearInterval(cueTimerRef.current);
    cueTimerRef.current = null;
    cueLockRef.current = false;
    sendControl({ type: 'commit_turn' });
    // Restore whatever turn-taking mode the learner configured before the cue.
    sendControl({
      type: 'update_turn_mode',
      turnMode: settingsRef.current.turnMode === 'manual' ? 'manual' : 'auto',
    });
    setMicMuted(false);
    setCue(null);
  }, [sendControl, setMicMuted]);

  const handleServerEvent = useCallback(
    (event: ServerEvent) => {
      if (event.type === 'session_ready') {
        setOrb('idle');
        if (!greetedRef.current) {
          greetedRef.current = true;
          const first = planRef.current?.questions[0];
          if (first?.kind === 'cue_card') {
            beginCue(first.text);
          } else {
            sendControl({
              type: 'trigger_greeting',
              text: 'Begin the lesson now: greet the learner in one short English sentence, then ask question 1 exactly as written.',
            });
          }
        }
        return;
      }
      if (event.type === 'user_speech_started') {
        playerRef.current?.flush();
        setOrb('listening');
        if (speakerModeRef.current && !cueLockRef.current) setMicMuted(false);
        pendingUnmuteRef.current = false;
        // Draft captions only if the server stays silent for 1.2 s.
        if (draftCaptionRef.current && draftTimerRef.current === null) {
          draftTimerRef.current = window.setTimeout(() => {
            draftCaptionRef.current?.start();
            draftTimerRef.current = null;
          }, 1200);
        }
        return;
      }
      if (event.type === 'user_speech_stopped') {
        setOrb('thinking');
        return;
      }
      if (event.type === 'user_transcript_delta') {
        if (draftTimerRef.current !== null) {
          window.clearTimeout(draftTimerRef.current);
          draftTimerRef.current = null;
        }
        draftCaptionRef.current?.stop();
        const next = event.mode === 'append' ? draftUserRef.current + event.text : event.text;
        draftUserRef.current = next;
        setDraftUser(next);
        return;
      }
      if (event.type === 'user_transcript_final') {
        const text = event.text.trim();
        draftUserRef.current = '';
        setDraftUser('');
        draftCaptionRef.current?.stop();
        if (!text) return;
        const lastExaminer = [...linesRef.current].reverse().find((line) => line.role === 'examiner');
        const turnId = event.itemId + '-' + String(Date.now());
        pushLine({ id: turnId, role: 'user', text, final: true, at: Date.now() });
        userTurnsRef.current += 1;
        // full_mock: the plan's next item can be the Part 2 cue card. Move the
        // current part forward and start the 60 s prep without a page reload.
        const nextQuestion = planRef.current?.questions[userTurnsRef.current];
        if (nextQuestion) {
          partRef.current = nextQuestion.part;
          if (nextQuestion.kind === 'cue_card') beginCue(nextQuestion.text);
        }
        persistLesson();
        void analyzeTurn(turnId, text, lastExaminer?.text || '');
        return;
      }
      if (event.type === 'examiner_transcript_delta') {
        setOrb('speaking');
        if (speakerModeRef.current && !cueLockRef.current) setMicMuted(true);
        setDraftExaminer((current) => current + event.delta);
        return;
      }
      if (event.type === 'examiner_transcript_final') {
        const text = event.text;
        if (text && text.trim()) {
          pushLine({
            id: event.itemId + '-' + String(Date.now()),
            role: 'examiner',
            text: text.trim(),
            final: true,
            at: Date.now(),
          });
          persistLesson();
        }
        setDraftExaminer('');
        return;
      }
      if (event.type === 'examiner_turn_done') {
        setOrb('idle');
        // Keep the mic muted until the audio tail really finished playing.
        if (speakerModeRef.current) releaseMicAfterTail();
        return;
      }
      if (event.type === 'error') {
        if (event.code.startsWith('speech_')) {
          // 浏览器识别不可用/被拒：只给友好提示 + 打字备用，不弹阻塞式错误框。
          setDeepseekNotice(event.message);
          setBusy(false);
          setOrb('idle');
          return;
        }
        setError(event.message);
        setBusy(false);
        setOrb('idle');
      }
    },
    [analyzeTurn, beginCue, persistLesson, pushLine, releaseMicAfterTail, sendControl, setMicMuted],
  );

  const start = useCallback(async () => {
    const current = settingsRef.current;
    const deepseekMode = current.provider === 'deepseek';
    // DeepSeek 纯语音：自己的 Key，或「服务端已配置 DEEPSEEK_API_KEY + 访问口令」。
    const hasCredentials = deepseekMode
      ? Boolean(current.apiKey || (config?.serverProviders.deepseek && current.accessCode))
      : Boolean(current.apiKey || current.accessCode || config?.serverProviders[current.provider]);
    if (!hasCredentials) {
      setSettingsOpen(true);
      return;
    }
    setError(null);
    setDeepseekNotice(null);
    setBusy(true);
    setFeedbackMap({});
    feedbackMapRef.current = {};
    setCurrentFeedbackId(null);
    setLines([]);
    linesRef.current = [];
    userTurnsRef.current = 0;
    draftUserRef.current = '';
    greetedRef.current = false;
    setDraftUser('');
    setDraftExaminer('');
    if (cueTimerRef.current) window.clearInterval(cueTimerRef.current);
    cueTimerRef.current = null;
    cueLockRef.current = false;
    setCue(null);
    setReport(null);
    reportRef.current = null;
    lessonEndedAtRef.current = null;
    setReportLoading(false);
    setExternalPrompt(null);

    // A ?lesson=<id> hand-off keeps its plan and id; everything else plans on the fly.
    const linked = deepLinkRef.current;
    const plan = linked?.plan || planLesson(current.partMode, current.targetBand);
    planRef.current = plan;
    partRef.current = plan.questions[0]?.part || 'part1';
    lessonIdRef.current = linked?.lesson.id || 'l-' + String(Date.now());
    lessonStartedAtRef.current = linked?.lesson.startedAt || Date.now();
    reviewFocusRef.current = linked?.lesson.reviewFocus;
    persistLesson();

    const recentMemory = memoryRef.current.slice(0, 5).map((note) => note.title + ': ' + note.content);
    const planPartMode = plan.partMode || current.partMode;

    try {
      // AudioContext must be created and resumed inside the click handler.
      const Context =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const context = new Context();
      await context.resume();

      if (deepseekMode) {
        // DeepSeek 纯语音：浏览器识别负责听、服务端 SSE + Edge TTS 负责说，
        // 不需要采集 PCM，也绝不创建 PcmPlayer / RealtimeClient。
        draftCaptionRef.current?.stop();
        draftCaptionRef.current = null;
        const session = new DeepSeekVoiceSession({
          accent: current.voiceAccent === 'us' ? 'us' : 'uk',
          turnMode: current.turnMode,
          language: recognitionLanguage,
          systemPrompt: buildExaminerSystemPrompt({ plan, style: current.style, memory: recentMemory }),
          model: current.model || 'deepseek-chat',
          apiKey: current.apiKey,
          accessCode: current.accessCode,
          endpointUrl: current.endpointUrl,
          audioContext: context,
        });
        deepseekRef.current = session;
        session.onEvent = handleServerEvent;
        session.onClose = (reason) => {
          if (stageRef.current === 'live') setError('连接已断开：' + reason);
        };
        if (planPartMode === 'part2' || plan.questions[0]?.kind === 'cue_card') session.setMuted(true);
        await session.connect();
        session.send({ type: 'update_turn_mode', turnMode: current.turnMode });
        if (!session.supported) setDeepseekNotice(SPEECH_UNSUPPORTED_NOTICE);
        deepLinkRef.current = null;
        setStage('live');
        setOrb('idle');
        setBusy(false);
        return;
      }

      const player = new PcmPlayer(24000, context);
      playerRef.current = player;
      const capture = await startCapture({
        context,
        onPcm: (pcm) => clientRef.current?.sendAudio(pcm),
      });
      captureRef.current = capture;
      if (planPartMode === 'part2' || plan.questions[0]?.kind === 'cue_card') capture.setMuted(true);

      const client = new RealtimeClient(wsUrl);
      clientRef.current = client;
      client.onEvent = handleServerEvent;
      client.onAudio = (pcm, rate) => player.enqueue(pcm, rate);
      client.onClose = (reason) => {
        if (stageRef.current === 'live') setError('连接已断开：' + reason);
      };
      draftCaptionRef.current = new DraftCaption((text) => setDraftUser(text));
      await client.connect();
      client.send({
        type: 'start_session',
        provider: current.provider,
        model: current.model,
        voice: current.voice,
        endpointUrl: current.endpointUrl,
        workspaceId: current.workspaceId,
        apiKey: current.apiKey,
        accessCode: current.accessCode,
        systemPrompt: buildExaminerSystemPrompt({ plan, style: current.style, memory: recentMemory }),
        turnMode: current.turnMode,
        inputSampleRate: 16000,
      });
      deepLinkRef.current = null;
      setStage('live');
      setOrb('idle');
      setBusy(false);
    } catch (startError) {
      setBusy(false);
      setError('无法开始：' + String((startError as Error).message || startError));
      deepseekRef.current?.close();
      deepseekRef.current = null;
      captureRef.current?.stop();
      captureRef.current = null;
      clientRef.current?.close();
      clientRef.current = null;
    }
  }, [config, handleServerEvent, persistLesson, recognitionLanguage, wsUrl]);

  const clearCoachLink = useCallback(() => {
    deepLinkRef.current = null;
    reviewFocusRef.current = undefined;
    lessonIdRef.current = '';
    setCoachLesson(null);
  }, []);

  const stopAll = useCallback(() => {
    if (cueTimerRef.current) window.clearInterval(cueTimerRef.current);
    cueTimerRef.current = null;
    cueLockRef.current = false;
    if (linesRef.current.length > 0) {
      const endedAt = Date.now();
      lessonEndedAtRef.current = endedAt;
      persistLesson({ endedAt, status: 'live' });
    }
    deepseekRef.current?.close();
    deepseekRef.current = null;
    clientRef.current?.send({ type: 'end_session' });
    clientRef.current?.close();
    clientRef.current = null;
    captureRef.current?.stop();
    captureRef.current = null;
    playerRef.current?.flush();
    playerRef.current = null;
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    draftCaptionRef.current?.stop();
    draftCaptionRef.current = null;
    setCue(null);
    setDraftUser('');
    setDraftExaminer('');
    setOrb('idle');
    setStage('setup');
    clearCoachLink();
  }, [clearCoachLink, persistLesson]);

  const restart = useCallback(() => {
    setStage('setup');
    setReport(null);
    reportRef.current = null;
    setExternalPrompt(null);
    setError(null);
    lessonEndedAtRef.current = null;
    clearCoachLink();
    try {
      const url = new URL(location.href);
      url.searchParams.delete('lesson');
      window.history.replaceState({}, '', url);
    } catch {
      /* URL rewriting is cosmetic */
    }
  }, [clearCoachLink]);

  const endLesson = useCallback(async () => {
    const endedAt = Date.now();
    lessonEndedAtRef.current = endedAt;
    if (cueTimerRef.current) window.clearInterval(cueTimerRef.current);
    cueTimerRef.current = null;
    cueLockRef.current = false;
    deepseekRef.current?.close();
    deepseekRef.current = null;
    clientRef.current?.send({ type: 'end_session' });
    clientRef.current?.close();
    clientRef.current = null;
    captureRef.current?.stop();
    captureRef.current = null;
    playerRef.current?.flush();
    playerRef.current = null;
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    draftCaptionRef.current?.stop();
    draftCaptionRef.current = null;
    setCue(null);
    setDraftUser('');
    setDraftExaminer('');
    setOrb('idle');
    setStage('report');
    setError(null);

    // External review: keep status "live" (the external client flips it to completed
    // when it calls save_lesson_report) and hand over a copyable prompt.
    if (externalMode) {
      persistLesson({ endedAt, status: 'live' });
      setReportLoading(false);
      setExternalPrompt(buildExternalPrompt(lessonIdRef.current));
      return;
    }

    persistLesson({ endedAt, status: 'completed' });
    const learnerTurns: Array<{ examinerQuestion: string; learnerTranscript: string }> = [];
    let lastQuestion = '';
    for (const line of linesRef.current) {
      if (line.role === 'examiner') lastQuestion = line.text;
      else if (line.role === 'user') learnerTurns.push({ examinerQuestion: lastQuestion, learnerTranscript: line.text });
    }
    if (learnerTurns.length === 0) {
      setReportLoading(false);
      return;
    }

    setReportLoading(true);
    try {
      const response = await fetch('/api/coach/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...coachPayload(),
          partMode: planRef.current?.partMode || settingsRef.current.partMode,
          targetBand: planRef.current?.targetBand || settingsRef.current.targetBand,
          turns: learnerTurns,
          memory: memoryRef.current.slice(0, 6).map((note) => note.title + ': ' + note.content),
        }),
      });
      const data = (await response.json()) as { report?: LessonReport; error?: string };
      if (!response.ok || !data.report) {
        setError(data.error || '报告生成失败，请检查精批模型设置后重试。');
        return;
      }
      reportRef.current = data.report;
      setReport(data.report);
      if (lessonIdRef.current) {
        await saveReport(lessonIdRef.current, data.report);
        await saveMemory(data.report.memory_updates);
        void fetch('/api/memory', {
          method: 'POST',
          headers: syncHeaders(),
          body: JSON.stringify({ items: data.report.memory_updates }),
        }).catch(() => undefined);
      }
      persistLesson({ report: data.report, endedAt, status: 'completed' });
      refreshLocal();
    } catch (reportError) {
      setError('报告生成失败：' + String((reportError as Error).message || reportError));
    } finally {
      setReportLoading(false);
    }
  }, [coachPayload, externalMode, persistLesson, refreshLocal, syncHeaders]);

  const downloadReport = useCallback(() => {
    if (!report) return;
    const text = [
      '# IELTS 口语课报告',
      '',
      '总分 ' +
        report.bands.overall.toFixed(1) +
        ' · FC ' +
        report.bands.fc.toFixed(1) +
        ' · LR ' +
        report.bands.lr.toFixed(1) +
        ' · GRA ' +
        report.bands.gra.toFixed(1) +
        ' · PR ' +
        report.bands.pr.toFixed(1),
      '',
      report.summary_zh,
      '',
      '## 升级句',
      ...report.upgraded_sentences.map((sentence) => '- ' + sentence),
    ].join('\n');
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'ielts-report.md';
    anchor.click();
    URL.revokeObjectURL(url);
  }, [report]);

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      setMicMuted(!current);
      return !current;
    });
  }, [setMicMuted]);

  const toggleHandsFree = useCallback(() => {
    setSettings((current) => {
      const next = { ...current, turnMode: current.turnMode === 'auto' ? ('manual' as const) : ('auto' as const) };
      sendControl({ type: 'update_turn_mode', turnMode: next.turnMode });
      return next;
    });
  }, [sendControl]);

  const commitTurn = useCallback(() => {
    if (settingsRef.current.turnMode === 'auto') {
      sendControl({ type: 'interrupt' });
      playerRef.current?.flush();
    } else {
      sendControl({ type: 'commit_turn' });
    }
  }, [sendControl]);

  const feedbackIds = useMemo(() => {
    const map: Record<string, boolean> = {};
    Object.keys(feedbackMap).forEach((key) => {
      map[key] = true;
    });
    return map;
  }, [feedbackMap]);

  const currentFeedback = currentFeedbackId ? feedbackMap[currentFeedbackId] || null : null;
  const questionIndex = Math.min(userTurnsRef.current, (planRef.current?.questions.length || 1) - 1);

  const coachBanner = useMemo<CoachBanner | null>(() => {
    if (!coachLesson) return null;
    const topic = coachLesson.plan?.topic || coachLesson.topic;
    const targetBand = coachLesson.plan?.targetBand;
    return {
      topic,
      reviewFocus: coachLesson.reviewFocus,
      targetBand: typeof targetBand === 'number' ? targetBand : undefined,
    };
  }, [coachLesson]);

  const deleteMemory = useCallback(
    async (note: MemoryNote) => {
      // Optimistic removal, then both stores.
      const nextLocal = memoryRef.current.filter((item) => item.id !== note.id);
      memoryRef.current = nextLocal;
      setMemory(nextLocal);
      await deleteMemoryNote(note.id).catch(() => undefined);
      await fetch('/api/memory/' + encodeURIComponent(note.id), {
        method: 'DELETE',
        headers: syncHeaders(),
      }).catch(() => undefined);
      await refreshMemory();
    },
    [refreshMemory, syncHeaders],
  );

  const exportData = useCallback(async () => {
    const json = await exportArchive();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'ielts-archive.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  const importData = useCallback(
    async (file: File) => {
      const text = await file.text();
      await importArchive(text);
      refreshLocal();
    },
    [refreshLocal],
  );

  const liveBanner = coachLesson
    ? 'AI 定制课表' + (coachLesson.reviewFocus ? ' · ' + coachLesson.reviewFocus : '')
    : externalMode
      ? '外部精批模式 · 课后复制提示词'
      : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className={'dot' + (stage === 'live' ? '' : ' idle')} />
          IELTS 口语教练
        </div>
        <div className="top-actions">
          <button className="ghost" onClick={() => setSettingsOpen(true)}>
            {settings.apiKey || settings.accessCode ? '🟢 ' + (settings.apiKey ? providerName(settings.provider) : '口令已连') : '⚪ 配置连接'}
          </button>
          {stage === 'live' && (
            <button className="ghost" onClick={stopAll}>
              挂断
            </button>
          )}
        </div>
      </header>

      {stage === 'setup' && (
        <SetupCard
          settings={settings}
          onChange={patchSettings}
          onStart={() => void start()}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenHistory={() => {
            setHistoryOpen(true);
            refreshLocal();
          }}
          busy={busy}
          error={error}
          ready={Boolean(settings.apiKey || settings.accessCode || config?.serverProviders[settings.provider])}
          historyCount={history.length}
          coachBanner={coachBanner}
          onOpenKeyGuide={() => {
            setSettingsOpen(true);
            setGuideRequested(true);
          }}
        />
      )}

      {stage === 'live' && (
        <LiveStage
          lines={lines}
          draftUser={draftUser}
          draftExaminer={draftExaminer}
          orb={orb}
          partLabel={PART_LABEL[settings.partMode]}
          questionIndex={questionIndex}
          questionCount={planRef.current?.questions.length || 0}
          muted={muted}
          handsFree={handsFree}
          speakerMode={speakerMode}
          captionsVisible={captionsVisible}
          cue={cue}
          feedback={currentFeedback}
          feedbackIds={feedbackIds}
          onToggleMute={toggleMute}
          onToggleHandsFree={toggleHandsFree}
          onToggleSpeaker={() => setSpeakerMode((current) => !current)}
          onToggleCaptions={() => setCaptionsVisible((current) => !current)}
          onCommit={commitTurn}
          onInterrupt={() => {
            sendControl({ type: 'interrupt' });
            playerRef.current?.flush();
          }}
          onEnd={() => void endLesson()}
          onStartCue={startCueSpeaking}
          onFinishCue={finishCue}
          onSelectFeedback={(turnId) => {
            setCurrentFeedbackId(turnId);
            setMobileSide(true);
          }}
          mobileSide={mobileSide}
          onToggleMobileSide={() => setMobileSide((current) => !current)}
          coachBanner={liveBanner}
          typingEnabled={isDeepSeek}
          onTypingSubmit={(text) => deepseekRef.current?.submitTypedText(text)}
          recognitionLanguage={isDeepSeek ? recognitionLanguage : undefined}
          onToggleRecognitionLanguage={() => {
            const next = recognitionLanguage === 'en' ? 'zh' : 'en';
            setRecognitionLanguage(next);
            deepseekRef.current?.setLanguage(next);
          }}
          notice={deepseekNotice}
        />
      )}

      {stage === 'report' && (
        <ReportView
          report={report}
          loading={reportLoading}
          emptyHint={
            externalMode
              ? '外部精批模式：本课字幕已保存到历史和服务器，网页不会调用精批 API。把复盘提示词发给豆包 / dsh / Codex，精批和四维报告会写回这节课。'
              : null
          }
          onShowPrompt={externalMode ? () => setExternalPrompt(buildExternalPrompt(lessonIdRef.current)) : null}
          onRestart={restart}
          onDownload={downloadReport}
        />
      )}

      <SettingsSheet
        open={settingsOpen}
        value={settings}
        config={config}
        onClose={() => setSettingsOpen(false)}
        onSave={(next) => {
          setSettings(next);
          setSettingsOpen(false);
        }}
        guideRequested={guideRequested}
        onGuideShown={() => setGuideRequested(false)}
      />

      <HistorySheet
        open={historyOpen}
        lessons={history}
        memory={memory}
        onClose={() => setHistoryOpen(false)}
        onExport={() => void exportData()}
        onImport={(file) => void importData(file)}
        onDeleteMemory={(note) => void deleteMemory(note)}
      />

      {externalPrompt && (
        <div className="sheet-backdrop" onClick={() => setExternalPrompt(null)}>
          <div className="sheet" onClick={(event) => event.stopPropagation()} role="dialog">
            <h2>本课已保存，去外部免费精批</h2>
            <p className="hint">
              字幕和记忆都已写回本地与服务器。把下面这段话整段发给豆包 / DeepSeek Harness / Codex，它们会通过 MCP
              读取完整字幕，免费出逐句红绿精批与四维报告。
            </p>
            <pre className="prompt-box">{externalPrompt}</pre>
            <div className="sheet-actions">
              <button
                className="ghost"
                onClick={() => {
                  void navigator.clipboard?.writeText(externalPrompt);
                }}
              >
                复制复盘提示词
              </button>
              <button className="primary" onClick={() => setExternalPrompt(null)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {error && stage !== 'setup' && (
        <div className="sheet-backdrop" onClick={() => setError(null)}>
          <div className="sheet" onClick={(event) => event.stopPropagation()} role="alertdialog">
            <h2>出了点问题</h2>
            <p className="error">{error}</p>
            <div className="sheet-actions">
              <button className="ghost" onClick={() => setError(null)}>
                知道了
              </button>
              <button className="primary" onClick={() => setSettingsOpen(true)}>
                去设置
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function providerName(provider: RealtimeSettings['provider']): string {
  if (provider === 'deepseek') return 'DeepSeek 纯语音';
  if (provider === 'qwen') return '百炼通义';
  if (provider === 'gemini') return 'Gemini';
  return 'OpenAI';
}
