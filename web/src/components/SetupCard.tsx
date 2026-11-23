import type { PartMode, RealtimeSettings } from '@ielts/shared';

const PARTS: Array<{ id: PartMode; label: string }> = [
  { id: 'part1', label: 'Part 1 日常问答' },
  { id: 'part2', label: 'Part 2 题卡独白' },
  { id: 'part3', label: 'Part 3 深度思辨' },
  { id: 'full_mock', label: '全真模考' },
];

const STYLES: Array<{ id: RealtimeSettings['style']; label: string }> = [
  { id: 'friendly', label: '友好鼓励' },
  { id: 'strict', label: '严格考官' },
  { id: 'coach', label: '纠错私教' },
];

export function SetupCard(props: {
  settings: RealtimeSettings;
  onChange: (patch: Partial<RealtimeSettings>) => void;
  onStart: () => void;
  onOpenSettings: () => void;
  onOpenHistory: () => void;
  busy: boolean;
  error: string | null;
  ready: boolean;
  historyCount: number;
}) {
  const { settings, onChange, onStart, onOpenSettings, onOpenHistory, busy, error, ready, historyCount } = props;
  return (
    <div className="setup-wrap">
      <div className="setup-card">
        <p className="pill">实时语音模考</p>
        <h1>随时开口，练真雅思</h1>
        <p className="lead">真实考官对话节奏，实时双语字幕同步，说完即看高分润色。</p>

        <div className="field">
          <span>练哪一部分</span>
          <div className="chips">
            {PARTS.map((part) => (
              <button
                key={part.id}
                className={'chip' + (settings.partMode === part.id ? ' selected' : '')}
                onClick={() => onChange({ partMode: part.id })}
              >
                {part.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>目标分数</span>
          <div className="chips">
            {[6, 6.5, 7, 7.5, 8, 8.5].map((band) => (
              <button
                key={band}
                className={'chip' + (settings.targetBand === band ? ' selected' : '')}
                onClick={() => onChange({ targetBand: band })}
              >
                {band.toFixed(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>考官风格</span>
          <div className="chips">
            {STYLES.map((style) => (
              <button
                key={style.id}
                className={'chip' + (settings.style === style.id ? ' selected' : '')}
                onClick={() => onChange({ style: style.id })}
              >
                {style.label}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="error">{error}</p>}

        <button
          className="primary big-cta"
          onClick={() => (ready ? onStart() : onOpenSettings())}
          disabled={busy}
        >
          {busy ? '正在连接…' : ready ? '开始对话' : '配置连接并开始'}
        </button>
        <div className="row">
          <button className="ghost" onClick={onOpenSettings}>
            连接设置
          </button>
          <button className="ghost" onClick={onOpenHistory}>
            历史课{historyCount > 0 ? '（' + String(historyCount) + '）' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
