interface Part2TimerProps {
  stage: 'prep' | 'speak'
  remaining: number
  onStartSpeaking: () => void
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function Part2Timer({ stage, remaining, onStartSpeaking }: Part2TimerProps) {
  const duration = stage === 'prep' ? 60 : 120
  const progress = Math.max(0, Math.min(1, remaining / duration))
  const circumference = 2 * Math.PI * 45

  return (
    <section className={`part2-timer ${stage}`} aria-label={stage === 'prep' ? 'Part 2 准备计时' : 'Part 2 作答计时'}>
      <div className="timer-ring" aria-hidden="true">
        <svg viewBox="0 0 104 104">
          <circle className="timer-track" cx="52" cy="52" r="45" />
          <circle
            className="timer-progress"
            cx="52"
            cy="52"
            r="45"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - progress)}
          />
        </svg>
        <strong>{formatTime(remaining)}</strong>
      </div>
      <div className="timer-copy">
        <strong>{stage === 'prep' ? 'Part 2 · 准备' : 'Part 2 · 作答'}</strong>
        <span>{stage === 'prep' ? '整理思路，可以记下关键词' : '保持表达，时间到会自动提交'}</span>
      </div>
      {stage === 'prep' && <button className="primary-button compact" onClick={onStartSpeaking}>立即开讲</button>}
    </section>
  )
}
