import { useCallback, useEffect, useRef, useState } from 'react'
import { LiveUtterance, type UtteranceResult } from '../audio/liveSession'
import { diagnoseMic, explainMicError, type MicDiagnosis } from '../audio/mic'
import { PhonemeDrawer } from './PhonemeDrawer'
import type { Accent, PronWord, PronunciationResult } from '../types'

interface Props {
  accent: Accent
  onBack: () => void
}

type Phase = 'idle' | 'listening' | 'uploading' | 'done' | 'error'

interface SelftestResult {
  transcript: string
  wpm: number | null
  word_count: number | null
  pause_count: number | null
  pauses: { after_word?: string; duration_sec?: number }[]
  duration_sec: number
  audio_url: string
  pronunciation: PronunciationResult | null
  timings: { asr_sec: number; gop_sec: number; acoustic_forward_sec?: number; total_sec: number }
  models: { asr: string; pronounce: string; device: string }
}

export function SelftestView({ accent, onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SelftestResult | null>(null)
  const [selected, setSelected] = useState<PronWord | null>(null)
  const [diagnosis, setDiagnosis] = useState<MicDiagnosis | null>(null)
  const utteranceRef = useRef<LiveUtterance | null>(null)

  const refreshDiagnosis = useCallback(() => {
    diagnoseMic().then(setDiagnosis).catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshDiagnosis()
  }, [refreshDiagnosis])

  const run = useCallback(async () => {
    if (utteranceRef.current) return
    setError(null)
    setResult(null)
    const utterance = new LiveUtterance(0, {
      onLevel: setLevel,
      onError: (message) => {
        setError(message)
        setPhase('error')
        refreshDiagnosis()
      },
    })
    utteranceRef.current = utterance
    setPhase('listening')
    const recorded: UtteranceResult | null = await utterance.run()
    utteranceRef.current = null
    setLevel(0)
    if (!recorded) {
      setPhase('idle')
      return
    }
    setPhase('uploading')
    try {
      const form = new FormData()
      form.append('file', recorded.blob, 'selftest.wav')
      const response = await fetch('/api/selftest/audio?accent=' + accent, { method: 'POST', body: form })
      if (!response.ok) {
        let detail = response.statusText
        try {
          const body = await response.json()
          detail = body.detail ?? detail
        } catch {
          /* ignore */
        }
        throw new Error(String(detail))
      }
      setResult((await response.json()) as SelftestResult)
      setPhase('done')
    } catch (issue) {
      setError(String(issue))
      setPhase('error')
    }
  }, [accent])

  const stop = () => utteranceRef.current?.stopNow()

  const uploadFile = useCallback(
    async (file: File) => {
      setError(null)
      setResult(null)
      setPhase('uploading')
      try {
        const form = new FormData()
        form.append('file', file, file.name || 'selftest.wav')
        const response = await fetch('/api/selftest/audio?accent=' + accent, { method: 'POST', body: form })
        if (!response.ok) {
          let detail = response.statusText
          try {
            const body = await response.json()
            detail = body.detail ?? detail
          } catch {
            /* ignore */
          }
          throw new Error(String(detail))
        }
        setResult((await response.json()) as SelftestResult)
        setPhase('done')
      } catch (issue) {
        setError(String(issue))
        setPhase('error')
      }
    },
    [accent],
  )

  const pronunciation = result?.pronunciation ?? null
  const words = pronunciation?.words ?? []

  return (
    <div className="selftest">
      <header className="selftest-head">
        <div>
          <h1>麦克风与发音引擎自检</h1>
          <p className="muted small">
            不需要智能体、不写数据库：说一句话，看看本地转写与音素评分是否正常。
          </p>
        </div>
        <div className="spacer" />
        <button className="ghost small" onClick={onBack}>
          返回课堂
        </button>
      </header>

      <div className="selftest-card">
        <div className={'st-ball ' + phase} style={{ opacity: 0.4 + Math.min(0.6, level) }}>
          {phase === 'listening' ? '🎙' : phase === 'uploading' ? '⏳' : '🎧'}
        </div>
        {phase !== 'listening' && (
          <button className="gate-button" onClick={() => void run()} disabled={phase === 'uploading'}>
            {phase === 'uploading' ? '正在识别与打分…' : '🎙 开始试音（说一句英文，停 2.6 秒自动结束）'}
          </button>
        )}
        {phase === 'listening' && (
          <>
            <div className="listening-dots big">
              正在听你说<i />
              <i />
              <i />
            </div>
            <button className="ghost" onClick={stop}>
              我说完了，直接提交
            </button>
          </>
        )}
        {error && <p className="gate-error">{error}</p>}
        {diagnosis && (
          <div className="mic-diag">
            <div className="mic-diag-row">
              <span className={diagnosis.secureContext ? 'dot ok' : 'dot bad'} />
              安全上下文 {diagnosis.secureContext ? '正常' : '异常'}
              <span className={diagnosis.inIframe ? 'dot bad' : 'dot ok'} />
              {diagnosis.inIframe ? '页面被嵌入 iframe' : '独立标签页'}
              <span className={diagnosis.permission === 'granted' ? 'dot ok' : diagnosis.permission === 'denied' ? 'dot bad' : 'dot warn'} />
              权限：{diagnosis.permission}
              <span className={diagnosis.deviceCount > 0 ? 'dot ok' : 'dot bad'} />
              输入设备 {diagnosis.deviceCount} 个
              <button className="ghost tiny" onClick={refreshDiagnosis}>
                重新检测
              </button>
            </div>
            {diagnosis.devices.length > 0 && (
              <p className="muted tiny">设备：{diagnosis.devices.join(' / ')}</p>
            )}
            {diagnosis.hints.length > 0 && (
              <ul className="mic-hints">
                {diagnosis.hints.map((hint, index) => (
                  <li key={String(index)}>{hint}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="muted tiny">
          例如：“I live in a small city near the coast, and I really like the slow pace of life.”
        </p>
        <label className="upload-fallback">
          麦克风用不了？直接上传一段 16kHz WAV 也能测：
          <input
            type="file"
            accept=".wav,audio/wav"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void uploadFile(file)
              event.target.value = ''
            }}
          />
        </label>
      </div>

      {result && (
        <div className="selftest-result">
          <div className="selftest-meta">
            <span className="chip tiny">{result.models.device}</span>
            <span className="chip tiny ghost-chip">ASR {result.models.asr}</span>
            <span className="chip tiny ghost-chip">GOP {result.models.pronounce.split('/').pop()}</span>
            {pronunciation?.overall_score !== null && pronunciation?.overall_score !== undefined && (
              <span className={'score-pill ' + (pronunciation.overall_score >= 80 ? 'green' : pronunciation.overall_score >= 60 ? 'amber' : 'red')}>
                发音 {Math.round(pronunciation.overall_score)}
              </span>
            )}
            <span className="chip tiny ghost-chip">ASR {result.timings.asr_sec}s</span>
            <span className="chip tiny ghost-chip">GOP {result.timings.gop_sec}s</span>
            <span className="chip tiny ghost-chip">{result.duration_sec}s 音频</span>
            {result.wpm ? <span className="chip tiny ghost-chip">{Math.round(result.wpm)} WPM</span> : null}
          </div>

          <div className="bubble learner-bubble selftest-bubble">
            {words.length === 0 ? (
              <p className="bubble-text">{result.transcript || '（没有识别到内容）'}</p>
            ) : (
              <p className="bubble-text">
                {result.transcript.split(/(\s+)/).map((piece, index) => {
                  if (/^\s+$/.test(piece)) return piece
                  const word = words[index]
                  if (!word) return <span key={String(index)}>{piece}</span>
                  return (
                    <span
                      key={String(index)}
                      className={'heat-word ' + word.color + ' clickable'}
                      title={word.ipa ? '/' + word.ipa + '/ · ' + (word.score ?? '') : undefined}
                      onClick={() => setSelected(word)}
                    >
                      {piece}
                    </span>
                  )
                })}
              </p>
            )}
            <button
              className="bubble-action"
              onClick={() => {
                const audio = new Audio(result.audio_url)
                void audio.play().catch(() => undefined)
              }}
              title="回放我的录音"
            >
              ▶
            </button>
          </div>

          {result.pauses.length > 0 && (
            <div className="pause-list">
              {result.pauses.slice(0, 5).map((pause, index) => (
                <span className="pause-tag" key={String(index)}>
                  在 “{pause.after_word}” 后停顿 {pause.duration_sec}s
                </span>
              ))}
            </div>
          )}

          {pronunciation && (pronunciation.weak_phonemes ?? []).length > 0 && (
            <div className="weak-phonemes">
              <span className="tag pron">弱音素</span>
              {pronunciation.weak_phonemes.map((item) => (
                <span className="weak-chip" key={item.phoneme}>
                  /{item.phoneme}/ {Math.round(item.avg_score)}
                  <small> ×{item.count}</small>
                </span>
              ))}
            </div>
          )}

          {pronunciation && !pronunciation.alignment_ok && (
            <p className="gate-error">
              发音对齐未成功：{pronunciation.reason ?? '未知原因'}（转写与流利度仍然有效）
            </p>
          )}

          <p className="muted tiny">
            点任意彩色单词可看音标、逐音素分数，并对比「我的原声」与「标准示范音」。
          </p>
        </div>
      )}

      <PhonemeDrawer
        word={selected}
        learnerAudioUrl={result?.audio_url ?? null}
        accent={accent}
        onClose={() => setSelected(null)}
      />
    </div>
  )
}
