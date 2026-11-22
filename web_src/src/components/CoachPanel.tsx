import { useMemo } from 'react'
import type { PracticeState, PronWord, PronWordPhoneme, Turn } from '../types'
import { wordDiff } from '../utils/wordDiff'

interface CoachPanelProps {
  turn: Turn | null
  practice: PracticeState
  onPractice: (targetText: string, previousScore?: number | null) => void
  onSpeak: (text: string) => void
  onSelectWord: (word: PronWord, learnerAudioUrl: string | null) => void
}

export function PracticeOutcome({ practice, targetText, previousPhonemes = [] }: { practice: PracticeState; targetText: string; previousPhonemes?: PronWordPhoneme[] }) {
  if (practice.targetText !== targetText) return null
  if (practice.status === 'recording') return <div className="practice-outcome is-live" aria-live="polite"><strong>正在听你的跟读 {practice.elapsed.toFixed(1)}s</strong><span>2–8 秒，读完后点“完成重测”。</span></div>
  if (practice.status === 'uploading') return <div className="practice-outcome" aria-live="polite"><strong>正在对比这一次的发音…</strong></div>
  if (practice.error) return <div className="practice-outcome is-error" role="alert">{practice.error}</div>
  const result = practice.result
  if (!result) return null
  const score = result.pronunciation?.overall_score
  const newPhonemes = result.pronunciation?.words.flatMap((word) => word.phonemes ?? []) ?? []
  const comparisons = previousPhonemes.map((before) => {
    const after = newPhonemes.find((item) => item.phoneme === before.phoneme)
    return after ? { phoneme: before.phoneme, before: before.score, after: after.score } : null
  }).filter((item): item is { phoneme: string; before: number; after: number } => Boolean(item))
  return <div className="practice-outcome is-result" aria-live="polite">
    <div className="practice-score-line">
      <strong>{practice.previousScore !== null && practice.previousScore !== undefined ? `上次 ${Math.round(practice.previousScore)} 分 → ` : ''}本次 {score === null || score === undefined ? '已完成' : `${Math.round(score)} 分`}</strong>
      {score !== null && score !== undefined && practice.previousScore !== null && practice.previousScore !== undefined && <span className={score >= practice.previousScore ? 'score-up' : 'score-down'}>{score >= practice.previousScore ? '+' : ''}{Math.round(score - practice.previousScore)}</span>}
    </div>
    {result.transcript && <p>识别：{result.transcript}</p>}
    {comparisons.length > 0 && <div className="phoneme-delta-list">{comparisons.map((item) => <span key={item.phoneme}>/{item.phoneme}/ <s>{Math.round(item.before)}</s> → <b>{Math.round(item.after)}</b></span>)}</div>}
    {!result.pronunciation && <p className="muted">本次录音已收到，当前声学评分未返回。</p>}
  </div>
}

function tipsText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : '').filter(Boolean).join('；')
  return ''
}

export function CoachPanel({ turn, practice, onPractice, onSpeak, onSelectWord }: CoachPanelProps) {
  const original = turn?.learner_transcript ?? ''
  const feedback = turn?.grammar_feedback_json ?? null
  const corrected = feedback?.corrected_text ?? turn?.corrected_text ?? original
  const upgraded = feedback?.upgraded_text ?? turn?.upgraded_text ?? corrected
  const diff = useMemo(() => wordDiff(original, corrected), [original, corrected])

  if (!turn) return <aside className="coach-panel coach-empty"><p className="eyebrow">COACH WORKBENCH</p><h2>精批会在这里展开</h2><p>完成一轮回答后，不用点开折叠按钮，就能直接看到 Diff、升级句、错因和发音复练。</p></aside>

  const samePractice = practice.targetText === upgraded
  const practiceDisabled = practice.status === 'uploading' || (samePractice && practice.status === 'recording' && practice.elapsed < 2)
  const practiceLabel = samePractice && practice.status === 'recording'
    ? practice.elapsed < 2 ? `再读 ${(2 - practice.elapsed).toFixed(1)}s` : `完成重测 ${practice.elapsed.toFixed(1)}s`
    : samePractice && practice.status === 'uploading' ? '评分中…' : '跟读重测'
  const words = turn.pronunciation_json?.words ?? []
  const weakWords = words.filter((word) => word.score !== null && word.score < 80)
  const weakPhonemes = turn.pronunciation_json?.weak_phonemes ?? []
  const tips = tipsText(feedback?.pronunciation_tips)

  const openPhoneme = (phoneme: string) => {
    const word = words.find((item) => item.issues.some((issue) => issue.phoneme === phoneme))
      ?? weakWords[0]
    if (word) onSelectWord(word, turn.learner_audio_url ?? null)
  }

  const detailContent = <>
    {(feedback?.grammar_mistakes?.length ?? 0) > 0 && <section className="coach-section"><h3>错因点拨</h3><div className="mistake-grid">{feedback?.grammar_mistakes?.map((mistake, index) => <article className="mistake-card" key={`${mistake.original_excerpt}-${index}`}><span>{mistake.error_category}</span><p>{mistake.explanation}</p></article>)}</div></section>}
    {(weakPhonemes.length > 0 || weakWords.length > 0) && <section className="coach-section"><h3>本轮发音巩固</h3><div className="phoneme-chip-list">{weakPhonemes.map((item) => <button key={item.phoneme} onClick={() => openPhoneme(item.phoneme)}>/{item.phoneme}/ <b>{Math.round(item.avg_score)}</b></button>)}</div>{weakWords.length > 0 && <div className="weak-word-list">{weakWords.slice(0, 8).map((word, index) => <button key={`${word.word}-${index}`} className={`pron-word ${word.color}`} onClick={() => onSelectWord(word, turn.learner_audio_url ?? null)}>{word.word}<small>{word.score}</small></button>)}</div>}</section>}
    {tips && <section className="coach-section"><h3>发音动作提示</h3><p>{tips}</p></section>}
  </>

  return <aside className="coach-panel" aria-label="Coach 精批与提分工作台">
    <header className="coach-heading"><div><p className="eyebrow">COACH WORKBENCH</p><h2>这一轮，如何再进一步</h2></div><span>第 {turn.turn_index} 轮</span></header>
    {!feedback && !turn.pronunciation_json ? <div className="coach-waiting">回答已收到，精批正在生成。你可以先回放自己的表达。</div> : <>
      {feedback?.quick_praise && <p className="quick-praise">{feedback.quick_praise}</p>}
      <section className="coach-section diff-section"><div className="section-title"><h3>语法精准修正</h3><span>红删 · 绿增</span></div><div className="diff-row"><span>原句</span><p>{diff.original.map((token, index) => <span className={token.kind === 'delete' ? 'diff-delete' : ''} key={index}>{token.value}</span>)}</p></div><div className="diff-row"><span>修正</span><p>{diff.corrected.map((token, index) => <span className={token.kind === 'insert' ? 'diff-insert' : ''} key={index}>{token.value}</span>)}</p></div></section>
      <section className="coach-section upgrade-section"><div className="section-title"><h3>Band 7.5+ 地道升级</h3><span>跟读到变绿</span></div><p className="upgrade-sentence">{upgraded || '本轮没有额外升级句。'}</p>{upgraded && <div className="upgrade-actions"><button className="secondary-button" onClick={() => onSpeak(upgraded)}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M8 5v14l11-7Z" /></svg>听示范</button><button className="primary-button" disabled={practiceDisabled} onClick={() => onPractice(upgraded, turn.pronunciation_json?.overall_score)}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>{practiceLabel}</button></div>}<PracticeOutcome practice={practice} targetText={upgraded} /></section>
      <div className="coach-detail-desktop">{detailContent}</div>
      <details className="coach-detail-mobile"><summary>展开错因与音素详情</summary>{detailContent}</details>
    </>}
  </aside>
}
