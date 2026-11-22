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

const PHONEME_GUIDE: Record<string, { tip: string; pairs: [string, string][] }> = {
  'θ': { tip: '舌尖轻放在上下齿之间，送气，不要咬住；不要读成 s 或 f。', pairs: [['think', 'sink'], ['three', 'tree']] },
  'ð': { tip: '舌尖轻触上齿，声带振动；不要读成 d 或 z。', pairs: [['this', 'dis'], ['breathe', 'breed']] },
  'v': { tip: '上齿轻咬下唇，声带振动；不要读成 w。', pairs: [['very', 'wery'], ['vine', 'wine']] },
  'w': { tip: '双唇先收圆再放开，牙齿不碰嘴唇。', pairs: [['west', 'vest'], ['wine', 'vine']] },
  'ŋ': { tip: '舌根顶住软腭，气流从鼻腔出；结尾不要加 g。', pairs: [['sing', 'sin'], ['thing', 'thin']] },
  'æ': { tip: '嘴张大、嘴角向两边，介于「哎」和「啊」之间。', pairs: [['bad', 'bed'], ['man', 'men']] },
  'e': { tip: '嘴型比 æ 小，舌位前半高，短促。', pairs: [['bed', 'bad'], ['pen', 'pan']] },
  'ɪ': { tip: '短促松弛的「衣」，不要拉长成 iː。', pairs: [['ship', 'sheep'], ['sit', 'seat']] },
  'iː': { tip: '嘴角拉开、舌位高，明显比 ɪ 长。', pairs: [['sheep', 'ship'], ['seat', 'sit']] },
  'l': { tip: '词尾 l 舌尖要抵住上齿龈，别吞掉。', pairs: [['feel', 'fee'], ['pool', 'poo']] },
  'r': { tip: '舌尖卷起但不碰上颚，嘴唇略圆。', pairs: [['right', 'light'], ['red', 'led']] },
  'ʃ': { tip: '舌面靠近硬腭，双唇略圆，像让人安静的声音。', pairs: [['ship', 'sip'], ['she', 'see']] },
  'ʒ': { tip: '和 ʃ 同位置，但声带振动。', pairs: [['measure', 'mesher'], ['vision', 'vishion']] },
  'tʃ': { tip: 't 和 ʃ 快速连读，像中文「吃」的声母但更短。', pairs: [['cheap', 'jeep'], ['chair', 'share']] },
  'dʒ': { tip: 'd 和 ʒ 连读，像「知」的声母，声带振动。', pairs: [['jeep', 'cheep'], ['joke', 'choke']] },
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
  const speakWord = async (text: string) => {
    standardRef.current?.pause()
    setStandardPlaying(true)
    try {
      const data = await api.ttsWord(text, accent)
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
  const guides = word.issues
    .map((issue) => ({ phoneme: issue.phoneme, guide: PHONEME_GUIDE[issue.phoneme.toLowerCase()] }))
    .filter((item) => Boolean(item.guide))
  const samePractice = practice.targetText === word.word
  const practiceLabel = samePractice && practice.status === 'recording'
    ? practice.elapsed < 0.5 ? '再读 ' + (0.5 - practice.elapsed).toFixed(1) + 's' : '完成重测 ' + practice.elapsed.toFixed(1) + 's'
    : samePractice && practice.status === 'uploading' ? '评分中…' : '跟读重测'

  return <div className="drawer-backdrop phoneme-backdrop" onClick={close}><section className="phoneme-drawer" role="dialog" aria-modal="true" aria-label={`${word.word} 发音详情`} onClick={(event) => event.stopPropagation()}>
    <header className="drawer-head"><div><p className="eyebrow">PRONUNCIATION LAB</p><h2>{word.word}</h2><p className="phoneme-ipa">/{word.ipa ?? '—'}/</p></div><span className={`word-score ${scoreColor(word.score)}`}>{word.score ?? '—'}</span><button className="close-button" onClick={close} aria-label="关闭发音详情">×</button></header>
    {word.phonemes && word.phonemes.length > 0 && <div className="phoneme-scores">{word.phonemes.map((phoneme, index) => <div className={`phoneme-score ${scoreColor(phoneme.score)}`} key={`${phoneme.phoneme}-${index}`}><strong>/{phoneme.phoneme}/</strong><span>{phoneme.score}</span></div>)}</div>}
    {word.issues.length > 0 ? <ul className="issue-list">{word.issues.map((issue, index) => <li key={`${issue.phoneme}-${index}`}><strong>/{issue.phoneme}/</strong><span>{issue.likely_pronounced_as ? `听起来更接近 /${issue.likely_pronounced_as}/` : '这个音素需要再稳定一些'}{issue.gop_score !== undefined ? ` · GOP ${issue.gop_score}` : ''}</span></li>)}</ul> : <p className="muted">没有明显音素替换问题，可以对比原声与标准音再跟读一次。</p>}
    {guides.length > 0 && <div className="phoneme-guide">{guides.map(({ phoneme, guide }) => guide && (
      <section className="guide-card" key={phoneme}>
        <p><strong>/{phoneme}/ 怎么摆</strong> {guide.tip}</p>
        <div className="guide-pairs">{guide.pairs.map(([good, bad]) => (
          <span key={good}>
            <button className="hint-word" onClick={() => void speakWord(good)}>{good}</button>
            <em>对比</em>
            <button className="hint-word is-bad" onClick={() => void speakWord(bad)}>{bad}</button>
          </span>
        ))}</div>
      </section>
    ))}</div>}
    <div className="listen-compare"><button className="secondary-button" onClick={playMine} disabled={!learnerAudioUrl || minePlaying}>{minePlaying ? '播放原声中…' : '听我的原声'}</button><button className="secondary-button" onClick={() => void playStandard()} disabled={standardPlaying}>{standardPlaying ? '播放示范中…' : '听标准示范'}</button><button className="primary-button" disabled={practice.status === 'uploading' || (samePractice && practice.status === 'recording' && practice.elapsed < 0.5)} onClick={() => onPractice(word.word, word.score)}>{practiceLabel}</button></div>
    <PracticeOutcome practice={practice} targetText={word.word} previousPhonemes={word.phonemes ?? []} />
    {!learnerAudioUrl && <p className="muted">本轮没有可回放的原始音频。</p>}
    {audioError && <p role="alert">{audioError}</p>}
    <p className="drawer-footnote">标准音使用{accent === 'uk' ? '英音' : '美音'}；跟读同样生成 16kHz 单声道 16bit WAV。</p>
  </section></div>
}
