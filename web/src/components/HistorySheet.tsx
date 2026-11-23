import { useState } from 'react';
import type { GrammarMistake, LessonRecord, MemoryNote, TurnFeedback } from '@ielts/shared';

const STATUS_LABEL: Record<'planned' | 'live' | 'completed', string> = {
  planned: '待上课',
  live: '进行中',
  completed: '已完成',
};

/**
 * Review JSON can be written back by an external AI client (豆包 / dsh / Codex)
 * through MCP, so every field is treated as possibly missing or the wrong type.
 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asItems<T>(value: T[] | null | undefined): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is T => Boolean(item) && typeof item === 'object');
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asText).filter((item) => item.length > 0);
}

function formatBand(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '—';
}

function MistakeRow({ mistake }: { mistake: GrammarMistake }) {
  const original = asText(mistake.original);
  const corrected = asText(mistake.corrected);
  const category = asText(mistake.category);
  const explanation = asText(mistake.explanation_zh);
  if (!original && !corrected) return null;
  return (
    <div className="mistake">
      <strong>
        {original && <span className="wrong">{original}</span>}
        {original && corrected ? ' → ' : null}
        {corrected && <span className="right">{corrected}</span>}
      </strong>
      {(category || explanation) && (
        <span>{[category, explanation].filter((item) => item).join(' · ')}</span>
      )}
    </div>
  );
}

/** A single saved TurnFeedback block, shown under its user subtitle in history. */
function LineFeedback({ feedback }: { feedback: TurnFeedback }) {
  const corrected = asText(feedback.corrected_text);
  const upgraded = asText(feedback.upgraded_text);
  const coachNote = asText(feedback.coach_note_zh);
  const mistakes = asItems(feedback.grammar_mistakes);
  const tips = asItems(feedback.lexical_tips);
  if (!corrected && !upgraded && !coachNote && mistakes.length === 0 && tips.length === 0) return null;
  return (
    <div className="history-feedback">
      {(corrected || upgraded) && (
        <div className="diff">
          {corrected && (
            <div>
              <span className="tag">修正</span>
              <span className="right">{corrected}</span>
            </div>
          )}
          {upgraded && (
            <div className="upgraded">
              <span className="tag">Band 8</span>
              {upgraded}
            </div>
          )}
        </div>
      )}
      {mistakes.map((mistake, index) => (
        <MistakeRow key={String(index)} mistake={mistake} />
      ))}
      {tips.map((tip, index) => {
        const basic = asText(tip.basic);
        const better = asText(tip.upgraded);
        const usage = asText(tip.usage_zh);
        if (!basic && !better) return null;
        return (
          <div className="mistake" key={'tip-' + String(index)}>
            <strong>
              {basic && <span className="wrong">{basic}</span>}
              {basic && better ? ' → ' : null}
              {better && <span className="right">{better}</span>}
            </strong>
            {usage && <span>{usage}</span>}
          </div>
        );
      })}
      {coachNote && <p className="hint coach-note">{coachNote}</p>}
    </div>
  );
}

function lessonStatus(lesson: LessonRecord): 'planned' | 'live' | 'completed' {
  if (lesson.status) return lesson.status;
  return lesson.report ? 'completed' : 'live';
}

export function HistorySheet(props: {
  open: boolean;
  lessons: LessonRecord[];
  memory: MemoryNote[];
  onClose: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onDeleteMemory: (note: MemoryNote) => void;
}) {
  const { open, lessons, memory, onClose, onExport, onImport, onDeleteMemory } = props;
  const [selected, setSelected] = useState<LessonRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  if (!open) return null;

  const close = () => {
    setSelected(null);
    setPendingDelete(null);
    onClose();
  };

  const report = selected?.report || null;
  const reportBands = report?.bands;
  const reportSummary = asText(report?.summary_zh);
  const reportMistakes = asItems(report?.top_mistakes);
  const reportUpgraded = asStringList(report?.upgraded_sentences);

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div className="sheet" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <h2>{selected ? '这一节课' : '历史与记忆'}</h2>

        {selected ? (
          <>
            <p className="hint">
              {new Date(selected.startedAt).toLocaleString('zh-CN')} · {selected.partMode} · {selected.topic || '未命名话题'}{' '}
              · {STATUS_LABEL[lessonStatus(selected)]}
            </p>
            <div className="history-lines">
              {selected.lines.map((line) => {
                // Saved per-sentence review (from the web coach or an external AI via MCP).
                const saved = line.role === 'user' && selected.feedback ? selected.feedback[line.id] : undefined;
                const lineFeedback = saved && typeof saved === 'object' ? saved : null;
                return (
                  <div key={line.id} className="history-line-block">
                    <div className={'line ' + line.role}>
                      <span className="who">{line.role === 'user' ? '你' : '考官'}</span>
                      {line.text}
                    </div>
                    {lineFeedback && <LineFeedback feedback={lineFeedback} />}
                  </div>
                );
              })}
            </div>
            {selected.report && (
              <div className="panel-card">
                <h3>四维评分</h3>
                <p>
                  Overall {formatBand(reportBands?.overall)} · FC {formatBand(reportBands?.fc)} · LR{' '}
                  {formatBand(reportBands?.lr)} · GRA {formatBand(reportBands?.gra)} · PR {formatBand(reportBands?.pr)}
                </p>
                {reportSummary && <p className="hint">{reportSummary}</p>}
                {reportMistakes.length > 0 && (
                  <div className="report-list">
                    <h4>Top 错题</h4>
                    {reportMistakes.map((mistake, index) => (
                      <MistakeRow key={String(index)} mistake={mistake} />
                    ))}
                  </div>
                )}
                {reportUpgraded.length > 0 && (
                  <div className="report-list">
                    <h4>可以直接背的升级句</h4>
                    <ul>
                      {reportUpgraded.map((sentence, index) => (
                        <li key={String(index)}>{sentence}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <div className="sheet-actions">
              <button className="ghost" onClick={() => setSelected(null)}>
                返回列表
              </button>
              <button className="primary" onClick={close}>
                关闭
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <span>已存课程（{lessons.length}）</span>
              {lessons.length === 0 && <p className="hint">还没有历史课。上完一节会自动存在这台设备。</p>}
              <div className="history-list">
                {lessons.slice(0, 20).map((lesson) => {
                  const status = lessonStatus(lesson);
                  return (
                    <button key={lesson.id} className="history-item" onClick={() => setSelected(lesson)}>
                      <strong>
                        {new Date(lesson.startedAt).toLocaleDateString('zh-CN')} · {lesson.partMode}
                      </strong>
                      <span>{lesson.topic || '未命名话题'}</span>
                      <em className={'history-status ' + status}>
                        {STATUS_LABEL[status]}
                        {lesson.report ? ' · Overall ' + formatBand(lesson.report.bands?.overall) : ''}
                      </em>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="field">
              <span>长期记忆（{memory.length}）· 点 × 可删除</span>
              {memory.length === 0 && <p className="hint">上完课会自动记下薄弱点，下次开课会带进考官提示里。</p>}
              <div className="memory-tags">
                {memory.slice(0, 12).map((note) => (
                  <span key={note.id} className={'memory-tag' + (pendingDelete === note.id ? ' confirming' : '')}>
                    {pendingDelete === note.id ? (
                      <>
                        <span>删除「{note.title}」？</span>
                        <button
                          className="memory-yes"
                          onClick={() => {
                            setPendingDelete(null);
                            onDeleteMemory(note);
                          }}
                        >
                          确认
                        </button>
                        <button className="memory-no" onClick={() => setPendingDelete(null)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <>
                        <span title={note.content}>{note.title}</span>
                        <button className="memory-x" title="删除这条长期记忆" onClick={() => setPendingDelete(note.id)}>
                          ×
                        </button>
                      </>
                    )}
                  </span>
                ))}
              </div>
            </div>

            <div className="sheet-actions">
              <button className="ghost" onClick={onExport}>
                导出学习档案
              </button>
              <label className="ghost file-label">
                导入档案
                <input
                  type="file"
                  accept="application/json"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) onImport(file);
                  }}
                />
              </label>
              <button className="primary" onClick={close}>
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
