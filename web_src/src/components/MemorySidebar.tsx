import type { LearnerContext } from '../types'

interface Props {
  context: LearnerContext | null
}

const MEMORY_LABEL: Record<string, string> = {
  personal_fact: '个人事实',
  part2_story: 'Part 2 素材',
  weakness_grammar: '语法顽疾',
  weakness_phoneme: '弱音素',
  next_lesson_plan: '下节课处方',
}

export function MemorySidebar({ context }: Props) {
  if (!context) {
    return (
      <div className="memory">
        <p className="muted">还没有加载长期记忆。</p>
      </div>
    )
  }

  const profile = context.profile
  const history = context.band_history ?? []

  return (
    <div className="memory">
      <section className="memory-block">
        <h3>学习者画像</h3>
        <div className="kv">
          <span>目标分</span>
          <strong>{profile.target_band}</strong>
        </div>
        <div className="kv">
          <span>口音偏好</span>
          <strong>{profile.accent_preference === 'uk' ? '英音' : '美音'}</strong>
        </div>
        <div className="kv">
          <span>上课次数</span>
          <strong>{history.length}</strong>
        </div>
      </section>

      <section className="memory-block">
        <h3>Top 语法顽疾</h3>
        {context.top_grammar_weaknesses.length === 0 && <p className="muted small">暂无记录</p>}
        <ul className="memory-list">
          {context.top_grammar_weaknesses.map((item) => (
            <li key={item.error_pattern}>
              <code>{item.error_pattern}</code>
              <span className="badge">{item.count} 次</span>
              {item.explanation && <p className="muted small">{item.explanation}</p>}
            </li>
          ))}
        </ul>
      </section>

      <section className="memory-block">
        <h3>Top 弱音素 {context.top_weak_phonemes.length === 0 && <span className="muted small">（Phase 2 启用）</span>}</h3>
        <ul className="memory-list">
          {context.top_weak_phonemes.map((item) => (
            <li key={item.phoneme}>
              <span className="phoneme">/{item.phoneme}/</span>
              <span className="badge">{item.avg_score} 分</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="memory-block">
        <h3>已有 Part 2 素材</h3>
        {context.part2_stories.length === 0 && <p className="muted small">暂无记录</p>}
        <ul className="memory-list">
          {context.part2_stories.map((story) => (
            <li key={story.id}>
              <strong>{story.title}</strong>
              <p className="muted small">{story.content}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="memory-block">
        <h3>个人事实</h3>
        {context.personal_facts.length === 0 && <p className="muted small">暂无记录</p>}
        <ul className="memory-list">
          {context.personal_facts.slice(0, 6).map((fact) => (
            <li key={fact.id}>
              <span className="chip tiny">{MEMORY_LABEL[fact.memory_type] ?? fact.memory_type}</span>
              <strong>{fact.title}</strong>
              <p className="muted small">{fact.content}</p>
            </li>
          ))}
        </ul>
      </section>

      {context.last_lesson_plan && (
        <section className="memory-block highlight">
          <h3>上节课处方</h3>
          <p className="small">{context.last_lesson_plan.content}</p>
        </section>
      )}
    </div>
  )
}
