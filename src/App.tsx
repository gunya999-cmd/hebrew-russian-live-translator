import { useMemo, useRef, useState } from 'react';
import { INPUT_SAMPLE_RATE, arrayBufferToBase64, base64ToInt16Array, downsampleBuffer, floatTo16BitPCM, int16ToFloat32, parseSampleRateFromMimeType } from './audio';

type Status = 'idle' | 'connecting' | 'listening' | 'stopping' | 'error';
type GeminiPart = { inlineData?: { mimeType?: string; data?: string }; text?: string };
type GeminiServerMessage = { setupComplete?: object; serverContent?: { interrupted?: boolean; inputTranscription?: { text?: string }; outputTranscription?: { text?: string }; modelTurn?: { parts?: GeminiPart[] } }; goAway?: object };

const WS_URL = import.meta.env.VITE_WS_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

function setupMessage() {
  return {
    setup: {
      model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
      generationConfig: {
        responseModalities: ['AUDIO'],
        temperature: 0.2,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
      },
      systemInstruction: {
        parts: [{ text: 'You are a professional simultaneous interpreter. The incoming speech is usually Hebrew. Translate only into natural spoken Russian. Do not answer the speaker. Do not add explanations. Keep the translation short, like a live interpreter in an earpiece.' }]
      },
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
          prefixPaddingMs: 100,
          silenceDurationMs: 650
        },
        activityHandling: 'NO_INTERRUPTION',
        turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY'
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    }
  };
}

export default function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [inputText, setInputText] = useState('');
  const [outputText, setOutputText] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const micRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playAtRef = useRef(0);
  const outRef = useRef<AudioBufferSourceNode[]>([]);
  const startedRef = useRef(false);

  const subtitle = useMemo(() => status === 'idle' ? 'Put on AirPods, place the iPhone near the speaker, then press start.' : status === 'listening' ? 'Listening to Hebrew and sending Russian voice translation to the iPhone audio output.' : status === 'connecting' ? 'Connecting to Cloudflare Worker and Gemini Live API...' : status === 'stopping' ? 'Stopping microphone...' : 'Startup error.', [status]);
  const addLog = (text: string) => setLog((items) => [`${new Date().toLocaleTimeString('ru-RU')} - ${text}`, ...items].slice(0, 8));

  function stopOutput() {
    for (const node of outRef.current) { try { node.stop(); } catch {} }
    outRef.current = [];
    playAtRef.current = ctxRef.current?.currentTime ?? 0;
  }

  function playPcm(base64: string, mimeType?: string) {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const floats = int16ToFloat32(base64ToInt16Array(base64));
    const buffer = ctx.createBuffer(1, floats.length, parseSampleRateFromMimeType(mimeType));
    buffer.copyToChannel(floats, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(playAtRef.current, ctx.currentTime + 0.02);
    source.start(startAt);
    playAtRef.current = startAt + buffer.duration;
    outRef.current.push(source);
    source.onended = () => { outRef.current = outRef.current.filter((item) => item !== source); };
  }

  async function startMic() {
    if (startedRef.current) return;
    startedRef.current = true;
    const ctx = ctxRef.current;
    const ws = wsRef.current;
    if (!ctx || !ws || ws.readyState !== WebSocket.OPEN) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    streamRef.current = stream;
    await ctx.audioWorklet.addModule('/mic-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    const mic = new AudioWorkletNode(ctx, 'mic-processor');
    const muted = ctx.createGain();
    muted.gain.value = 0;
    mic.port.onmessage = (event: MessageEvent<Float32Array<ArrayBufferLike>>) => {
      const socket = wsRef.current;
      const audioCtx = ctxRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN || !audioCtx) return;
      const downsampled = downsampleBuffer(event.data, audioCtx.sampleRate, INPUT_SAMPLE_RATE);
      const pcm16 = floatTo16BitPCM(downsampled);
      socket.send(JSON.stringify({ realtimeInput: { audio: { mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`, data: arrayBufferToBase64(pcm16.buffer as ArrayBuffer) } } }));
    };
    source.connect(mic);
    mic.connect(muted);
    muted.connect(ctx.destination);
    sourceRef.current = source;
    micRef.current = mic;
    setStatus('listening');
    addLog('Microphone enabled.');
  }

  function onMessage(raw: MessageEvent) {
    let data: GeminiServerMessage;
    try { data = JSON.parse(String(raw.data)); } catch { return; }
    if (data.setupComplete) { addLog('Gemini setup complete.'); void startMic(); return; }
    const content = data.serverContent;
    if (!content) return;
    if (content.interrupted) stopOutput();
    if (content.inputTranscription?.text) setInputText(content.inputTranscription.text);
    if (content.outputTranscription?.text) setOutputText(content.outputTranscription.text);
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) playPcm(part.inlineData.data, part.inlineData.mimeType);
      if (part.text) setOutputText(part.text);
    }
  }

  async function start() {
    setError(''); setInputText(''); setOutputText(''); setStatus('connecting'); startedRef.current = false; addLog('Session started.');
    try {
      const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioContextCtor({ latencyHint: 'interactive' });
      ctxRef.current = ctx;
      await ctx.resume();
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify(setupMessage()));
      ws.onmessage = onMessage;
      ws.onerror = () => { setStatus('error'); setError('WebSocket error. Check Cloudflare Worker, GEMINI_API_KEY, and Gemini Live model access.'); };
      ws.onclose = (event) => { if (status !== 'stopping') addLog(`WebSocket closed ${event.code || ''} ${event.reason || ''}`.trim()); };
    } catch (e) { setStatus('error'); setError(e instanceof Error ? e.message : 'Could not start translator.'); }
  }

  async function stop() {
    setStatus('stopping'); addLog('Stopping.');
    stopOutput();
    try { micRef.current?.disconnect(); sourceRef.current?.disconnect(); } catch {}
    streamRef.current?.getTracks().forEach((t) => t.stop());
    wsRef.current?.close();
    await ctxRef.current?.close();
    wsRef.current = null; streamRef.current = null; ctxRef.current = null; micRef.current = null; sourceRef.current = null; playAtRef.current = 0; startedRef.current = false;
    setStatus('idle');
  }

  return <main className="app-shell"><section className="hero-card"><div className="eyebrow">Hebrew -> Russian · Live Audio</div><h1>Hebrew to Russian voice translation in your headphones</h1><p className="subtitle">{subtitle}</p>{error && <div className="error">{error}</div>}<div className="controls"><button className="primary" disabled={status !== 'idle' && status !== 'error'} onClick={start}>Start translation</button><button className="secondary" disabled={status === 'idle' || status === 'stopping'} onClick={() => void stop()}>Stop</button></div><div className={`status-pill ${status}`}><span />{status}</div></section><section className="grid"><div className="panel"><h2>Input speech</h2><p>{inputText || 'Input transcript will appear here.'}</p></div><div className="panel"><h2>Russian translation</h2><p>{outputText || 'The main result is played as voice in your headphones.'}</p></div></section><section className="panel log-panel"><h2>Log</h2>{log.length ? <ul>{log.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p>Log is empty.</p>}</section></main>;
}
