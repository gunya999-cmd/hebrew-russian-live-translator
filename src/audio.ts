export const INPUT_SAMPLE_RATE = 16000;
export const DEFAULT_OUTPUT_SAMPLE_RATE = 24000;

export function downsampleBuffer(input: Float32Array<ArrayBufferLike>, inputRate: number, outputRate: number): Float32Array<ArrayBuffer> {
  if (outputRate === inputRate) return new Float32Array(input);
  if (outputRate > inputRate) throw new Error(`Output sample rate ${outputRate} cannot be higher than input sample rate ${inputRate}`);
  const ratio = inputRate / outputRate;
  const newLength = Math.round(input.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i += 1) { accum += input[i]; count += 1; }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

export function floatTo16BitPCM(input: Float32Array<ArrayBufferLike>): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

export function int16ToFloat32(input: Int16Array<ArrayBufferLike>): Float32Array<ArrayBuffer> {
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) output[i] = input[i] / 32768;
  return output;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  return btoa(binary);
}

export function base64ToInt16Array(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export function parseSampleRateFromMimeType(mimeType?: string | null): number {
  if (!mimeType) return DEFAULT_OUTPUT_SAMPLE_RATE;
  const match = mimeType.match(/rate=(\d+)/i);
  return match ? Number(match[1]) : DEFAULT_OUTPUT_SAMPLE_RATE;
}
