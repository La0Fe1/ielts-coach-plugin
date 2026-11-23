import { useState } from 'react';
import type { LessonRecord, MemoryNote } from '@ielts/shared';

const STATUS_LABEL: Record<'planned' | 'live' | 'completed', string> = {
  planned: '待上课',
  live: '进行中',
  completed: '已完成',
};

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
              {selected.lines.map((line) => (
                <div key={line.id} className={'line ' + line.role}>
                  <span className="who">{line.role === 'user' ? '你' : '考官'}</span>
                  {line.text}
                </div>
              ))}
            </div>
            {selected.report && (
              <div className="panel-card">
                <h3>四维评分</h3>
                <p>
                  Overall {selected.report.bands.overall.toFixed(1)} · FC {selected.report.bands.fc.toFixed(1)} · LR{' '}
                  {selected.report.bands.lr.toFixed(1)} · GRA {selected.report.bands.gra.toFixed(1)} · PR{' '}
                  {selected.report.bands.pr.toFixed(1)}
                </p>
                <p className="hint">{selected.report.summary_zh}</p>
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
                        {lesson.report ? ' · Overall ' + lesson.report.bands.overall.toFixed(1) : ''}
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
