import { useEffect, useState } from 'react'
import type { MicMode, Part2Stage, Phase, SendProgress } from '../types'
import { VoiceWave } from './ExaminerBubble'

interface VoiceDockProps {
  phase: Phase
  part2Stage: Part2Stage
  mode: MicMode
  muted: boolean
  level: number
  elapsed: number
  sendProgress: SendProgress
  hintWords: string[]
  onHint: (word: string) => void
  onPrimary: () => void
  onChangeMode: (mode: MicMode) => void
  onToggleMute: () => void
  onReplay: () => void
  onEndLesson: () => void
  onShowReport: () => void
}

function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function VoiceDock({ phase, part2Stage, mode, muted, level, elapsed, sendProgress, hintWords, onHint, onPrimary, onChangeMode, onToggleMute, onReplay, onEndLesson, onShowReport }: VoiceDockProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const listening = phase === 'listening'
  const speaking = phase === 'examiner_speaking'
  const busy = phase === 'submitting' || phase === 'thinking'
  useEffect(() => {
    if (!menuOpen) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenuOpen(false); setConfirmEnd(false) } }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menuOpen])

  const status = phase === 'examiner_speaking' ? '考官说话中'
    : phase === 'listening' ? `正在听你说 ${formatElapsed(elapsed)}`
      : phase === 'submitting' || phase === 'thinking' ? '思考与批改中…'
        : phase === 'ended' ? '本课已完成'
          : part2Stage === 'prep' ? 'Part 2 准备中，尚未开麦'
            : muted ? '麦克风已暂停' : '轮到你了'
  const subtitle = listening ? (part2Stage === 'speak' ? '时间到自动提交，也可手动结束' : mode === 'free' ? '停顿会先显示发送倒计时' : '说完再按一次或点按钮')
    : speaking ? '听完自动进入下一轮' : busy ? '你的回答已上屏' : '空格也可以开始 / 停止'
  const primaryLabel = phase === 'ended' ? '查看报告'
    : part2Stage === 'prep' ? '立即开讲'
      : listening ? '我说完了'
        : speaking ? '重听' : busy ? '请稍候' : '开始说话'
  const handlePrimary = () => {
    if (phase === 'ended') onShowReport()
    else if (speaking) onReplay()
    else if (!busy) onPrimary()
  }

  return <div className="voice-dock-area">
    {hintWords.length > 0 && listening && <div className="stuck-rescue" aria-live="polite"><span>好像卡住了，可以试试</span><div>{hintWords.map((word) => <button key={word} onClick={() => onHint(word)}>{word}</button>)}</div></div>}
    {sendProgress.active && listening && <div className="send-countdown" role="status"><div><span>即将发送，继续说即取消</span><b>{sendProgress.remainingSec.toFixed(1)}s</b></div><i><em style={{ width: `${Math.round(sendProgress.progress * 100)}%` }} /></i></div>}
    <div className="voice-dock">
      <div className="mode-switch" role="group" aria-label="收音模式"><button className={mode === 'free' ? 'selected' : ''} onClick={() => onChangeMode('free')}>自由连麦</button><button className={mode === 'manual' ? 'selected' : ''} onClick={() => onChangeMode('manual')}>手动控场</button></div>
      <div className="dock-main-row">
        <div className="dock-status" aria-live="polite"><VoiceWave active={listening || speaking} animated={speaking} level={level} /><div className="dock-copy"><strong>{status}</strong><span>{subtitle}</span></div></div>
        <button className="primary-button dock-primary" onClick={handlePrimary} disabled={busy}>{primaryLabel}</button>
        {phase !== 'ended' && <button className="dock-icon" onClick={onToggleMute} aria-label={muted ? '恢复麦克风' : '静音或暂停'}>{muted ? <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 4l16 16M9 5v6M15 9v2M5 11a7 7 0 0 0 11 5M12 18v3" /></svg> : <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>}</button>}
        {phase !== 'ended' && <div className="dock-more"><button className="dock-icon more-button" aria-label="更多" aria-expanded={menuOpen} onClick={() => { setMenuOpen((value) => !value); setConfirmEnd(false) }}>···</button>{menuOpen && <div className="dock-menu">{!confirmEnd ? <><button onClick={onReplay}>重听考官问题</button><button onClick={() => setConfirmEnd(true)}>结束本课并出报告</button></> : <div className="end-confirmation"><strong>现在结束这节课？</strong><p>结束后会进入报告生成流程，不能再继续录音。</p><button className="primary-button" onClick={onEndLesson}>确认结束</button><button className="text-button" onClick={() => setConfirmEnd(false)}>继续上课</button></div>}</div>}</div>}
      </div>
    </div>
  </div>
}
