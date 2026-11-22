/** Web Audio capture plus 32 ms int16 streaming to the local VAD. */

import { explainMicError, startRecording, type ActiveRecording } from './pcmRecorder'
import type { SendProgress, VadEvent } from '../types'

const TARGET_RATE = 16000
const FRAME_SAMPLES = 512
const FALLBACK_STUCK_MS = 2500
const FALLBACK_RMS = 0.011
const MAX_UTTERANCE_MS = 200_000

export interface UtteranceResult {
  blob: Blob
  durationSec: number
  speechSec: number
  reason: string
  enoughSpeech: boolean
  probeId?: string
}

export interface LiveCallbacks {
  onLevel?: (level: number) => void
  onVad?: (event: VadEvent) => void
  onSendProgress?: (progress: SendProgress) => void
  onError?: (message: string) => void
  onFallback?: () => void
  /** Free mode cuts after the visible silence countdown; manual/Part 2 do not. */
  autoStop?: boolean
  /** Fired once per pause when the sentence-completeness probe returns. */
  onCompleteness?: (complete: boolean, detail?: string) => void
}

function encodeFrame(samples: Float32Array): ArrayBuffer {
  const output = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]))
    output[index] = value < 0 ? value * 0x8000 : value * 0x7fff
  }
  return output.buffer
}

function rms(samples: Float32Array): number {
  let sum = 0
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

function inactiveProgress(): SendProgress {
  return { active: false, progress: 0, remainingSec: 0, thresholdSec: 0 }
}

export class LiveUtterance {
  private readonly sessionId: number
  private readonly callbacks: LiveCallbacks
  private recorder: ActiveRecording | null = null
  private socket: WebSocket | null = null
  private buffer = new Float32Array(0)
  private fallback = false
  private localStuck = false
  private lastVoiceAt = 0
  private speechSeen = false
  private speechSec = 0
  private silenceSec: number
  private finished = false
  private stopReason = 'manual'
  private resolver: ((result: UtteranceResult | null) => void) | null = null
  private guard: number | undefined
  private probed = false

  constructor(sessionId: number, callbacks: LiveCallbacks = {}) {
    this.sessionId = sessionId
    this.callbacks = callbacks
    this.silenceSec = callbacks.autoStop === false ? 2.5 : 1.8
  }

  private sendConfig() {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({
      type: 'config',
      manual: this.callbacks.autoStop === false,
      silence_sec: this.silenceSec,
      cut_on_silence: this.callbacks.autoStop !== false,
    }))
  }

  private updateDynamicSilence() {
    if (this.callbacks.autoStop === false) return
    const next = this.speechSec < 4 ? 2.0 : this.speechSec > 12 ? 1.6 : 1.8
    if (Math.abs(next - this.silenceSec) < 0.1) return
    this.silenceSec = next
    this.sendConfig()
  }

  private updateSendProgress(silenceSec: number) {
    const active = this.callbacks.autoStop !== false && this.speechSeen && silenceSec > 0 && silenceSec <= this.silenceSec
    this.callbacks.onSendProgress?.(active ? {
      active: true,
      progress: Math.min(1, silenceSec / this.silenceSec),
      remainingSec: Math.max(0, this.silenceSec - silenceSec),
      thresholdSec: this.silenceSec,
    } : inactiveProgress())
  }

  private connectSocket(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
        const socket = new WebSocket(`${protocol}://${window.location.host}/ws/live/${this.sessionId}`)
        socket.binaryType = 'arraybuffer'
        this.socket = socket
        const timer = window.setTimeout(() => {
          this.enableFallback()
          finish()
        }, 1200)
        socket.onmessage = (event: MessageEvent) => {
          let payload: VadEvent
          try { payload = JSON.parse(String(event.data)) as VadEvent } catch { return }
          if (payload.type === 'ready') {
            window.clearTimeout(timer)
            this.sendConfig()
            if (!payload.available) this.enableFallback()
            finish()
          } else if (payload.type === 'vad') {
            this.handleVad(payload)
          }
        }
        socket.onerror = () => {
          window.clearTimeout(timer)
          this.enableFallback()
          finish()
        }
        socket.onclose = () => {
          window.clearTimeout(timer)
          if (!this.finished) this.enableFallback()
          finish()
        }
      } catch {
        this.enableFallback()
        finish()
      }
    })
  }

  private enableFallback() {
    if (this.fallback) return
    this.fallback = true
    this.callbacks.onFallback?.()
  }

  private maybeProbe(silenceSec: number) {
    if (this.callbacks.autoStop === false || this.finished || this.probed) return
    if (!this.speechSeen || silenceSec < 1.4) return
    this.probed = true
    const recorder = this.recorder
    if (!recorder) return
    const blob = recorder.snapshot()
    if (!blob || blob.size < 2000) return
    const form = new FormData()
    form.append('file', blob, 'probe.wav')
    const url = '/api/sessions/' + this.sessionId + '/probe?pause_sec=' + silenceSec.toFixed(2)
    void fetch(url, { method: 'POST', body: form })
      .then((response) => (response.ok ? response.json() : null))
      .then((result: { complete?: boolean; detail?: string } | null) => {
        if (!result || this.finished) return
        if (result.complete === false) {
          // Unfinished sentence: give the learner room instead of cutting at 1.8 s.
          this.silenceSec = 3.5
          this.sendConfig()
          this.callbacks.onCompleteness?.(false, result.detail)
        } else {
          this.callbacks.onCompleteness?.(true, result.detail)
        }
      })
      .catch(() => undefined)
  }

  private handleVad(event: VadEvent) {
    if (event.speech_started || event.speech) this.speechSeen = true
    if (event.speech_started) this.probed = false
    if (event.speech_sec !== undefined) this.speechSec = event.speech_sec
    this.updateDynamicSilence()
    this.updateSendProgress(event.trailing_silence ?? 0)
    this.maybeProbe(event.trailing_silence ?? 0)
    this.callbacks.onVad?.(event)
    if (event.should_stop && this.callbacks.autoStop !== false && !this.finished) {
      this.stopReason = event.stop_reason || 'silence'
      void this.finish(false)
    }
  }

  private localVad(chunk: Float32Array) {
    const now = performance.now()
    if (rms(chunk) > FALLBACK_RMS) {
      const firstSpeech = !this.speechSeen
      this.lastVoiceAt = now
      this.speechSeen = true
      this.speechSec += chunk.length / TARGET_RATE
      this.updateDynamicSilence()
      this.updateSendProgress(0)
      if (firstSpeech) {
        this.callbacks.onVad?.({ type: 'vad', speech: true, speech_started: true })
      } else if (this.localStuck) {
        this.localStuck = false
        this.callbacks.onVad?.({ type: 'vad', speech: true, stuck: false })
      }
      return
    }

    if (!this.speechSeen) return
    const silenceMs = now - this.lastVoiceAt
    this.updateSendProgress(silenceMs / 1000)
    this.maybeProbe(silenceMs / 1000)
    if (silenceMs >= FALLBACK_STUCK_MS && !this.localStuck) {
      this.localStuck = true
      this.callbacks.onVad?.({ type: 'vad', speech: false, trailing_silence: silenceMs / 1000, stuck: true })
    }
    if (silenceMs >= this.silenceSec * 1000 && this.callbacks.autoStop !== false && !this.finished) {
      this.stopReason = 'silence'
      void this.finish(false)
    }
  }

  private onSamples = (chunk: Float32Array) => {
    if (this.finished) return
    if (this.fallback) {
      this.localVad(chunk)
      return
    }
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.localVad(chunk)
      return
    }
    const merged = new Float32Array(this.buffer.length + chunk.length)
    merged.set(this.buffer)
    merged.set(chunk, this.buffer.length)
    let offset = 0
    while (merged.length - offset >= FRAME_SAMPLES) {
      socket.send(encodeFrame(merged.subarray(offset, offset + FRAME_SAMPLES)))
      offset += FRAME_SAMPLES
    }
    this.buffer = merged.slice(offset)
  }

  private closeSocket() {
    const socket = this.socket
    this.socket = null
    try { socket?.close() } catch { /* already closed */ }
  }

  private async finish(silent = false): Promise<void> {
    if (this.finished) return
    this.finished = true
    this.callbacks.onSendProgress?.(inactiveProgress())
    if (this.guard) window.clearTimeout(this.guard)
    const recorder = this.recorder
    this.recorder = null
    this.closeSocket()
    if (!recorder) {
      this.resolver?.(null)
      return
    }
    try {
      const result = await recorder.stop()
      this.resolver?.({
        blob: result.blob,
        durationSec: result.durationSec,
        speechSec: Math.max(this.speechSec, 0),
        reason: this.stopReason,
        enoughSpeech: !silent && (this.speechSec >= 0.25 || result.durationSec >= 0.35),
      })
    } catch (error) {
      this.callbacks.onError?.(String(error))
      this.resolver?.(null)
    }
  }

  async run(): Promise<UtteranceResult | null> {
    await this.connectSocket()
    if (this.finished) {
      this.closeSocket()
      return null
    }
    const promise = new Promise<UtteranceResult | null>((resolve) => { this.resolver = resolve })
    try {
      const recorder = await startRecording({
        onLevel: this.callbacks.onLevel,
        onSamples: this.onSamples,
        onError: (error) => this.callbacks.onError?.(error.message),
      })
      if (this.finished) {
        recorder.cancel()
        return null
      }
      this.recorder = recorder
    } catch (error) {
      this.callbacks.onError?.(explainMicError(error))
      this.closeSocket()
      this.finished = true
      return null
    }
    this.guard = window.setTimeout(() => {
      if (!this.finished) {
        this.stopReason = 'max_length'
        void this.finish(false)
      }
    }, MAX_UTTERANCE_MS)
    return promise
  }

  markStart() {
    this.speechSec = 0
    this.recorder?.markStart()
  }

  stopNow() {
    if (this.finished) return
    this.stopReason = 'manual'
    void this.finish(false)
  }

  cancel() {
    if (this.finished) return
    this.finished = true
    this.callbacks.onSendProgress?.(inactiveProgress())
    if (this.guard) window.clearTimeout(this.guard)
    this.closeSocket()
    this.recorder?.cancel()
    this.recorder = null
    this.resolver?.(null)
  }
}
