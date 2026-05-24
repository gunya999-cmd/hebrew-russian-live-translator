import { useRef, useState } from 'react';
import { INPUT_SAMPLE_RATE, arrayBufferToBase64, base64ToInt16Array, downsampleBuffer, floatTo16BitPCM, int16ToFloat32, parseSampleRateFromMimeType } from './audio';

type Status = 'idle' | 'connecting' | 'listening' | 'error';
type Part = { text?: string; inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mimeType?: string } };
type Msg = { setupComplete?: unknown; error?: { message?: string }; serverContent?: { interrupted?: boolean; inputTranscription?: { text?: string }; outputTranscription?: { text?: string }; modelTurn?: { parts?: Part[] } } };

declare global { interface Window { webkitAudioContext?: typeof AudioContext } }

const WS_URL = import.meta.env.VITE_WS_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const MODEL = 'models/gemini-3.1-flash-live-preview';
const GAIN = 8;
const GATE = 6;
const LEVEL_SCALE = 1800;
const HANGOVER_MS = 900;
const END_MS = 1400;

const isAirPods = (label = '') => label.toLowerCase().includes('airpods');
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function audioContext(): AudioContext {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) throw new Error('AudioContext is not available. Use Chrome over HTTPS.');
  return new Ctor({ latencyHint: 'interactive' });
}

async function asText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  const blobLike = data as { text?: () => Promise<string>; arrayBuffer?: () => Promise<ArrayBuffer> };
  if (blobLike && typeof blobLike.text === 'function') return blobLike.text();
  if (blobLike && typeof blobLike.arrayBuffer === 'function') return new TextDecoder().decode(await blobLike.arrayBuffer());
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer);
  return String(data);
}

function micLevel(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.min(100, Math.round(Math.sqrt(sum / Math.max(1, samples.length)) * LEVEL_SCALE));
}

function boost(samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = Math.max(-1, Math.min(1, samples[i] * GAIN));
  return out;
}

function micConstraints(deviceId?: string): MediaStreamConstraints {
  const audio: MediaTrackConstraints = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

async function openIphoneMic(log: (s: string) => void): Promise<MediaStream> {
  const first = await navigator.mediaDevices.getUserMedia(micConstraints());
  await sleep(450);
  const firstLabel = first.getAudioTracks()[0]?.label || 'iPhone microphone';
  if (!isAirPods(firstLabel)) return first;

  first.getTracks().forEach((track) => track.stop());
  log('AirPods selected as input. Retrying iPhone mic...');
  const devices = await navigator.mediaDevices.enumerateDevices();
  const candidates = devices.filter((d) => d.kind === 'audioinput' && !isAirPods(d.label));

  for (const d of candidates) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(micConstraints(d.deviceId));
      await sleep(450);
      const label = stream.getAudioTracks()[0]?.label || d.label || 'iPhone microphone';
      if (!isAirPods(label)) return stream;
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      // try next
    }
  }
  throw new Error('Chrome is using AirPods as microphone. Disconnect AirPods, tap Start, then reconnect AirPods as output.');
}

function setupMessage() {
  return { config: { model: MODEL, responseModalities: ['AUDIO'], systemInstruction: { parts: [{ text: 'Translate Hebrew speech into natural spoken Russian only. Do not answer. Do not explain.' }] }, inputAudioTranscription: {}, outputAudioTranscription: {} } };
}

function audioMessage(base64: string) {
  return { realtimeInput: { audio: { mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`, data: base64 } } };
}

export default function AppV3() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [micName, setMicName] = useState('not started');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [log, setLog] = useState<string[]>([]);

  const ctxRef = useRef<AudioContext | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const playAtRef = useRef(0);
  const outputsRef = useRef<AudioBufferSourceNode[]>([]);
  const runningRef = useRef(false);
  const readyRef = useRef(false);
  const lastVoiceRef = useRef(0);
  const sentSinceEndRef = useRef(false);
  const endTimerRef = useRef<number | null>(null);
  const sentRef = useRef(0);
  const gotAudioRef = useRef(0);

  const addLog = (text: string) => setLog((items) => [`${new Date().toLocaleTimeString()} - ${text}`, ...items].slice(0, 12));

  function clearEndTimer() {
    if (endTimerRef.current !== null) window.clearTimeout(endTimerRef.current);
    endTimerRef.current = null;
  }

  function phraseEndSoon() {
    clearEndTimer();
    endTimerRef.current = window.setTimeout(() => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN && sentSinceEndRef.current) {
        ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        sentSinceEndRef.current = false;
      }
    }, END_MS);
  }

  function stopOutput() {
    for (const node of outputsRef.current) { try { node.stop(); } catch {} }
    outputsRef.current = [];
    playAtRef.current = ctxRef.current?.currentTime || 0;
  }

  function playPcm(base64: string, mimeType?: string) {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const floats = int16ToFloat32(base64ToInt16Array(base64));
    const buffer = ctx.createBuffer(1, floats.length, parseSampleRateFromMimeType(mimeType));
    buffer.copyToChannel(floats, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, playAtRef.current);
    src.start(startAt);
    playAtRef.current = startAt + buffer.duration;
    outputsRef.current.push(src);
    src.onended = () => { outputsRef.current = outputsRef.current.filter((node) => node !== src); };
  }

  async function onMessage(event: MessageEvent) {
    let msg: Msg;
    try { msg = JSON.parse(await asText(event.data)); } catch (e) { addLog(`Bad Gemini message: ${e instanceof Error ? e.message : String(e)}`); return; }
    if (msg.setupComplete) { readyRef.current = true; addLog('Gemini ready.'); }
    if (msg.error?.message) { setError(msg.error.message); setStatus('error'); addLog(`Gemini error: ${msg.error.message}`); }
    const content = msg.serverContent;
    if (!content) return;
    if (content.interrupted) stopOutput();
    if (content.inputTranscription?.text) setInput(content.inputTranscription.text);
    if (content.outputTranscription?.text) setOutput(content.outputTranscription.text);
    for (const part of content.modelTurn?.parts || []) {
      if (part.text) setOutput(part.text);
      const audio = part.inlineData || part.inline_data;
      if (audio?.data) {
        gotAudioRef.current += 1;
        if (gotAudioRef.current === 1) addLog('Translation audio received.');
        playPcm(audio.data, audio.mimeType);
      }
    }
  }

  async function attachMic(stream: MediaStream) {
    const ctx = ctxRef.current || audioContext();
    ctxRef.current = ctx;
    await ctx.resume();
    await ctx.audioWorklet.addModule('/mic-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, 'mic-processor');
    const mute = ctx.createGain();
    mute.gain.value = 0;

    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const samples = event.data;
      const current = micLevel(samples);
      setLevel(current);
      if (!runningRef.current || !readyRef.current) return;
      const now = performance.now();
      if (current >= GATE) lastVoiceRef.current = now;
      if (now - lastVoiceRef.current > HANGOVER_MS) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !ctxRef.current) return;
      const down = downsampleBuffer(boost(samples), ctxRef.current.sampleRate, INPUT_SAMPLE_RATE);
      const pcm = floatTo16BitPCM(down);
      ws.send(JSON.stringify(audioMessage(arrayBufferToBase64(pcm.buffer))));
      sentSinceEndRef.current = true;
      sentRef.current += 1;
      phraseEndSoon();
      if (sentRef.current === 1 || sentRef.current % 100 === 0) addLog(`Audio sent: ${sentRef.current}.`);
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
      setLevel(0);
      sentRef.current = 0;
      gotAudioRef.current = 0;
      readyRef.current = false;
      sentSinceEndRef.current = false;
      const stream = await openIphoneMic(addLog);
      streamRef.current = stream;
      setMicName(stream.getAudioTracks()[0]?.label || 'iPhone microphone');
      await attachMic(stream);
      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      ws.onopen = () => { ws.send(JSON.stringify(setupMessage())); runningRef.current = true; lastVoiceRef.current = performance.now(); setStatus('listening'); addLog('Connected. Speak Hebrew.'); };
      ws.onmessage = (event) => { void onMessage(event); };
      ws.onerror = () => { setError('WebSocket error.'); setStatus('error'); addLog('WebSocket error.'); };
      ws.onclose = (event) => { if (event.code !== 1000) setStatus('error'); addLog(`WebSocket closed ${event.code || ''} ${event.reason || ''}`.trim()); };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setStatus('error');
      addLog(message);
    }
  }

  async function stop(reset = true) {
    runningRef.current = false;
    readyRef.current = false;
    clearEndTimer();
    try { workletRef.current?.disconnect(); sourceRef.current?.disconnect(); } catch {}
    streamRef.current?.getTracks().forEach((track) => track.stop());
    try { wsRef.current?.close(1000, 'stop'); } catch {}
    stopOutput();
    wsRef.current = null;
    streamRef.current = null;
    sourceRef.current = null;
    workletRef.current = null;
    setMicName('not started');
    setLevel(0);
    if (reset) { setStatus('idle'); addLog('Stopped.'); }
  }

  return <main className="app-shell">
    <section className="hero-card"><div className="eyebrow">V3 Chrome live translator</div><h1>Hebrew to Russian live translator</h1><p className="subtitle">One button. Opens iPhone mic, connects to Gemini, and translates until Stop.</p>{error && <div className="error">{error}</div>}<div className="controls"><button className="primary" disabled={status === 'connecting' || status === 'listening'} onClick={() => void start()}>Start</button><button className="secondary" onClick={() => void stop()}>Stop</button></div><div className={`status-pill ${status}`}><span />{status}</div></section>
    <section className="grid"><div className="panel"><h2>Microphone</h2><p>Active: {micName}</p><div className="meter"><div style={{ width: `${level}%` }} /></div><p>Mic level: {level}%</p></div><div className="panel"><h2>Russian translation</h2><p>{output || 'Russian voice and text will appear here.'}</p></div></section>
    <section className="grid"><div className="panel"><h2>Hebrew input</h2><p>{input || 'Hebrew transcript will appear here.'}</p></div><div className="panel"><h2>Log</h2>{log.length ? <ul>{log.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>Log is empty.</p>}</div></section>
  </main>;
}
