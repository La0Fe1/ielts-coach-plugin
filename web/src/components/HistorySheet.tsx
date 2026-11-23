import { useState } from 'react';
import type { LessonRecord, MemoryNote } from '@ielts/shared';

export function HistorySheet(props: {
  open: boolean;
  lessons: LessonRecord[];
  memory: MemoryNote[];
  onClose: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
}) {
  const { open, lessons, memory, onClose, onExport, onImport } = props;
  const [selected, setSelected] = useState<LessonRecord | null>(null);
  if (!open) return null;

  const close = () => {
    setSelected(null);
    onClose();
  };

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div className="sheet" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <h2>{selected ? '这一节课' : '历史与记忆'}</h2>

        {selected ? (
          <>
            <p className="hint">
              {new Date(selected.startedAt).toLocaleString('zh-CN')} · {selected.partMode} · {selected.topic}
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
                {lessons.slice(0, 20).map((lesson) => (
                  <button key={lesson.id} className="history-item" onClick={() => setSelected(lesson)}>
                    <strong>{new Date(lesson.startedAt).toLocaleDateString('zh-CN')} · {lesson.partMode}</strong>
                    <span>{lesson.topic || '未命名话题'}</span>
                    <em>
                      {lesson.report ? 'Overall ' + lesson.report.bands.overall.toFixed(1) : '未评分'}
                    </em>
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <span>长期记忆（{memory.length}）</span>
              {memory.length === 0 && <p className="hint">上完课会自动记下薄弱点，下次开课会带进考官提示里。</p>}
              <div className="memory-tags">
                {memory.slice(0, 12).map((note) => (
                  <span key={note.id} className="memory-tag" title={note.content}>
                    {note.title}
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
