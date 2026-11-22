import { useEffect, useState } from 'react'
import type { Accent, FeedbackStyle, PartMode, Profile, Session } from '../types'

export interface LessonSetup {
  part_mode: PartMode
  topic_hint: string
  target_band: number
  accent: Accent
  feedback_style: FeedbackStyle
}

interface StartGateProps {
  session: Session | null
  profile: Profile | null
  starting: boolean
  creating: boolean
  error: string | null
  errorKind: 'microphone' | 'network' | 'audio' | 'playback' | null
  inIframe: boolean
  onStart: () => void
  onCreate: (setup: LessonSetup) => void
  onOpenHistory: () => void
  onOpenSettings: () => void
  onOpenStandalone: () => void
}

const PARTS: { value: PartMode; label: string }[] = [
  { value: 'part1', label: 'Part 1 日常' },
  { value: 'part2', label: 'Part 2 独白' },
  { value: 'part3', label: 'Part 3 探讨' },
  { value: 'full_mock', label: '全真模考' },
  { value: 'free_drill', label: '专项靶向练' },
]

export function StartGate({
  session,
  profile,
  starting,
  creating,
  error,
  errorKind,
  inIframe,
  onStart,
  onCreate,
  onOpenHistory,
  onOpenSettings,
  onOpenStandalone,
}: StartGateProps) {
  const [setupOpen, setSetupOpen] = useState(!session)
  const [partMode, setPartMode] = useState<PartMode>('part1')
  const [topic, setTopic] = useState('')
  const [target, setTarget] = useState(profile?.target_band ?? 7.5)
  const [accent, setAccent] = useState<Accent>(profile?.accent_preference ?? 'uk')
  const [feedback, setFeedback] = useState<FeedbackStyle>(profile?.feedback_style ?? 'instant_card_plus_voice')

  useEffect(() => {
    if (session) setSetupOpen(false)
  }, [session?.id])

  useEffect(() => {
    if (!profile) return
    setTarget(profile.target_band ?? 7.5)
    setAccent(profile.accent_preference ?? 'uk')
    setFeedback(profile.feedback_style ?? 'instant_card_plus_voice')
  }, [profile])

  const needsModel = (profile?.llm_mode ?? 'standalone') === 'standalone'
    && (profile?.llm_provider ?? 'deepseek') !== 'ollama'
    && !profile?.has_api_key

  return (
    <main className="start-gate">
      <section className="gate-card studio-gate" aria-labelledby="gate-title">
        <header className="gate-header">
          <div className="gate-teacher">
            <div className="examiner-avatar" aria-hidden="true">E</div>
            <span><strong>Elena</strong><small>IELTS Studio</small></span>
          </div>
          <button className="text-button" onClick={onOpenSettings}>设置模型与偏好</button>
        </header>

        {session && !setupOpen ? (
          <div className="gate-existing">
            <p className="eyebrow">READY WHEN YOU ARE</p>
            <h1 id="gate-title">继续你的口语工作室</h1>
            <div className="gate-course-card">
              <span>{session.part_mode.replace('part', 'Part ').replace('_', ' ')}</span>
              <strong>{session.topic_title}</strong>
              <small>目标 Band {(session.target_band ?? profile?.target_band ?? 7.5).toFixed(1)} · {profile?.accent_preference === 'us' ? '美音' : '英音'}</small>
            </div>
            <p className="gate-description">一次点击同时解锁麦克风与考官语音。自由连麦会显示发送倒计时，继续说即可取消。</p>
            <button className="primary-button gate-button" onClick={onStart} disabled={starting}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg>
              {starting ? '正在连接麦克风…' : '开始语音连麦上课'}
            </button>
            <button className="text-button gate-new-link" onClick={() => setSetupOpen(true)}>自主新开一课</button>
          </div>
        ) : (
          <div className="lesson-setup">
            <p className="eyebrow">NEW LESSON</p>
            <h1 id="gate-title">今天想练哪一种表达？</h1>
            <p className="gate-description">留空话题会由本地题库避重抽题。课程、音频和记忆都保存在本机。</p>

            <div className="mode-grid" role="group" aria-label="课程模式">
              {PARTS.map((part) => <button key={part.value} className={partMode === part.value ? 'selected' : ''} onClick={() => setPartMode(part.value)}>{part.label}</button>)}
            </div>
            <label className="field-label">话题关键词（可选）<input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="例如：hometown、technology" /></label>

            <div className="setup-row"><span>目标分</span><div className="choice-chips">{[6.5, 7, 7.5, 8].map((band) => <button key={band} className={target === band ? 'selected' : ''} onClick={() => setTarget(band)}>{band.toFixed(1)}</button>)}</div></div>
            <div className="setup-row"><span>示范口音</span><div className="choice-chips"><button className={accent === 'uk' ? 'selected' : ''} onClick={() => setAccent('uk')}>英音</button><button className={accent === 'us' ? 'selected' : ''} onClick={() => setAccent('us')}>美音</button></div></div>
            <div className="setup-row"><span>反馈风格</span><div className="choice-chips"><button className={feedback === 'instant_card_plus_voice' ? 'selected' : ''} onClick={() => setFeedback('instant_card_plus_voice')}>口头简评 + 卡片</button><button className={feedback === 'instant_card_only' ? 'selected' : ''} onClick={() => setFeedback('instant_card_only')}>纯考官沉浸</button></div></div>

            {needsModel && <div className="model-hint"><strong>还差一步即可使用界面直连考官</strong><p>在设置中填入 DeepSeek / OpenAI Key，或选择 Ollama。也可以创建课程后由 dsh / Cursor 接管。</p><button className="text-button" onClick={onOpenSettings}>现在设置模型</button></div>}
            <button className="primary-button gate-button" disabled={creating} onClick={() => onCreate({ part_mode: partMode, topic_hint: topic.trim(), target_band: target, accent, feedback_style: feedback })}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              {creating ? '正在创建并解锁…' : '立即开始本课'}
            </button>
            {session && <button className="text-button gate-new-link" onClick={() => setSetupOpen(false)}>返回当前课程</button>}
          </div>
        )}

        {error && <div className="gate-error" role="alert"><strong>{errorKind === 'microphone' ? '麦克风还没有准备好' : '本地服务需要检查'}</strong><p>{error}</p>{errorKind === 'microphone' ? <ol><li>在地址栏的网站权限中允许麦克风。</li>{inIframe && <li>侧栏内无法授权时，请在新标签页打开。</li>}<li>确认使用 127.0.0.1 或 localhost。</li></ol> : <p>确认 daemon 正在 127.0.0.1:8765 运行。扩展接口若返回 404，请更新配套后端。</p>}{errorKind === 'microphone' && inIframe && <button className="secondary-button" onClick={onOpenStandalone}>在新标签页打开</button>}</div>}

        <footer className="gate-footer"><button className="text-button" onClick={onOpenHistory}>查看往期课程与报告</button><span>仅连接本机服务</span></footer>
      </section>
    </main>
  )
}
