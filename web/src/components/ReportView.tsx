import type { LessonReport } from '@ielts/shared';

const DIMENSIONS: Array<[keyof LessonReport['bands'], string]> = [
  ['overall', 'Overall'],
  ['fc', '流利连贯'],
  ['lr', '词汇资源'],
  ['gra', '语法多样'],
  ['pr', '发音'],
];

export function ReportView(props: {
  report: LessonReport | null;
  loading: boolean;
  onRestart: () => void;
  onDownload: () => void;
}) {
  const { report, loading, onRestart, onDownload } = props;
  return (
    <div className="report">
      <p className="pill neutral">LESSON REPORT</p>
      <h1>这节课，留下了什么</h1>
      {loading && <p className="hint">正在汇总本课录音与精批，生成四维报告…</p>}
      {!loading && !report && <p className="hint">本课没有生成报告，可以再来一节。</p>}
      {report && (
        <>
          <div className="bands">
            {DIMENSIONS.map(([key, label]) => (
              <div className="band" key={key}>
                <strong>{report.bands[key].toFixed(1)}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          {report.summary_zh && (
            <section className="report-section">
              <h2>总评</h2>
              <p>{report.summary_zh}</p>
            </section>
          )}
          {report.top_mistakes.length > 0 && (
            <section className="report-section">
              <h2>Top 错题</h2>
              {report.top_mistakes.map((mistake, index) => (
                <div className="mistake" key={String(index)}>
                  <strong>
                    {mistake.original} → {mistake.corrected}
                  </strong>
                  <span>
                    {mistake.category} · {mistake.explanation_zh}
                  </span>
                </div>
              ))}
            </section>
          )}
          {report.upgraded_sentences.length > 0 && (
            <section className="report-section">
              <h2>可以直接背的升级句</h2>
              {report.upgraded_sentences.map((sentence, index) => (
                <div className="upgraded" key={String(index)} style={{ marginBottom: 8 }}>
                  {sentence}
                </div>
              ))}
            </section>
          )}
          {report.memory_updates.length > 0 && (
            <section className="report-section">
              <h2>记进长期记忆</h2>
              {report.memory_updates.map((note) => (
                <div className="mistake" key={note.id}>
                  <strong>{note.title}</strong>
                  <span>{note.content}</span>
                </div>
              ))}
            </section>
          )}
        </>
      )}
      <div className="row" style={{ marginTop: 18 }}>
        <button className="primary" onClick={onRestart}>
          再来一节
        </button>
        <button className="ghost" onClick={onDownload} disabled={!report}>
          下载 Markdown
        </button>
      </div>
    </div>
  );
}
