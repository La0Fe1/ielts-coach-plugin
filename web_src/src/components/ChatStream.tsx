import type { Accent, Phase, PronWord, Turn } from '../types'
import { CorrectionCard } from './CorrectionCard'

interface Props {
  turns: Turn[]
  phase: Phase
  pendingTranscript: string | null
  onSelectWord: (word: PronWord, learnerAudioUrl: string | null) => void
  onSpeak: (text: string) => void
  onReplay: (url: string | null) => void
}

function LearnerText({
  turn,
  onSelectWord,
}: {
  turn: Turn
  onSelectWord: (word: PronWord, learnerAudioUrl: string | null) => void
}) {
  const transcript = turn.learner_transcript ?? ''
  const words = turn.pronunciation_json?.words ?? []
  if (!transcript) return <p className="bubble-text">（没有识别到内容）</p>
  if (words.length === 0) return <p className="bubble-text">{transcript}</p>

  const pieces = transcript.split(/(\s+)/)
  let wordIndex = 0
  return (
    <p className="bubble-text">
      {pieces.map((piece, index) => {
        if (/^\s+$/.test(piece)) return piece
        const word = words[wordIndex]
        wordIndex += 1
        if (!word) return <span key={String(index)}>{piece}</span>
        const clickable = word.score !== null && word.score !== undefined
        return (
          <span
            key={String(index)}
            className={'heat-word ' + word.color + (clickable ? ' clickable' : '')}
            title={word.ipa ? '/' + word.ipa + '/ · ' + (word.score ?? '') : undefined}
            onClick={() => {
              if (clickable) onSelectWord(word, turn.learner_audio_url ?? null)
            }}
          >
            {piece}
          </span>
        )
      })}
    </p>
  )
}

export function ChatStream({ turns, phase, pendingTranscript, onSelectWord, onSpeak, onReplay }: Props) {
  const listening = phase === 'listening'
  const submitting = phase === 'submitting'
  const thinking = phase === 'thinking'

  return (
    <div className="chat-stream">
      {turns.length === 0 && (
        <div className="chat-empty">
          <p className="muted">考官正在准备第一道题…</p>
        </div>
      )}

      {turns.map((turn) => {
        const answered = Boolean(turn.learner_transcript)
        return (
          <div className="turn-block" key={turn.id}>
            <div className="row examiner-row">
              <div className="avatar examiner-avatar">👩‍🏫</div>
              <div className="bubble examiner-bubble">
                <p className="bubble-text">{turn.examiner_question}</p>
                {turn.examiner_audio_url && (
                  <button
                    className="bubble-action"
                    onClick={() => onReplay(turn.examiner_audio_url ?? null)}
                    title="重听这一句"
                  >
                    ▶
                  </button>
                )}
              </div>
            </div>

            {answered && (
              <div className="row learner-row">
                <div className="bubble learner-bubble">
                  <LearnerText turn={turn} onSelectWord={onSelectWord} />
                  {turn.learner_duration_sec ? (
                    <span className="bubble-meta">{turn.learner_duration_sec.toFixed(1)}s</span>
                  ) : null}
                </div>
                <div className="avatar learner-avatar">🧑</div>
              </div>
            )}

            {answered && (turn.grammar_feedback_json || turn.pronunciation_json) && (
              <div className="row correction-row">
                <div className="correction-wrap">
                  <CorrectionCard
                    feedback={turn.grammar_feedback_json ?? null}
                    pronunciation={turn.pronunciation_json ?? null}
                    wpm={turn.wpm}
                    pauseCount={turn.pause_count}
                    stuck={turn.long_pauses_json?.stuck ?? null}
                    accent={'uk'}
                    onSpeak={onSpeak}
                  />
                </div>
              </div>
            )}
          </div>
        )
      })}

      {(listening || submitting || thinking) && (
        <div className="row learner-row pending-row">
          <div className={'bubble learner-bubble pending' + (listening ? ' listening' : '')}>
            {listening && (
              <span className="listening-dots">
                正在听你说<i />
                <i />
                <i />
              </span>
            )}
            {submitting && <span className="muted">正在识别你的语音…</span>}
            {thinking && (
              <>
                {pendingTranscript && <p className="bubble-text">{pendingTranscript}</p>}
                <span className="muted small">批改中…</span>
              </>
            )}
          </div>
          <div className="avatar learner-avatar">🧑</div>
        </div>
      )}
    </div>
  )
}
