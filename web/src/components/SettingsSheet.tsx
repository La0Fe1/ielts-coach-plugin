import { useEffect, useRef, useState } from 'react';
import type { PauseTolerance, PublicConfig, RealtimeSettings, ReviewMode } from '@ielts/shared';

type VoiceAccent = NonNullable<RealtimeSettings['voiceAccent']>;

const PROVIDERS: Array<{ id: RealtimeSettings['provider']; label: string; models: string[] }> = [
  {
    // v2.2.0 pure-voice mode: browser SpeechRecognition + Edge TTS, one DeepSeek key.
    id: 'deepseek',
    label: 'DeepSeek 纯语音（仅需 DeepSeek Key）',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'qwen',
    label: '阿里云百炼（国内）',
    models: ['qwen3.8-omni-flash-realtime', 'qwen3.5-omni-flash-realtime', 'qwen3-omni-flash-realtime', 'qwen-omni-turbo-realtime'],
  },
  { id: 'gemini', label: 'Google Gemini（海外）', models: ['gemini-2.5-flash-native-audio', 'gemini-3.8-live'] },
  { id: 'openai', label: 'OpenAI / 中转', models: ['gpt-realtime', 'gpt-realtime-mini', 'gpt-4o-realtime-preview'] },
];

/** DeepSeek pure-voice examiner voices (Edge Neural TTS). */
const VOICE_ACCENTS: Array<{ id: VoiceAccent; label: string }> = [
  { id: 'uk', label: '英音考官 Sonia' },
  { id: 'us', label: '美音考官 Jenny' },
];

/**
 * v2.2.1: how long a thinking pause may last before the answer is submitted.
 * The default used to be too snappy and cut learners off mid-thought.
 */
const PAUSE_TOLERANCES: Array<{ id: PauseTolerance; label: string }> = [
  { id: 'fast', label: '快速（最长约 3.5 秒）' },
  { id: 'standard', label: '标准（最长约 5 秒，推荐）' },
  { id: 'patient', label: '耐心（最长约 6.5 秒）' },
];

/** Official "where do I get a key" links, shown in the collapsible guide card. */
const KEY_GUIDES: Array<{ title: string; url: string; linkText: string; note: string }> = [
  {
    title: 'DeepSeek（单 Key 通吃，最省心）',
    url: 'https://platform.deepseek.com/api_keys',
    linkText: 'platform.deepseek.com/api_keys',
    note: '创建 Key 后选「DeepSeek 纯语音」即可语音 + 实时字幕 + 精批。',
  },
  {
    title: '阿里云百炼 Qwen-Omni（国内直连 · 端到端低延迟）',
    url: 'https://bailian.console.aliyun.com/',
    linkText: 'bailian.console.aliyun.com',
    note: '实名后通常有免费 Token 额度（华北2 北京地域）。',
  },
  {
    title: 'Google Gemini Live（海外 · 免绑卡免费档）',
    url: 'https://aistudio.google.com/apikey',
    linkText: 'aistudio.google.com/apikey',
    note: '登录 Google 账号点 Create API key 即可免费体验，无需信用卡。',
  },
  {
    title: 'OpenAI / 兼容中转站',
    url: 'https://platform.openai.com/api-keys',
    linkText: 'platform.openai.com/api-keys',
    note: '或在「高级选项」填自定义地址。',
  },
];

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = 'deepseek-chat';

interface ReviewModeOption {
  id: ReviewMode;
  label: string;
  hint: string;
}

const REVIEW_MODES: ReviewModeOption[] = [
  {
    id: 'auto',
    label: '网页自动（同当前主服务商）',
    hint: '复用上面的实时语音 Key / 访问口令，由主服务商顺带出每轮语法精批和课后四维报告。',
  },
  {
    id: 'deepseek',
    label: '独立 DeepSeek',
    hint: '地址和模型已自动填好，只需再贴一个 DeepSeek Key；文本精批通常最便宜。',
  },
  {
    id: 'custom',
    label: '独立自定义模型',
    hint: '任何 OpenAI 兼容接口（中转站 / 自建反代 / 其他厂商），自己填地址、模型和 Key。',
  },
  {
    id: 'external',
    label: '交给外部 AI 工具（豆包 / dsh / Codex）免费精批',
    hint: '网页不再发起任何每轮精批请求（不花钱）。字幕仍会存进历史并同步给 MCP 工具，课后复制提示词交给外部 AI 出精批和报告。',
  },
];

type Tab = 'key' | 'code';

function withReviewMode(settings: RealtimeSettings): RealtimeSettings {
  return { ...settings, reviewMode: settings.reviewMode || 'auto' };
}

export function SettingsSheet(props: {
  open: boolean;
  value: RealtimeSettings;
  config: PublicConfig | null;
  onClose: () => void;
  onSave: (next: RealtimeSettings) => void;
  /** Set by App when 首页的「获取 API Key」requests the guide card. */
  guideRequested?: boolean;
  /** Called once after the guide was expanded, so App can reset guideRequested. */
  onGuideShown?: () => void;
}) {
  const { open, value, config, onClose, onSave, guideRequested, onGuideShown } = props;
  const [draft, setDraft] = useState<RealtimeSettings>(() => withReviewMode(value));
  const [tab, setTab] = useState<Tab>(value.accessCode && !value.apiKey ? 'code' : 'key');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  /** One-shot guard: don't re-expand (or re-notify App) on every render. */
  const guideHandled = useRef(false);

  useEffect(() => {
    if (open) {
      setDraft(withReviewMode(value));
      setTestResult(null);
      setTab(value.accessCode && !value.apiKey ? 'code' : 'key');
    }
  }, [open, value]);

  // A request from 首页 expands the API-key guide; the learner can still collapse it again.
  useEffect(() => {
    if (!open) {
      guideHandled.current = false;
      return;
    }
    if (!guideRequested || guideHandled.current) return;
    guideHandled.current = true;
    // The guide is about keys, so show the key tab if the sheet opened on 访问口令.
    setTab('key');
    setGuideOpen(true);
    onGuideShown?.();
  }, [open, guideRequested, onGuideShown]);

  if (!open) return null;
  const provider = PROVIDERS.find((item) => item.id === draft.provider) || PROVIDERS[0];
  const reviewMode: ReviewMode = draft.reviewMode || 'auto';
  const reviewHint = REVIEW_MODES.find((item) => item.id === reviewMode)?.hint || '';

  const pickReviewMode = (mode: ReviewMode) => {
    if (mode === 'deepseek') {
      // One click gives a working DeepSeek preset; the learner only pastes a Key.
      setDraft({
        ...draft,
        reviewMode: mode,
        coachBaseUrl: DEEPSEEK_BASE_URL,
        coachModel: DEEPSEEK_MODEL,
      });
      return;
    }
    setDraft({ ...draft, reviewMode: mode });
  };

  const pickProvider = (id: RealtimeSettings['provider']) => {
    const preset = PROVIDERS.find((item) => item.id === id) || PROVIDERS[0];
    const next: RealtimeSettings = { ...draft, provider: id, model: preset.models[0] };
    // 纯语音模式下，自动精批可直接复用同一个 DeepSeek Key；仅在这个字段还没设置时才补默认。
    if (id === 'deepseek' && !next.reviewMode) next.reviewMode = 'auto';
    setDraft(next);
  };

  const toggleKeyGuide = () => setGuideOpen((current) => !current);

  const accent: VoiceAccent = draft.voiceAccent === 'us' ? 'us' : 'uk';
  const pauseTolerance: PauseTolerance = draft.pauseTolerance || 'standard';

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
          reviewMode,
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
              onClick={() => pickProvider(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {draft.provider === 'deepseek' && (
          <div className="voice-panel">
            <p className="hint">
              DeepSeek 纯语音：浏览器负责识别你的口语，Edge 神经网络负责考官朗读，1 个 DeepSeek Key
              即可语音 + 实时字幕 + 精批，不需要实时语音 Key。
            </p>
            <div className="field">
              <span>考官口音</span>
              <div className="chips">
                {VOICE_ACCENTS.map((item) => (
                  <button
                    key={item.id}
                    className={'chip accent-chip' + (accent === item.id ? ' selected' : '')}
                    onClick={() => setDraft({ ...draft, voiceAccent: item.id })}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span>接话速度（停顿多久算你说完）</span>
              <div className="chips">
                {PAUSE_TOLERANCES.map((item) => (
                  <button
                    key={item.id}
                    className={'chip accent-chip' + (pauseTolerance === item.id ? ' selected' : '')}
                    onClick={() => setDraft({ ...draft, pauseTolerance: item.id })}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <p className="hint">
                停下后会先判断整段回答的完成度：出现 well / and / because / 嗯 / 然后 这类没说完的
                尾巴，或只有一句短句，会继续等你到上限（默认约 5 秒）；两句话以上且说完整，约 3.5–3.7 秒
                就交给考官。等待期间你一开口就取消提交。思考多就选「耐心」。
              </p>
            </div>
          </div>
        )}

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

        <div className={'key-guide' + (guideOpen ? ' open' : '')}>
          <button className="key-guide-head" onClick={toggleKeyGuide} aria-expanded={guideOpen}>
            <span>还没有 API Key？各家获取方式与免费额度</span>
            <span className="key-guide-toggle">{guideOpen ? '收起' : '展开'}</span>
          </button>
          {guideOpen && (
            <div className="key-guide-body">
              {KEY_GUIDES.map((guide) => (
                <div className="key-guide-item" key={guide.url}>
                  <strong>{guide.title}</strong>
                  <a href={guide.url} target="_blank" rel="noreferrer">
                    {guide.linkText}
                  </a>
                  <p>{guide.note}</p>
                </div>
              ))}
              <p className="hint">
                提示：网页版所有 Key 只存在当前浏览器的 localStorage。DeepSeek 纯语音模式 1 个 Key
                即可；百炼 / Gemini / OpenAI 走的是端到端实时语音模式。
              </p>
            </div>
          )}
        </div>

        <div className="field">
          <span>精批方式</span>
          <div className="chips">
            {REVIEW_MODES.map((mode) => (
              <button
                key={mode.id}
                className={'chip' + (reviewMode === mode.id ? ' selected' : '')}
                onClick={() => pickReviewMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <p className="hint">{reviewHint}</p>
          {reviewMode === 'auto' && (draft.coachApiKey || draft.coachBaseUrl || draft.coachModel) && (
            <p className="hint">
              已保存过「精批专用」配置（{draft.coachApiKey ? 'Key 已填' : 'Key 未填'}
              {draft.coachBaseUrl ? ' · ' + draft.coachBaseUrl : ''}
              {draft.coachModel ? ' · ' + draft.coachModel : ''}），自动模式会优先使用它；要修改请切到「独立自定义模型」。
            </p>
          )}
        </div>

        {reviewMode === 'deepseek' && (
          <div className="review-panel">
            <label className="field">
              <span>DeepSeek API Key</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                placeholder="sk-..."
                value={draft.coachApiKey || ''}
                onChange={(event) => setDraft({ ...draft, coachApiKey: event.target.value })}
              />
            </label>
            <p className="hint">
              接口地址 {DEEPSEEK_BASE_URL} · 模型 {DEEPSEEK_MODEL}（已自动填好，想换模型请选「独立自定义模型」）
            </p>
          </div>
        )}

        {reviewMode === 'custom' && (
          <div className="review-panel">
            <label className="field">
              <span>精批接口地址</span>
              <input
                className="input"
                placeholder="https://api.deepseek.com/v1"
                value={draft.coachBaseUrl || ''}
                onChange={(event) => setDraft({ ...draft, coachBaseUrl: event.target.value })}
              />
            </label>
            <label className="field">
              <span>精批模型</span>
              <input
                className="input"
                placeholder="deepseek-chat"
                value={draft.coachModel || ''}
                onChange={(event) => setDraft({ ...draft, coachModel: event.target.value })}
              />
            </label>
            <label className="field">
              <span>精批 API Key</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                placeholder="sk-..."
                value={draft.coachApiKey || ''}
                onChange={(event) => setDraft({ ...draft, coachApiKey: event.target.value })}
              />
            </label>
          </div>
        )}

        {reviewMode === 'external' && (
          <p className="hint">
            结束课程后会弹出可复制的复盘提示词，把 lessonId 一起发给豆包 / dsh / Codex，让它们读取完整字幕后再写回精批、四维报告和长期记忆。
          </p>
        )}

        <details className="advanced">
          <summary>高级选项</summary>
          <label className="field">
            <span>自定义实时接口地址（中转 / 反代，可留空）</span>
            <input
              className="input"
              placeholder="wss://..."
              value={draft.endpointUrl || ''}
              onChange={(event) => setDraft({ ...draft, endpointUrl: event.target.value })}
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
          <button className="primary" onClick={() => onSave(withReviewMode(draft))}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
