import type { LessonPlan } from '../types'

interface PlanDrawerProps {
  open: boolean
  plan: LessonPlan | null
  onClose: () => void
}

export function PlanDrawer({ open, plan, onClose }: PlanDrawerProps) {
  if (!open) return null
  return <div className="drawer-backdrop" onClick={onClose}><aside className="side-drawer" role="dialog" aria-modal="true" aria-label="本课题单" onClick={(event) => event.stopPropagation()}>
    <header className="drawer-head"><div><p className="eyebrow">LESSON MAP</p><h2>本课题单</h2><p>{plan?.topic.title ?? '题目生成中'}</p></div><button className="close-button" onClick={onClose} aria-label="关闭题单">×</button></header>
    {plan ? <><section className="drawer-section"><h3>本课目标</h3><div className="choice-chips static-chips">{plan.focus.map((item) => <span key={item}>{item}</span>)}</div>{plan.rationale && <p className="muted">{plan.rationale}</p>}</section><section className="drawer-section"><h3>{plan.is_first_lesson ? '首次课程问题' : '复习与题目'}</h3><ol className="plan-list">{plan.questions.map((question, index) => <li key={`${question.text}-${index}`}><span>{question.part} · {question.kind}{question.ref ? ` · ${question.ref}` : ''}</span><p>{question.text}</p></li>)}</ol></section>{(plan.review.revisit_questions.length > 0 || plan.review.grammar_patterns.length > 0 || plan.review.story_to_polish) && <section className="drawer-section"><h3>从记忆里带出</h3>{plan.review.revisit_questions.length > 0 && <ul>{plan.review.revisit_questions.map((item, index) => <li key={index}>{typeof item === 'string' ? item : item.question}</li>)}</ul>}{plan.review.grammar_patterns.length > 0 && <p>语法：{plan.review.grammar_patterns.map((item) => typeof item === 'string' ? item : item.pattern).join('、')}</p>}{plan.review.story_to_polish && <p>打磨故事：{plan.review.story_to_polish.title}</p>}</section>}</> : <p className="muted">题单尚未生成。</p>}
  </aside></div>
}
