import { useEffect } from 'react'
import type { LessonPlan } from '../types'

interface PlanBarProps {
  plan: LessonPlan | null
  open: boolean
  onClose: () => void
}

const KIND_LABEL: Record<string, string> = {
  question: '新题',
  cue_card: '题卡',
  revisit: '复习',
  follow_up: '追问',
}

export function PlanBar({ plan, open, onClose }: PlanBarProps) {
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="side-drawer" role="dialog" aria-modal="true" aria-label="本节题单" onClick={(event) => event.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <p className="eyebrow">LESSON PLAN</p>
            <h2>本节题单</h2>
          </div>
          <button className="close-button" onClick={onClose} aria-label="关闭题单">×</button>
        </header>

        {!plan ? (
          <p className="muted">这节课还没有题单，考官会自由出题。</p>
        ) : (
          <>
            <section className="drawer-section">
              <h3>{plan.topic.title_zh || plan.topic.title || '自由练习'}</h3>
              <p>{plan.rationale}</p>
              {plan.focus.length > 0 && (
                <ul className="plain-list">
                  {plan.focus.map((item) => <li key={item}>{item}</li>)}
                </ul>
              )}
            </section>

            <section className="drawer-section">
              <h3>{plan.questions.length} 道问题</h3>
              <ol className="plan-list">
                {plan.questions.map((question, index) => (
                  <li key={`${question.ref ?? question.text}-${index}`}>
                    <span>{KIND_LABEL[question.kind] ?? question.kind} · {question.part}</span>
                    <p>{question.text}</p>
                  </li>
                ))}
              </ol>
            </section>

            {(plan.review.grammar_patterns.length > 0 || plan.review.weak_phonemes.length > 0) && (
              <section className="drawer-section">
                <h3>带着复习目标来</h3>
                {plan.review.grammar_patterns.map((item, index) => (
                  <p key={index}>{typeof item === 'string' ? item : `${item.pattern}${item.count ? ` · ${item.count} 次` : ''}`}</p>
                ))}
                {plan.review.weak_phonemes.map((item) => (
                  <p key={item.phoneme}>/{item.phoneme}/ · 平均 {Math.round(item.avg_score)} 分</p>
                ))}
              </section>
            )}

            {plan.review.revisit_questions.length > 0 && (
              <section className="drawer-section">
                <h3>旧题回访</h3>
                {plan.review.revisit_questions.map((item, index) => (
                  <p key={index}>{typeof item === 'string' ? item : item.question}</p>
                ))}
              </section>
            )}

            {plan.review.story_to_polish && (
              <section className="drawer-section">
                <h3>{plan.review.story_to_polish.title}</h3>
                <p>{plan.review.story_to_polish.content}</p>
              </section>
            )}
          </>
        )}
      </aside>
    </div>
  )
}
