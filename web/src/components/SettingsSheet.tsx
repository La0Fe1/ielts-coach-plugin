import { useEffect, useState } from 'react';
import type { PublicConfig, RealtimeSettings } from '@ielts/shared';

const PROVIDERS: Array<{ id: RealtimeSettings['provider']; label: string; models: string[] }> = [
  { id: 'qwen', label: '阿里云百炼（国内）', models: ['qwen3-omni-flash-realtime', 'qwen-omni-turbo-realtime'] },
  { id: 'gemini', label: 'Google Gemini（海外）', models: ['gemini-2.5-flash-native-audio', 'gemini-3.8-live'] },
  { id: 'openai', label: 'OpenAI / 中转', models: ['gpt-realtime', 'gpt-realtime-mini', 'gpt-4o-realtime-preview'] },
];

export function SettingsSheet(props: {
  open: boolean;
  value: RealtimeSettings;
  config: PublicConfig | null;
  onClose: () => void;
  onSave: (next: RealtimeSettings) => void;
}) {
  const { open, value, config, onClose, onSave } = props;
  const [draft, setDraft] = useState<RealtimeSettings>(value);

  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  if (!open) return null;
  const provider = PROVIDERS.find((item) => item.id === draft.provider) || PROVIDERS[0];

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <h2>连接设置</h2>
        <p className="hint">
          用自己的 Key（只存在这台设备的浏览器里），或用朋友分享的访问口令。
        </p>
        <div className="chips">
          {PROVIDERS.map((item) => (
            <button
              key={item.id}
              className={'chip' + (draft.provider === item.id ? ' selected' : '')}
              onClick={() =>
                setDraft({
                  ...draft,
                  provider: item.id,
                  model: item.models[0],
                })
              }
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="field">
          <span>模型</span>
          <select className="select" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
            {provider.models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>API Key（BYOK，只存在本机）</span>
          <input
            className="input"
            type="password"
            autoComplete="off"
            placeholder="sk-..."
            value={draft.apiKey || ''}
            onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
          />
        </label>
        {config?.hasAccessCode && (
          <label className="field">
            <span>朋友的访问口令</span>
            <input
              className="input"
              placeholder="例如 ielts2026"
              value={draft.accessCode || ''}
              onChange={(event) => setDraft({ ...draft, accessCode: event.target.value })}
            />
          </label>
        )}
        <label className="field">
          <span>高级：自定义 endpoint（中转站 / 反代，可留空）</span>
          <input
            className="input"
            placeholder="wss://..."
            value={draft.endpointUrl || ''}
            onChange={(event) => setDraft({ ...draft, endpointUrl: event.target.value })}
          />
        </label>
        {config && (
          <p className="hint">
            站长已配置：
            {Object.entries(config.serverProviders)
              .filter(([, on]) => on)
              .map(([name]) => name)
              .join(' / ') || '无（只能用自带 Key）'}
          </p>
        )}
        <div className="sheet-actions">
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="primary" onClick={() => onSave(draft)}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
