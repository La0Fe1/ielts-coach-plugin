import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildExaminerSystemPrompt,
  planLesson,
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
import { DraftCaption } from './realtime/speechFallback';
import { exportArchive, importArchive, listLessons, listMemory, saveLesson, saveMemory, saveReport } from './storage/db';
import { HistorySheet } from './components/HistorySheet';
import { LiveStage, type CueState } from './components/LiveStage';
import { ReportView } from './components/ReportView';
import { SettingsSheet } from './components/SettingsSheet';
import { SetupCard } from './components/SetupCard';

const STORAGE_KEY = 'ielts-v2-settings';

const DEFAULT_SETTINGS: RealtimeSettings = {
  provider: 'qwen',
  model: 'qwen3-omni-flash-realtime',
  partMode: 'part1',
  targetBand: 7,
  style: 'friendly',
  turnMode: 'auto',
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

  const clientRef = useRef<RealtimeClient | null>(null);
  const captureRef = useRef<CaptureHandle | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const draftCaptionRef = useRef<DraftCaption | null>(null);
  const draftTimerRef = useRef<number | null>(null);
  const planRef = useRef<LessonPlan | null>(null);
  const lessonIdRef = useRef<string>('');
  const linesRef = useRef<TranscriptLine[]>([]);
  const userTurnsRef = useRef(0);
  const cueTimerRef = useRef<number | null>(null);
  const partRef = useRef<string>('part1');
  const analyzingRef = useRef<Set<string>>(new Set());
  const draftUserRef = useRef('');
  const greetedRef = useRef(false);
  const pendingUnmuteRef = useRef(false);

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

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const refreshLocal = useCallback(() => {
    listLessons()
      .then((items) => setHistory(items))
      .catch(() => undefined);
    listMemory()
      .then((items) => setMemory(items))
      .catch(() => undefined);
  }, []);

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
      coachApiKey: current.coachApiKey,
      coachBaseUrl: current.coachBaseUrl,
      coachModel: current.coachModel,
    };
  }, []);

  const pushLine = useCallback((line: TranscriptLine) => {
    linesRef.current = [...linesRef.current, line];
    setLines(linesRef.current);
  }, []);

  const analyzeTurn = useCallback(
    async (turnId: string, learnerText: string, examinerQuestion: string) => {
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
        if (lessonIdRef.current) {
          const plan = planRef.current;
          void saveLesson({
            id: lessonIdRef.current,
            startedAt: Date.now(),
            endedAt: null,
            partMode: current.partMode,
            topic: plan?.topic || '',
            provider: current.provider,
            lines: linesRef.current,
            feedback: nextMap,
            report: null,
          });
        }
      } catch {
        /* the card is best-effort */
      }
    },
    [coachPayload],
  );

  const releaseMicAfterTail = useCallback(() => {
    pendingUnmuteRef.current = true;
    const player = playerRef.current;
    if (!player) return;
    player.onIdle = () => {
      if (!pendingUnmuteRef.current) return;
      pendingUnmuteRef.current = false;
      captureRef.current?.setMuted(false);
    };
  }, []);

  const beginCue = useCallback((text: string) => {
    setCue({ text, stage: 'prep', remaining: 60 });
    captureRef.current?.setMuted(true);
    clientRef.current?.send({ type: 'update_turn_mode', turnMode: 'manual' });
    if (cueTimerRef.current) window.clearInterval(cueTimerRef.current);
    let remaining = 60;
    cueTimerRef.current = window.setInterval(() => {
      remaining -= 1;
      setCue((current) => (current ? { ...current, remaining: Math.max(0, remaining) } : current));
      if (remaining <= 0) {
        if (cueTimerRef.current) window.clearInterval(cueTimerRef.current);
        setCue((current) => (current ? { ...current, stage: 'speak', remaining: 120 } : current));
        captureRef.current?.setMuted(false);
      }
    }, 1000);
  }, []);

  const startCueSpeaking = useCallback(() => {
    if (cueTimerRef.current) window.clearInterval(cueTimerRef.current);
    setCue((current) => (current ? { ...current, stage: 'speak', remaining: 120 } : current));
    captureRef.current?.setMuted(false);
    clientRef.current?.send({ type: 'update_turn_mode', turnMode: 'manual' });
    let remaining = 120;
    cueTimerRef.current = window.setInterval(() => {
      remaining -= 1;
      setCue((current) => (current ? { ...current, remaining: Math.max(0, remaining) } : current));
      if (remaining <= 0 && cueTimerRef.current) window.clearInterval(cueTimerRef.current);
    }, 1000);
  }, []);

  const finishCue = useCallback(() => {
    if (cueTimerRef.current) window.clearInterval(cueTimerRef.current);
    cueTimerRef.current = null;
    clientRef.current?.send({ type: 'commit_turn' });
    clientRef.current?.send({ type: 'update_turn_mode', turnMode: 'auto' });
    captureRef.current?.setMuted(false);
    setCue(null);
  }, []);

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
            clientRef.current?.send({
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
        if (speakerModeRef.current) captureRef.current?.setMuted(false);
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
        pushLine({ id: event.itemId + '-' + String(Date.now()), role: 'user', text, final: true, at: Date.now() });
        userTurnsRef.current += 1;
        void analyzeTurn(linesRef.current[linesRef.current.length - 1].id, text, lastExaminer?.text || '');
        return;
      }
      if (event.type === 'examiner_transcript_delta') {
        setOrb('speaking');
        if (speakerModeRef.current) captureRef.current?.setMuted(true);
        setDraftExaminer((current) => current + event.delta);
        return;
      }
      if (event.type === 'examiner_transcript_final') {
        const text = event.text;
        if (text && text.trim()) {
          pushLine({ id: event.itemId + '-' + String(Date.now()), role: 'examiner', text: text.trim(), final: true, at: Date.now() });
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
        setError(event.message);
        setBusy(false);
        setOrb('idle');
      }
    },
    [analyzeTurn, beginCue, pushLine, releaseMicAfterTail],
  );

  const start = useCallback(async () => {
    const current = settingsRef.current;
    const hasCredentials = Boolean(current.apiKey || current.accessCode || config?.serverProviders[current.provider]);
    if (!hasCredentials) {
      setSettingsOpen(true);
      return;
    }
    setError(null);
    setBusy(true);
    setFeedbackMap({});
    setCurrentFeedbackId(null);
    setLines([]);
    linesRef.current = [];
    userTurnsRef.current = 0;
    draftUserRef.current = '';
    greetedRef.current = false;
    setDraftUser('');
    setDraftExaminer('');
    setCue(null);
    setReport(null);

    const recentMemory = memory.slice(0, 5).map((note) => note.title + ': ' + note.content);
    const plan = planLesson(current.partMode, current.targetBand);
    planRef.current = plan;
    partRef.current = plan.questions[0]?.part || 'part1';
    lessonIdRef.current = 'l-' + String(Date.now());
    void saveLesson({
      id: lessonIdRef.current,
      startedAt: Date.now(),
      endedAt: null,
      partMode: current.partMode,
      topic: plan.topic,
      provider: current.provider,
      lines: [],
      feedback: {},
      report: null,
    });

    try {
      // AudioContext must be created and resumed inside the click handler.
      const Context =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const context = new Context();
      await context.resume();
      const player = new PcmPlayer(24000, context);
      playerRef.current = player;
      const capture = await startCapture({
        context,
        onPcm: (pcm) => clientRef.current?.sendAudio(pcm),
      });
      captureRef.current = capture;
      if (current.partMode === 'part2' || plan.questions[0]?.kind === 'cue_card') capture.setMuted(true);

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
      setStage('live');
      setOrb('idle');
      setBusy(false);
    } catch (startError) {
      setBusy(false);
      setError('无法开始：' + String((startError as Error).message || startError));
      captureRef.current?.stop();
      captureRef.current = null;
      clientRef.current?.close();
      clientRef.current = null;
    }
  }, [config, handleServerEvent, memory, wsUrl]);

  const stopAll = useCallback(() => {
    if (cueTimerRef.current) window.clearInterval(cueTimerRef.current);
    cueTimerRef.current = null;
    clientRef.current?.send({ type: 'end_session' });
    clientRef.current?.close();
    clientRef.current = null;
    captureRef.current?.stop();
    captureRef.current = null;
    playerRef.current?.flush();
    draftCaptionRef.current?.stop();
    setCue(null);
    setDraftUser('');
    setDraftExaminer('');
    setOrb('idle');
    setStage('setup');
  }, []);

  const endLesson = useCallback(async () => {
    const localLines = linesRef.current;
    clientRef.current?.send({ type: 'end_session' });
    clientRef.current?.close();
    clientRef.current = null;
    captureRef.current?.stop();
    captureRef.current = null;
    playerRef.current?.flush();
    setCue(null);
    setStage('report');
    setReportLoading(true);
    setError(null);
    try {
      const turns: Array<{ examinerQuestion: string; learnerTranscript: string }> = [];
      let lastQuestion = '';
      for (const line of localLines) {
        if (line.role === 'examiner') lastQuestion = line.text;
        else if (line.role === 'user') turns.push({ examinerQuestion: lastQuestion, learnerTranscript: line.text });
      }
      const response = await fetch('/api/coach/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...coachPayload(),
          partMode: settingsRef.current.partMode,
          targetBand: settingsRef.current.targetBand,
          turns,
        }),
      });
      const data = (await response.json()) as { report?: LessonReport; error?: string };
      if (!response.ok || !data.report) {
        setError(data.error || '报告生成失败，请检查精批模型设置后重试。');
        return;
      }
      setReport(data.report);
      if (lessonIdRef.current) {
        await saveReport(lessonIdRef.current, data.report);
        await saveMemory(data.report.memory_updates);
      }
      refreshLocal();
    } catch (reportError) {
      setError('报告生成失败：' + String((reportError as Error).message || reportError));
    } finally {
      setReportLoading(false);
    }
  }, [coachPayload, refreshLocal]);

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
      captureRef.current?.setMuted(!current);
      return !current;
    });
  }, []);

  const toggleHandsFree = useCallback(() => {
    setSettings((current) => {
      const next = { ...current, turnMode: current.turnMode === 'auto' ? ('manual' as const) : ('auto' as const) };
      clientRef.current?.send({ type: 'update_turn_mode', turnMode: next.turnMode });
      return next;
    });
  }, []);

  const commitTurn = useCallback(() => {
    if (settingsRef.current.turnMode === 'auto') {
      clientRef.current?.send({ type: 'interrupt' });
      playerRef.current?.flush();
    } else {
      clientRef.current?.send({ type: 'commit_turn' });
    }
  }, []);

  const feedbackIds = useMemo(() => {
    const map: Record<string, boolean> = {};
    Object.keys(feedbackMap).forEach((key) => {
      map[key] = true;
    });
    return map;
  }, [feedbackMap]);

  const currentFeedback = currentFeedbackId ? feedbackMap[currentFeedbackId] || null : null;
  const questionIndex = Math.min(userTurnsRef.current, (planRef.current?.questions.length || 1) - 1);

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
          onOpenHistory={() => setHistoryOpen(true)}
          busy={busy}
          error={error}
          ready={Boolean(settings.apiKey || settings.accessCode || config?.serverProviders[settings.provider])}
          historyCount={history.length}
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
            clientRef.current?.send({ type: 'interrupt' });
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
        />
      )}

      {stage === 'report' && (
        <ReportView report={report} loading={reportLoading} onRestart={() => setStage('setup')} onDownload={downloadReport} />
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
      />

      <HistorySheet
        open={historyOpen}
        lessons={history}
        memory={memory}
        onClose={() => setHistoryOpen(false)}
        onExport={() => void exportData()}
        onImport={(file) => void importData(file)}
      />

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
  if (provider === 'qwen') return '百炼通义';
  if (provider === 'gemini') return 'Gemini';
  return 'OpenAI';
}
