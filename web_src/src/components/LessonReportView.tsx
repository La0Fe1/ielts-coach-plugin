import type { BandHistoryItem, LearnerContext, LessonReport, PronWord, Turn } from '../types'

interface LessonReportViewProps {
  report: LessonReport | null
  turns: Turn[]
  context: LearnerContext | null
  targetBand: number
  onClose: () => void
  onRestart: () => void
  onDownload: () => void
  onSpeak: (text: string) => void
  onReplay: (url: string) => void
  onSelectWord: (word: PronWord, learnerAudioUrl: string | null) => void
}

function getBand(bands: Record<string, number | null>, key: string): number | null {
  const entry = Object.entries(bands).find(([name]) => name.toLowerCase().replace(/[^a-z]/g, '') === key.toLowerCase())
  return entry?.[1] ?? null
}

const RADAR_KEYS = [{ key: 'fc', label: 'FC 流利连贯' }, { key: 'lr', label: 'LR 词汇资源' }, { key: 'gra', label: 'GRA 语法' }, { key: 'pr', label: 'PR 发音' }]

function radarPoint(index: number, value: number) {
  const angle = -Math.PI / 2 + index * Math.PI / 2
  const radius = 82 * Math.max(0, Math.min(9, value)) / 9
  return [120 + Math.cos(angle) * radius, 120 + Math.sin(angle) * radius] as const
}

function BandRadar({ bands, target }: { bands: Record<string, number | null>; target: number }) {
  const currentPoints = RADAR_KEYS.map((item, index) => radarPoint(index, getBand(bands, item.key) ?? 0).join(',')).join(' ')
  const targetPoints = RADAR_KEYS.map((_, index) => radarPoint(index, target).join(',')).join(' ')
  return <svg className="band-radar" viewBox="0 0 240 240" role="img" aria-label="四维能力雷达图：彩色为本课，虚线为目标分">
    {[3, 6, 9].map((ring) => <polygon key={ring} points={RADAR_KEYS.map((_, index) => radarPoint(index, ring).join(',')).join(' ')} fill="none" stroke="var(--line)" />)}
    {RADAR_KEYS.map((item, index) => { const [x, y] = radarPoint(index, 9); return <line key={item.key} x1="120" y1="120" x2={x} y2={y} stroke="var(--line)" /> })}
    <polygon points={targetPoints} fill="none" stroke="var(--muted)" strokeDasharray="5 4" />
    <polygon points={currentPoints} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2.5" />
    {RADAR_KEYS.map((item, index) => { const [x, y] = radarPoint(index, 11.3); return <text key={item.key} x={x} y={y} textAnchor="middle" fill="var(--text)" fontSize="11">{item.label} {getBand(bands, item.key)?.toFixed(1) ?? '—'}</text> })}
  </svg>
}

function BandTrend({ history, target }: { history: BandHistoryItem[]; target: number }) {
  const width = 620
  const height = 220
  const left = 42
  const right = 20
  const top = 18
  const bottom = 40
  const x = (index: number) => history.length <= 1 ? (width + left - right) / 2 : left + index * (width - left - right) / (history.length - 1)
  const y = (score: number) => top + (9 - Math.max(5, Math.min(9, score))) * (height - top - bottom) / 4
  const points = history.map((item, index) => `${x(index)},${y(item.estimated_band_overall)}`).join(' ')
  return <svg className="band-trend" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`近 ${history.length} 课 Overall 折线趋势，目标 ${target}`}>
    {[5, 6, 7, 8, 9].map((score) => <g key={score}><line x1={left} x2={width - right} y1={y(score)} y2={y(score)} stroke="var(--line)" /><text x="4" y={y(score) + 4} fill="var(--muted)" fontSize="12">{score.toFixed(1)}</text></g>)}
    <line x1={left} x2={width - right} y1={y(target)} y2={y(target)} stroke="var(--accent)" strokeDasharray="5 4" />
    {history.length > 1 && <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinejoin="round" />}
    {history.map((item, index) => <g key={item.session_id}><circle cx={x(index)} cy={y(item.estimated_band_overall)} r="4.5" fill="var(--surface)" stroke="var(--accent)" strokeWidth="2.5" /><text x={x(index)} y={height - 14} textAnchor="middle" fill="var(--muted)" fontSize="11">#{item.session_id}</text><text x={x(index)} y={y(item.estimated_band_overall) - 11} textAnchor="middle" fill="var(--text)" fontSize="12">{item.estimated_band_overall.toFixed(1)}</text></g>)}
  </svg>
}

function renderMarkdown(markdown: string) {
  return markdown.split(/\r?\n/).map((line, index) => {
    if (/^####\s+/.test(line)) return <h4 key={index}>{line.replace(/^####\s+/, '')}</h4>
    if (/^###\s+/.test(line)) return <h3 key={index}>{line.replace(/^###\s+/, '')}</h3>
    if (/^##\s+/.test(line)) return <h2 key={index}>{line.replace(/^##\s+/, '')}</h2>
    if (/^#\s+/.test(line)) return <h2 key={index}>{line.replace(/^#\s+/, '')}</h2>
    if (/^>\s?/.test(line)) return <blockquote key={index}>{line.replace(/^>\s?/, '')}</blockquote>
    if (/^[-*]\s+/.test(line)) return <li key={index}>{line.replace(/^[-*]\s+/, '')}</li>
    if (/^---+$/.test(line.trim())) return <hr key={index} />
    if (!line.trim()) return <div className="md-gap" key={index} />
    return <p key={index}>{line}</p>
  })
}

export function LessonReportView({ report, turns, context, targetBand, onClose, onRestart, onDownload, onSpeak, onReplay, onSelectWord }: LessonReportViewProps) {
  if (!report) return <div className="report-overlay" role="dialog" aria-modal="true" aria-label="课程报告"><main className="report"><header className="report-head"><div><p className="eyebrow">LESSON REPORT</p><h1>课程报告</h1></div><button className="close-button" onClick={onClose} aria-label="关闭报告">×</button></header><section className="report-waiting"><h2>报告还没有生成</h2><p>结束本课后，评分与报告会通过本地 WebSocket 推送并自动刷新。没有收到前只显示这个占位，不虚构分数。</p></section><footer className="report-footer"><button className="secondary-button" onClick={onClose}>返回</button></footer></main></div>

  const bands = report.report_json?.bands ?? {}
  const history = context?.band_history ?? []
  const mistakes = turns.flatMap((turn) => (turn.grammar_feedback_json?.grammar_mistakes ?? []).map((mistake) => ({ ...mistake, turnId: turn.id, turnIndex: turn.turn_index, audioUrl: turn.learner_audio_url ?? null })))
  const wordMap = new Map<string, PronWord>()
  turns.forEach((turn) => turn.pronunciation_json?.words.forEach((word) => { if (word.score !== null && word.score < 80 && !wordMap.has(word.word)) wordMap.set(word.word, word) }))
  const weakWords = [...wordMap.values()].sort((a, b) => (a.score ?? 100) - (b.score ?? 100)).slice(0, 12)
  const nextPlan = report.report_json?.next_lesson_plan || context?.last_lesson_plan?.content
  const fluentTurns = turns.filter((turn) => (turn.learner_transcript || '').trim() && turn.wpm)
  const avgWpm = fluentTurns.length > 0
    ? Math.round(fluentTurns.reduce((sum, turn) => sum + (turn.wpm || 0), 0) / fluentTurns.length)
    : null
  const totalSpeechSec = Math.round(turns.reduce((sum, turn) => sum + (turn.learner_duration_sec || 0), 0))
  const totalPauses = turns.reduce((sum, turn) => sum + (turn.pause_count || 0), 0)

  const overall = getBand(bands, 'overall')

  return <div className="report-overlay" role="dialog" aria-modal="true" aria-label="课程报告"><main className="report studio-report">
    <header className="report-head"><div><p className="eyebrow">LESSON REPORT · #{report.session_id}</p><h1>这节课，留下了什么</h1><p>{new Date(report.created_at).toLocaleString('zh-CN')} · 成绩、原文音频与复练入口</p></div><button className="close-button" onClick={onClose} aria-label="关闭报告">×</button></header>
    <section className="report-overview"><div className="report-fluency-stats"><div><span>平均语速</span><strong>{avgWpm ?? '—'}<small> wpm</small></strong></div><div><span>总开口</span><strong>{totalSpeechSec}<small> 秒</small></strong></div><div><span>停顿</span><strong>{totalPauses}<small> 次</small></strong></div></div><div className="overall-score"><span>Overall</span><strong>{overall?.toFixed(1) ?? '—'}</strong><small>虚线为目标 {targetBand.toFixed(1)}</small></div><div className="report-chart-grid"><div><h2>四维能力雷达</h2><BandRadar bands={bands} target={targetBand} /></div><div><h2>近 {history.length} 课 Overall 趋势</h2>{history.length > 0 ? <BandTrend history={history} target={targetBand} /> : <p className="muted">完成更多课程后，这里会显示真实历史折线。</p>}</div></div><div className="band-grid">{RADAR_KEYS.map((item) => <div className="band-score" key={item.key}><strong>{getBand(bands, item.key)?.toFixed(1) ?? '—'}</strong><span>{item.label}</span></div>)}</div></section>
    <section className="report-section"><h2>语法与表达错题本</h2>{mistakes.length > 0 ? <ul className="report-mistakes">{mistakes.map((mistake, index) => <li key={`${mistake.turnId}-${index}`}><span>第 {mistake.turnIndex} 轮 · {mistake.error_category}</span><p><s>{mistake.original_excerpt}</s> → <b>{mistake.corrected_excerpt}</b></p><p>{mistake.explanation}</p><div className="report-inline-actions">{mistake.audioUrl && <button className="text-button" onClick={() => onReplay(mistake.audioUrl ?? '')}>听我的原句</button>}<button className="text-button" onClick={() => onSpeak(mistake.upgraded_excerpt || mistake.corrected_excerpt)}>听正确示范</button></div></li>)}</ul> : <p className="muted">本课没有记录语法错题。</p>}</section>
    <section className="report-section"><h2>发音复练清单</h2>{weakWords.length > 0 ? <div className="report-word-grid">{weakWords.map((word, index) => { const turn = turns.find((item) => item.pronunciation_json?.words.includes(word)); return <button key={`${word.word}-${index}`} className={`report-word ${word.color}`} onClick={() => onSelectWord(word, turn?.learner_audio_url ?? null)}><strong>{word.word}</strong><span>{word.ipa ? `/${word.ipa}/` : '查看音素'} · {word.score} 分</span><small>点击对比并跟读</small></button> })}</div> : <p className="muted">本课没有返回低分单词。</p>}</section>
    {nextPlan && <section className="report-section"><h2>下节专项处方</h2><p className="next-prescription">{nextPlan}</p></section>}
    {report.report_markdown && <details className="full-report"><summary>查看完整报告原文</summary><div className="markdown">{renderMarkdown(report.report_markdown)}</div></details>}
    <footer className="report-footer"><button className="secondary-button" onClick={onDownload}>下载 Markdown</button><button className="primary-button" onClick={onRestart}>开始下一课</button></footer>
  </main></div>
}
