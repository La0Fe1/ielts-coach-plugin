import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from './api'
import { LiveUtterance, type UtteranceResult } from './audio/liveSession'
import { explainMicError } from './audio/pcmRecorder'
import { StartGate } from './components/StartGate'
import { ExaminerBubble } from './components/ExaminerBubble'
import { LearnerBubble } from './components/LearnerBubble'
import { CorrectionCard } from './components/CorrectionCard'
import { PlanBar } from './components/PlanBar'
import { VoiceDock } from './components/VoiceDock'
import { Part2Timer } from './components/Part2Timer'
import { PhonemeDrawer } from './components/PhonemeDrawer'
import { HistoryDrawer } from './components/HistoryDrawer'
import { MemoryDrawer } from './components/MemoryDrawer'
import { LessonReportView } from './components/LessonReportView'
import type {
  Accent,
  LearnerContext,
  LessonPlan,
  LessonReport,
  MicMode,
  Phase,
  PronWord,
  Session,
  StateSnapshot,
  Turn,
  WsEvent,
} from './types'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function readSessionId(): number | null {
  const raw = new URLSearchParams(window.location.search).get('session')
  const value = raw ? Number(raw) : NaN
  return Number.isFinite(value) && value > 0 ? value : null
}

function runningInIframe(): boolean {
  try { return window.self !== window.top } catch { return true }
}

interface Part2State {
  stage: 'idle' | 'prep' | 'speak'
  deadline: number
}

interface ActiveExaminer {
  turnId: number | null
  text: string
  audioUrl: string | null
  part: string
}

interface AppError {
  kind: 'microphone' | 'network' | 'audio' | 'playback'
  message: string
}

function classifyError(error: unknown, fallback: AppError['kind'] = 'network'): AppError {
  if (error instanceof ApiError && error.status === 400) {
    return { kind: 'audio', message: error.message }
  }
  return { kind: fallback, message: error instanceof Error ? error.message : String(error) }
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'because', 'could', 'does', 'from', 'have', 'into', 'like', 'more', 'most',
  'some', 'than', 'that', 'their', 'there', 'these', 'they', 'this', 'what', 'when', 'where', 'which', 'with',
  'would', 'your', 'yours', 'you', 'and', 'are', 'for', 'the', 'why', 'how', 'did', 'can',
])

export default function App() {
  const previewMode = new URLSearchParams(window.location.search).get('preview') === '1'
  const [sessionId, setSessionId] = useState<number | null>(readSessionId)
  const [session, setSession] = useState<Session | null>(null)
  const [state, setState] = useState<StateSnapshot | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [report, setReport] = useState<LessonReport | null>(null)
  const [plan, setPlan] = useState<LessonPlan | null>(null)
  const [context, setContext] = useState<LearnerContext | null>(null)
  const [accent, setAccent] = useState<Accent>('uk')
  const [phase, setPhase] = useState<Phase>(previewMode ? 'idle' : 'gate')
  const [mode, setMode] = useState<MicMode>('auto')
  const [muted, setMuted] = useState(false)
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [pendingTranscript, setPendingTranscript] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [appError, setAppError] = useState<AppError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [liveStuck, setLiveStuck] = useState(false)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [selectedWord, setSelectedWord] = useState<{ word: PronWord; audioUrl: string | null } | null>(null)
  const [part2, setPart2] = useState<Part2State>({ stage: 'idle', deadline: 0 })
  const [part2Remaining, setPart2Remaining] = useState(0)
  const [activeExaminer, setActiveExaminer] = useState<ActiveExaminer>({
    turnId: null, text: '', audioUrl: null, part: 'part1',
  })

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const utteranceRef = useRef<LiveUtterance | null>(null)
  const sessionIdRef = useRef<number | null>(sessionId)
  const phaseRef = useRef<Phase>(previewMode ? 'idle' : 'gate')
  const modeRef = useRef<MicMode>('auto')
  const mutedRef = useRef(false)
  const part2Ref = useRef<Part2State>(part2)
  const currentPartRef = useRef('part1')
  const listeningStartedAtRef = useRef(0)
  const lastExaminerAudioRef = useRef<string | null>(null)
  const endOfChatRef = useRef<HTMLDivElement | null>(null)

  sessionIdRef.current = sessionId
  phaseRef.current = phase
  modeRef.current = mode
  mutedRef.current = muted
  part2Ref.current = part2
  currentPartRef.current = activeExaminer.part || state?.current_part || 'part1'

  const embedMode = new URLSearchParams(window.location.search).get('embed') === '1'

  useEffect(() => {
    if (embedMode) document.documentElement.dataset.embed = '1'
  }, [embedMode])

  const refreshTurns = useCallback(async (id?: number) => {
    const target = id ?? sessionIdRef.current
    if (!target) return
    const data = await api.turns(target)
    if (sessionIdRef.current === target) setTurns(data.turns)
  }, [])

  const loadBootstrap = useCallback(async (id: number) => {
    const data = await api.bootstrap(id)
    if (sessionIdRef.current !== id) return data
    setSession(data.session)
    setState(data.state)
    setTurns(data.turns)
    setContext(data.context)
    setReport(data.report ?? null)
    setPlan(data.plan ?? null)
    setAccent(data.profile.accent_preference ?? 'uk')
    setActiveExaminer({
      turnId: data.state.current_turn_id ?? null,
      text: data.state.examiner_text ?? '',
      audioUrl: data.state.examiner_audio_url,
      part: data.state.current_part || data.session.part_mode,
    })
    lastExaminerAudioRef.current = data.state.examiner_audio_url
    return data
  }, [])

  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      try {
        let id = sessionIdRef.current
        if (!id) {
          const list = await api.sessions()
          id = list.sessions.find((item) => item.status === 'active')?.id ?? list.sessions[0]?.id ?? null
        }
        if (!id || cancelled) return
        setSessionId(id)
        sessionIdRef.current = id
        const data = await loadBootstrap(id)
        if (!cancelled && data.session.status !== 'active') setPhase('ended')
      } catch (error) {
        if (!cancelled) setAppError(classifyError(error))
      }
    }
    void boot()
    return () => { cancelled = true }
  }, [loadBootstrap])

  useEffect(() => {
    if (!embedMode) return
    let stopped = false
    const poll = async () => {
      if (stopped || sessionIdRef.current) return
      try {
        const list = await api.sessions()
        const active = list.sessions.find((item) => item.status === 'active')
        if (!active || stopped) return
        const params = new URLSearchParams(window.location.search)
        params.set('session', String(active.id))
        window.history.replaceState(null, '', `?${params.toString()}`)
        sessionIdRef.current = active.id
        setSessionId(active.id)
        await loadBootstrap(active.id)
      } catch {
        // The sidebar may open before the daemon; keep the quiet gate visible.
      }
    }
    void poll()
    const handle = window.setInterval(poll, 4000)
    return () => {
      stopped = true
      window.clearInterval(handle)
    }
  }, [embedMode, loadBootstrap])

  const playExaminer = useCallback(async (url: string | null): Promise<void> => {
    setPhase('examiner_speaking')
    lastExaminerAudioRef.current = url
    if (!url) {
      await sleep(700)
      return
    }
    const audio = audioRef.current
    if (!audio) return
    audio.onended = null
    audio.onerror = null
    audio.src = url
    try {
      await audio.play()
    } catch {
      setAppError({ kind: 'playback', message: '浏览器没有放行考官语音。点击“重听问题”即可再次播放。' })
      await sleep(400)
      return
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        audio.onended = null
        audio.onerror = null
        resolve()
      }
      audio.onended = done
      audio.onerror = done
    })
  }, [])

  const submitUtterance = useCallback(async (result: UtteranceResult) => {
    const id = sessionIdRef.current
    if (!id) return
    setPhase('submitting')
    setAppError(null)
    const thinkingTimer = window.setTimeout(() => {
      if (sessionIdRef.current === id) setPhase('thinking')
    }, 650)
    try {
      const reply = await api.uploadAudio(id, result.blob)
      if (sessionIdRef.current !== id) return
      setPendingTranscript(reply.transcript ?? '')
      await refreshTurns(id)
      setPhase('thinking')
    } catch (error) {
      if (sessionIdRef.current !== id) return
      setPendingTranscript(null)
      setAppError(classifyError(error))
      setPhase('idle')
    } finally {
      window.clearTimeout(thinkingTimer)
    }
  }, [refreshTurns])

  const startListening = useCallback(async (continuous = part2Ref.current.stage !== 'idle') => {
    const id = sessionIdRef.current
    if (!id || mutedRef.current || utteranceRef.current) return
    if (phaseRef.current === 'gate' || phaseRef.current === 'ended' || phaseRef.current === 'submitting' || phaseRef.current === 'thinking') return

    setAppError(null)
    setNotice(null)
    setLiveStuck(false)
    setElapsed(0)
    listeningStartedAtRef.current = Date.now()
    let recordingFailed = false
    const utterance = new LiveUtterance(id, {
      autoStop: !continuous,
      onLevel: setLevel,
      onVad: (event) => {
        if (sessionIdRef.current !== id) return
        setLiveStuck(Boolean(event.stuck))
        if (event.speech_started && part2Ref.current.stage === 'prep') {
          utterance.markStart()
          listeningStartedAtRef.current = Date.now()
          setElapsed(0)
          setPart2({ stage: 'speak', deadline: Date.now() + 120_000 })
        }
      },
      onFallback: () => setNotice('本地 VAD 暂不可用，已用静音检测继续自动接话。'),
      onError: (message) => {
        if (sessionIdRef.current !== id) return
        recordingFailed = true
        setAppError({ kind: 'microphone', message })
        setPhase('idle')
      },
    })
    utteranceRef.current = utterance
    setPhase('listening')

    try {
      await api.recordingStart(id)
    } catch (error) {
      utterance.cancel()
      if (utteranceRef.current === utterance) utteranceRef.current = null
      setAppError(classifyError(error))
      setPhase('idle')
      return
    }

    const result = await utterance.run()
    if (sessionIdRef.current !== id) return
    if (utteranceRef.current && utteranceRef.current !== utterance) return
    utteranceRef.current = null
    setLevel(0)
    if (!result) {
      void api.recordingCancel(id).catch(() => undefined)
      if (!recordingFailed) setPhase('idle')
      return
    }
    if (!result.enoughSpeech) {
      void api.recordingCancel(id).catch(() => undefined)
      setNotice('刚才没有听清。可以靠近麦克风，再自然地说一次。')
      setPhase('idle')
      if (modeRef.current === 'auto' && !mutedRef.current) {
        window.setTimeout(() => void startListening(continuous), 350)
      }
      return
    }
    await submitUtterance(result)
  }, [submitUtterance])

  const cancelActive = useCallback(() => {
    const active = utteranceRef.current
    if (!active) return
    active.cancel()
    utteranceRef.current = null
    setLevel(0)
    const id = sessionIdRef.current
    if (id) void api.recordingCancel(id).catch(() => undefined)
  }, [])

  const maybeAutoListen = useCallback((part?: string | null) => {
    if ((part ?? currentPartRef.current) === 'part2') {
      setPart2({ stage: 'prep', deadline: Date.now() + 60_000 })
      setPhase('idle')
      if (modeRef.current === 'auto' && !mutedRef.current) void startListening(true)
      return
    }
    if (modeRef.current !== 'auto' || mutedRef.current) {
      setPhase('idle')
      return
    }
    setPhase('idle')
    void startListening()
  }, [startListening])

  useEffect(() => {
    if (!sessionId) return
    let disposed = false
    let socket: WebSocket | null = null
    let retry: number | undefined

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      socket = new WebSocket(`${protocol}://${window.location.host}/ws/${sessionId}`)
      socket.onclose = () => {
        if (!disposed) retry = window.setTimeout(connect, 2000)
      }
      socket.onmessage = (event) => {
        let payload: WsEvent
        try { payload = JSON.parse(event.data) as WsEvent } catch { return }
        if (payload.type === 'ping') return
        if (payload.type === 'hello') {
          setState(payload.state)
          return
        }
        if (payload.type === 'state') {
          setState((previous) => previous ? { ...previous, status: payload.status } : previous)
          return
        }
        if (payload.type === 'examiner_turn') {
          cancelActive()
          setAppError(null)
          setNotice(null)
          setPendingTranscript(null)
          setLiveStuck(false)
          setPart2({ stage: 'idle', deadline: 0 })
          setState((previous) => previous ? {
            ...previous,
            current_turn_id: payload.turn_id,
            current_part: payload.part,
            examiner_text: payload.text,
            examiner_audio_url: payload.audio_url,
          } : previous)
          setActiveExaminer({
            turnId: payload.turn_id,
            text: payload.text,
            audioUrl: payload.audio_url,
            part: payload.part,
          })
          void refreshTurns(sessionId).catch(() => undefined)
          const url = payload.audio_url ? `${payload.audio_url}?v=${Date.now()}` : null
          void playExaminer(url).then(() => maybeAutoListen(payload.part))
          return
        }
        if (payload.type === 'turn_ready') {
          void refreshTurns(sessionId).catch(() => undefined)
          return
        }
        if (payload.type === 'feedback') {
          void refreshTurns(sessionId).then(() => setPendingTranscript(null)).catch(() => undefined)
          return
        }
        if (payload.type === 'lesson_ended') {
          cancelActive()
          setPart2({ stage: 'idle', deadline: 0 })
          setSession((previous) => previous ? { ...previous, status: 'completed' } : previous)
          setPhase('ended')
          setReportOpen(true)
          return
        }
        if (payload.type === 'report') {
          void api.report(sessionId).then((data) => {
            setReport(data)
            setReportOpen(true)
          }).catch(() => undefined)
          void api.context().then(setContext).catch(() => undefined)
        }
      }
    }
    connect()
    return () => {
      disposed = true
      if (retry) window.clearTimeout(retry)
      socket?.close()
    }
  }, [sessionId, refreshTurns, playExaminer, maybeAutoListen, cancelActive])

  useEffect(() => {
    if (part2.stage === 'idle') {
      setPart2Remaining(0)
      return
    }
    const tick = () => {
      const left = Math.max(0, (part2.deadline - Date.now()) / 1000)
      setPart2Remaining(left)
      if (left > 0) return
      if (part2.stage === 'prep') {
        utteranceRef.current?.markStart()
        listeningStartedAtRef.current = Date.now()
        setElapsed(0)
        setPart2({ stage: 'speak', deadline: Date.now() + 120_000 })
        if (!utteranceRef.current) {
          setPhase('idle')
          window.setTimeout(() => void startListening(true), 0)
        }
      } else {
        setPart2({ stage: 'idle', deadline: 0 })
        utteranceRef.current?.stopNow()
      }
    }
    tick()
    const handle = window.setInterval(tick, 250)
    return () => window.clearInterval(handle)
  }, [part2, startListening])

  useEffect(() => {
    if (phase !== 'listening') return
    const tick = () => setElapsed((Date.now() - listeningStartedAtRef.current) / 1000)
    tick()
    const handle = window.setInterval(tick, 250)
    return () => window.clearInterval(handle)
  }, [phase])

  useEffect(() => {
    if (!notice) return
    const handle = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(handle)
  }, [notice])

  useEffect(() => {
    endOfChatRef.current?.scrollIntoView({ block: 'end' })
  }, [turns, phase, pendingTranscript, liveStuck])

  useEffect(() => () => {
    utteranceRef.current?.cancel()
    audioRef.current?.pause()
  }, [])

  const unlockAndStart = useCallback(async () => {
    if (!sessionIdRef.current) return
    setStarting(true)
    setAppError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
      try {
        const Ctor: typeof AudioContext = window.AudioContext
          || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const audioContext = new Ctor()
        await audioContext.resume()
        const buffer = audioContext.createBuffer(1, 1, 22050)
        const source = audioContext.createBufferSource()
        source.buffer = buffer
        source.connect(audioContext.destination)
        source.onended = () => { void audioContext.close() }
        source.start(0)
      } catch {
        // The explicit examiner play() below remains the playback unlock fallback.
      }
      setPhase('idle')
      if (activeExaminer.text) {
        const url = activeExaminer.audioUrl ? `${activeExaminer.audioUrl}?v=${Date.now()}` : null
        await playExaminer(url)
        maybeAutoListen(activeExaminer.part)
      } else {
        setNotice('麦克风已就绪。考官出题后，这里会自动开始。')
      }
    } catch (error) {
      setAppError({ kind: 'microphone', message: explainMicError(error) })
    } finally {
      setStarting(false)
    }
  }, [activeExaminer, maybeAutoListen, playExaminer])

  const stopOrStart = useCallback(() => {
    const active = utteranceRef.current
    if (active && part2Ref.current.stage === 'prep') {
      active.markStart()
      listeningStartedAtRef.current = Date.now()
      setElapsed(0)
      setPart2({ stage: 'speak', deadline: Date.now() + 120_000 })
    } else if (active) {
      active.stopNow()
    } else if (phaseRef.current === 'idle') {
      if (part2Ref.current.stage === 'prep') {
        setPart2({ stage: 'speak', deadline: Date.now() + 120_000 })
        window.setTimeout(() => void startListening(true), 0)
      } else {
        void startListening()
      }
    }
  }, [startListening])

  const replayLast = useCallback(() => {
    const url = lastExaminerAudioRef.current ?? activeExaminer.audioUrl
    if (!url) {
      setNotice('还没有可重听的考官语音。')
      return
    }
    cancelActive()
    void playExaminer(url).then(() => maybeAutoListen(activeExaminer.part))
  }, [activeExaminer, cancelActive, maybeAutoListen, playExaminer])

  const replayAudio = useCallback((url: string | null) => {
    if (!url) return
    const audio = new Audio(url)
    void audio.play().catch(() => setNotice('语音播放失败，请再试一次。'))
  }, [])

  const toggleMute = useCallback(() => {
    setMuted((previous) => {
      const next = !previous
      if (next) {
        cancelActive()
        setPhase('idle')
      } else if (modeRef.current === 'auto' && phaseRef.current === 'idle') {
        window.setTimeout(() => void startListening(), 100)
      }
      return next
    })
  }, [cancelActive, startListening])

  const changeMode = useCallback((next: MicMode) => {
    setMode(next)
    modeRef.current = next
    if (next === 'manual') {
      cancelActive()
      setPhase('idle')
    } else if (!mutedRef.current && phaseRef.current === 'idle') {
      void startListening()
    }
  }, [cancelActive, startListening])

  const endLesson = useCallback(async () => {
    const id = sessionIdRef.current
    if (!id) return
    cancelActive()
    setPart2({ stage: 'idle', deadline: 0 })
    try {
      await api.endLesson(id)
      setSession((previous) => previous ? { ...previous, status: 'completed' } : previous)
      setPhase('ended')
      setReportOpen(true)
    } catch (error) {
      setAppError(classifyError(error))
    }
  }, [cancelActive])

  const speakText = useCallback(async (text: string) => {
    if (!text.trim()) return
    try {
      const isSingleWord = /^[\p{L}'-]+$/u.test(text.trim())
      const data = isSingleWord ? await api.ttsWord(text.trim(), accent) : await api.ttsSay(text, accent)
      if (!data.url) throw new Error('missing audio url')
      await new Audio(data.url).play()
    } catch {
      setNotice('示范音暂时不可用，请确认本地语音服务已启动。')
    }
  }, [accent])

  const openSession = useCallback(async (id: number) => {
    cancelActive()
    setHistoryOpen(false)
    setReportOpen(false)
    setAppError(null)
    setPart2({ stage: 'idle', deadline: 0 })
    setPendingTranscript(null)
    const params = new URLSearchParams(window.location.search)
    params.set('session', String(id))
    window.history.replaceState(null, '', `?${params.toString()}`)
    sessionIdRef.current = id
    setSessionId(id)
    setPhase('gate')
    try {
      const data = await loadBootstrap(id)
      if (data.session.status !== 'active') setPhase('ended')
    } catch (error) {
      setAppError(classifyError(error))
    }
  }, [cancelActive, loadBootstrap])

  const restartLesson = useCallback(async () => {
    if (!session || restarting) return
    setRestarting(true)
    setAppError(null)
    cancelActive()
    try {
      const created = await api.createSession({
        part_mode: session.part_mode,
        topic_title: session.topic_title,
        feedback_style: session.feedback_style,
        auto_plan: true,
      })
      const id = created.session_id
      const params = new URLSearchParams(window.location.search)
      params.set('session', String(id))
      window.history.replaceState(null, '', `?${params.toString()}`)
      sessionIdRef.current = id
      setSessionId(id)
      setReport(null)
      setTurns([])
      setPart2({ stage: 'idle', deadline: 0 })
      setPendingTranscript(null)
      setReportOpen(false)
      await loadBootstrap(id)
      setPhase('gate')
    } catch (error) {
      setAppError(classifyError(error))
    } finally {
      setRestarting(false)
    }
  }, [session, restarting, cancelActive, loadBootstrap])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (historyOpen || memoryOpen || planOpen || reportOpen || selectedWord) return
      if (phaseRef.current === 'listening' || phaseRef.current === 'idle') {
        event.preventDefault()
        stopOrStart()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [historyOpen, memoryOpen, planOpen, reportOpen, selectedWord, stopOrStart])

  const hintWords = useMemo(() => {
    const activeTurn = turns.find((turn) => turn.id === activeExaminer.turnId)
    const saved = activeTurn?.long_pauses_json?.stuck?.hint_words ?? []
    const tags = plan?.topic.tags ?? []
    const questionWords = activeExaminer.text.match(/[A-Za-z][A-Za-z'-]+/g) ?? []
    const output: string[] = []
    for (const candidate of [...saved, ...tags, ...questionWords.reverse()]) {
      const word = candidate.trim().replace(/^[-.!?]+|[-.!?]+$/g, '')
      if (!/^[A-Za-z][A-Za-z'-]{2,}$/.test(word)) continue
      if (STOP_WORDS.has(word.toLowerCase())) continue
      if (!output.some((item) => item.toLowerCase() === word.toLowerCase())) output.push(word)
      if (output.length === 3) break
    }
    return output
  }, [turns, activeExaminer, plan])

  const startPart2Speaking = useCallback(() => {
    utteranceRef.current?.markStart()
    listeningStartedAtRef.current = Date.now()
    setElapsed(0)
    setPart2({ stage: 'speak', deadline: Date.now() + 120_000 })
    if (!utteranceRef.current) {
      setPhase('idle')
      window.setTimeout(() => void startListening(true), 0)
    }
  }, [startListening])

  const activeQuestionInTurns = turns.some((turn) =>
    (activeExaminer.turnId !== null && turn.id === activeExaminer.turnId)
    || (activeExaminer.turnId === null && turn.examiner_question === activeExaminer.text),
  )
  const showGate = phase === 'gate'
  const errorInstructions = appError?.kind === 'microphone'
    ? ['在地址栏的网站权限中允许麦克风。', runningInIframe() ? '侧栏内无法授权时，在新标签页打开本页。' : '检查系统麦克风隐私开关与其他录音程序。']
    : appError?.kind === 'audio'
      ? ['回到课堂重新录一次，不要上传其他格式。', '本界面会生成后端支持的 16kHz 单声道 16bit WAV。']
      : appError?.kind === 'playback'
        ? ['点击声音条里的“重听问题”。', '若仍然没有声音，检查浏览器标签页是否被静音。']
        : ['确认本地 daemon 正在 127.0.0.1:8765 运行。', '恢复连接后点击重试；学习记录仍保存在本机。']

  return (
    <div className="app">
      {showGate ? (
        <>
          <StartGate
            session={session}
            starting={starting}
            error={appError?.kind === 'microphone' ? appError.message : appError?.message ?? null}
            errorKind={appError?.kind ?? null}
            inIframe={runningInIframe()}
            onStart={() => void unlockAndStart()}
            onOpenHistory={() => setHistoryOpen(true)}
            onOpenStandalone={() => window.open(window.location.href, '_blank', 'noopener,noreferrer')}
          />
          {appError?.kind === 'network' && (
            <button className="gate-retry text-button" onClick={() => window.location.reload()}>重新连接本地服务</button>
          )}
        </>
      ) : (
        <>
          <header className="topbar">
            <div className="teacher-identity">
              <div className={`examiner-avatar${phase === 'examiner_speaking' ? ' is-speaking' : ''}`} aria-hidden="true">E</div>
              <div className="teacher-copy">
                <strong>Elena 的口语课</strong>
                <span>{session ? `${session.topic_title} · ${state?.current_part ?? session.part_mode}` : '正在连接本机课程'}</span>
              </div>
            </div>
            <nav className="topnav" aria-label="课程工具">
              <button onClick={() => setMemoryOpen(true)}>记忆</button>
              <button onClick={() => setPlanOpen(true)}>题单</button>
              <button onClick={() => setReportOpen(true)}>报告</button>
            </nav>
          </header>

          <main className="stage">
            {part2.stage !== 'idle' && phase !== 'ended' && (
              <Part2Timer stage={part2.stage} remaining={part2Remaining} onStartSpeaking={startPart2Speaking} />
            )}

            <div className="chat-stream">
              {turns.length === 0 && !activeExaminer.text && phase !== 'ended' && (
                <section className="quiet-empty">
                  <div className="examiner-avatar" aria-hidden="true">E</div>
                  <h1>考官正在准备第一道题</h1>
                  <p>不用一直盯着屏幕。新题到达后会自动播报，然后轮到你。</p>
                </section>
              )}

              {turns.map((turn) => {
                const answered = Boolean(turn.learner_transcript || turn.learner_audio_url)
                const speaking = phase === 'examiner_speaking' && (
                  (activeExaminer.turnId !== null && activeExaminer.turnId === turn.id)
                  || (activeExaminer.turnId === null && activeExaminer.text === turn.examiner_question)
                )
                return (
                  <article className="turn-block" key={turn.id}>
                    <ExaminerBubble
                      question={turn.examiner_question}
                      audioUrl={turn.examiner_audio_url}
                      speaking={speaking}
                      onReplay={replayAudio}
                    />
                    {answered && (
                      <LearnerBubble
                        turn={turn}
                        onSelectWord={(word, audioUrl) => setSelectedWord({ word, audioUrl })}
                      />
                    )}
                    {answered && (
                      <div className="correction-wrap">
                        <CorrectionCard
                          feedback={turn.grammar_feedback_json ?? null}
                          pronunciation={turn.pronunciation_json ?? null}
                          wpm={turn.wpm}
                          pauseCount={turn.pause_count}
                          stuck={turn.long_pauses_json?.stuck}
                          accent={accent}
                          onSpeak={(text) => void speakText(text)}
                        />
                      </div>
                    )}
                  </article>
                )
              })}

              {activeExaminer.text && !activeQuestionInTurns && phase !== 'ended' && (
                <article className="turn-block">
                  <ExaminerBubble
                    question={activeExaminer.text}
                    audioUrl={activeExaminer.audioUrl}
                    speaking={phase === 'examiner_speaking'}
                    onReplay={replayAudio}
                  />
                </article>
              )}

              {liveStuck && phase === 'listening' && (
                <section className="stuck-panel card-expand" aria-live="polite">
                  <strong>好像卡住了，没关系。</strong>
                  <span>可以先接一个简单的词，再继续说。</span>
                  <div className="hint-words">
                    {hintWords.map((word) => <button className="hint-word" key={word} onClick={() => void speakText(word)}>{word}</button>)}
                  </div>
                </section>
              )}

              {(phase === 'listening' || phase === 'submitting' || phase === 'thinking') && (
                <div className="learner-block pending bubble-enter">
                  <div className="learner-meta"><span>{phase === 'listening' ? '正在听你说' : '你的回答'}</span></div>
                  <div className="learner-bubble">
                    {phase === 'thinking' && pendingTranscript ? (
                      <p className="learner-transcript">{pendingTranscript}</p>
                    ) : (
                      <p className="muted">
                        {phase === 'listening' ? '自然地说就好，停顿后会自动提交。' : '语音已收到，正在整理转写与发音结果…'}
                      </p>
                    )}
                    {phase === 'thinking' && <p className="pending-feedback">批改中，纠错卡会挂在这段回答下面。</p>}
                  </div>
                </div>
              )}

              {phase === 'ended' && (
                <section className="ended-card bubble-enter">
                  <p className="eyebrow">LESSON COMPLETE</p>
                  <h1>这节课完成了</h1>
                  <p>先喝杯水平缓一下。报告生成后会自动打开；也可以准备好后直接重开新局。</p>
                  <div className="ended-actions">
                    <button className="secondary-button" onClick={() => setReportOpen(true)}>查看本课报告</button>
                    <button className="primary-button" onClick={() => void restartLesson()} disabled={restarting || !session}>
                      {restarting ? '正在准备…' : '重开新局'}
                    </button>
                  </div>
                </section>
              )}
              <div ref={endOfChatRef} />
            </div>

            {appError && (
              <section className="error-panel" role="alert">
                <strong>
                  {appError.kind === 'microphone' ? '麦克风需要重新授权'
                    : appError.kind === 'audio' ? '这段音频没有被接收'
                      : appError.kind === 'playback' ? '考官语音没有播放' : '本地连接暂时中断'}
                </strong>
                <p>{appError.message}</p>
                <ol>{errorInstructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ol>
                <div>
                  <button className="secondary-button" onClick={() => setAppError(null)}>知道了</button>
                  <button className="primary-button" onClick={() => {
                    setAppError(null)
                    if (appError.kind === 'network' && sessionIdRef.current) {
                      void loadBootstrap(sessionIdRef.current).catch((error) => setAppError(classifyError(error)))
                    } else if (appError.kind === 'playback') replayLast()
                    else if (phaseRef.current === 'idle') void startListening()
                  }}>重试</button>
                </div>
              </section>
            )}
          </main>

          <VoiceDock
            phase={phase}
            part2Stage={part2.stage}
            mode={mode}
            muted={muted}
            level={level}
            elapsed={elapsed}
            onPrimary={stopOrStart}
            onToggleMode={changeMode}
            onToggleMute={toggleMute}
            onReplay={replayLast}
            onEndLesson={() => void endLesson()}
            onShowReport={() => setReportOpen(true)}
          />

          {notice && <div className="notice" role="status" onClick={() => setNotice(null)}>{notice}</div>}
        </>
      )}

      <HistoryDrawer open={historyOpen} currentSessionId={sessionId} onClose={() => setHistoryOpen(false)} onOpen={(id) => void openSession(id)} />
      <MemoryDrawer open={memoryOpen} context={context} onClose={() => setMemoryOpen(false)} />
      <PlanBar plan={plan} open={planOpen} onClose={() => setPlanOpen(false)} />
      <PhonemeDrawer
        word={selectedWord?.word ?? null}
        learnerAudioUrl={selectedWord?.audioUrl ?? null}
        accent={accent}
        onClose={() => setSelectedWord(null)}
      />

      {reportOpen && (
        <div className="report-overlay">
          <LessonReportView
            report={report}
            session={session}
            turns={turns}
            restarting={restarting}
            onClose={() => setReportOpen(false)}
            onRestart={() => void restartLesson()}
          />
        </div>
      )}

      <audio ref={audioRef} preload="auto" hidden />
    </div>
  )
}
