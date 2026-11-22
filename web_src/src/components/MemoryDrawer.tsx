import { useEffect } from 'react'
import type { LearnerContext } from '../types'

interface MemoryDrawerProps {
  open: boolean
  context: LearnerContext | null
  onClose: () => void
  onDrill?: () => void
}

export function MemoryDrawer({ open, context, onClose, onDrill }: MemoryDrawerProps) {
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="side-drawer" role="dialog" aria-modal="true" aria-label="长期记忆" onClick={(event) => event.stopPropagation()}>
        <header className="drawer-head">
          <div><p className="eyebrow">LEARNER MEMORY</p><h2>老师记得的事</h2></div>
          <button className="close-button" onClick={onClose} aria-label="关闭长期记忆">×</button>
        </header>

        {onDrill && (
          <div className="drawer-section">
            <button className="primary-button" onClick={onDrill}>针对薄弱点开一节专项课</button>
          </div>
        )}

        {!context ? <p className="muted">还没有读取到学习者记忆。</p> : (
          <>
            <section className="drawer-section memory-profile">
              <h3>学习目标</h3>
              <p>目标 Band <strong>{context.profile.target_band}</strong></p>
              <p>示范口音：{context.profile.accent_preference === 'uk' ? '英音' : '美音'} · 已练 {context.band_history.length} 节课</p>
            </section>

            <section className="drawer-section">
              <h3>反复出现的语法问题</h3>
              {context.top_grammar_weaknesses.length === 0 && <p className="muted">暂无记录。</p>}
              <ul className="plain-list">
                {context.top_grammar_weaknesses.map((item) => (
                  <li key={item.error_pattern}>
                    <strong>{item.error_pattern}</strong> · {item.count} 次
                    {item.explanation && <p className="muted">{item.explanation}</p>}
                  </li>
                ))}
              </ul>
            </section>

            <section className="drawer-section">
              <h3>需要巩固的音素</h3>
              {context.top_weak_phonemes.length === 0 && <p className="muted">暂无记录。</p>}
              {context.top_weak_phonemes.map((item) => (
                <p key={item.phoneme}>/{item.phoneme}/ · {Math.round(item.avg_score)} 分 · 出现 {item.count} 次</p>
              ))}
            </section>

            <section className="drawer-section">
              <h3>你的 Part 2 素材</h3>
              {context.part2_stories.length === 0 && <p className="muted">还没有保存的故事。</p>}
              {context.part2_stories.map((story) => (
                <article className="memory-note" key={story.id}>
                  <strong>{story.title}</strong><p>{story.content}</p>
                </article>
              ))}
            </section>

            <section className="drawer-section">
              <h3>个人表达素材</h3>
              {context.personal_facts.length === 0 && <p className="muted">暂无记录。</p>}
              {context.personal_facts.slice(0, 8).map((fact) => (
                <article className="memory-note" key={fact.id}>
                  <strong>{fact.title}</strong><p>{fact.content}</p>
                </article>
              ))}
            </section>

            {context.last_lesson_plan && (
              <section className="drawer-section">
                <h3>上节课留下的处方</h3>
                <p>{context.last_lesson_plan.content}</p>
              </section>
            )}
          </>
        )}
      </aside>
    </div>
  )
}
