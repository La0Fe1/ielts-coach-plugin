import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Session } from '../types'

interface HistoryDrawerProps {
  open: boolean
  currentSessionId: number | null
  onClose: () => void
  onOpen: (sessionId: number) => void
}

export function HistoryDrawer({ open, currentSessionId, onClose, onOpen }: HistoryDrawerProps) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api.sessions()
      .then((data) => { if (!cancelled) setSessions(data.sessions) })
      .catch((issue: unknown) => { if (!cancelled) setError(String(issue)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => {
      cancelled = true
      window.removeEventListener('keydown', close)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="side-drawer" role="dialog" aria-modal="true" aria-label="往期课程" onClick={(event) => event.stopPropagation()}>
        <header className="drawer-head">
          <div><p className="eyebrow">YOUR LESSONS</p><h2>往期课程</h2></div>
          <button className="close-button" onClick={onClose} aria-label="关闭往期课程">×</button>
        </header>
        {loading && <p className="muted">正在读取本机课程记录…</p>}
        {error && <p role="alert">课程记录暂时读不到，请确认本地 daemon 已启动后重试。</p>}
        <ul className="history-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <button className={`history-item${session.id === currentSessionId ? ' current' : ''}`} onClick={() => onOpen(session.id)}>
                <span>
                  <strong>{session.topic_title}</strong>
                  <small>
                    {(session.started_at ?? '').slice(0, 16).replace('T', ' ')} · {session.part_mode}
                  </small>
                </span>
                <b>{session.estimated_band_overall?.toFixed(1) ?? '—'}</b>
              </button>
            </li>
          ))}
        </ul>
        {!loading && !error && sessions.length === 0 && <p className="muted">完成第一节课后，记录会出现在这里。</p>}
      </aside>
    </div>
  )
}
