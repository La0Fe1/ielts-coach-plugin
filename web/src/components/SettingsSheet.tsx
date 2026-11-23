import { useEffect, useState } from 'react';
import type { PublicConfig, RealtimeSettings } from '@ielts/shared';

const PROVIDERS: Array<{ id: RealtimeSettings['provider']; label: string; models: string[] }> = [
  {
    id: 'qwen',
    label: '阿里云百炼（国内）',
    models: ['qwen3.8-omni-flash-realtime', 'qwen3.5-omni-flash-realtime', 'qwen3-omni-flash-realtime', 'qwen-omni-turbo-realtime'],
  },
  { id: 'gemini', label: 'Google Gemini（海外）', models: ['gemini-2.5-flash-native-audio', 'gemini-3.8-live'] },
  { id: 'openai', label: 'OpenAI / 中转', models: ['gpt-realtime', 'gpt-realtime-mini', 'gpt-4o-realtime-preview'] },
];

type Tab = 'key' | 'code';

export function SettingsSheet(props: {
  open: boolean;
  value: RealtimeSettings;
  config: PublicConfig | null;
  onClose: () => void;
  onSave: (next: RealtimeSettings) => void;
}) {
  const { open, value, config, onClose, onSave } = props;
  const [draft, setDraft] = useState<RealtimeSettings>(value);
  const [tab, setTab] = useState<Tab>(value.accessCode && !value.apiKey ? 'code' : 'key');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(value);
      setTestResult(null);
      setTab(value.accessCode && !value.apiKey ? 'code' : 'key');
    }
  }, [open, value]);

  if (!open) return null;
  const provider = PROVIDERS.find((item) => item.id === draft.provider) || PROVIDERS[0];

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch('/api/coach/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: draft.provider,
          apiKey: draft.apiKey,
          accessCode: draft.accessCode,
          coachApiKey: draft.coachApiKey,
          coachBaseUrl: draft.coachBaseUrl,
          coachModel: draft.coachModel,
        }),
      });
      const data = (await response.json()) as { ok?: boolean; latency_ms?: number; message?: string; error?: string };
      if (response.ok && data.ok) setTestResult('✅ 连接正常 · ' + String(data.latency_ms ?? '?') + 'ms');
      else setTestResult('❌ ' + (data.error || data.message || '连接失败'));
    } catch (error) {
      setTestResult('❌ ' + String(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <h2>连接设置</h2>
        <div className="tabs">
          <button className={'tab' + (tab === 'key' ? ' selected' : '')} onClick={() => setTab('key')}>
            自带 API Key
          </button>
          {config?.hasAccessCode && (
            <button className={'tab' + (tab === 'code' ? ' selected' : '')} onClick={() => setTab('code')}>
              朋友访问口令
            </button>
          )}
        </div>

        <div className="chips">
          {PROVIDERS.map((item) => (
            <button
              key={item.id}
              className={'chip' + (draft.provider === item.id ? ' selected' : '')}
              onClick={() => setDraft({ ...draft, provider: item.id, model: item.models[0] })}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'key' ? (
          <>
            <label className="field">
              <span>模型（可下拉，也可直接填任意模型名）</span>
              <input
                className="input"
                list="model-presets"
                value={draft.model}
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              />
              <datalist id="model-presets">
                {provider.models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span>API Key</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                placeholder="sk-..."
                value={draft.apiKey || ''}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              />
              <span className="hint">仅存于当前浏览器本地</span>
            </label>
            {draft.provider === 'qwen' && (
              <label className="field">
                <span>Workspace ID（新版百炼可选，留空走公共地址）</span>
                <input
                  className="input"
                  placeholder="ws-..."
                  value={draft.workspaceId || ''}
                  onChange={(event) => setDraft({ ...draft, workspaceId: event.target.value })}
                />
              </label>
            )}
          </>
        ) : (
          <label className="field">
            <span>访问口令</span>
            <input
              className="input"
              placeholder="问朋友要一个"
              value={draft.accessCode || ''}
              onChange={(event) => setDraft({ ...draft, accessCode: event.target.value })}
            />
          </label>
        )}

        <details className="advanced">
          <summary>高级选项</summary>
          <label className="field">
            <span>自定义接口地址（中转 / 反代，可留空）</span>
            <input
              className="input"
              placeholder="wss://..."
              value={draft.endpointUrl || ''}
              onChange={(event) => setDraft({ ...draft, endpointUrl: event.target.value })}
            />
          </label>
          <label className="field">
            <span>精批专用 API Key（可选，单独挂 DeepSeek 更省）</span>
            <input
              className="input"
              type="password"
              autoComplete="off"
              value={draft.coachApiKey || ''}
              onChange={(event) => setDraft({ ...draft, coachApiKey: event.target.value })}
            />
          </label>
          <label className="field">
            <span>精批接口地址（可选）</span>
            <input
              className="input"
              placeholder="https://api.deepseek.com/v1"
              value={draft.coachBaseUrl || ''}
              onChange={(event) => setDraft({ ...draft, coachBaseUrl: event.target.value })}
            />
          </label>
          <label className="field">
            <span>精批模型（可选）</span>
            <input
              className="input"
              placeholder="deepseek-chat"
              value={draft.coachModel || ''}
              onChange={(event) => setDraft({ ...draft, coachModel: event.target.value })}
            />
          </label>
        </details>

        {config && (
          <p className="hint">
            站长可用：
            {Object.entries(config.serverProviders)
              .filter(([, on]) => on)
              .map(([name]) => name)
              .join(' / ') || '无（只能自带 Key）'}
          </p>
        )}
        {testResult && <p className={testResult.startsWith('✅') ? 'ok-text' : 'error'}>{testResult}</p>}

        <div className="sheet-actions">
          <button className="ghost" onClick={() => void testConnection()} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
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
