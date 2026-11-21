import type { MicMode, Phase } from '../types'

interface Props {
  phase: Phase
  mode: MicMode
  muted: boolean
  level: number
  onToggleMode: (mode: MicMode) => void
  onToggleMute: () => void
  onStopNow: () => void
  onReplay: () => void
  onEndLesson: () => void
  disabled: boolean
}

const STATUS: Record<Phase, string> = {
  gate: '等待开课',
  idle: '等待考官出题 / 轮到你时说',
  examiner_speaking: '考官正在说…',
  listening: '正在听你说（说完自动接话）',
  submitting: '正在识别…',
  thinking: '思考与批改中…',
  ended: '本课已结束',
}

export function LiveVoiceDock({
  phase,
  mode,
  muted,
  level,
  onToggleMode,
  onToggleMute,
  onStopNow,
  onReplay,
  onEndLesson,
  disabled,
}: Props) {
  const listening = phase === 'listening'
  const speaking = phase === 'examiner_speaking'
  return (
    <div className="voice-dock">
      <div className={'status-ball ' + phase + (listening ? ' pulsing' : '')}>
        <div className="ball-core" style={{ transform: 'scale(' + (1 + Math.min(0.55, level * 0.9)) + ')' }} />
        <div className="ball-ring" />
        <div className="ball-ring delay" />
      </div>
      <div className="dock-status">
        <strong>{STATUS[phase]}</strong>
        <span className="muted tiny">
          {mode === 'auto' ? '自动接话模式' : '手动按键模式'}
          {muted ? ' · 已静音' : ''}
        </span>
      </div>

      <div className="dock-actions">
        {mode === 'manual' && (
          <button className="dock-button primary" onClick={onStopNow} disabled={disabled}>
            {listening ? '说完，提交' : '开始说话'}
          </button>
        )}
        {mode === 'auto' && listening && (
          <button className="dock-button" onClick={onStopNow}>
            我说完了
          </button>
        )}
        {speaking && (
          <button className="dock-button" onClick={onReplay} title="重听考官这一句">
            ↺ 重听
          </button>
        )}
        <button className="dock-button" onClick={() => onToggleMode(mode === 'auto' ? 'manual' : 'auto')}>
          {mode === 'auto' ? '切回手动' : '切到自动'}
        </button>
        <button
          className={'dock-button' + (muted ? ' active' : '')}
          onClick={onToggleMute}
          title="暂停/恢复麦克风"
        >
          {muted ? '🎙 已静音' : '🔇 静音'}
        </button>
        <button className="dock-button danger" onClick={onEndLesson}>
          结束本课并生成报告
        </button>
      </div>
    </div>
  )
}
