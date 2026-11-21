import { useState } from 'react'
import type { Accent, FeedbackCard, GrammarMistake, Turn } from '../types'

interface Props {
  turn: Turn
  accent: Accent
}

async function speak(text: string, accent: Accent): Promise<void> {
  if (!text.trim()) return
  const response = await fetch('/api/tts/say?text=' + encodeURIComponent(text) + '&accent=' + accent)
  if (!response.ok) return
  const data = (await response.json()) as { url?: string }
  if (!data.url) return
  const audio = new Audio(data.url)
  await audio.play().catch(() => undefined)
}

function pronounceTips(tips: unknown): string[] {
  if (!tips) return []
  if (typeof tips === 'string') return [tips]
  if (Array.isArray(tips)) {
    return tips.map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        return String(record.tip ?? record.text ?? record.coaching_tip ?? JSON.stringify(record))
      }
      return String(item)
    })
  }
  if (typeof tips === 'object') {
    const record = tips as Record<string, unknown>
    return [String(record.summary ?? record.text ?? JSON.stringify(record))]
  }
  return []
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

export function TurnCard({ turn, accent }: Props) {
  const feedback: FeedbackCard | null = (turn.grammar_feedback_json as FeedbackCard) ?? null
  const mistakes: GrammarMistake[] = feedback?.grammar_mistakes ?? []
  const tips = pronounceTips(feedback?.pronunciation_tips)
  const [playing, setPlaying] = useState(false)
  const answered = Boolean(turn.learner_transcript)
  const pauseSource = turn.long_pauses_json?.pauses
  const pauses: Array<{ after_word?: string; duration_sec?: number }> = Array.isArray(pauseSource)
    ? pauseSource
    : []

  return (
    <article className="turn-card">
      <header className="turn-head">
        <span className="turn-index">第 {turn.turn_index} 轮</span>
        <span className="chip tiny">{turn.part}</span>
        {turn.learner_duration_sec ? (
          <span className="chip tiny ghost-chip">{turn.learner_duration_sec.toFixed(1)}s</span>
        ) : null}
        {turn.wpm ? <span className="chip tiny ghost-chip">{Math.round(turn.wpm)} WPM</span> : null}
        {turn.pause_count ? (
          <span className="chip tiny ghost-chip" title="≥0.8 秒的明显停顿次数">
            停顿 {turn.pause_count}
          </span>
        ) : null}
      </header>

      <div className="examiner-line">
        <span className="speaker-icon">🎙</span>
        <p>{turn.examiner_question}</p>
      </div>

      {!answered && <p className="muted small">等待学习者回答…</p>}

      {answered && (
        <div className="answer-block">
          <div className="label-row">
            <span className="label">你的原句</span>
            {turn.learner_audio_url && (
              <button
                className="ghost small"
                onClick={() => {
                  const audio = new Audio(turn.learner_audio_url as string)
                  void audio.play().catch(() => undefined)
                }}
              >
                ▶ 听我的原声
              </button>
            )}
          </div>
          <p className="original">{turn.learner_transcript}</p>
          {pauses.length > 0 && (
            <div className="pause-list">
              {pauses.slice(0, 4).map((pause, index) => (
                <span className="pause-tag" key={String(index)}>
                  在 “{pause.after_word}” 后停顿 {pause.duration_sec}s
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {feedback && (
        <div className="feedback-block">
          {feedback.quick_praise && (
            <div className="praise">
              <span className="praise-icon">✨</span>
              <span>{feedback.quick_praise}</span>
            </div>
          )}

          {feedback.corrected_text && (
            <div className="compare">
              <div className="compare-head">
                <span className="label fix">语法修正</span>
                <button
                  className="ghost tiny"
                  onClick={() => {
                    setPlaying(true)
                    void speak(feedback.corrected_text as string, accent).finally(() => setPlaying(false))
                  }}
                  disabled={playing}
                >
                  {playing ? '合成中…' : '🔊 示范'}
                </button>
              </div>
              <p className="corrected">{feedback.corrected_text}</p>
            </div>
          )}

          {feedback.upgraded_text && (
            <div className="compare">
              <div className="compare-head">
                <span className="label upgrade">7.5+ 地道升级</span>
                <button
                  className="ghost tiny"
                  onClick={() => {
                    setPlaying(true)
                    void speak(feedback.upgraded_text as string, accent).finally(() => setPlaying(false))
                  }}
                  disabled={playing}
                >
                  {playing ? '合成中…' : '🔊 示范'}
                </button>
              </div>
              <p className="upgraded">{feedback.upgraded_text}</p>
            </div>
          )}

          {mistakes.length > 0 && (
            <ul className="mistake-list">
              {mistakes.map((mistake, index) => (
                <li key={String(index)} className="mistake">
                  <div className="mistake-head">
                    <span className={'chip tiny cat-' + mistake.error_category}>
                      {CATEGORY_LABEL[mistake.error_category] ?? mistake.error_category}
                    </span>
                    {mistake.error_pattern ? (
                      <code className="pattern">{mistake.error_pattern}</code>
                    ) : null}
                  </div>
                  <div className="mistake-diff">
                    <span className="wrong">{mistake.original_excerpt}</span>
                    <span className="arrow">→</span>
                    <span className="right">{mistake.corrected_excerpt}</span>
                  </div>
                  {mistake.upgraded_excerpt ? (
                    <div className="mistake-upgrade">升级：{mistake.upgraded_excerpt}</div>
                  ) : null}
                  <div className="mistake-why">{mistake.explanation}</div>
                </li>
              ))}
            </ul>
          )}

          {tips.length > 0 && (
            <div className="pron-tips">
              <span className="label">发音 / 流利度提示</span>
              {tips.map((tip, index) => (
                <p key={String(index)}>{tip}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {answered && !feedback && (
        <p className="muted small pending-feedback">已收到你的回答，正在生成即时纠错…</p>
      )}
    </article>
  )
}
