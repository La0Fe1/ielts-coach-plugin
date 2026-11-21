import { useState } from 'react'
import type { Accent, FeedbackCard, GrammarMistake, PronunciationResult, StuckInfo } from '../types'

interface CorrectionCardProps {
  feedback: FeedbackCard | null
  pronunciation: PronunciationResult | null
  wpm?: number | null
  pauseCount?: number | null
  stuck?: StuckInfo | null
  accent: Accent
  onSpeak: (text: string) => void
}

const CATEGORY_LABEL: Record<string, string> = {
  tense: '时态',
  subject_verb_agreement: '主谓一致',
  article: '冠词',
  preposition: '介词',
  collocation: '搭配',
  word_order: '语序',
  chinglish: '中式英语',
  plural_singular: '单复数',
  other: '其他',
}

function pronunciationTips(value: unknown): string[] {
  if (!value) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        return String(record.tip ?? record.text ?? record.coaching_tip ?? JSON.stringify(record))
      }
      return String(item)
    })
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return [String(record.summary ?? record.text ?? JSON.stringify(record))]
  }
  return []
}

export function CorrectionCard({
  feedback,
  pronunciation,
  wpm,
  pauseCount,
  stuck,
  accent,
  onSpeak,
}: CorrectionCardProps) {
  const [expanded, setExpanded] = useState(false)
  if (!feedback && !pronunciation && !stuck?.detected) return null

  const mistakes: GrammarMistake[] = feedback?.grammar_mistakes ?? []
  const tips = pronunciationTips(feedback?.pronunciation_tips)
  const weak = pronunciation?.weak_phonemes ?? []
  const hasDetails = Boolean(feedback?.upgraded_text) || mistakes.length > 0 || tips.length > 0 || weak.length > 0

  return (
    <section className="correction-card card-expand" aria-label="本轮纠错">
      <div className="correction-summary">
        <div className="correction-heading">
          <strong>老师批改</strong>
          <span>
            {pronunciation?.overall_score !== null && pronunciation?.overall_score !== undefined
              ? `发音 ${Math.round(pronunciation.overall_score)}`
              : ''}
            {wpm ? ` · ${Math.round(wpm)} WPM` : ''}
            {pauseCount ? ` · 停顿 ${pauseCount}` : ''}
          </span>
        </div>

        {feedback?.quick_praise && <p className="quick-praise">{feedback.quick_praise}</p>}

        {feedback?.corrected_text && (
          <div className="corrected-line">
            <span>这样说更自然</span>
            <p>{feedback.corrected_text}</p>
            <button className="text-button" onClick={() => onSpeak(feedback.corrected_text as string)}>
              听示范
            </button>
          </div>
        )}

        {stuck?.detected && (
          <div className="stuck-summary">
            <p>
              好像在这里卡了一下{stuck.at_word ? `：${stuck.at_word}` : ''}。可以试试接着往下说。
            </p>
            <div className="hint-words">
              {(stuck.hint_words ?? []).slice(0, 3).map((word) => (
                <button className="hint-word" key={word} onClick={() => onSpeak(word)}>{word}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      {hasDetails && (
        <>
          <button
            className="correction-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起详细讲解' : '查看错题、发音与升级句'}
            <span aria-hidden="true">{expanded ? '−' : '+'}</span>
          </button>
          {expanded && (
            <div className="correction-detail card-expand">
              {feedback?.upgraded_text && (
                <section className="detail-section">
                  <div className="detail-heading">
                    <h3>更地道的表达</h3>
                    <button className="text-button" onClick={() => onSpeak(feedback.upgraded_text as string)}>
                      听{accent === 'uk' ? '英音' : '美音'}示范
                    </button>
                  </div>
                  <p>{feedback.upgraded_text}</p>
                </section>
              )}

              {mistakes.length > 0 && (
                <section className="detail-section">
                  <h3>本轮错题</h3>
                  <ul className="mistake-list">
                    {mistakes.map((mistake, index) => (
                      <li key={`${mistake.original_excerpt}-${index}`}>
                        <strong>{CATEGORY_LABEL[mistake.error_category] ?? mistake.error_category}</strong>
                        <p>
                          <span className="original-excerpt">{mistake.original_excerpt}</span>
                          <span aria-hidden="true"> → </span>
                          <span>{mistake.corrected_excerpt}</span>
                        </p>
                        {mistake.upgraded_excerpt && <p>升级：{mistake.upgraded_excerpt}</p>}
                        <p className="muted">{mistake.explanation}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {tips.length > 0 && (
                <section className="detail-section">
                  <h3>发音与流利度</h3>
                  {tips.map((tip, index) => <p key={index}>{tip}</p>)}
                </section>
              )}

              {weak.length > 0 && (
                <section className="detail-section">
                  <h3>需要留意的音素</h3>
                      <div className="weak-phoneme-list">
                    {weak.map((item) => (
                      <span key={item.phoneme}>/{item.phoneme}/ · {Math.round(item.avg_score)} 分</span>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
