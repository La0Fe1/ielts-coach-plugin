import type { ReactNode } from 'react'
import type { Phase, PronWord, Turn } from '../types'
import { ExaminerBubble } from './ExaminerBubble'
import { LearnerBubble } from './LearnerBubble'

interface ActiveExaminer {
  turnId: number | null
  text: string
  audioUrl: string | null
  part: string
}

interface ChatStreamProps {
  turns: Turn[]
  activeExaminer: ActiveExaminer
  selectedTurnId: number | null
  phase: Phase
  pendingTranscript: string | null
  onSelectTurn: (turnId: number) => void
  onSelectWord: (word: PronWord, learnerAudioUrl: string | null) => void
  onReplay: (url: string | null) => void
  renderCoach: (turn: Turn) => ReactNode
}

export function ChatStream({ turns, activeExaminer, selectedTurnId, phase, pendingTranscript, onSelectTurn, onSelectWord, onReplay, renderCoach }: ChatStreamProps) {
  const activeQuestionInTurns = turns.some((turn) => (activeExaminer.turnId !== null && turn.id === activeExaminer.turnId) || (activeExaminer.turnId === null && turn.examiner_question === activeExaminer.text))
  return <div className="chat-stream">
    {turns.length === 0 && !activeExaminer.text && phase !== 'ended' && <section className="quiet-empty"><div className="examiner-avatar" aria-hidden="true">E</div><h1>考官正在准备第一道题</h1><p>课程已创建。新题通过本地 WebSocket 到达后会自动播报。</p></section>}
    {turns.map((turn) => {
      const answered = Boolean(turn.learner_transcript || turn.learner_audio_url)
      const selected = selectedTurnId === turn.id
      const speaking = phase === 'examiner_speaking' && ((activeExaminer.turnId !== null && activeExaminer.turnId === turn.id) || (activeExaminer.turnId === null && activeExaminer.text === turn.examiner_question))
      return <article className={`turn-block${selected && answered ? ' is-selected' : ''}`} key={turn.id}>
        <ExaminerBubble question={turn.examiner_question} audioUrl={turn.examiner_audio_url} speaking={speaking} onReplay={onReplay} />
        {answered && <LearnerBubble turn={turn} selected={selected} onSelect={() => onSelectTurn(turn.id)} onSelectWord={onSelectWord} />}
        {answered && selected && <div className="mobile-coach">{renderCoach(turn)}</div>}
      </article>
    })}
    {activeExaminer.text && !activeQuestionInTurns && phase !== 'ended' && <article className="turn-block"><ExaminerBubble question={activeExaminer.text} audioUrl={activeExaminer.audioUrl} speaking={phase === 'examiner_speaking'} onReplay={onReplay} /></article>}
    {(phase === 'listening' || phase === 'submitting' || phase === 'thinking') && <div className="learner-block pending bubble-enter"><div className="learner-meta"><span>{phase === 'listening' ? '正在听你说' : '你的回答'}</span></div><div className="learner-bubble">{phase === 'thinking' && pendingTranscript ? <p className="learner-transcript">{pendingTranscript}</p> : <p className="muted">{phase === 'listening' ? '自然表达即可，发送前会出现可取消的倒计时。' : '语音已收到，正在整理转写与发音结果…'}</p>}{phase === 'thinking' && <p className="pending-feedback">精批生成后会自动挂到这一轮。</p>}</div></div>}
  </div>
}
