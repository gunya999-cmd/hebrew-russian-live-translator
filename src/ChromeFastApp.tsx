import { useRef, useState } from 'react';
import { INPUT_SAMPLE_RATE, arrayBufferToBase64, base64ToInt16Array, downsampleBuffer, floatTo16BitPCM, int16ToFloat32, parseSampleRateFromMimeType } from './audio';

type Status = 'idle' | 'testing' | 'connecting' | 'listening' | 'error';
type Part = { inlineData?: { mimeType?: string; data?: string }; text?: string };
type LiveMessage = { setupComplete?: object; serverContent?: { interrupted?: boolean; inputTranscription?: { text?: string }; outputTranscription?: { text?: string }; modelTurn?: { parts?: Part[] } }; error?: { message?: string } };

declare global { interface Window { webkitAudioContext?: typeof AudioContext } }

const WS_URL = import.meta.env.VITE_WS_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const MODEL = 'models/gemini-3.1-flash-live-preview';
const MIC_GAIN = 8;
const LEVEL_SCALE = 1800;
const VOICE_GATE = 6;
const SILENCE_MS = 1200;

function makeAudioContext(): AudioContext {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) throw new Error('AudioContext is not available.');
  return new Ctor({ latencyHint: 'interactive' });
}

async function messageToText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  const maybeBlob = data as { text?: () => Promise<string>; arrayBuffer?: () => Promise<ArrayBuffer> };
  if (maybeBlob && typeof maybeBlob.text === 'function') return maybeBlob.text();
  if (maybeBlob && typeof maybeBlob.arrayBuffer === 'function') return new TextDecoder().decode(await maybeBlob.arrayBuffer());
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer);
  return String(data);
}

function micLevel(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.min(100, Math.round(Math.sqrt(sum / Math.max(1, samples.length)) * LEVEL_SCALE));
}

function boosted(samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = Math.max(-1, Math.min(1, samples[i] * MIC_GAIN));
  return out;
}

function isAirPods(label?: string): boolean {
  return (label || '').toLowerCase().includes('airpods');
}

function configMessage() {
  return {
    config: {
      model: MODEL,
      responseModalities: ['AUDIO'],
      systemInstruction: { parts: [{ text: 'Translate Hebrew speech into natural spoken Russian only. Do not answer questions. Do not add explanations.' }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    }
  };
}

export default function ChromeFastApp() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [activeMic, setActiveMic] = useState('not started');
  const [inputText, setInputText] = useState('');
  const [outputText, setOutputText] = useState('');
  const [log, setLog] = useState<string[]>([]);

  const ctxRef = useRef<AudioContext | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const playAtRef = useRef(0);
  const outputNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const audioEnabledRef = useRef(false);
  const sendAudioRef = useRef(false);
  const lastVoiceAtRef = useRef(0);
  const chunksRef = useRef(0);
  const inboundRef = useRef(0);
  const audioInRef = useRef(0);

  const addLog = (text: string) => setLog((items) => [`${new Date().toLocaleTimeString()} - ${text}`, ...items].slice(0, 16));

  function reusableIphoneMic(): boolean {
    const track = streamRef.current?.getAudioTracks()[0];
    return Boolean(track && track.readyState === 'live' && !isAirPods(track.label));
  }

  async function openMicStream(deviceId?: string): Promise<MediaStream> {
    const audio: MediaTrackConstraints = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (deviceId) audio.deviceId = { exact: deviceId };
    return navigator.mediaDevices.getUserMedia({ audio, video: false });
  }

  async function getIphoneMic(): Promise<MediaStream> {
    const first = await openMicStream();
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    const firstLabel = first.getAudioTracks()[0]?.label || 'iPhone microphone';
    if (!isAirPods(firstLabel)) {
      setActiveMic(firstLabel);
      return first;
    }

    first.getTracks().forEach((track) => track.stop());
    addLog('Chrome picked AirPods as mic. Searching for iPhone/non-AirPods input...');

    const devices = await navigator.mediaDevices.enumerateDevices();
    const candidates = devices.filter((device) => device.kind === 'audioinput' && !isAirPods(device.label));
    addLog(`Non-AirPods mic candidates: ${candidates.length}.`);

    for (const candidate of candidates) {
      try {
        const stream = await openMicStream(candidate.deviceId);
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const label = stream.getAudioTracks()[0]?.label || candidate.label || 'iPhone microphone';
        if (!isAirPods(label)) {
          setActiveMic(label);
          addLog(`Selected mic: ${label}.`);
          return stream;
        }
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        // Try next candidate.
      }
    }

    throw new Error('Chrome still selected AirPods as microphone. Disconnect AirPods, press Test mic first, then Start listening, then choose AirPods as output in Control Center.');
  }

  function stopOutput() {
    for (const node of outputNodesRef.current) { try { node.stop(); } catch {} }
    outputNodesRef.current = [];
    playAtRef.current = ctxRef.current?.currentTime || 0;
  }

  function playPcm(data: string, mimeType?: string) {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const floats = int16ToFloat32(base64ToInt16Array(data));
    const sampleRate = parseSampleRateFromMimeType(mimeType);
    const buffer = ctx.createBuffer(1, floats.length, sampleRate);
    buffer.copyToChannel(floats, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, playAtRef.current);
    src.start(startAt);
    playAtRef.current = startAt + buffer.duration;
    outputNodesRef.current.push(src);
    src.onended = () => { outputNodesRef.current = outputNodesRef.current.filter((node) => node !== src); };
    addLog(`Queued Gemini audio ${Math.round(buffer.duration * 1000)}ms.`);
  }

  async function onLiveMessage(event: MessageEvent) {
    inboundRef.current += 1;
    const raw = await messageToText(event.data);
    if (inboundRef.current === 1 || inboundRef.current % 10 === 0) addLog(`Gemini messages received: ${inboundRef.current}.`);

    let msg: LiveMessage;
    try { msg = JSON.parse(raw); } catch { addLog(`Unreadable Gemini message: ${raw.slice(0, 120)}`); return; }

    if (msg.setupComplete) addLog('Gemini setupComplete received.');
    if (msg.error?.message) { setError(msg.error.message); setStatus('error'); addLog(`Gemini error: ${msg.error.message}`); }

    const content = msg.serverContent;
    if (!content) return;

    if (content.interrupted) stopOutput();
    if (content.inputTranscription?.text) { setInputText(content.inputTranscription.text); addLog(`Input: ${content.inputTranscription.text.slice(0, 80)}`); }
    if (content.outputTranscription?.text) { setOutputText(content.outputTranscription.text); addLog(`Output: ${content.outputTranscription.text.slice(0, 80)}`); }

    for (const part of content.modelTurn?.parts || []) {
      if (part.text) { setOutputText(part.text); addLog(`Text part: ${part.text.slice(0, 80)}`); }
      if (part.inlineData?.data) { audioInRef.current += 1; addLog(`Gemini audio chunk received: ${audioInRef.current}.`); playPcm(part.inlineData.data, part.inlineData.mimeType); }
    }
  }

  async function openMic(sendAudio: boolean) {
    sendAudioRef.current = sendAudio;
    const ctx = ctxRef.current || makeAudioContext();
    ctxRef.current = ctx;
    await ctx.resume();
    const stream = await getIphoneMic();
    streamRef.current = stream;
    await ctx.audioWorklet.addModule('/mic-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, 'mic-processor');
    const mute = ctx.createGain();
    mute.gain.value = 0;

    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const samples = event.data;
      const current = micLevel(samples);
      setLevel(current);
      if (!sendAudioRef.current) return;
      const now = performance.now();
      if (current >= VOICE_GATE) lastVoiceAtRef.current = now;
      if (now - lastVoiceAtRef.current > SILENCE_MS) return;
      const ws = wsRef.current;
      const liveCtx = ctxRef.current;
      if (!audioEnabledRef.current || !ws || ws.readyState !== WebSocket.OPEN || !liveCtx) return;
      const down = downsampleBuffer(boosted(samples), liveCtx.sampleRate, INPUT_SAMPLE_RATE);
      const pcm = floatTo16BitPCM(down);
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: arrayBufferToBase64(pcm.buffer as ArrayBuffer), mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` } } }));
      chunksRef.current += 1;
      if (chunksRef.current === 1 || chunksRef.current % 50 === 0) addLog(`Audio chunks sent: ${chunksRef.current}.`);
    };

    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(ctx.destination);
    sourceRef.current = source;
    workletRef.current = worklet;
    addLog(`Mic active: ${stream.getAudioTracks()[0]?.label || 'iPhone microphone'}.`);
  }

  async function stop(reset = true) {
    audioEnabledRef.current = false;
    sendAudioRef.current = false;
    try { workletRef.current?.disconnect(); sourceRef.current?.disconnect(); } catch {}
    streamRef.current?.getTracks().forEach((track) => track.stop());
    try { wsRef.current?.close(1000, 'stop'); } catch {}
    stopOutput();
    wsRef.current = null;
    streamRef.current = null;
    sourceRef.current = null;
    workletRef.current = null;
    setLevel(0);
    setActiveMic('not started');
    if (reset) { setStatus('idle'); addLog('Stopped.'); }
  }

  async function testMic() {
    try { await stop(false); setStatus('testing'); setError(''); await openMic(false); addLog('Mic test is running. Press Start listening now to reuse this mic.'); }
    catch (err) { const message = err instanceof Error ? err.message : String(err); setError(message); setStatus('error'); addLog(message); }
  }

  async function testSpeaker() {
    try {
      const ctx = ctxRef.current || makeAudioContext();
      ctxRef.current = ctx;
      await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
      addLog('Speaker test played.');
    } catch (err) { const message = err instanceof Error ? err.message : String(err); setError(message); setStatus('error'); addLog(message); }
  }

  async function startListening() {
    try {
      const reuseMic = reusableIphoneMic();
      if (!reuseMic) await stop(false);
      else addLog('Reusing iPhone mic from Mic test.');

      setStatus('connecting');
      setError('');
      setInputText('');
      setOutputText('');
      setLevel(0);
      chunksRef.current = 0;
      inboundRef.current = 0;
      audioInRef.current = 0;

      if (!reuseMic) await openMic(true);
      else sendAudioRef.current = true;

      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify(configMessage()));
        audioEnabledRef.current = true;
        lastVoiceAtRef.current = performance.now();
        setStatus('listening');
        addLog('WebSocket open. Config sent. Audio gate enabled.');
        window.setTimeout(() => {
          if (wsRef.current === ws && chunksRef.current > 0 && inboundRef.current === 0) addLog(`No Gemini messages after ${chunksRef.current} audio chunks.`);
        }, 12000);
      };
      ws.onmessage = (event) => { void onLiveMessage(event); };
      ws.onerror = () => { setStatus('error'); setError('WebSocket error. Check /debug, API key, Live API access, or model access.'); addLog('WebSocket error.'); };
      ws.onclose = (event) => { addLog(`WebSocket closed ${event.code || ''} ${event.reason || ''}`.trim()); if (event.code !== 1000) setStatus('error'); };
    } catch (err) { const message = err instanceof Error ? err.message : String(err); setError(message); setStatus('error'); addLog(message); }
  }

  return <main className="app-shell">
    <section className="hero-card">
      <div className="eyebrow">Chrome first live translator</div>
      <h1>Hebrew to Russian live audio translator</h1>
      <p className="subtitle">Best flow with AirPods: Test mic first. If Active is iPhone mic, press Start listening. Russian audio should play through current iOS output.</p>
      {error && <div className="error">{error}</div>}
      <div className="controls">
        <button className="primary" disabled={status === 'connecting' || status === 'listening'} onClick={() => void startListening()}>Start listening</button>
        <button className="secondary" onClick={() => void stop()}>Stop</button>
        <button className="secondary" onClick={() => void testMic()}>Test mic</button>
        <button className="secondary" onClick={() => void testSpeaker()}>Test speaker</button>
      </div>
      <div className={`status-pill ${status}`}><span />{status}</div>
    </section>
    <section className="grid">
      <div className="panel"><h2>Microphone</h2><p>Active: {activeMic}</p><div className="meter"><div style={{ width: `${level}%` }} /></div><p>Mic level: {level}%</p></div>
      <div className="panel"><h2>Diagnostics</h2><p>Look for: Reusing iPhone mic, Audio chunks sent, Gemini messages received, Input, Output, Gemini audio chunk received.</p></div>
    </section>
    <section className="grid"><div className="panel"><h2>Input speech</h2><p>{inputText || 'Input transcript will appear here.'}</p></div><div className="panel"><h2>Russian translation</h2><p>{outputText || 'Russian translation will appear here.'}</p></div></section>
    <section className="panel log-panel"><h2>Log</h2>{log.length ? <ul>{log.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>Log is empty.</p>}</section>
  </main>;
}
