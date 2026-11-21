import { useEffect, useState } from 'react'
import type { MicMode, Phase } from '../types'
import { VoiceWave } from './ExaminerBubble'

interface VoiceDockProps {
  phase: Phase
  part2Stage: 'idle' | 'prep' | 'speak'
  mode: MicMode
  muted: boolean
  level: number
  elapsed: number
  onPrimary: () => void
  onToggleMode: (mode: MicMode) => void
  cutOnSilence: boolean
  onToggleCut: () => void
  smartTurn: boolean
  onToggleSmart: () => void
  onToggleMute: () => void
  onReplay: () => void
  onEndLesson: () => void
  onShowReport: () => void
}

function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

const STATUS: Record<Phase, { title: string; subtitle: string }> = {
  gate: { title: '等待开课', subtitle: '先完成一次语音授权' },
  idle: { title: '轮到你了', subtitle: '准备好了就开口，也可按空格' },
  examiner_speaking: { title: '考官正在说', subtitle: '听完会自动轮到你' },
  listening: { title: '正在听你说', subtitle: '说完会自己接（判断句子是否完整），卡住会给你提示' },
  submitting: { title: '语音已收到', subtitle: '正在识别，马上就好' },
  thinking: { title: '老师正在批改', subtitle: '纠错卡会出现在回答下方' },
  ended: { title: '本课已结束', subtitle: '报告与下一课入口已就绪' },
}

export function VoiceDock({
  phase,
  part2Stage,
  mode,
  muted,
  level,
  elapsed,
  onPrimary,
  onToggleMode,
  cutOnSilence,
  onToggleCut,
  smartTurn,
  onToggleSmart,
  onToggleMute,
  onReplay,
  onEndLesson,
  onShowReport,
}: VoiceDockProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const listening = phase === 'listening'
  const speaking = phase === 'examiner_speaking'
  const busy = phase === 'submitting' || phase === 'thinking'
  const status = listening && part2Stage === 'prep'
    ? { title: 'Part 2 准备中', subtitle: '开口即作答，也可点击立即开讲' }
    : listening && part2Stage === 'speak'
      ? { title: 'Part 2 作答中', subtitle: '时间到自动提交' }
      : STATUS[phase]

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setConfirmEnd(false)
      }
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menuOpen])

  const primaryLabel = phase === 'ended'
    ? '查看报告'
    : part2Stage === 'prep' && (listening || phase === 'idle')
      ? '立即开讲'
      : listening
        ? '我说完了'
        : speaking
          ? '重听问题'
          : busy
            ? '请稍候'
            : '开始说话'

  const handlePrimary = () => {
    if (phase === 'ended') onShowReport()
    else if (speaking) onReplay()
    else if (!busy) onPrimary()
  }

  return (
    <div className="voice-dock">
      <div className="dock-status" aria-live="polite">
        <VoiceWave active={listening || speaking} animated={speaking} level={level} />
        <div className="dock-copy">
          <strong>{muted && phase !== 'ended' ? '麦克风已暂停' : status.title}</strong>
          <span>{listening ? `${formatElapsed(elapsed)} · ${status.subtitle}` : status.subtitle}</span>
        </div>
      </div>

      <button className="primary-button dock-primary" onClick={handlePrimary} disabled={busy}>
        {primaryLabel}
      </button>

      {phase !== 'ended' && (
        <div className="dock-more">
          <button
            className="secondary-button more-button"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((value) => !value)
              setConfirmEnd(false)
            }}
          >
            更多
          </button>
          {menuOpen && (
            <div className="dock-menu">
              {!confirmEnd ? (
                <>
                  <button onClick={() => onToggleMode(mode === 'auto' ? 'manual' : 'auto')}>
                    <span>自动接话</span><strong>{mode === 'auto' ? '已开启' : '已关闭'}</strong>
                  </button>
                  <button onClick={onToggleSmart}>
                    <span>智能断句</span><strong>{smartTurn ? '已开启' : '已关闭'}</strong>
                  </button>
                  <button onClick={onToggleCut}>
                    <span>停顿自动提交</span><strong>{cutOnSilence ? '已开启' : '已关闭'}</strong>
                  </button>
                  <button onClick={onToggleMute}>{muted ? '恢复麦克风' : '暂停麦克风'}</button>
                  <button onClick={onReplay}>重听考官问题</button>
                  <button onClick={() => setConfirmEnd(true)}>结束本课</button>
                </>
              ) : (
                <div className="end-confirmation">
                  <strong>现在结束这节课？</strong>
                  <p>结束后会进入报告生成流程，不能再继续录音。</p>
                  <button className="primary-button" onClick={onEndLesson}>确认结束并生成报告</button>
                  <button className="text-button" onClick={() => setConfirmEnd(false)}>继续上课</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
