import { useRef, useState } from 'react';
import { INPUT_SAMPLE_RATE, arrayBufferToBase64, base64ToInt16Array, downsampleBuffer, floatTo16BitPCM, int16ToFloat32, parseSampleRateFromMimeType } from './audio';

type Status = 'idle' | 'testing' | 'connecting' | 'listening' | 'error';
type DeviceOption = { deviceId: string; label: string };
type Part = { inlineData?: { mimeType?: string; data?: string }; text?: string };
type Msg = { setupComplete?: object; serverContent?: { interrupted?: boolean; inputTranscription?: { text?: string }; outputTranscription?: { text?: string }; modelTurn?: { parts?: Part[] } }; error?: { message?: string } };

declare global { interface Window { webkitAudioContext?: typeof AudioContext } }

const WS_URL = import.meta.env.VITE_WS_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const MODEL = 'models/gemini-3.1-flash-live-preview';
const MIC_GAIN = 8;
const METER_SCALE = 1800;
const VOICE_GATE = 6;
const SILENCE_MS = 1200;

function audioContext() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) throw new Error('AudioContext is not available.');
  return new Ctor({ latencyHint: 'interactive' });
}

function isAirPods(label?: string) { return (label || '').toLowerCase().includes('airpods'); }
function levelOf(samples: Float32Array) { let sum = 0; for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]; return Math.min(100, Math.round(Math.sqrt(sum / Math.max(1, samples.length)) * METER_SCALE)); }
function boosted(samples: Float32Array) { const out = new Float32Array(samples.length); for (let i = 0; i < samples.length; i += 1) out[i] = Math.max(-1, Math.min(1, samples[i] * MIC_GAIN)); return out; }
function configMessage() { return { config: { model: MODEL, responseModalities: ['AUDIO'], systemInstruction: { parts: [{ text: 'You are a simultaneous interpreter. Translate Hebrew speech into natural spoken Russian only. Do not answer. Do not explain. Keep output short and immediate.' }] }, inputAudioTranscription: {}, outputAudioTranscription: {} } }; }

export default function ChromeCleanApp() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [activeMic, setActiveMic] = useState('not started');
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [inputText, setInputText] = useState('');
  const [outputText, setOutputText] = useState('');
  const [log, setLog] = useState<string[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const playAtRef = useRef(0);
  const outRef = useRef<AudioBufferSourceNode[]>([]);
  const readyRef = useRef(false);
  const lastVoiceAtRef = useRef(0);

  const addLog = (text: string) => setLog((items) => [`${new Date().toLocaleTimeString()} - ${text}`, ...items].slice(0, 12));

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) throw new Error('MediaDevices are not available. Use Chrome over HTTPS.');
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = all.filter((d) => d.kind === 'audioinput' && !isAirPods(d.label)).map((d, i) => ({ deviceId: d.deviceId, label: d.label || `iPhone microphone ${i + 1}` }));
    setDevices(inputs);
    if ((!selectedDeviceId || !inputs.some((d) => d.deviceId === selectedDeviceId)) && inputs[0]) setSelectedDeviceId(inputs[0].deviceId);
    addLog(`Mic inputs: ${inputs.length} non-AirPods device(s).`);
    return inputs;
  }

  async function getMicStream() {
    let id = selectedDeviceId;
    if (!id) id = (await refreshDevices())[0]?.deviceId || '';
    const audio: MediaTrackConstraints = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (id) audio.deviceId = { exact: id };
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    const label = stream.getAudioTracks()[0]?.label ||'iPhone microphone';
    if (isAirPods(label)) { stream.getTracks().forEach((t) => t.stop()); throw new Error('Browser returned AirPods as microphone. Choose iPhone microphone or start mic before choosing AirPods as output.'); }
    setActiveMic(label);
    return stream;
  }

  function stopOutput() { for (const n of outRef.current) { try { n.stop(); } catch {} } outRef.current = []; playAtRef.current = ctxRef.current?.currentTime || 0; }
  function playPcm(base64: string, mimeType?: string) { const ctx = ctxRef.current; if (!ctx) return; const floats = int16ToFloat32(base64ToInt16Array(base64)); const buffer = ctx.createBuffer(1, floats.length, parseSampleRateFromMimeType(mimeType)); buffer.copyToChannel(floats, 0); const src = ctx.createBufferSource(); src.buffer = buffer; src.connect(ctx.destination); const startAt = Math.max(ctx.currentTime + 0.02, playAtRef.current); src.start(startAt); playAtRef.current = startAt + buffer.duration; outRef.current.push(src); src.onended = () => { outRef.current = outRef.current.filter((n) => n !== src); }; }

  function onGeminiMessage(event: MessageEvent) {
    let msg: Msg;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (msg.setupComplete) { readyRef.current = true; addLog('Gemini ready.'); }
    if (msg.error?.message) { setError(msg.error.message); setStatus('error'); addLog(`Gemini error: ${msg.error.message}`); }
    const content = msg.serverContent;
    if (!content) return;
    if (content.interrupted) stopOutput();
    if (content.inputTranscription?.text) setInputText(content.inputTranscription.text);
    if (content.outputTranscription?.text) setOutputText(content.outputTranscription.text);
    for (const part of content.modelTurn?.parts || []) { if (part.text) setOutputText(part.text); if (part.inlineData?.data) playPcm(part.inlineData.data, part.inlineData.mimeType); }
  }

  async function openMic(sendToGemini: boolean) {
    const ctx = ctxRef.current || audioContext(); ctxRef.current = ctx; await ctx.resume();
    const stream = await getMicStream(); streamRef.current = stream;
    await ctx.audioWorklet.addModule('/mic-worklet.js');
    const source = ctx.createMediaStreamSource(stream); const worklet = new AudioWorkletNode(ctx, 'mic-processor'); const muted = ctx.createGain(); muted.gain.value = 0;
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => { const samples = event.data; const current = levelOf(samples); setLevel(current); if (!sendToGemini) return; const now = performance.now(); if (current >= VOICE_GATE) lastVoiceAtRef.current = now; if (now - lastVoiceAtRef.current > SILENCE_MS) return; const ws = wsRef.current; const activeCtx = ctxRef.current; if (!readyRef.current || !ws || ws.readyState !== WebSocket.OPEN || !activeCtx) return; const down = downsampleBuffer(boosted(samples), activeCtx.sampleRate, INPUT_SAMPLE_RATE); const pcm = floatTo16BitPCM(down); ws.send(JSON.stringify({ realtimeInput: { audio: { data: arrayBufferToBase64(pcm.buffer as ArrayBuffer), mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` } } })); };
    source.connect(worklet); worklet.connect(muted); muted.connect(ctx.destination); sourceRef.current = source; workletRef.current = worklet; addLog(`Mic active: ${stream.getAudioTracks()[0]?.label ||'iPhone microphone'}.`);
  }

  async function stop(reset = true) { readyRef.current = false; try { workletRef.current?.disconnect(); sourceRef.current?.disconnect(); } catch {} streamRef.current?.getTracks().forEach((t) => t.stop()); try { wsRef.current?.close(1000, 'stop'); } catch {} stopOutput(); wsRef.current = null; streamRef.current = null; sourceRef.current = null; workletRef.current = null; setLevel(0); setActiveMic('not started'); if (reset) { setStatus('idle'); addLog('Stopped.'); } }
  async function testMic() { try { await stop(false); setStatus('testing'); setError(''); await refreshDevices(); await openMic(false); addLog('Mic test is running.'); } catch (e) { const m = e instanceof Error ? e.message : String(e); setError(m); setStatus('error'); addLog(m); } }
  async function testSpeaker() { try { const ctx = ctxRef.current || audioContext(); ctxRef.current = ctx; await ctx.resume(); const osc = ctx.createOscillator(); const gain = ctx.createGain(); osc.frequency.value = 880; gain.gain.value = 0.08; osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.35); addLog('Speaker test played.'); } catch (e) { const m = e instanceof Error ? e.message : String(e); setError(m); setStatus('error'); addLog(m); } }
  async function startListening() { try { await stop(false); setStatus('connecting'); setError(''); setInputText(''); setOutputText(''); setLevel(0); readyRef.current = false; await refreshDevices(); await openMic(true); const ws = new WebSocket(WS_URL); wsRef.current = ws; ws.onopen = () => { ws.send(JSON.stringify(configMessage())); addLog('WebSocket open. Config sent.'); }; ws.onmessage = onGeminiMessage; ws.onerror = () => { setStatus('error'); setError('WebSocket error. Check /debug, API key, and Live API access.'); addLog('WebSocket error.'); }; ws.onclose = (e) => { addLog(`WebSocket closed ${e.code || ''} ${e.reason || ''}`.trim()); if (e.code !== 1000) setStatus('error'); }; window.setTimeout(() => { if (!readyRef.current && ws.readyState === WebSocket.OPEN) addLog('Waiting for Gemini setupComplete...'); }, 10000); setStatus('listening'); } catch (e) { const m = e instanceof Error ? e.message : String(e); setError(m); setStatus('error'); addLog(m); } }

  return <main className="app-shell"><section className="hero-card"><div className="eyebrow">Chrome first live translator</div><h1>Hebrew to Russian live audio translator</h1><p className="subtitle">Use Chrome on iPhone. Input is iPhone microphone. Output is whatever iOS sends audio to, usually AirPods from Control Center.</p>{error && <div className="error">{error}</div>}<div className="controls"><button className="primary" disabled={status === 'connecting' || status === 'listening'} onClick={() => void startListening()}>Start listening</button><button className="secondary" onClick={() => void stop()}>Stop</button><button className="secondary" onClick={() => void refreshDevices()}>Refresh mic</button><button className="secondary" onClick={() => void testMic()}>Test mic</button><button className="secondary" onClick={() => void testSpeaker()}>Test speaker</button></div><div className={`status-pill ${status}`}><span />{status}</div></section><section className="grid"><div className="panel"><h2>Microphone</h2><select value={selectedDeviceId} onChange={(e) => setSelectedDeviceId(e.target.value)} disabled={status === 'listening'}>{devices.length === 0 && <option value="">iPhone microphone only</option>}{devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}</select><p>Active: {activeMic}</p><div className="meter"><div style={{ width: `${level}%` }} /></div><p>Mic level: {level}%</p></div><div className="panel"><h2>Voice gate</h2><p>Audio is sent only when Mic level is above {VOICE_GATE}%.</p></div></section><section className="grid"><div className="panel"><h2>Input speech</h2><p>{inputText || 'Gemini input transcript will appear here.'}</p></div><div className="panel"><h2>Russian translation</h2><p>{outputText || 'Russian voice should play in AirPods.'}</p></div></section><section className="panel log-panel"><h2>Log</h2>{log.length ? <ul>{log.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p>Log is empty.</p>}</section></main>;
}
