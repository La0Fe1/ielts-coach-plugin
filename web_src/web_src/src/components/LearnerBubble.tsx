import type { PronWord, Turn } from '../types'

interface LearnerBubbleProps {
  turn: Turn
  onSelectWord: (word: PronWord, learnerAudioUrl: string | null) => void
}

export function LearnerBubble({ turn, onSelectWord }: LearnerBubbleProps) {
  const transcript = turn.learner_transcript ?? ''
  const words = turn.pronunciation_json?.words ?? []
  const duration = turn.learner_duration_sec
  const wpm = turn.wpm
  let wordIndex = 0

  return (
    <div className="learner-block bubble-enter">
      <div className="learner-meta">
        <span>你的回答</span>
        {turn.learner_audio_url && (
          <button
            className="text-button"
            onClick={() => {
              const audio = new Audio(turn.learner_audio_url as string)
              void audio.play().catch(() => undefined)
            }}
          >
            回放原声
          </button>
        )}
      </div>
      <div className="learner-bubble">
        {transcript ? (
          <p className="learner-transcript">
            {transcript.split(/(\s+)/).map((piece, index) => {
              if (/^\s+$/.test(piece)) return <span key={`space-${index}`}>{piece}</span>
              const word = words[wordIndex]
              wordIndex += 1
              if (!word || word.color === 'gray') return <span key={`plain-${index}`}>{piece}</span>
              return (
                <button
                  className={`pron-word ${word.color}`}
                  key={`word-${index}`}
                  onClick={() => onSelectWord(word, turn.learner_audio_url ?? null)}
                  title={`${word.ipa ? `/${word.ipa}/ · ` : ''}${word.score ?? '查看发音'}，点击查看`}
                >
                  {piece}
                </button>
              )
            })}
          </p>
        ) : (
          <p className="learner-transcript muted">没有识别到内容，可以重听后再试一次。</p>
        )}
        {(duration || wpm) && (
          <div className="answer-stats">
            {duration ? `${duration.toFixed(1)} 秒` : ''}
            {duration && wpm ? ' · ' : ''}
            {wpm ? `${Math.round(wpm)} WPM` : ''}
          </div>
        )}
      </div>
    </div>
  )
}
