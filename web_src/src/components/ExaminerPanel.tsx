import { useEffect, useRef, useState } from 'react'
import type { Accent, FeedbackStyle, Session, StateSnapshot } from '../types'

export type BusyState = 'idle' | 'uploading' | 'thinking'

interface Props {
  session: Session | null
  state: StateSnapshot | null
  examinerText: string
  audioUrl: string | null
  accent: Accent
  onAccentChange: (accent: Accent) => void
  feedbackStyle: FeedbackStyle
  onFeedbackStyleChange: (style: FeedbackStyle) => void
  recording: boolean
  busy: BusyState
  level: number
  elapsed: number
  onToggleRecording: () => void
  onEndLesson: () => void
  onReplay: () => void
}

const STATUS_TEXT: Record<string, { label: string; tone: string }> = {
  idle: { label: '待机中', tone: 'idle' },
  waiting_for_learner: { label: '考官倾听中', tone: 'listen' },
  recording_in_progress: { label: '正在录音', tone: 'record' },
  processing: { label: '声学分析中', tone: 'think' },
  learner_replied: { label: '正在生成纠错', tone: 'think' },
  lesson_ended_by_user: { label: '本课已结束', tone: 'ended' },
}

function formatSeconds(value: number): string {
  const total = Math.max(0, Math.round(value))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return (minutes < 10 ? '0' : '') + minutes + ':' + (seconds < 10 ? '0' : '') + seconds
}

export function ExaminerPanel(props: Props) {
  const {
    session,
    state,
    examinerText,
    audioUrl,
    accent,
    onAccentChange,
    feedbackStyle,
    onFeedbackStyleChange,
    recording,
    busy,
    level,
    elapsed,
    onToggleRecording,
    onEndLesson,
    onReplay,
  } = props

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [timerMode, setTimerMode] = useState<'idle' | 'prep' | 'speak'>('idle')
  const [remaining, setRemaining] = useState(0)
  const deadlineRef = useRef<number | null>(null)

  useEffect(() => {
    if (!audioUrl) return
    const element = audioRef.current
    if (!element) return
    element.src = audioUrl
    element.play().then(
      () => setAutoplayBlocked(false),
      () => setAutoplayBlocked(true),
    )
  }, [audioUrl])

  useEffect(() => {
    if (timerMode === 'idle') {
      deadlineRef.current = null
      return
    }
    const tick = () => {
      if (deadlineRef.current === null) return
      const left = (deadlineRef.current - Date.now()) / 1000
      if (left <= 0) {
        setRemaining(0)
        setTimerMode('idle')
        deadlineRef.current = null
      } else {
        setRemaining(left)
      }
    }
    tick()
    const handle = window.setInterval(tick, 250)
    return () => window.clearInterval(handle)
  }, [timerMode])

  useEffect(() => {
    if (!state || state.current_part !== 'part2') return
    if (timerMode !== 'idle') return
    setTimerMode('prep')
    setRemaining(60)
    deadlineRef.current = Date.now() + 60_000
  }, [state?.current_turn_id])

  const status = STATUS_TEXT[state?.status ?? 'idle'] ?? STATUS_TEXT.idle
  const isPartTwo = session ? session.part_mode === 'part2' || session.part_mode === 'full_mock' : false

  const startTimer = (mode: 'prep' | 'speak') => {
    const seconds = mode === 'prep' ? 60 : 120
    setTimerMode(mode)
    setRemaining(seconds)
    deadlineRef.current = Date.now() + seconds * 1000
  }

  return (
    <section className="panel examiner">
      <header className="panel-head">
        <div className={'status-dot ' + status.tone} />
        <div className="panel-title">
          <strong>雅思考官</strong>
          <span className="muted">{status.label}</span>
        </div>
        <div className="spacer" />
        <div className="toggle-group" role="group" aria-label="口音">
          <button className={accent === 'uk' ? 'chip active' : 'chip'} onClick={() => onAccentChange('uk')}>
            英音
          </button>
          <button className={accent === 'us' ? 'chip active' : 'chip'} onClick={() => onAccentChange('us')}>
            美音
          </button>
        </div>
        <select
          className="select"
          value={feedbackStyle}
          onChange={(event) => onFeedbackStyleChange(event.target.value as FeedbackStyle)}
          title="反馈模式"
        >
          <option value="instant_card_plus_voice">即时语音 + 卡片纠错</option>
          <option value="instant_card_only">仅卡片纠错 · 全真考官</option>
        </select>
      </header>

      <div className="question-box">
        <div className="eyebrow">当前问题</div>
        <p className="question">{examinerText || '等待考官提问…'}</p>
        <div className="question-actions">
          <button className="ghost" onClick={onReplay} disabled={!audioUrl}>
            ▶ 重听问题
          </button>
          {autoplayBlocked && <span className="warn">浏览器阻止了自动播放，请点上面的按钮</span>}
        </div>
      </div>

      {isPartTwo && (
        <div className="timer-box">
          <div className="timer-row">
            <button className="chip" onClick={() => startTimer('prep')}>
              1 分钟准备
            </button>
            <button className="chip" onClick={() => startTimer('speak')}>
              2 分钟作答
            </button>
            <button className="chip" onClick={() => setTimerMode('idle')}>
              停止计时
            </button>
          </div>
          <div className={timerMode === 'speak' ? 'timer-value speak' : 'timer-value'}>
            {formatSeconds(remaining)}
            <span className="muted small">
              {timerMode === 'prep' ? ' 准备中' : timerMode === 'speak' ? ' 作答中' : ''}
            </span>
          </div>
        </div>
      )}

      <div className="record-area">
        <button
          className={recording ? 'record-button active' : 'record-button'}
          onClick={onToggleRecording}
          disabled={busy !== 'idle'}
          aria-label={recording ? '停止录音' : '开始录音'}
        >
          <span className="record-icon">{recording ? '■' : '●'}</span>
          <span className="record-label">
            {recording ? '停止并提交 (空格)' : busy === 'uploading' ? '上传中…' : busy === 'thinking' ? '分析中…' : '开始说话 (空格)'}
          </span>
        </button>
        <div className="level-meter" aria-hidden>
          <div className="level-fill" style={{ width: Math.round(level * 100) + '%' }} />
        </div>
        <div className="muted small">
          {recording ? '录音时长 ' + formatSeconds(elapsed) : '手动模式：说完再点停止，避免被静音误切'}
        </div>
      </div>

      <footer className="panel-foot">
        <div className="muted small">
          {session ? '话题：' + session.topic_title + ' · 模式：' + session.part_mode : '尚未加载课程'}
        </div>
        <div className="spacer" />
        <button className="danger" onClick={onEndLesson}>
          结束本课并生成报告
        </button>
      </footer>

      <audio ref={audioRef} preload="auto" hidden />
    </section>
  )
}
