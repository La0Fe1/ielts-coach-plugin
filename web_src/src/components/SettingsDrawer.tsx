import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api'
import { startRecording, type ActiveRecording } from '../audio/pcmRecorder'
import type { Accent, DriveMode, FeedbackStyle, LlmTestResult, Profile } from '../types'

interface SettingsDrawerProps {
  open: boolean
  profile: Profile | null
  onClose: () => void
  onSaved: (profile: Profile) => void
}

export function SettingsDrawer({ open, profile, onClose, onSaved }: SettingsDrawerProps) {
  const [mode, setMode] = useState<DriveMode>('standalone')
  const [provider, setProvider] = useState('deepseek')
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1')
  const [model, setModel] = useState('deepseek-chat')
  const [apiKey, setApiKey] = useState('')
  const [target, setTarget] = useState(7.5)
  const [accent, setAccent] = useState<Accent>('uk')
  const [speed, setSpeed] = useState(1)
  const [feedback, setFeedback] = useState<FeedbackStyle>('instant_card_plus_voice')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [micStatus, setMicStatus] = useState<'idle' | 'recording' | 'playing'>('idle')
  const micRef = useRef<ActiveRecording | null>(null)
  const micUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMode(profile?.llm_mode ?? 'standalone')
    setProvider(profile?.llm_provider ?? 'deepseek')
    setBaseUrl(profile?.llm_base_url ?? 'https://api.deepseek.com/v1')
    setModel(profile?.llm_model ?? 'deepseek-chat')
    setApiKey('')
    setTarget(profile?.target_band ?? 7.5)
    setAccent(profile?.accent_preference ?? 'uk')
    setSpeed(profile?.voice_speed ?? 1)
    setFeedback(profile?.feedback_style ?? 'instant_card_plus_voice')
    setTestResult(null)
    setMessage(null)
  }, [open, profile])

  useEffect(() => () => {
    micRef.current?.cancel()
    if (micUrlRef.current) URL.revokeObjectURL(micUrlRef.current)
  }, [])

  if (!open) return null

  const changeProvider = (next: string) => {
    setProvider(next)
    if (next === 'deepseek') { setBaseUrl('https://api.deepseek.com/v1'); setModel('deepseek-chat') }
    if (next === 'openai') { setBaseUrl('https://api.openai.com/v1'); setModel('gpt-4o-mini') }
    if (next === 'ollama') { setBaseUrl('http://localhost:11434/v1'); setModel('qwen2.5:7b') }
  }
  const testConnection = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.testLlm({ llm_provider: provider, llm_base_url: baseUrl, llm_model: model, ...(apiKey ? { llm_api_key: apiKey } : {}) })
      setTestResult(result)
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof ApiError && error.status === 404 ? '当前 daemon 尚未提供 /api/llm/test，请更新配套后端。' : String(error) })
    } finally { setTesting(false) }
  }
  const save = async () => {
    setSaving(true)
    setMessage(null)
    const payload: Record<string, unknown> = { llm_mode: mode, llm_provider: provider, llm_base_url: baseUrl, llm_model: model, target_band: target, accent_preference: accent, voice_speed: speed, feedback_style: feedback }
    if (apiKey.trim()) payload.llm_api_key = apiKey.trim()
    try {
      const saved = await api.updateProfile(payload)
      const merged = { ...profile, ...payload, ...saved, has_api_key: saved.has_api_key ?? (apiKey.trim() ? true : profile?.has_api_key) } as Profile
      onSaved(merged)
      setApiKey('')
      setMessage(saved.llm_mode === undefined ? '基础偏好已保存；当前 daemon 未返回直连模型字段，请更新后端以持久化模型配置。' : '设置已保存到本机。')
    } catch (error) { setMessage(`保存失败：${String(error)}`) } finally { setSaving(false) }
  }
  const stopMic = async (recorder: ActiveRecording) => {
    try {
      const result = await recorder.stop()
      if (micRef.current !== recorder) return
      micRef.current = null
      if (micUrlRef.current) URL.revokeObjectURL(micUrlRef.current)
      const url = URL.createObjectURL(result.blob)
      micUrlRef.current = url
      const audio = new Audio(url)
      setMicStatus('playing')
      audio.onended = () => setMicStatus('idle')
      audio.onerror = () => { setMicStatus('idle'); setMessage('试麦回放失败，请再试一次。') }
      await audio.play()
    } catch (error) { setMicStatus('idle'); setMessage(`试麦失败：${String(error)}`) } finally { micRef.current = null }
  }
  const testMic = async () => {
    if (micRef.current || micStatus !== 'idle') return
    setMessage(null)
    try {
      const context = new AudioContext()
      await context.resume()
      await context.close()
      const recorder = await startRecording()
      micRef.current = recorder
      setMicStatus('recording')
      window.setTimeout(() => void stopMic(recorder), 2000)
    } catch (error) { setMessage(`试麦失败：${String(error)}`) }
  }

  return <div className="drawer-backdrop" onClick={onClose}><aside className="side-drawer settings-drawer" role="dialog" aria-modal="true" aria-label="模型与偏好设置" onClick={(event) => event.stopPropagation()}>
    <header className="drawer-head"><div><p className="eyebrow">LOCAL SETTINGS</p><h2>模型与课程偏好</h2></div><button className="close-button" onClick={onClose} aria-label="关闭设置">×</button></header>
    <section className="drawer-section"><h3>考官驱动</h3><div className="choice-chips"><button className={mode === 'standalone' ? 'selected' : ''} onClick={() => setMode('standalone')}>界面直连接课</button><button className={mode === 'mcp' ? 'selected' : ''} onClick={() => setMode('mcp')}>外部代理接课</button></div><p className="muted">直连接课在创建后自动生成计划并播报第一题；外部代理接课等待 dsh / Cursor 驱动。</p></section>
    <section className="drawer-section"><h3>OpenAI 兼容模型</h3><div className="settings-form"><label>Provider<select value={provider} onChange={(event) => changeProvider(event.target.value)}><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option><option value="ollama">Ollama</option></select></label><label>Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} /></label><label>Model<input value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} /></label><label>API Key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={profile?.has_api_key ? '已保存，留空则不修改' : provider === 'ollama' ? 'Ollama 可留空' : '输入本机保存的 Key'} autoComplete="off" /></label></div><button className="secondary-button settings-test" onClick={() => void testConnection()} disabled={testing}>{testing ? '正在测试…' : '测试模型连接'}</button>{testResult && <div className={`connection-result ${testResult.ok ? 'is-ok' : 'is-error'}`}><strong>{testResult.ok ? `连接成功${testResult.latency_ms !== undefined ? ` · ${testResult.latency_ms}ms` : ''}` : '连接未成功'}</strong><p>{testResult.message}</p></div>}</section>
    <section className="drawer-section"><h3>学习目标</h3><div className="settings-form"><label>目标分<select value={target} onChange={(event) => setTarget(Number(event.target.value))}>{[6, 6.5, 7, 7.5, 8, 8.5].map((band) => <option value={band} key={band}>{band.toFixed(1)}</option>)}</select></label><label>示范口音<select value={accent} onChange={(event) => setAccent(event.target.value as Accent)}><option value="uk">英音</option><option value="us">美音</option></select></label><label>反馈风格<select value={feedback} onChange={(event) => setFeedback(event.target.value as FeedbackStyle)}><option value="instant_card_plus_voice">口头简评 + 卡片</option><option value="instant_card_only">纯考官沉浸</option></select></label><label>语速 {speed.toFixed(2)}×<input type="range" min="0.8" max="1.2" step="0.05" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} /></label></div></section>
    <section className="drawer-section"><h3>设备检查</h3><p className="muted">录 2 秒并立即回放，使用与正式上课相同的 Web Audio / WAV 链路。</p><button className="secondary-button" onClick={() => void testMic()} disabled={micStatus !== 'idle'}>{micStatus === 'recording' ? '正在试麦 2 秒…' : micStatus === 'playing' ? '正在回放…' : '试麦并回放'}</button></section>
    {message && <p className="settings-message" role="status">{message}</p>}
    <button className="primary-button settings-save" onClick={() => void save()} disabled={saving}>{saving ? '正在保存…' : '保存设置'}</button>
  </aside></div>
}
