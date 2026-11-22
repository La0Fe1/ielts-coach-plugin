import type { PartMode, ThemeName } from '../types'

interface TopBarProps {
  topic: string
  partMode: PartMode | null
  currentPart: string
  questionIndex: number
  questionCount: number
  speaking: boolean
  theme: ThemeName
  onToggleTheme: () => void
  onOpenPlan: () => void
  onOpenMemory: () => void
  onOpenHistory: () => void
  onOpenSettings: () => void
}

function partLabel(part: string): string {
  if (part === 'full_mock') return '全真模考'
  if (part === 'free_drill') return '专项靶向练'
  return part.replace('part', 'Part ')
}

export function TopBar({
  topic,
  partMode,
  currentPart,
  questionIndex,
  questionCount,
  speaking,
  theme,
  onToggleTheme,
  onOpenPlan,
  onOpenMemory,
  onOpenHistory,
  onOpenSettings,
}: TopBarProps) {
  const progress = questionCount > 0
    ? `${partMode === 'full_mock' ? '全真模考 · ' : ''}${partLabel(currentPart)} · 第 ${Math.min(questionIndex + 1, questionCount)}/${questionCount} 题`
    : partLabel(currentPart || partMode || 'part1')
  return (
    <header className="topbar">
      <div className="teacher-identity">
        <div className={`examiner-avatar${speaking ? ' is-speaking' : ''}`} aria-hidden="true">E</div>
        <div className="teacher-copy"><strong>Elena <span>· {progress}</span></strong><small>{topic || 'IELTS Studio'}</small></div>
      </div>
      <nav className="topnav" aria-label="课程工具">
        <button onClick={onOpenPlan}>题单</button>
        <button onClick={onOpenMemory}>记忆</button>
        <button onClick={onOpenHistory}>历史</button>
        <button onClick={onOpenSettings}>设置</button>
        <button className="theme-toggle" onClick={onToggleTheme} aria-label={theme === 'dark' ? '切换浅色主题' : '切换深色主题'}>
          {theme === 'dark' ? <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></svg> : <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" /></svg>}
        </button>
      </nav>
    </header>
  )
}
