import type { CSSProperties } from 'react'

interface VoiceWaveProps {
  active: boolean
  animated?: boolean
  level?: number
}

export function VoiceWave({ active, animated = false, level = 0 }: VoiceWaveProps) {
  const weights = [0.45, 0.78, 1, 0.68, 0.4]
  return (
    <span
      className={`voice-wave${active ? ' is-active' : ''}${animated && active ? ' is-animated' : ''}`}
      aria-hidden="true"
    >
      {weights.map((weight, index) => {
        const scale = active ? 0.35 + Math.min(1, level * 1.8) * weight : 0.25
        const style = animated
          ? ({ '--wave-weight': weight } as CSSProperties)
          : { transform: `scaleY(${scale})` }
        return <i className="wave-bar" style={style} key={index} />
      })}
    </span>
  )
}

interface ExaminerBubbleProps {
  question: string
  audioUrl?: string | null
  speaking?: boolean
  onReplay: (url: string | null) => void
}

export function ExaminerBubble({ question, audioUrl, speaking = false, onReplay }: ExaminerBubbleProps) {
  return (
    <div className="examiner-row bubble-enter">
      <div className={`examiner-avatar${speaking ? ' is-speaking' : ''}`} aria-hidden="true">E</div>
      <div className="examiner-content">
        <div className="speaker-line">
          <span className="speaker-name">Elena · IELTS 考官</span>
          <VoiceWave active={speaking} animated />
          {audioUrl && (
            <button className="icon-text-button" onClick={() => onReplay(audioUrl)} aria-label="重听考官问题">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M4 10v4h4l5 4V6L8 10H4Z" />
                <path d="M16 9c1.4 1.6 1.4 4.4 0 6M18.5 6.5c3 3 3 8 0 11" />
              </svg>
              重听
            </button>
          )}
        </div>
        <p className="examiner-question" aria-live="polite">{question}</p>
      </div>
    </div>
  )
}
