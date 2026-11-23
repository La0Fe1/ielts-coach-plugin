/** Seamless PCM16 streaming player with a 0 ms flush() for interruptions. */

export class PcmPlayer {
  private context: AudioContext;
  private nextPlayTime = 0;
  private sources: AudioBufferSourceNode[] = [];
  private readonly sampleRate: number;

  constructor(sampleRate = 24000, context?: AudioContext) {
    this.sampleRate = sampleRate;
    const Context = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.context = context || new Context();
  }

  async resume(): Promise<void> {
    if (this.context.state !== 'running') await this.context.resume();
  }

  enqueue(pcm: ArrayBuffer, sampleRate?: number): void {
    const rate = sampleRate || this.sampleRate;
    const samples = new Int16Array(pcm);
    if (samples.length === 0) return;
    const buffer = this.context.createBuffer(1, samples.length, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const now = this.context.currentTime;
    const startAt = Math.max(now + 0.05, this.nextPlayTime);
    source.start(startAt);
    this.nextPlayTime = startAt + buffer.duration;
    this.sources.push(source);
    source.onended = () => {
      this.sources = this.sources.filter((item) => item !== source);
    };
  }

  /** Instant silence: stop every scheduled node and reset the timeline. */
  flush(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
    this.nextPlayTime = 0;
  }
}
