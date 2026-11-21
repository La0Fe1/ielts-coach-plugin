/**
 * Canonical 16 kHz / mono / 16-bit PCM WAV capture built on Web Audio.
 * MediaRecorder is intentionally not used: the daemon does not accept webm/mp4.
 */

const TARGET_RATE = 16000

const WORKLET_SOURCE = [
  'class PCMCapture extends AudioWorkletProcessor {',
  '  process(inputs) {',
  '    const input = inputs[0];',
  '    if (input && input[0]) {',
  '      const copy = new Float32Array(input[0]);',
  '      this.port.postMessage(copy, [copy.buffer]);',
  '    }',
  '    return true;',
  '  }',
  '}',
  "registerProcessor('pcm-capture', PCMCapture);",
].join('\n')

export interface RecordingResult {
  blob: Blob
  durationSec: number
  sampleRate: number
}

export interface ActiveRecording {
  stop(): Promise<RecordingResult>
  cancel(): void
  markStart(): void
  isActive(): boolean
}

export interface RecorderOptions {
  onLevel?: (level: number) => void
  onError?: (error: Error) => void
  onSamples?: (chunk: Float32Array) => void
}

export function explainMicError(error: unknown): string {
  const name = (error as { name?: string })?.name ?? ''
  const message = (error as { message?: string })?.message ?? String(error)
  if (name === 'NotAllowedError' || /permission denied/i.test(message)) {
    return '麦克风权限被拒绝。请允许本站使用麦克风；如果你在侧栏 iframe 内，请在新标签页打开后重试。'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没有找到麦克风。请确认设备已连接，并在系统设置中选择一个可用输入设备。'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '麦克风可能正被会议或录音软件占用。关闭其他录音程序后再试一次。'
  }
  if (name === 'SecurityError') {
    return '浏览器安全策略阻止了录音。请通过 127.0.0.1 或 localhost 的真实浏览器标签页打开。'
  }
  return message || '麦克风暂时无法启动，请检查权限与输入设备。'
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeString = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }
  return new Blob([view], { type: 'audio/wav' })
}

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input
  const outputLength = Math.max(1, Math.round(input.length * (toRate / fromRate)))
  const output = new Float32Array(outputLength)
  const step = (input.length - 1) / Math.max(1, outputLength - 1)
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * step
    const left = Math.floor(position)
    const right = Math.min(input.length - 1, left + 1)
    const weight = position - left
    output[index] = input[left] * (1 - weight) + input[right] * weight
  }
  return output
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  const merged = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

export async function startRecording(options: RecorderOptions = {}): Promise<ActiveRecording> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前浏览器不支持麦克风采集，请使用支持 Web Audio 的 Safari 或 Chromium 浏览器。')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })

  let context: AudioContext
  try {
    const Ctor: typeof AudioContext = window.AudioContext
      || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    context = new Ctor({ sampleRate: TARGET_RATE })
    await context.resume()
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    throw error
  }

  const captureRate = context.sampleRate || TARGET_RATE
  const source = context.createMediaStreamSource(stream)
  const chunks: Float32Array[] = []
  let active = true
  const sink = context.createGain()
  sink.gain.value = 0
  sink.connect(context.destination)

  const handleChunk = (data: Float32Array, forStream = false) => {
    if (!active) return
    if (forStream) {
      options.onSamples?.(captureRate !== TARGET_RATE ? resample(data, captureRate, TARGET_RATE) : data)
      return
    }
    chunks.push(data)
    if (options.onLevel) {
      let sum = 0
      for (let index = 0; index < data.length; index += 1) sum += data[index] * data[index]
      options.onLevel(Math.min(1, Math.sqrt(sum / Math.max(1, data.length)) * 8))
    }
  }

  let workletNode: AudioWorkletNode | null = null
  let scriptNode: ScriptProcessorNode | null = null
  try {
    if (!context.audioWorklet) throw new Error('AudioWorklet unsupported')
    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    workletNode = new AudioWorkletNode(context, 'pcm-capture')
    workletNode.port.onmessage = (event: MessageEvent) => {
      const data = new Float32Array(event.data as Float32Array)
      handleChunk(data)
      handleChunk(data, true)
    }
    source.connect(workletNode)
    workletNode.connect(sink)
  } catch {
    // Web Audio fallback for older Safari/WebViews; output remains canonical WAV.
    scriptNode = context.createScriptProcessor(4096, 1, 1)
    scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
      const data = new Float32Array(event.inputBuffer.getChannelData(0))
      handleChunk(data)
      handleChunk(data, true)
    }
    source.connect(scriptNode)
    scriptNode.connect(sink)
  }

  const cleanup = async () => {
    active = false
    try {
      source.disconnect()
      workletNode?.disconnect()
      scriptNode?.disconnect()
      sink.disconnect()
    } catch {
      // Nodes may already be detached by the browser during page teardown.
    }
    stream.getTracks().forEach((track) => track.stop())
    try { await context.close() } catch { /* already closed */ }
  }

  return {
    isActive: () => active,
    async stop(): Promise<RecordingResult> {
      if (!active) return { blob: new Blob([], { type: 'audio/wav' }), durationSec: 0, sampleRate: TARGET_RATE }
      await cleanup()
      const merged = mergeChunks(chunks)
      const resampled = resample(merged, captureRate, TARGET_RATE)
      return {
        blob: encodeWav(resampled, TARGET_RATE),
        durationSec: merged.length / captureRate,
        sampleRate: TARGET_RATE,
      }
    },
    cancel() { void cleanup() },
    markStart() {
      if (!active) return
      const currentFrame = chunks[chunks.length - 1]
      chunks.length = 0
      if (currentFrame) chunks.push(currentFrame)
    },
  }
}
