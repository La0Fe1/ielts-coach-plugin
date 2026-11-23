import type { TurnFeedback } from '@ielts/shared';

export function FeedbackCard({ feedback }: { feedback: TurnFeedback | null }) {
  if (!feedback) {
    return (
      <div className="panel-card">
        <h3>本轮精批</h3>
        <p className="hint">说完一句后，这里会在后台生成语法修正和升级表达。</p>
      </div>
    );
  }
  return (
    <div className="panel-card">
      <h3>本轮精批</h3>
      {feedback.coach_note_zh && <p className="hint">{feedback.coach_note_zh}</p>}
      {(feedback.corrected_text || feedback.upgraded_text) && (
        <div className="diff">
          {feedback.corrected_text && (
            <div>
              <span className="tag">修正</span>
              {feedback.corrected_text}
            </div>
          )}
          {feedback.upgraded_text && (
            <div className="upgraded">
              <span className="tag">Band 8</span>
              {feedback.upgraded_text}
            </div>
          )}
        </div>
      )}
      {feedback.grammar_mistakes.map((mistake, index) => (
        <div className="mistake" key={String(index)}>
          <strong>
            {mistake.original} → {mistake.corrected}
          </strong>
          <span>
            {mistake.category} · {mistake.explanation_zh}
          </span>
        </div>
      ))}
      {feedback.lexical_tips.length > 0 && (
        <div className="mistake">
          <strong>高分替换</strong>
          {feedback.lexical_tips.map((tip, index) => (
            <span key={String(index)}>
              {tip.basic} → {tip.upgraded}（{tip.usage_zh}）
            </span>
          ))}
        </div>
      )}
      {!feedback.corrected_text && feedback.grammar_mistakes.length === 0 && (
        <p className="hint">这句没有明显的语法问题，继续保持。</p>
      )}
    </div>
  );
}
