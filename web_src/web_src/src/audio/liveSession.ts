/**
 * One utterance: Web Audio capture + 32 ms int16 frames to the daemon's VAD.
 * If the live socket/model is unavailable, a local energy VAD preserves the
 * same 1.8 s hands-free ending rule without changing the WAV upload format.
 */

import { explainMicError, startRecording, type ActiveRecording } from './pcmRecorder'
import type { VadEvent } from '../types'

const TARGET_RATE = 16000
const FRAME_SAMPLES = 512
const FALLBACK_SILENCE_MS = 1800
const FALLBACK_STUCK_MS = 2500
const FALLBACK_RMS = 0.011
const MAX_UTTERANCE_MS = 200_000

export interface UtteranceResult {
  blob: Blob
  durationSec: number
  speechSec: number
  reason: string
  enoughSpeech: boolean
}

export interface LiveCallbacks {
  onLevel?: (level: number) => void
  onVad?: (event: VadEvent) => void
  onError?: (message: string) => void
  onFallback?: () => void
  /** Part 2 keeps recording across normal pauses until its timer/manual stop. */
  autoStop?: boolean
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
  private finished = false
  private stopReason = 'manual'
  private resolver: ((result: UtteranceResult | null) => void) | null = null
  private guard: number | undefined

  constructor(sessionId: number, callbacks: LiveCallbacks = {}) {
    this.sessionId = sessionId
    this.callbacks = callbacks
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
            if (this.callbacks.autoStop === false && socket.readyState === WebSocket.OPEN) {
              // Keep a continuous Part 2 answer alive long enough to surface the 2.5 s stuck hint.
              socket.send(JSON.stringify({ type: 'config', silence_sec: 3.0 }))
            }
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

  private handleVad(event: VadEvent) {
    this.callbacks.onVad?.(event)
    if (event.speech_sec !== undefined) this.speechSec = event.speech_sec
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
      if (firstSpeech) {
        this.callbacks.onVad?.({ type: 'vad', speech: true, speech_started: true })
      } else if (this.localStuck) {
        this.localStuck = false
        this.callbacks.onVad?.({ type: 'vad', speech: true, stuck: false })
      }
    } else if (this.speechSeen) {
      const silence = now - this.lastVoiceAt
      if (silence >= FALLBACK_STUCK_MS && !this.localStuck) {
        this.localStuck = true
        this.callbacks.onVad?.({ type: 'vad', speech: false, trailing_silence: silence / 1000, stuck: true })
      }
      if (silence >= FALLBACK_SILENCE_MS && this.callbacks.autoStop !== false && !this.finished) {
        this.stopReason = 'silence'
        void this.finish(false)
      }
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
    if (this.guard) window.clearTimeout(this.guard)
    this.closeSocket()
    this.recorder?.cancel()
    this.recorder = null
    this.resolver?.(null)
  }
}
