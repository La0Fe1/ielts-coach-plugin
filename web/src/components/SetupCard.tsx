import type { PartMode, RealtimeSettings } from '@ielts/shared';

const PARTS: Array<{ id: PartMode; label: string; hint: string }> = [
  { id: 'part1', label: 'Part 1 日常问答', hint: '4 题热身' },
  { id: 'part2', label: 'Part 2 题卡独白', hint: '1 分钟准备 + 2 分钟作答' },
  { id: 'part3', label: 'Part 3 深度思辨', hint: '4 题追问' },
  { id: 'full_mock', label: '全真模考', hint: 'Part 1 → 2 → 3' },
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
        <p className="pill">实时语音 · 2.0</p>
        <h1>打开就能练的雅思口语外教</h1>
        <p className="lead">
          像打电话一样对话：考官会实时听、实时接话，你可以随时打断。语法和升级表达在后台安静生成，不打断开口。
        </p>

        <div className="field">
          <span>练哪一部分</span>
          <div className="chips">
            {PARTS.map((part) => (
              <button
                key={part.id}
                className={'chip' + (settings.partMode === part.id ? ' selected' : '')}
                onClick={() => onChange({ partMode: part.id })}
                title={part.hint}
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

        <div className="hint">
          当前服务商：{settings.provider} · {settings.model}
          {settings.apiKey ? ' · 已用自带 Key' : settings.accessCode ? ' · 已用访问口令' : ' · 尚未配置'}
          {historyCount > 0 ? ' · 本机已存 ' + String(historyCount) + ' 节课' : ''}
        </div>

        {error && <p className="error">{error}</p>}

        <button className="primary big-cta" onClick={onStart} disabled={busy || !ready}>
          {busy ? '正在连接…' : '开始实时语音连麦'}
        </button>
        <div className="row">
          <button className="ghost" onClick={onOpenSettings}>
            连接设置
          </button>
          <button className="ghost" onClick={onOpenHistory} disabled={historyCount === 0}>
            历史课
          </button>
        </div>
        <p className="hint">第一次点开始会请求麦克风权限；Key 只保存在你自己的浏览器里。</p>
      </div>
    </div>
  );
}
