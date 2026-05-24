class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffers = [];
    this.totalSamples = 0;
    this.targetSamples = 2048;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const mono = input[0];
    const copy = new Float32Array(mono.length);
    copy.set(mono);
    this.buffers.push(copy);
    this.totalSamples += copy.length;
    if (this.totalSamples >= this.targetSamples) {
      const out = new Float32Array(this.totalSamples);
      let offset = 0;
      for (const b of this.buffers) { out.set(b, offset); offset += b.length; }
      this.buffers = [];
      this.totalSamples = 0;
      this.port.postMessage(out, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('mic-processor', MicProcessor);
