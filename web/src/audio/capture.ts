/** Microphone capture: AudioWorklet (16 kHz Int16) with ScriptProcessor fallback.

 * iOS Safari ignores new AudioContext({ sampleRate: 16000 }) and runs at 48 kHz,
 * so the worklet resamples inside the audio thread. Must be called from a click
 * handler: creating/resuming AudioContext later loses the unlock.
 */

export interface CaptureHandle {
  stop(): void;
  setMuted(muted: boolean): void;
}

export interface CaptureOptions {
  /** Created inside the click handler so iOS keeps the audio unlock. */
  context?: AudioContext;
  onPcm: (pcm: ArrayBuffer) => void;
  onLevel?: (level: number) => void;
  onError?: (message: string) => void;
}

export async function startCapture(options: CaptureOptions): Promise<CaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const Context = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = options.context || new Context();
  await context.resume();
  const source = context.createMediaStreamSource(stream);
  const sink = context.createGain();
  sink.gain.value = 0;
  sink.connect(context.destination);

  let muted = false;
  let node: AudioWorkletNode | ScriptProcessorNode | null = null;

  const emit = (pcm: ArrayBuffer, level: number): void => {
    if (muted) return;
    options.onLevel?.(level);
    options.onPcm(pcm);
  };

  try {
    await context.audioWorklet.addModule('/audio-processor.js');
    const worklet = new AudioWorkletNode(context, 'pcm-capture', {
      processorOptions: { inputSampleRate: context.sampleRate },
    });
    worklet.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { pcm: ArrayBuffer; level: number };
      emit(data.pcm, data.level);
    };
    source.connect(worklet);
    worklet.connect(sink);
    node = worklet;
  } catch {
    // Old browsers (or non-secure contexts): fall back to ScriptProcessor.
    const script = context.createScriptProcessor(4096, 1, 1);
    const ratio = context.sampleRate / 16000;
    let pending: number[] = [];
    script.onaudioprocess = (event: AudioProcessingEvent) => {
      const input = event.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i += 1) {
        sum += input[i] * input[i];
        pending.push(input[i]);
      }
      const level = Math.sqrt(sum / Math.max(1, input.length));
      const step = Math.max(1, Math.round(ratio));
      if (pending.length >= 960 * step) {
        const frame = new Int16Array(960);
        for (let i = 0; i < 960; i += 1) {
          const value = Math.max(-1, Math.min(1, pending[i * step]));
          frame[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
        }
        pending = pending.slice(960 * step);
        emit(frame.buffer, level);
      }
    };
    source.connect(script);
    script.connect(sink);
    node = script;
  }

  return {
    stop() {
      try {
        node?.disconnect();
        source.disconnect();
        sink.disconnect();
      } catch {
        /* already detached */
      }
      stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => undefined);
    },
    setMuted(value: boolean) {
      muted = value;
    },
  };
}
