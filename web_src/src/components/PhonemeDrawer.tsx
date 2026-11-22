import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Accent, PracticeState, PronWord } from '../types'
import { PracticeOutcome } from './CoachPanel'

interface PhonemeDrawerProps {
  word: PronWord | null
  learnerAudioUrl?: string | null
  accent: Accent
  practice: PracticeState
  onPractice: (targetText: string, previousScore?: number | null) => void
  onClose: () => void
}

function scoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined) return 'gray'
  if (score >= 80) return 'green'
  if (score >= 60) return 'amber'
  return 'red'
}

export function PhonemeDrawer({ word, learnerAudioUrl, accent, practice, onPractice, onClose }: PhonemeDrawerProps) {
  const [standardPlaying, setStandardPlaying] = useState(false)
  const [minePlaying, setMinePlaying] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)
  const mineRef = useRef<HTMLAudioElement | null>(null)
  const standardRef = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    setMinePlaying(false)
    setStandardPlaying(false)
    setAudioError(null)
    return () => { mineRef.current?.pause(); standardRef.current?.pause() }
  }, [word])
  if (!word) return null

  const close = () => { mineRef.current?.pause(); standardRef.current?.pause(); onClose() }
  const playMine = () => {
    if (!learnerAudioUrl) return
    mineRef.current?.pause()
    setAudioError(null)
    const audio = new Audio(learnerAudioUrl)
    mineRef.current = audio
    const start = Math.max(0, (word.start_sec ?? 0) - 0.05)
    const end = (word.end_sec ?? (word.start_sec ?? 0) + 0.6) + 0.08
    const stopAtWordEnd = () => {
      if (audio.currentTime >= end) { audio.pause(); audio.removeEventListener('timeupdate', stopAtWordEnd); setMinePlaying(false) }
    }
    const begin = () => {
      audio.currentTime = start
      setMinePlaying(true)
      void audio.play().catch(() => { setMinePlaying(false); setAudioError('原声播放失败，请再试一次。') })
    }
    audio.addEventListener('timeupdate', stopAtWordEnd)
    audio.onended = () => setMinePlaying(false)
    if (audio.readyState >= 1) begin()
    else audio.addEventListener('loadedmetadata', begin, { once: true })
  }
  const playStandard = async () => {
    standardRef.current?.pause()
    setStandardPlaying(true)
    setAudioError(null)
    try {
      const data = await api.ttsWord(word.word, accent)
      if (!data.url) throw new Error('missing audio url')
      const audio = new Audio(data.url)
      standardRef.current = audio
      audio.onended = () => setStandardPlaying(false)
      audio.onerror = () => setStandardPlaying(false)
      await audio.play()
    } catch {
      setStandardPlaying(false)
      setAudioError('示范音暂时不可用，请确认本地语音服务已启动。')
    }
  }
  const samePractice = practice.targetText === word.word
  const practiceLabel = samePractice && practice.status === 'recording'
    ? practice.elapsed < 2 ? `再读 ${(2 - practice.elapsed).toFixed(1)}s` : `完成重测 ${practice.elapsed.toFixed(1)}s`
    : samePractice && practice.status === 'uploading' ? '评分中…' : '跟读重测'

  return <div className="drawer-backdrop phoneme-backdrop" onClick={close}><section className="phoneme-drawer" role="dialog" aria-modal="true" aria-label={`${word.word} 发音详情`} onClick={(event) => event.stopPropagation()}>
    <header className="drawer-head"><div><p className="eyebrow">PRONUNCIATION LAB</p><h2>{word.word}</h2><p className="phoneme-ipa">/{word.ipa ?? '—'}/</p></div><span className={`word-score ${scoreColor(word.score)}`}>{word.score ?? '—'}</span><button className="close-button" onClick={close} aria-label="关闭发音详情">×</button></header>
    {word.phonemes && word.phonemes.length > 0 && <div className="phoneme-scores">{word.phonemes.map((phoneme, index) => <div className={`phoneme-score ${scoreColor(phoneme.score)}`} key={`${phoneme.phoneme}-${index}`}><strong>/{phoneme.phoneme}/</strong><span>{phoneme.score}</span></div>)}</div>}
    {word.issues.length > 0 ? <ul className="issue-list">{word.issues.map((issue, index) => <li key={`${issue.phoneme}-${index}`}><strong>/{issue.phoneme}/</strong><span>{issue.likely_pronounced_as ? `听起来更接近 /${issue.likely_pronounced_as}/` : '这个音素需要再稳定一些'}{issue.gop_score !== undefined ? ` · GOP ${issue.gop_score}` : ''}</span></li>)}</ul> : <p className="muted">没有明显音素替换问题，可以对比原声与标准音再跟读一次。</p>}
    <div className="listen-compare"><button className="secondary-button" onClick={playMine} disabled={!learnerAudioUrl || minePlaying}>{minePlaying ? '播放原声中…' : '听我的原声'}</button><button className="secondary-button" onClick={() => void playStandard()} disabled={standardPlaying}>{standardPlaying ? '播放示范中…' : '听标准示范'}</button><button className="primary-button" disabled={practice.status === 'uploading' || (samePractice && practice.status === 'recording' && practice.elapsed < 2)} onClick={() => onPractice(word.word, word.score)}>{practiceLabel}</button></div>
    <PracticeOutcome practice={practice} targetText={word.word} previousPhonemes={word.phonemes ?? []} />
    {!learnerAudioUrl && <p className="muted">本轮没有可回放的原始音频。</p>}
    {audioError && <p role="alert">{audioError}</p>}
    <p className="drawer-footnote">标准音使用{accent === 'uk' ? '英音' : '美音'}；跟读同样生成 16kHz 单声道 16bit WAV。</p>
  </section></div>
}
