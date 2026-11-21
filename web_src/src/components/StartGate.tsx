import type { Session } from '../types'

interface StartGateProps {
  session: Session | null
  starting: boolean
  error: string | null
  errorKind: 'microphone' | 'network' | 'audio' | 'playback' | null
  inIframe: boolean
  onStart: () => void
  onOpenHistory: () => void
  onOpenStandalone: () => void
}

export function StartGate({
  session,
  starting,
  error,
  errorKind,
  inIframe,
  onStart,
  onOpenHistory,
  onOpenStandalone,
}: StartGateProps) {
  return (
    <main className="start-gate">
      <section className="gate-card" aria-labelledby="gate-title">
        <div className="gate-teacher" aria-hidden="true">
          <div className="examiner-avatar">E</div>
          <span>Elena</span>
        </div>
        <p className="eyebrow">IELTS SPEAKING · 一对一陪练</p>
        <h1 id="gate-title">{session ? '开始语音连麦上课' : '还没有进行中的课程'}</h1>
        {session ? (
          <>
            <p className="gate-topic">{session.topic_title} · {session.part_mode.replace('part', 'Part ')}</p>
            <p className="gate-description">
              点一次，同时授权麦克风与考官语音播放。考官问、你回答，说完点一下「我说完了」；中途卡住它会给你提示词。
            </p>
            <button className="primary-button gate-button" onClick={onStart} disabled={starting}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="8" y="3" width="8" height="12" rx="4" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
              </svg>
              {starting ? '正在连接麦克风…' : '开始语音连麦上课'}
            </button>
          </>
        ) : (
          <p className="gate-description">
            回到 dsh、Cursor 或 Claude Code，说“开始练雅思 Part 1”。课程出现后，这个面板会自动接入。
          </p>
        )}

        {error && (
          <div className="gate-error" role="alert">
            <strong>{errorKind === 'microphone' ? '麦克风还没有准备好' : '本地语音服务暂时不可用'}</strong>
            <p>{error}</p>
            {errorKind === 'microphone' ? (
              <ol>
                <li>点地址栏左侧的锁形或麦克风图标，把本站麦克风改为“允许”，再刷新页面。</li>
                {inIframe && <li>当前页面在侧栏 iframe 内，请改为新标签页打开后再授权。</li>}
                <li>确认使用 127.0.0.1 或 localhost，并检查系统是否允许浏览器访问麦克风。</li>
              </ol>
            ) : (
              <p>请确认 daemon 正在 127.0.0.1:8765 运行，然后重新连接。课程记录仍保存在本机。</p>
            )}
            {errorKind === 'microphone' && inIframe && <button className="secondary-button" onClick={onOpenStandalone}>在新标签页打开</button>}
          </div>
        )}

        <button className="text-button gate-history" onClick={onOpenHistory}>查看往期课程与报告</button>
        <p className="gate-privacy">音频只发往本机 127.0.0.1:8765，不经过外部服务。</p>
      </section>
    </main>
  )
}
