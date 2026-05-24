import { useRef, useState } from 'react';
import { INPUT_SAMPLE_RATE, arrayBufferToBase64, base64ToInt16Array, downsampleBuffer, floatTo16BitPCM, int16ToFloat32, parseSampleRateFromMimeType } from './audio';

type Status = 'idle' | 'connecting' | 'receiving' | 'error';
type Inline = { data?: string; mimeType?: string; mime_type?: string };
type Part = { text?: string; inlineData?: Inline; inline_data?: Inline };
type Msg = { setupComplete?: unknown; error?: { message?: string }; serverContent?: { interrupted?: boolean; inputTranscription?: { text?: string }; outputTranscription?: { text?: string }; modelTurn?: { parts?: Part[] }; turnComplete?: boolean } };

declare global { interface Window { webkitAudioContext?: typeof AudioContext } }

const WS_URL = import.meta.env.VITE_WS_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const MODEL = 'models/gemini-3.1-flash-live-preview';
const GAIN = 12;
const LEVEL_SCALE = 2600;
const SEGMENT_MS = 650;
const MIN_CHUNKS = 8;
const MAX_TEXT = 900;
const isAirPods = (label = '') => label.toLowerCase().includes('airpods');
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function makeContext(): AudioContext {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) throw new Error('AudioContext is not available. Use Chrome over HTTPS.');
  return new Ctor({ latencyHint: 'interactive' });
}

async function textOf(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  const blob = data as { text?: () => Promise<string>; arrayBuffer?: () => Promise<ArrayBuffer> };
  if (blob?.text) return blob.text();
  if (blob?.arrayBuffer) return new TextDecoder().decode(await blob.arrayBuffer());
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer);
  return String(data);
}

function append(base: string, chunk: string): string {
  const text = chunk.trim();
  if (!text) return base;
  if (!base) return text;
  return /^[,.;:!?…)]/.test(text) ? `${base}${text}` : `${base} ${text}`;
}

function trim(text: string): string {
  return text.length > MAX_TEXT ? text.slice(text.length - MAX_TEXT) : text;
}

function level(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.min(100, Math.round(Math.sqrt(sum / Math.max(1, samples.length)) * LEVEL_SCALE));
}

function boost(samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = Math.max(-1, Math.min(1, samples[i] * GAIN));
  return out;
}

function constraints(deviceId?: string): MediaStreamConstraints {
  const audio: MediaTrackConstraints = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

async function openInputMic(log: (s: string) => void): Promise<MediaStream> {
  const first = await navigator.mediaDevices.getUserMedia(constraints());
  await wait(450);
  const label = first.getAudioTracks()[0]?.label || 'iPhone microphone';
  if (!isAirPods(label)) return first;
  first.getTracks().forEach((track) => track.stop());
  log('AirPods selected as input. Switching to iPhone mic...');
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const d of devices.filter((x) => x.kind === 'audioinput' && !isAirPods(x.label))) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints(d.deviceId));
      await wait(450);
      const streamLabel = stream.getAudioTracks()[0]?.label || d.label || 'iPhone microphone';
      if (!isAirPods(streamLabel)) return stream;
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      // Try next input.
    }
  }
  throw new Error('Input is still AirPods mic. Disconnect AirPods, press Start, then reconnect/select AirPods as output.');
}

function setupMessage() {
  return { config: { model: MODEL, responseModalities: ['AUDIO'], systemInstruction: { parts: [{ text: 'You are a one-way live interpreter. Translate only Hebrew speech from an external source into natural spoken Russian. Ignore Russian speech, user speech, background noise, and non-Hebrew audio. Do not answer questions. Do not explain.' }] }, inputAudioTranscription: {}, outputAudioTranscription: {} } };
}

function audioMessage(base64: string) {
  return { realtimeInput: { audio: { mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`, data: base64 } } };
}

export default function ReceiverApp() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [micName, setMicName] = useState('not started');
  const [micLevel, setMicLevel] = useState(0);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [log, setLog] = useState<string[]>([]);

  const ctxRef = useRef<AudioContext | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const workletLoadedRef = useRef(false);
  const playAtRef = useRef(0);
  const outputNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const runningRef = useRef(false);
  const readyRef = useRef(false);
  const sentSinceEndRef = useRef(false);
  const segmentStartRef = useRef(0);
  const segmentChunksRef = useRef(0);
  const sentRef = useRef(0);
  const audioInRef = useRef(0);
  const inputRef = useRef('');
  const outputRef = useRef('');

  const addLog = (text: string) => setLog((items) => [`${new Date().toLocaleTimeString()} - ${text}`, ...items].slice(0, 12));

  function sendEnd() {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !sentSinceEndRef.current) return;
    ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    sentSinceEndRef.current = false;
    segmentChunksRef.current = 0;
    segmentStartRef.current = performance.now();
  }

  function maybeEndSegment() {
    if (segmentChunksRef.current < MIN_CHUNKS) return;
    if (performance.now() - segmentStartRef.current < SEGMENT_MS) return;
    sendEnd();
  }

  function stopOutput() {
    for (const node of outputNodesRef.current) { try { node.stop(); } catch {} }
    outputNodesRef.current = [];
    playAtRef.current = ctxRef.current?.currentTime || 0;
  }

  function playPcm(base64: string, mimeType?: string) {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const floats = int16ToFloat32(base64ToInt16Array(base64));
    const buffer = ctx.createBuffer(1, floats.length, parseSampleRateFromMimeType(mimeType));
    buffer.copyToChannel(floats, 0);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, playAtRef.current);
    node.start(startAt);
    playAtRef.current = startAt + buffer.duration;
    outputNodesRef.current.push(node);
    node.onended = () => { outputNodesRef.current = outputNodesRef.current.filter((n) => n !== node); };
  }

  async function onMessage(event: MessageEvent) {
    let msg: Msg;
    try { msg = JSON.parse(await textOf(event.data)); } catch { return; }
    if (msg.setupComplete) { readyRef.current = true; addLog('Gemini ready. Receiving Hebrew source.'); }
    if (msg.error?.message) { setError(msg.error.message); setStatus('error'); addLog(`Gemini error: ${msg.error.message}`); }
    const content = msg.serverContent;
    if (!content) return;
    if (content.interrupted) stopOutput();
    if (content.inputTranscription?.text) { inputRef.current = trim(append(inputRef.current, content.inputTranscription.text)); setInput(inputRef.current); }
    if (content.outputTranscription?.text) { outputRef.current = trim(append(outputRef.current, content.outputTranscription.text)); setOutput(outputRef.current); }
    for (const part of content.modelTurn?.parts || []) {
      if (part.text) { outputRef.current = trim(append(outputRef.current, part.text)); setOutput(outputRef.current); }
      const inline = part.inlineData || part.inline_data;
      if (inline?.data) {
        audioInRef.current += 1;
        if (audioInRef.current === 1) addLog('Russian audio started.');
        playPcm(inline.data, inline.mimeType || inline.mime_type);
      }
    }
  }

  async function attachMic(stream: MediaStream) {
    const ctx = ctxRef.current || makeContext();
    ctxRef.current = ctx;
    await ctx.resume();
    if (!workletLoadedRef.current) { await ctx.audioWorklet.addModule('/mic-worklet.js'); workletLoadedRef.current = true; }
    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, 'mic-processor');
    const mute = ctx.createGain();
    mute.gain.value = 0;
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const samples = event.data;
      setMicLevel(level(samples));
      if (!runningRef.current || !readyRef.current) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !ctxRef.current) return;
      const down = downsampleBuffer(boost(samples), ctxRef.current.sampleRate, INPUT_SAMPLE_RATE);
      const pcm = floatTo16BitPCM(down);
      ws.send(JSON.stringify(audioMessage(arrayBufferToBase64(pcm.buffer))));
      sentSinceEndRef.current = true;
      sentRef.current += 1;
      segmentChunksRef.current += 1;
      maybeEndSegment();
      if (sentRef.current === 1 || sentRef.current % 200 === 0) addLog(`Input audio sent: ${sentRef.current}.`);
    };
    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(ctx.destination);
    sourceRef.current = source;
    workletRef.current = worklet;
  }

  async function start() {
    try {
      await stop(false);
      setStatus('connecting');
      setError('');
      setInput('');
      setOutput('');
      inputRef.current = '';
      outputRef.current = '';
      sentRef.current = 0;
      audioInRef.current = 0;
      sentSinceEndRef.current = false;
      segmentChunksRef.current = 0;
      segmentStartRef.current = performance.now();
      readyRef.current = false;
      const stream = await openInputMic(addLog);
      streamRef.current = stream;
      setMicName(stream.getAudioTracks()[0]?.label || 'iPhone microphone');
      await attachMic(stream);
      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      ws.onopen = () => { ws.send(JSON.stringify(setupMessage())); runningRef.current = true; setStatus('receiving'); addLog('Receiver started. Output should use AirPods if selected in iOS.'); };
      ws.onmessage = (event) => { void onMessage(event); };
      ws.onerror = () => { setError('WebSocket error.'); setStatus('error'); addLog('WebSocket error.'); };
      ws.onclose = (event) => { if (event.code !== 1000) setStatus('error'); addLog(`WebSocket closed ${event.code || ''} ${event.reason || ''}`.trim()); };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus('error');
      addLog(message);
    }
  }

  async function stop(reset = true) {
    sendEnd();
    runningRef.current = false;
    readyRef.current = false;
    try { workletRef.current?.disconnect(); sourceRef.current?.disconnect(); } catch {}
    streamRef.current?.getTracks().forEach((track) => track.stop());
    try { wsRef.current?.close(1000, 'stop'); } catch {}
    stopOutput();
    wsRef.current = null;
    streamRef.current = null;
    sourceRef.current = null;
    workletRef.current = null;
    setMicName('not started');
    setMicLevel(0);
    if (reset) { setStatus('idle'); addLog('Stopped.'); }
  }

  return <main className="app-shell">
    <section className="hero-card"><div className="eyebrow">One-way Hebrew receiver</div><h1>Hebrew source → Russian in AirPods</h1><p className="subtitle">Place iPhone near the Hebrew source. Select AirPods as iOS output. The app ignores non-Hebrew as much as possible.</p>{error && <div className="error">{error}</div>}<div className="controls"><button className="primary" disabled={status === 'connecting' || status === 'receiving'} onClick={() => void start()}>Start receiver</button><button className="secondary" onClick={() => void stop()}>Stop</button></div><div className={`status-pill ${status}`}><span />{status}</div></section>
    <section className="grid"><div className="panel"><h2>Input microphone</h2><p>Active: {micName}</p><div className="meter"><div style={{ width: `${micLevel}%` }} /></div><p>Level: {micLevel}%</p></div><div className="panel"><h2>Russian output</h2><p>{output || 'Russian translation will appear and play here.'}</p></div></section>
    <section className="grid"><div className="panel"><h2>Hebrew heard</h2><p>{input || 'Hebrew transcript will appear here.'}</p></div><div className="panel"><h2>Log</h2>{log.length ? <ul>{log.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>Log is empty.</p>}</div></section>
  </main>;
}
