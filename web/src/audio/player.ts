/** Seamless PCM16 streaming player with a 0 ms flush() for interruptions. */

export class PcmPlayer {
  private context: AudioContext;
  private nextPlayTime = 0;
  private sources: AudioBufferSourceNode[] = [];
  private readonly sampleRate: number;
  private idleTimer: number | null = null;
  /** Fires ~220 ms after the last chunk finished: safe to unmute the mic. */
  onIdle?: () => void;

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
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    source.onended = () => {
      this.sources = this.sources.filter((item) => item !== source);
      if (this.sources.length > 0) return;
      if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
      this.idleTimer = window.setTimeout(() => {
        this.idleTimer = null;
        if (this.sources.length === 0) this.onIdle?.();
      }, 220);
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
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
