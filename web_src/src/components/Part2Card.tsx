import type { Part2Stage } from '../types'

interface Part2CardProps {
  question: string
  topic: string
  stage: Exclude<Part2Stage, 'idle'>
  remaining: number
  scratchpad: string[]
  onScratchpadChange: (index: number, value: string) => void
  onStartSpeaking: () => void
}

function parseCueCard(question: string, fallbackTopic: string) {
  const sections = question.split(/you should say:?/i)
  const topic = fallbackTopic || sections[0]?.trim().split('\n')[0] || 'Part 2 Topic'
  const points = (sections[1] ?? '').split(/\r?\n|(?<=[.!?])\s+/).map((line) => line.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim()).filter((line) => line.length > 1).slice(0, 4)
  return { topic, points }
}

export function Part2Card({ question, topic, stage, remaining, scratchpad, onScratchpadChange, onStartSpeaking }: Part2CardProps) {
  const cue = parseCueCard(question, topic)
  const total = stage === 'prep' ? 60 : 120
  const progress = Math.max(0, Math.min(1, remaining / total))
  const circumference = 2 * Math.PI * 45
  const seconds = Math.max(0, Math.ceil(remaining))
  const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  return <section className={`part2-card is-${stage}`} aria-label="Part 2 考场卡">
    <header className="part2-heading"><div><p className="eyebrow">PART 2 · EXAM CARD</p><h2>{stage === 'prep' ? '1 分钟关键词准备' : '2 分钟完整作答'}</h2></div><div className="timer-ring"><svg viewBox="0 0 100 100" aria-hidden="true"><circle className="timer-track" cx="50" cy="50" r="45" /><circle className="timer-progress" cx="50" cy="50" r="45" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - progress)} /></svg><strong>{time}</strong></div></header>
    <div className="cue-topic"><span>Topic</span><strong>{cue.topic}</strong></div>
    {cue.points.length > 0 && <div className="cue-points"><span>You should say:</span><ol>{cue.points.map((point, index) => <li key={index}>{point}</li>)}</ol></div>}
    {stage === 'prep' ? <div className="scratchpad"><div className="section-title"><h3>关键词便签</h3><span>只写提示词，不写整句</span></div><div className="scratch-grid">{scratchpad.map((value, index) => <label key={index}><span>{cue.points[index] ? `要点 ${index + 1}` : `关键词 ${index + 1}`}</span><input value={value} maxLength={36} onChange={(event) => onScratchpadChange(index, event.target.value)} placeholder={['经历 / 人物', '地点 / 时间', '细节 / 原因', '感受 / 收获'][index]} /></label>)}</div><p className="prep-safety">准备期不会开麦，咳嗽或试读不会跳过倒计时。</p><button className="primary-button part2-start" onClick={onStartSpeaking}>我准备好了，开始作答</button></div> : <div className="scratch-locked"><span>提词卡已锁定</span><div>{scratchpad.map((value, index) => <kbd key={index}>{value || '—'}</kbd>)}</div></div>}
  </section>
}
