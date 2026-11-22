import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from './api'
import { LiveUtterance, type UtteranceResult } from './audio/liveSession'
import { explainMicError, startRecording, type ActiveRecording } from './audio/pcmRecorder'
import { ChatStream } from './components/ChatStream'
import { CoachPanel } from './components/CoachPanel'
import { HistoryDrawer } from './components/HistoryDrawer'
import { LessonReportView } from './components/LessonReportView'
import { MemoryDrawer } from './components/MemoryDrawer'
import { Part2Card } from './components/Part2Card'
import { PhonemeDrawer } from './components/PhonemeDrawer'
import { PlanDrawer } from './components/PlanDrawer'
import { SettingsDrawer } from './components/SettingsDrawer'
import { StartGate, type LessonSetup } from './components/StartGate'
import { TopBar } from './components/TopBar'
import { VoiceDock } from './components/VoiceDock'
import type {
  Accent,
  Bootstrap,
  CreateSessionResult,
  LearnerContext,
  LessonPlan,
  LessonReport,
  MicMode,
  Part2Stage,
  Phase,
  PracticeState,
  Profile,
  PronWord,
  SendProgress,
  Session,
  ThemeName,
  Turn,
  TurnReply,
  WsEvent,
} from './types'

interface ActiveExaminer {
  turnId: number | null
  text: string
  audioUrl: string | null
  part: string
}

interface Part2State {
  stage: Part2Stage
  deadline: number | null
}

type ErrorKind = 'microphone' | 'network' | 'audio' | 'playback'
interface AppError { message: string; kind: ErrorKind }
type ThemePreference = ThemeName | 'system'

const EMPTY_EXAMINER: ActiveExaminer = { turnId: null, text: '', audioUrl: null, part: 'part1' }
const INITIAL_SEND_PROGRESS: SendProgress = { active: false, progress: 0, remainingSec: 0, thresholdSec: 0 }
const INITIAL_PRACTICE: PracticeState = { targetText: null, status: 'idle', elapsed: 0, result: null, error: null }

function playPrepChime() {
  try {
    const context = new AudioContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = 660
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.24)
    oscillator.onended = () => void context.close()
  } catch {
    // The visible stage transition remains available when audio is blocked.
  }
}

function App() {
  const params = new URLSearchParams(window.location.search)
  const preview = params.get('preview') === '1'
  const [sessionId, setSessionId] = useState<number | null>(() => Number(params.get('session')) || null)
  const initialSessionIdRef = useRef(sessionId)
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [state, setState] = useState<Bootstrap['state'] | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [context, setContext] = useState<LearnerContext | null>(null)
  const [plan, setPlan] = useState<LessonPlan | null>(null)
  const [report, setReport] = useState<LessonReport | null>(null)
  const [activeExaminer, setActiveExaminer] = useState<ActiveExaminer>(EMPTY_EXAMINER)
  const [phase, setPhase] = useState<Phase>('gate')
  const [mode, setMode] = useState<MicMode>('free')
  const [muted, setMuted] = useState(false)
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [sendProgress, setSendProgress] = useState<SendProgress>(INITIAL_SEND_PROGRESS)
  const [pendingTranscript, setPendingTranscript] = useState<string | null>(null)
  const [liveStuck, setLiveStuck] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [appError, setAppError] = useState<AppError | null>(null)
  const [accent, setAccent] = useState<Accent>('uk')
  const [starting, setStarting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [gateError, setGateError] = useState<string | null>(null)
  const [gateErrorKind, setGateErrorKind] = useState<ErrorKind | null>(null)
  const [selectedTurnId, setSelectedTurnId] = useState<number | null>(null)
  const [selectedWord, setSelectedWord] = useState<{ word: PronWord; audio: string | null } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [part2, setPart2] = useState<Part2State>({ stage: 'idle', deadline: null })
  const [part2Remaining, setPart2Remaining] = useState(0)
  const [scratchpad, setScratchpad] = useState<string[]>(['', '', '', ''])
  const [practice, setPractice] = useState<PracticeState>(INITIAL_PRACTICE)
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    const saved = localStorage.getItem('ielts-theme')
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  })
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)

  const activeAudioRef = useRef<HTMLAudioElement | null>(null)
  const utteranceRef = useRef<LiveUtterance | null>(null)
  const sessionIdRef = useRef<number | null>(sessionId)
  const phaseRef = useRef<Phase>(phase)
  const modeRef = useRef<MicMode>(mode)
  const mutedRef = useRef(muted)
  const currentPartRef = useRef('part1')
  const contextRef = useRef<LearnerContext | null>(null)
  const playTokenRef = useRef(0)
  const listeningStartedAtRef = useRef(0)
  const part2Ref = useRef(part2)
  const latestAnsweredIdRef = useRef<number | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const practiceRecorderRef = useRef<ActiveRecording | null>(null)
  const practiceTargetRef = useRef<string | null>(null)
  const practiceStartedAtRef = useRef(0)
  const practiceElapsedRef = useRef(0)
  const practiceTimerRef = useRef<number | null>(null)

  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  useEffect(() => { phaseRef.current = phase }, [phase])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { mutedRef.current = muted }, [muted])
  useEffect(() => { part2Ref.current = part2 }, [part2])
  useEffect(() => { contextRef.current = context }, [context])
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemDark(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const resolvedTheme: ThemeName = themePreference === 'system' ? (systemDark ? 'dark' : 'light') : themePreference
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    localStorage.setItem('ielts-theme', themePreference)
  }, [resolvedTheme, themePreference])
  useEffect(() => { if (params.get('embed') === '1') document.documentElement.dataset.embed = '1' }, [])

  const showNotice = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 4200)
  }, [])

  const loadBootstrap = useCallback(async (id: number) => {
    const data = await api.bootstrap(id)
    setSession(data.session)
    setState(data.state)
    setTurns(data.turns)
    setProfile(data.profile)
    setContext(data.context)
    setReport(data.report)
    setPlan(data.plan)
    setAccent(data.profile.accent_preference ?? 'uk')
    currentPartRef.current = data.state.current_part
    setActiveExaminer({ turnId: data.state.current_turn_id ?? null, text: data.state.examiner_text ?? '', audioUrl: data.state.examiner_audio_url, part: data.state.current_part })
    if (data.state.status === 'completed' || data.state.ended) setPhase('ended')
    return data
  }, [])

  useEffect(() => {
    let cancelled = false
    const initialize = async () => {
      try {
        const [profileResult, contextResult] = await Promise.allSettled([api.profile(), api.context()])
        if (cancelled) return
        if (profileResult.status === 'fulfilled') {
          setProfile(profileResult.value)
          setAccent(profileResult.value.accent_preference ?? 'uk')
        }
        if (contextResult.status === 'fulfilled') setContext(contextResult.value)
        const requested = initialSessionIdRef.current
        if (requested) {
          const data = await loadBootstrap(requested)
          if (preview) {
            setPhase('idle')
            if (data.state.current_part === 'part2') {
              setPart2({ stage: 'prep', deadline: Date.now() + 60_000 })
              setPart2Remaining(60)
            }
          }
          return
        }
        const data = await api.sessions()
        if (cancelled) return
        const active = data.sessions.find((item) => item.status === 'active')
        if (active) {
          setSessionId(active.id)
          sessionIdRef.current = active.id
          await loadBootstrap(active.id)
        } else {
          setPhase('gate')
        }
      } catch (error) {
        if (!cancelled) {
          setGateError(`无法连接本地口语服务：${String(error)}`)
          setGateErrorKind('network')
          setPhase('gate')
        }
      } finally { if (!cancelled) setStarting(false) }
    }
    void initialize()
    return () => { cancelled = true }
  }, [loadBootstrap, preview])

  useEffect(() => {
    if (params.get('embed') !== '1') return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && sessionIdRef.current) void loadBootstrap(sessionIdRef.current).catch(() => undefined)
    }, 15000)
    return () => window.clearInterval(timer)
  }, [loadBootstrap])

  const stopExaminerPlayback = useCallback(() => {
    playTokenRef.current += 1
    activeAudioRef.current?.pause()
    activeAudioRef.current = null
  }, [])

  const playExaminer = useCallback(async (url: string | null) => {
    const token = ++playTokenRef.current
    activeAudioRef.current?.pause()
    setPhase('examiner_speaking')
    if (!url) { setPhase('idle'); return }
    try {
      const audio = new Audio(url)
      activeAudioRef.current = audio
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve()
        audio.onerror = () => reject(new Error('考官音频加载失败'))
        void audio.play().catch(reject)
      })
    } catch {
      if (token === playTokenRef.current) {
        setAppError({ kind: 'playback', message: '浏览器未能播放考官音频。请先点击页面上的播放或重听按钮，再重新播放。' })
        showNotice('音频未能自动播放，可点重听或按空格开始回答')
      }
    } finally {
      if (activeAudioRef.current && token === playTokenRef.current) activeAudioRef.current = null
      if (token === playTokenRef.current) setPhase('idle')
    }
  }, [showNotice])

  const submitUtterance = useCallback(async (id: number, result: UtteranceResult) => {
    setPhase('submitting')
    setSendProgress(INITIAL_SEND_PROGRESS)
    setLiveStuck(false)
    try {
      const reply: TurnReply = await api.uploadAudio(id, result.blob, result.probeId)
      if (sessionIdRef.current !== id) return
      setPendingTranscript(reply.transcript ?? null)
      setPhase('thinking')
      const data = await api.turns(id)
      if (sessionIdRef.current !== id) return
      setTurns(data.turns)
      const latest = data.turns[data.turns.length - 1]
      if (latest) {
        currentPartRef.current = latest.part
        setActiveExaminer({ turnId: latest.id, text: latest.examiner_question, audioUrl: latest.examiner_audio_url ?? null, part: latest.part })
      }
    } catch (error) {
      const message = String(error)
      setAppError({
        kind: error instanceof ApiError && (error.status === 400 || /音频|audio|wav/i.test(message)) ? 'audio' : 'network',
        message: error instanceof ApiError && error.status === 400
          ? `本地服务没有接受这段音频。录音格式应为 16kHz、单声道、16bit PCM WAV。${message}`
          : `回答没有提交成功：${message}。请确认 127.0.0.1:8765 的 daemon 正在运行。`,
      })
      setPhase('idle')
      showNotice('提交失败，修复后可以重新回答')
    } finally { setPendingTranscript(null) }
  }, [showNotice])

  const cancelActive = useCallback(() => {
    const id = sessionIdRef.current
    const active = utteranceRef.current
    if (active) {
      utteranceRef.current = null
      active.cancel()
      setElapsed(0)
      setLevel(0)
      setSendProgress(INITIAL_SEND_PROGRESS)
      setLiveStuck(false)
      setPhase('idle')
      if (id) void api.recordingCancel(id).catch(() => undefined)
    }
  }, [])

  const startListening = useCallback(async (continuous = part2Ref.current.stage === 'speak') => {
    const id = sessionIdRef.current
    if (!id || utteranceRef.current || mutedRef.current || phaseRef.current === 'ended') return
    setAppError(null)
    setLiveStuck(false)
    setElapsed(0)
    setSendProgress(INITIAL_SEND_PROGRESS)
    listeningStartedAtRef.current = Date.now()
    setPhase('listening')
    try {
      await api.recordingStart(id)
      if (sessionIdRef.current !== id || utteranceRef.current) return
    } catch (error) {
      setPhase('idle')
      setAppError({ kind: 'network', message: `无法开始录音：${String(error)}。请确认本地 daemon 正在运行，且考官正在等待回答。` })
      return
    }
    const utterance = new LiveUtterance(id, {
      autoStop: !continuous && modeRef.current === 'free',
      onLevel: setLevel,
      onSendProgress: setSendProgress,
      onVad: (event) => {
        if (event.stuck) setLiveStuck(true)
        else if (event.speech) setLiveStuck(false)
      },
      onError: (message) => {
        const id = sessionIdRef.current
        setAppError({ kind: 'microphone', message })
        setPhase('idle')
        setSendProgress(INITIAL_SEND_PROGRESS)
        if (id) void api.recordingCancel(id).catch(() => undefined)
      },
      onFallback: () => showNotice('实时 VAD 暂不可用，已切换本地静音检测'),
    })
    utteranceRef.current = utterance
    const result = await utterance.run()
    if (utteranceRef.current === utterance) utteranceRef.current = null
    setLevel(0)
    setElapsed(0)
    setSendProgress(INITIAL_SEND_PROGRESS)
    setLiveStuck(false)
    if (!result) {
      if (sessionIdRef.current === id) {
        setPhase('idle')
        void api.recordingCancel(id).catch(() => undefined)
      }
      return
    }
    if (!result.enoughSpeech) {
      setPhase('idle')
      void api.recordingCancel(id).catch(() => undefined)
      showNotice('没有听清有效语音，请再试一次')
      if (modeRef.current === 'free' && part2Ref.current.stage === 'idle') window.setTimeout(() => void startListening(), 350)
      return
    }
    await submitUtterance(id, result)
  }, [showNotice, submitUtterance])

  const maybeAutoListen = useCallback((part?: string | null) => {
    const currentPart = part ?? currentPartRef.current
    if (currentPart === 'part2') {
      setPart2({ stage: 'prep', deadline: Date.now() + 60_000 })
      setPart2Remaining(60)
      setPhase('idle')
      return
    }
    if (modeRef.current === 'free' && !mutedRef.current) void startListening()
    else setPhase('idle')
  }, [startListening])

  const refreshTurns = useCallback(async () => {
    const id = sessionIdRef.current
    if (!id) return
    const data = await api.turns(id)
    setTurns(data.turns)
    const latest = data.turns[data.turns.length - 1]
    if (latest) {
      currentPartRef.current = latest.part
      setActiveExaminer({ turnId: latest.id, text: latest.examiner_question, audioUrl: latest.examiner_audio_url ?? null, part: latest.part })
    }
  }, [])

  useEffect(() => {
    if (!sessionId) return
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    let socket: WebSocket | null = null
    let closed = false
    let reconnectTimer = 0
    const connect = () => {
      if (closed) return
      socket = new WebSocket(`${protocol}://${window.location.host}/ws/${sessionId}`)
      socket.onmessage = (message: MessageEvent) => {
        let event: WsEvent
        try { event = JSON.parse(String(message.data)) as WsEvent } catch { return }
        if (event.type === 'hello') setState(event.state)
        if (event.type === 'state') setState((current) => current ? { ...current, status: event.status } : current)
        if (event.type === 'examiner_turn') {
          cancelActive()
          stopExaminerPlayback()
          setPart2({ stage: 'idle', deadline: null })
          if (event.part === 'part2') setScratchpad(['', '', '', ''])
          currentPartRef.current = event.part
          setActiveExaminer({ turnId: event.turn_id, text: event.text, audioUrl: event.audio_url, part: event.part })
          void playExaminer(event.audio_url).then(() => maybeAutoListen(event.part))
        }
        if (event.type === 'feedback') {
          const feedback = event.feedback
          setTurns((current) => current.map((turn) => turn.id === feedback.turn_id
            ? { ...turn, grammar_feedback_json: feedback, corrected_text: feedback.corrected_text ?? turn.corrected_text, upgraded_text: feedback.upgraded_text ?? turn.upgraded_text }
            : turn))
        }
        if (event.type === 'turn_ready') void refreshTurns()
        if (event.type === 'lesson_ended') {
          setPart2({ stage: 'idle', deadline: null })
          setPhase('ended')
          cancelActive()
          void loadBootstrap(sessionId).catch(() => undefined)
          void api.report(sessionId).then(setReport).catch(() => undefined)
        }
        if (event.type === 'report') void api.report(sessionId).then(setReport).catch(() => undefined)
      }
      socket.onclose = () => {
        if (!closed && phaseRef.current !== 'ended') reconnectTimer = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => socket?.close()
    }
    connect()
    return () => { closed = true; window.clearTimeout(reconnectTimer); socket?.close() }
  }, [sessionId, cancelActive, stopExaminerPlayback, playExaminer, maybeAutoListen, refreshTurns, loadBootstrap])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (phaseRef.current === 'listening' && listeningStartedAtRef.current) setElapsed((Date.now() - listeningStartedAtRef.current) / 1000)
    }, 200)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (part2.stage === 'idle' || !part2.deadline) { setPart2Remaining(0); return }
    const tick = () => {
      const remaining = Math.max(0, ((part2.deadline ?? Date.now()) - Date.now()) / 1000)
      setPart2Remaining(remaining)
      if (remaining > 0) return
      if (part2.stage === 'prep') {
        setPart2({ stage: 'speak', deadline: Date.now() + 120_000 })
        setPart2Remaining(120)
        setPhase('idle')
        playPrepChime()
        window.setTimeout(() => void startListening(true), 0)
      } else {
        setPart2({ stage: 'idle', deadline: null })
        utteranceRef.current?.stopNow()
      }
    }
    tick()
    const timer = window.setInterval(tick, 200)
    return () => window.clearInterval(timer)
  }, [part2, startListening])

  useEffect(() => {
    const answered = turns.filter((turn) => Boolean(turn.learner_transcript || turn.learner_audio_url))
    const latest = answered[answered.length - 1]
    if (!latest) { setSelectedTurnId(null); latestAnsweredIdRef.current = null; return }
    if (latestAnsweredIdRef.current !== latest.id || !answered.some((turn) => turn.id === selectedTurnId)) {
      setSelectedTurnId(latest.id)
      latestAnsweredIdRef.current = latest.id
    }
  }, [turns, selectedTurnId])

  const unlockMedia = useCallback(async () => {
    const context = new AudioContext()
    await context.resume()
    const buffer = context.createBuffer(1, 1, context.sampleRate)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => void context.close()
    source.start(0)
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风采集')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    stream.getTracks().forEach((track) => track.stop())
  }, [])

  const beginExistingLesson = useCallback(async () => {
    if (!sessionId) return
    setStarting(true)
    setGateError(null)
    try {
      await unlockMedia()
      setPhase('idle')
      if (activeExaminer.text) await playExaminer(activeExaminer.audioUrl)
      maybeAutoListen(activeExaminer.part)
    } catch (error) {
      setGateError(explainMicError(error))
      setGateErrorKind('microphone')
    } finally { setStarting(false) }
  }, [sessionId, activeExaminer, unlockMedia, playExaminer, maybeAutoListen])

  const createLesson = useCallback(async (setup: LessonSetup) => {
    setCreating(true)
    setGateError(null)
    let unlocked = false
    try {
      await unlockMedia()
      unlocked = true
      const result: CreateSessionResult = await api.createSession({
        part_mode: setup.part_mode,
        topic_hint: setup.topic_hint,
        feedback_style: setup.feedback_style,
        target_band: setup.target_band,
        accent: setup.accent,
        auto_plan: true,
        drive_mode: profile?.llm_mode ?? 'standalone',
      })
      const id = result.session_id
      setSessionId(id)
      sessionIdRef.current = id
      setSession(result.session)
      setPlan(result.plan)
      setReport(null)
      setTurns([])
      setPart2({ stage: 'idle', deadline: null })
      setAccent(setup.accent)
      setProfile((current) => current ? { ...current, target_band: setup.target_band, accent_preference: setup.accent, feedback_style: setup.feedback_style } : current)
      setPhase('idle')
      const data = await loadBootstrap(id)
      if (data.state.examiner_text) {
        await playExaminer(data.state.examiner_audio_url)
        maybeAutoListen(data.state.current_part)
      } else {
        showNotice(result.drive_mode ? '课程已创建，正在等待考官第一题' : '课程已创建；当前 daemon 未返回 drive_mode，若直连未出题请更新配套后端')
      }
    } catch (error) {
      setGateError(unlocked ? `新课程创建失败：${String(error)}` : explainMicError(error))
      setGateErrorKind(unlocked ? 'network' : 'microphone')
      setPhase('gate')
    } finally { setCreating(false) }
  }, [profile, unlockMedia, loadBootstrap, playExaminer, maybeAutoListen, showNotice])

  const startPart2Speaking = useCallback(() => {
    if (part2Ref.current.stage !== 'prep') return
    cancelActive()
    setPart2({ stage: 'speak', deadline: Date.now() + 120_000 })
    setPart2Remaining(120)
    setPhase('idle')
    playPrepChime()
    window.setTimeout(() => void startListening(true), 0)
  }, [cancelActive, startListening])

  const stopOrStart = useCallback(() => {
    if (part2Ref.current.stage === 'prep') { startPart2Speaking(); return }
    if (utteranceRef.current) utteranceRef.current.stopNow()
    else if (phaseRef.current === 'idle') void startListening()
  }, [startListening, startPart2Speaking])

  const changeMode = useCallback((next: MicMode) => {
    modeRef.current = next
    setMode(next)
    cancelActive()
    setPhase('idle')
    if (part2Ref.current.stage === 'speak' && !mutedRef.current) {
      window.setTimeout(() => void startListening(true), 0)
    } else if (next === 'free' && !mutedRef.current && part2Ref.current.stage === 'idle') {
      window.setTimeout(() => void startListening(), 0)
    }
  }, [cancelActive, startListening])

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current
    mutedRef.current = next
    setMuted(next)
    if (next) cancelActive()
    else if (part2Ref.current.stage === 'speak') void startListening(true)
    else if (modeRef.current === 'free' && part2Ref.current.stage === 'idle') void startListening()
  }, [cancelActive, startListening])

  const cancelPractice = useCallback(() => {
    if (practiceTimerRef.current) window.clearTimeout(practiceTimerRef.current)
    const recorder = practiceRecorderRef.current
    practiceRecorderRef.current = null
    recorder?.cancel()
    practiceTargetRef.current = null
    practiceElapsedRef.current = 0
    setPractice(INITIAL_PRACTICE)
  }, [])

  const finishPractice = useCallback(async () => {
    const recorder = practiceRecorderRef.current
    const targetText = practiceTargetRef.current
    const id = sessionIdRef.current
    if (!recorder || !targetText || !id) return
    practiceRecorderRef.current = null
    if (practiceTimerRef.current) window.clearTimeout(practiceTimerRef.current)
    setPractice((current) => ({ ...current, status: 'uploading', error: null }))
    try {
      const recording = await recorder.stop()
      if (recording.durationSec < 2) {
        setPractice((current) => ({ ...current, status: 'idle', error: '跟读至少需要 2 秒，本次没有上传。' }))
        return
      }
      const result = await api.practiceSentence(id, recording.blob, targetText, accent)
      if (sessionIdRef.current === id && practiceTargetRef.current === targetText) setPractice((current) => ({ ...current, status: 'idle', result, error: null }))
    } catch (error) {
      const message = error instanceof ApiError && error.status === 404
        ? '当前 daemon 尚未提供 practice_sentence，请更新配套后端后再进行跟读重测。'
        : `跟读评分失败：${String(error)}`
      setPractice((current) => ({ ...current, status: 'idle', error: message, result: null }))
    } finally { setLevel(0) }
  }, [accent])

  const beginPractice = useCallback(async (targetText: string, previousScore?: number | null) => {
    if (!targetText.trim()) return
    if (practiceRecorderRef.current) {
      if (practiceTargetRef.current === targetText) {
        if (practiceElapsedRef.current < 2) showNotice('跟读至少 2 秒，再完成重测')
        else await finishPractice()
      }
      return
    }
    if (practice.status === 'uploading') return
    if (part2Ref.current.stage === 'speak') {
      showNotice('请先完成并提交 Part 2 作答，再开始跟读')
      return
    }
    stopExaminerPlayback()
    cancelActive()
    setPhase('idle')
    practiceTargetRef.current = targetText
    practiceElapsedRef.current = 0
    setPractice({ targetText, previousScore, status: 'recording', elapsed: 0, result: null, error: null })
    try {
      const recorder = await startRecording({ onLevel: setLevel })
      if (practiceTargetRef.current !== targetText) { recorder.cancel(); return }
      practiceRecorderRef.current = recorder
      practiceStartedAtRef.current = Date.now()
      practiceTimerRef.current = window.setTimeout(() => void finishPractice(), 8000)
    } catch (error) {
      setPractice({ targetText, previousScore, status: 'idle', elapsed: 0, result: null, error: explainMicError(error) })
    }
  }, [practice.status, stopExaminerPlayback, cancelActive, finishPractice, showNotice])

  useEffect(() => {
    if (practice.status !== 'recording') return
    const update = () => {
      const value = Math.min(8, (Date.now() - practiceStartedAtRef.current) / 1000)
      practiceElapsedRef.current = value
      setPractice((current) => current.status === 'recording' ? { ...current, elapsed: value } : current)
    }
    update()
    const timer = window.setInterval(update, 100)
    return () => window.clearInterval(timer)
  }, [practice.status])

  const endLesson = useCallback(async () => {
    const id = sessionIdRef.current
    if (!id) return
    cancelActive()
    cancelPractice()
    stopExaminerPlayback()
    setPart2({ stage: 'idle', deadline: null })
    setReport(null)
    try {
      await api.endLesson(id)
      setPhase('ended')
      void api.report(id).then(setReport).catch(() => undefined)
    } catch (error) {
      setAppError({ kind: 'network', message: `结束课程失败：${String(error)}` })
      showNotice('暂时无法结束，请检查本地 daemon')
    }
  }, [cancelActive, cancelPractice, stopExaminerPlayback, showNotice])

  useEffect(() => {
    if (phase !== 'ended' || report || !sessionId) return
    const timer = window.setInterval(() => void api.report(sessionId).then(setReport).catch(() => undefined), 5000)
    return () => window.clearInterval(timer)
  }, [phase, report, sessionId])

  const replayAudio = useCallback((url: string | null) => {
    if (!url) return
    activeAudioRef.current?.pause()
    const audio = new Audio(url)
    activeAudioRef.current = audio
    void audio.play().catch(() => setAppError({ kind: 'playback', message: '音频播放失败，请在当前标签页中再点击一次播放。' }))
  }, [])

  const speakText = useCallback(async (text: string) => {
    try {
      const data = await api.ttsSay(text, accent)
      replayAudio(data.url)
    } catch (error) { showNotice(`示范音暂时不可用：${String(error)}`) }
  }, [accent, replayAudio, showNotice])

  const openSession = useCallback(async (id: number) => {
    cancelActive()
    cancelPractice()
    stopExaminerPlayback()
    setHistoryOpen(false)
    setReportOpen(false)
    setSelectedWord(null)
    setPart2({ stage: 'idle', deadline: null })
    setSessionId(id)
    sessionIdRef.current = id
    setPhase('gate')
    try { await loadBootstrap(id) } catch (error) { setGateError(String(error)); setGateErrorKind('network') }
  }, [cancelActive, cancelPractice, stopExaminerPlayback, loadBootstrap])

  const openSettings = useCallback(() => {
    cancelActive()
    cancelPractice()
    setPhase((current) => current === 'ended' || current === 'gate' ? current : 'idle')
    setSettingsOpen(true)
  }, [cancelActive, cancelPractice])

  const restartLesson = useCallback(() => {
    if (!session) return
    setReportOpen(false)
    void createLesson({
      part_mode: session.part_mode,
      topic_hint: '',
      target_band: session.target_band ?? profile?.target_band ?? 7.5,
      accent: profile?.accent_preference ?? accent,
      feedback_style: session.feedback_style,
    })
  }, [session, profile, accent, createLesson])

  const downloadReport = useCallback(() => {
    if (!report) return
    const url = URL.createObjectURL(new Blob([report.report_markdown], { type: 'text/markdown;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `ielts-lesson-${report.session_id}.md`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [report])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.code === 'Escape') {
        setSelectedWord(null); setHistoryOpen(false); setMemoryOpen(false); setPlanOpen(false); setSettingsOpen(false)
        return
      }
      if (event.code !== 'Space' || historyOpen || memoryOpen || planOpen || settingsOpen || reportOpen || selectedWord || phaseRef.current === 'gate') return
      event.preventDefault()
      if (practiceRecorderRef.current) {
        if (practiceElapsedRef.current >= 2) void finishPractice()
        else showNotice('跟读至少 2 秒，再完成重测')
        return
      }
      if (phaseRef.current === 'listening' || phaseRef.current === 'idle') stopOrStart()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [historyOpen, memoryOpen, planOpen, settingsOpen, reportOpen, selectedWord, stopOrStart, finishPractice, showNotice])

  useEffect(() => () => {
    utteranceRef.current?.cancel()
    practiceRecorderRef.current?.cancel()
    activeAudioRef.current?.pause()
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
  }, [])

  const openStandalone = () => {
    const url = new URL(window.location.href)
    url.search = ''
    url.hash = ''
    url.searchParams.set('embed', '0')
    if (sessionId) url.searchParams.set('session', String(sessionId))
    window.open(url.toString(), '_blank', 'noopener')
  }

  const selectedTurn = turns.find((turn) => turn.id === selectedTurnId) ?? null
  const currentPart = activeExaminer.part || session?.part_mode || 'part1'
  const questionIndex = Math.max(0, plan?.questions.findIndex((question) => question.text === activeExaminer.text) ?? 0)
  const recordedHints = turns[turns.length - 1]?.long_pauses_json?.stuck?.hint_words ?? []
  const hintWords = recordedHints.length > 0 ? recordedHints : ['in my opinion', 'to be honest']
  const errorInstructions = appError?.kind === 'microphone'
    ? ['在地址栏的网站权限中允许麦克风。', '侧栏内无法授权时，在新标签页打开本页面。', '确认当前地址是 127.0.0.1 或 localhost。']
    : appError?.kind === 'audio'
      ? ['重新录一小段清晰语音。', '前端会继续发送 16kHz、单声道、16bit PCM WAV。']
      : appError?.kind === 'playback'
        ? ['先点击一次页面按钮完成播放解锁。', '确认标签页没有静音，再点击重听。']
        : ['确认本地 daemon 已启动。', '在独立标签页访问 127.0.0.1:8765 检查服务。']
  const renderCoach = (turn: Turn | null) => <CoachPanel turn={turn} practice={practice} onPractice={(text, score) => void beginPractice(text, score)} onSpeak={(text) => void speakText(text)} onSelectWord={(word, audio) => setSelectedWord({ word, audio })} />
  const part2Card = part2.stage !== 'idle' ? <Part2Card question={activeExaminer.text} topic={session?.topic_title ?? ''} stage={part2.stage} remaining={part2Remaining} scratchpad={scratchpad} onScratchpadChange={(index, value) => setScratchpad((current) => current.map((item, itemIndex) => itemIndex === index ? value : item))} onStartSpeaking={startPart2Speaking} /> : null

  if (phase === 'gate') return <div className="app">
    <StartGate session={session} profile={profile} starting={starting} creating={creating} error={gateError} errorKind={gateErrorKind} inIframe={window.self !== window.top} onStart={() => void beginExistingLesson()} onCreate={(setup) => void createLesson(setup)} onOpenHistory={() => setHistoryOpen(true)} onOpenSettings={() => setSettingsOpen(true)} onOpenStandalone={openStandalone} />
    <HistoryDrawer open={historyOpen} currentSessionId={sessionId ?? -1} onClose={() => setHistoryOpen(false)} onOpen={(id) => void openSession(id)} />
    <SettingsDrawer open={settingsOpen} profile={profile} onClose={() => setSettingsOpen(false)} onSaved={setProfile} />
  </div>

  return <div className="app studio-app">
    <TopBar topic={session?.topic_title ?? ''} partMode={session?.part_mode ?? null} currentPart={currentPart} questionIndex={questionIndex} questionCount={plan?.questions.length ?? 0} speaking={phase === 'examiner_speaking'} theme={resolvedTheme} onToggleTheme={() => setThemePreference(resolvedTheme === 'dark' ? 'light' : 'dark')} onOpenPlan={() => setPlanOpen(true)} onOpenMemory={() => setMemoryOpen(true)} onOpenHistory={() => setHistoryOpen(true)} onOpenSettings={openSettings} />
    <div className="studio-layout">
      <main className="dialogue-pane">
        <div className="dialogue-part2">{part2Card}</div>
        <ChatStream turns={turns} activeExaminer={activeExaminer} selectedTurnId={selectedTurnId} phase={phase} pendingTranscript={pendingTranscript} onSelectTurn={setSelectedTurnId} onSelectWord={(word, audio) => setSelectedWord({ word, audio })} onReplay={replayAudio} renderCoach={renderCoach} />
        {appError && <section className="error-panel" role="alert"><strong>{appError.kind === 'microphone' ? '麦克风需要修复' : appError.kind === 'playback' ? '播放需要解锁' : appError.kind === 'audio' ? '音频格式或内容未被接受' : '本地连接需要检查'}</strong><p>{appError.message}</p><ol>{errorInstructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ol><div><button className="text-button" onClick={() => setAppError(null)}>知道了</button><button className="secondary-button" onClick={() => { setAppError(null); if (phase === 'idle') void startListening() }}>重试</button></div></section>}
        {phase === 'ended' && <section className="ended-card"><p className="eyebrow">LESSON COMPLETE</p><h1>这节课完成了</h1><p>{report ? '报告、趋势图与复练清单已生成。' : '报告生成后会自动更新，也可以先查看课堂记录。'}</p><div className="ended-actions"><button className="secondary-button" onClick={() => setReportOpen(true)}>查看报告</button><button className="primary-button" onClick={restartLesson}>开始下一课</button></div></section>}
      </main>
      <div className="coach-pane">{part2Card}{renderCoach(selectedTurn)}</div>
    </div>

    <VoiceDock phase={phase} part2Stage={part2.stage} mode={mode} muted={muted} level={level} elapsed={elapsed} sendProgress={sendProgress} hintWords={liveStuck ? hintWords : []} onHint={(word) => void speakText(word)} onPrimary={stopOrStart} onChangeMode={changeMode} onToggleMute={toggleMute} onReplay={() => { if (activeExaminer.audioUrl) void playExaminer(activeExaminer.audioUrl).then(() => maybeAutoListen(activeExaminer.part)) }} onEndLesson={() => void endLesson()} onShowReport={() => setReportOpen(true)} />
    {notice && <div className="notice" role="status">{notice}</div>}
    <PhonemeDrawer word={selectedWord?.word ?? null} learnerAudioUrl={selectedWord?.audio} accent={accent} practice={practice} onPractice={(text, score) => void beginPractice(text, score)} onClose={() => setSelectedWord(null)} />
    <HistoryDrawer open={historyOpen} currentSessionId={sessionId ?? -1} onClose={() => setHistoryOpen(false)} onOpen={(id) => void openSession(id)} />
    {context && <MemoryDrawer open={memoryOpen} context={context} onClose={() => setMemoryOpen(false)} />}
    <PlanDrawer open={planOpen} plan={plan} onClose={() => setPlanOpen(false)} />
    <SettingsDrawer open={settingsOpen} profile={profile} onClose={() => setSettingsOpen(false)} onSaved={(saved) => { setProfile(saved); setAccent(saved.accent_preference) }} />
    {reportOpen && <LessonReportView report={report} turns={turns} context={context} targetBand={profile?.target_band ?? session?.target_band ?? 7.5} onClose={() => setReportOpen(false)} onRestart={restartLesson} onDownload={downloadReport} onSpeak={(text) => void speakText(text)} onReplay={replayAudio} onSelectWord={(word, audio) => setSelectedWord({ word, audio })} />}
  </div>
}

export default App
