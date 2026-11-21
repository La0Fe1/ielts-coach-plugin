import { useMemo } from 'react'
import type { LessonReport, Session, Turn } from '../types'

interface LessonReportViewProps {
  report: LessonReport | null
  session: Session | null
  turns: Turn[]
  restarting?: boolean
  onClose: () => void
  onRestart: () => void
}

function inlineNodes(text: string, keyPrefix: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${keyPrefix}-${index}`}>{part.slice(2, -2)}</strong>
    }
    return <span key={`${keyPrefix}-${index}`}>{part}</span>
  })
}

function Markdown({ source }: { source: string }) {
  const nodes = useMemo(() => {
    const lines = source.split(/\r?\n/)
    const output: React.ReactNode[] = []
    let listBuffer: string[] = []
    const flushList = () => {
      if (listBuffer.length === 0) return
      output.push(
        <ul key={`ul-${output.length}`}>
          {listBuffer.map((item, index) => <li key={index}>{inlineNodes(item, `li-${index}`)}</li>)}
        </ul>,
      )
      listBuffer = []
    }
    lines.forEach((raw, index) => {
      const line = raw.trimEnd()
      const key = `md-${index}`
      if (/^\s*[-*]\s+/.test(line)) {
        listBuffer.push(line.replace(/^\s*[-*]\s+/, ''))
        return
      }
      flushList()
      if (!line.trim()) output.push(<div className="md-gap" key={key} />)
      else if (line.startsWith('### ')) output.push(<h4 key={key}>{inlineNodes(line.slice(4), key)}</h4>)
      else if (line.startsWith('## ')) output.push(<h3 key={key}>{inlineNodes(line.slice(3), key)}</h3>)
      else if (line.startsWith('# ')) output.push(<h2 key={key}>{inlineNodes(line.slice(2), key)}</h2>)
      else if (/^\s*---+\s*$/.test(line)) output.push(<hr key={key} />)
      else if (/^\s*>\s?/.test(line)) output.push(<blockquote key={key}>{inlineNodes(line.replace(/^\s*>\s?/, ''), key)}</blockquote>)
      else output.push(<p key={key}>{inlineNodes(line, key)}</p>)
    })
    flushList()
    return output
  }, [source])
  return <div className="markdown">{nodes}</div>
}

const BAND_LABEL: Record<string, string> = {
  fc: '流利度与连贯性',
  lr: '词汇资源',
  gra: '语法范围与准确性',
  pr: '发音',
}

export function LessonReportView({ report, session, turns, restarting = false, onClose, onRestart }: LessonReportViewProps) {
  if (!report) {
    return (
      <div className="report">
        <header className="report-head">
          <div><p className="eyebrow">LESSON REPORT</p><h1>课后学习报告</h1></div>
          <button className="close-button" onClick={onClose} aria-label="关闭报告">×</button>
        </header>
        <section className="report-waiting" aria-live="polite">
          <h2>{session?.status === 'active' ? '这节课还没有报告' : '报告生成中'}</h2>
          <p>老师正在汇总本课的四维表现、错题和发音记录。报告到达后，这里会自动更新，不需要重复点击。</p>
          <div className="report-actions">
            <button className="secondary-button" onClick={onClose}>返回课堂</button>
            {session?.status !== 'active' && <button className="primary-button" onClick={onRestart} disabled={restarting}>重开新局</button>}
          </div>
        </section>
      </div>
    )
  }

  const payload = report.report_json ?? {}
  const rawBands = (payload.bands ?? payload) as Record<string, unknown>
  const overall = rawBands.overall
  const nextPlan = typeof payload.next_lesson_plan === 'string' ? payload.next_lesson_plan : ''
  const mistakes = turns.flatMap((turn) =>
    (turn.grammar_feedback_json?.grammar_mistakes ?? []).map((mistake) => ({ ...mistake, turnIndex: turn.turn_index })),
  )
  const weakPhonemes = turns
    .flatMap((turn) => turn.pronunciation_json?.weak_phonemes ?? [])
    .sort((a, b) => a.avg_score - b.avg_score)
    .slice(0, 6)

  const download = () => {
    const blob = new Blob([report.report_markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `ielts-lesson-${report.session_id}.md`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="report">
      <header className="report-head">
        <div>
          <p className="eyebrow">LESSON REPORT</p>
          <h1>这节课，老师想对你说</h1>
          <p>{session?.topic_title ?? `Session ${report.session_id}`}</p>
        </div>
        <button className="close-button" onClick={onClose} aria-label="关闭报告">×</button>
      </header>

      <section className="report-overview">
        <div className="overall-score">
          <span>综合表现</span>
          <strong>{typeof overall === 'number' ? overall.toFixed(1) : '—'}</strong>
        </div>
        <div className="band-grid">
          {['fc', 'lr', 'gra', 'pr'].map((key) => {
            const value = rawBands[key]
            return (
              <div className="band-score" key={key}>
                <strong>{typeof value === 'number' ? value.toFixed(1) : '—'}</strong>
                <span>{BAND_LABEL[key]}</span>
              </div>
            )
          })}
        </div>
      </section>

      <section className="report-section">
        <h2>错题账本</h2>
        {mistakes.length === 0 ? <p className="muted">本课没有记录到需要整理的语法错题。</p> : (
          <ul className="report-mistakes">
            {mistakes.map((mistake, index) => (
              <li key={`${mistake.original_excerpt}-${index}`}>
                <span>第 {mistake.turnIndex} 轮 · {mistake.error_category}</span>
                <p><s>{mistake.original_excerpt}</s> → {mistake.corrected_excerpt}</p>
                <p className="muted">{mistake.explanation}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="report-section">
        <h2>发音巩固榜</h2>
        {weakPhonemes.length === 0 ? <p className="muted">本课没有生成弱音素排行。</p> : (
          <ol className="phoneme-ranking">
            {weakPhonemes.map((item, index) => (
              <li key={`${item.phoneme}-${index}`}><strong>/{item.phoneme}/</strong><span>{Math.round(item.avg_score)} 分 · {item.count} 次</span></li>
            ))}
          </ol>
        )}
      </section>

      <section className="report-section next-prescription">
        <h2>下一节课的练习处方</h2>
        <p>{nextPlan || '复习本课升级句，优先重练发音榜中的音素，再用同类话题做一次完整表达。'}</p>
      </section>

      <details className="full-report">
        <summary>查看完整报告原文</summary>
        <Markdown source={report.report_markdown} />
      </details>

      <footer className="report-footer">
        <button className="secondary-button" onClick={download}>下载 .md</button>
        <button className="primary-button" onClick={onRestart} disabled={restarting}>{restarting ? '正在准备新课…' : '重开新局'}</button>
      </footer>
    </div>
  )
}
