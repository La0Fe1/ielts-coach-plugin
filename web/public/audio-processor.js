class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const rate = (options && options.processorOptions && options.processorOptions.inputSampleRate) || sampleRate;
    this.ratio = rate / 16000;
    this.buffer = [];
    this.frame = 960;
    this.level = 0;
  }

  resample(input) {
    if (this.ratio === 1) return input;
    const outputLength = Math.floor(input.length / this.ratio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i += 1) {
      const position = i * this.ratio;
      const left = Math.floor(position);
      const right = Math.min(input.length - 1, left + 1);
      const weight = position - left;
      output[i] = input[left] * (1 - weight) + input[right] * weight;
    }
    return output;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    const samples = this.resample(channel);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
      sum += samples[i] * samples[i];
      this.buffer.push(samples[i]);
    }
    this.level = Math.sqrt(sum / Math.max(1, samples.length));
    while (this.buffer.length >= this.frame) {
      const chunk = new Int16Array(this.frame);
      for (let i = 0; i < this.frame; i += 1) {
        const value = Math.max(-1, Math.min(1, this.buffer[i]));
        chunk[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
      }
      this.buffer.splice(0, this.frame);
      this.port.postMessage({ pcm: chunk.buffer, level: this.level }, [chunk.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
