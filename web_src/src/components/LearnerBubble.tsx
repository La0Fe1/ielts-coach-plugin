import type { PronWord, Turn } from '../types'

interface LearnerBubbleProps {
  turn: Turn
  selected: boolean
  onSelect: () => void
  onSelectWord: (word: PronWord, learnerAudioUrl: string | null) => void
}

export function LearnerBubble({ turn, selected, onSelect, onSelectWord }: LearnerBubbleProps) {
  const transcript = turn.learner_transcript ?? ''
  const words = turn.pronunciation_json?.words ?? []
  const duration = turn.learner_duration_sec
  const wpm = turn.wpm
  let wordIndex = 0

  return (
    <div className={`learner-block bubble-enter${selected ? ' is-selected' : ''}`} onClick={onSelect}>
      <div className="learner-meta"><span>你的回答</span><button className="text-button" onClick={(event) => { event.stopPropagation(); onSelect() }}>{selected ? '正在精批这一轮' : '精批这一轮'}</button></div>
      <div className="learner-bubble">
        {transcript ? <p className="learner-transcript">{transcript.split(/(\s+)/).map((piece, index) => {
          if (/^\s+$/.test(piece)) return <span key={`space-${index}`}>{piece}</span>
          const word = words[wordIndex]
          wordIndex += 1
          if (!word || word.color === 'gray' || word.score === null) return <span key={`plain-${index}`}>{piece}</span>
          return <button
            className={`pron-word ${word.color}`}
            key={`word-${index}`}
            onClick={(event) => { event.stopPropagation(); onSelectWord(word, turn.learner_audio_url ?? null) }}
            title={`${word.ipa ? `/${word.ipa}/ · ` : ''}${word.score} 分，点击对比发音`}
            aria-label={`${piece}，发音 ${word.score} 分，点击查看`}
          >{piece}</button>
        })}</p> : <p className="learner-transcript muted">没有识别到内容，可以再试一次。</p>}
        {(duration || wpm) && <div className="answer-stats">{duration ? `${duration.toFixed(1)}s` : ''}{duration && wpm ? ' · ' : ''}{wpm ? `${Math.round(wpm)} WPM` : ''}</div>}
      </div>
    </div>
  )
}
