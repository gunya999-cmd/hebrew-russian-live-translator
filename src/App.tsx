import { useMemo, useRef, useState } from 'react';
import { INPUT_SAMPLE_RATE, arrayBufferToBase64, base64ToInt16Array, downsampleBuffer, floatTo16BitPCM, int16ToFloat32, parseSampleRateFromMimeType } from './audio';

type Status = 'idle' | 'connecting' | 'listening' | 'stopping' | 'error';
type GeminiPart = { inlineData?: { mimeType?: string; data?: string }; text?: string };
type GeminiServerMessage = { setupComplete?: object; serverContent?: { interrupted?: boolean; inputTranscription?: { text?: string }; outputTranscription?: { text?: string }; modelTurn?: { parts?: GeminiPart[] } }; goAway?: object };
type DeviceOption = { deviceId: string; label: string };

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

function getAudioContextCtor(): typeof AudioContext {
  return window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
}

function rmsLevel(samples: Float32Array<ArrayBufferLike>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.min(100, Math.round(Math.sqrt(sum / Math.max(1, samples.length)) * 240));
}

export default function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [inputText, setInputText] = useState('');
  const [outputText, setOutputText] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [audioInputs, setAudioInputs] = useState<DeviceOption[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<DeviceOption[]>([]);
  const [selectedInputId, setSelectedInputId] = useState('');
  const [activeMicLabel, setActiveMicLabel] = useState('not started');
  const [micLevel, setMicLevel] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const micRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playAtRef = useRef(0);
  const outRef = useRef<AudioBufferSourceNode[]>([]);
  const startedRef = useRef(false);
  const lastLevelUpdateRef = useRef(0);
  const testStreamRef = useRef<MediaStream | null>(null);
  const testCtxRef = useRef<AudioContext | null>(null);
  const testRafRef = useRef<number | null>(null);

  const subtitle = useMemo(() => status === 'idle' ? 'Put on AirPods, place the iPhone near the speaker, then press start.' : status === 'listening' ? 'Listening to Hebrew and sending Russian voice translation to the iPhone audio output.' : status === 'connecting' ? 'Connecting to Cloudflare Worker and Gemini Live API...' : status === 'stopping' ? 'Stopping microphone...' : 'Startup error.', [status]);
  const addLog = (text: string) => setLog((items) => [`${new Date().toLocaleTimeString('ru-RU')} - ${text}`, ...items].slice(0, 12));

  async function refreshDevices() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) {
        addLog('Device enumeration is not supported by this browser.');
        return;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === 'audioinput').map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` }));
      const outputs = devices.filter((device) => device.kind === 'audiooutput').map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Speaker ${index + 1}` }));
      setAudioInputs(inputs);
      setAudioOutputs(outputs);
      addLog(`Devices found: ${inputs.length} mic input(s), ${outputs.length} audio output(s).`);
    } catch (error) {
      addLog(`Device refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function playTestTone() {
    try {
      const ctx = new (getAudioContextCtor())({ latencyHint: 'interactive' });
      await ctx.resume();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.frequency.value = 880;
      gain.gain.value = 0.08;
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.35);
      oscillator.onended = () => void ctx.close();
      addLog('Speaker test tone played. Check iPhone audio output / AirPods.');
    } catch (error) {
      addLog(`Speaker test failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function stopMicTest() {
    if (testRafRef.current !== null) cancelAnimationFrame(testRafRef.current);
    testRafRef.current = null;
    testStreamRef.current?.getTracks().forEach((track) => track.stop());
    testStreamRef.current = null;
    void testCtxRef.current?.close();
    testCtxRef.current = null;
    setMicLevel(0);
    setActiveMicLabel('not started');
  }

  async function testMicrophone() {
    try {
      stopMicTest();
      const audioConstraints: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      };
      if (selectedInputId) audioConstraints.deviceId = { exact: selectedInputId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      testStreamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      setActiveMicLabel(track?.label || 'default microphone');
      addLog(`Mic test track: ${track?.label || 'default microphone'}`);
      await refreshDevices();

      const ctx = new (getAudioContextCtor())({ latencyHint: 'interactive' });
      testCtxRef.current = ctx;
      await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(samples);
        setMicLevel(rmsLevel(samples));
        testRafRef.current = requestAnimationFrame(tick);
      };
      tick();
      addLog('Standalone microphone test is running. Speak near iPhone and watch Mic level.');
    } catch (error) {
      setStatus('error');
      setError(error instanceof Error ? error.message : 'Standalone microphone test failed.');
      addLog(`Standalone microphone test failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

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
    stopMicTest();
    const ctx = ctxRef.current;
    const ws = wsRef.current;
    if (!ctx || !ws || ws.readyState !== WebSocket.OPEN) return;

    try {
      const audioConstraints: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      };
      if (selectedInputId) audioConstraints.deviceId = { exact: selectedInputId };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      setActiveMicLabel(track?.label || 'default microphone');
      addLog(`Microphone track: ${track?.label || 'default microphone'}`);
      await refreshDevices();

      await ctx.audioWorklet.addModule('/mic-worklet.js');
      const source = ctx.createMediaStreamSource(stream);
      const mic = new AudioWorkletNode(ctx, 'mic-processor');
      const muted = ctx.createGain();
      muted.gain.value = 0;

      mic.port.onmessage = (event: MessageEvent<Float32Array<ArrayBufferLike>>) => {
        const socket = wsRef.current;
        const audioCtx = ctxRef.current;
        const now = performance.now();
        if (now - lastLevelUpdateRef.current > 120) {
          lastLevelUpdateRef.current = now;
          setMicLevel(rmsLevel(event.data));
        }
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
      addLog('Microphone enabled. Speak Hebrew and watch Mic level.');
    } catch (error) {
      startedRef.current = false;
      setStatus('error');
      setError(error instanceof Error ? error.message : 'Microphone start failed.');
      addLog(`Microphone start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    setError(''); setInputText(''); setOutputText(''); setStatus('connecting'); startedRef.current = false; setMicLevel(0); addLog('Session started.');
    try {
      stopMicTest();
      const ctx = new (getAudioContextCtor())({ latencyHint: 'interactive' });
      ctxRef.current = ctx;
      await ctx.resume();
      await refreshDevices();
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => { addLog('WebSocket open. Sending Gemini setup.'); ws.send(JSON.stringify(setupMessage())); };
      ws.onmessage = onMessage;
      ws.onerror = () => { setStatus('error'); setError('WebSocket error. Check Cloudflare Worker, GEMINI_API_KEY, and Gemini Live model access.'); };
      ws.onclose = (event) => { if (status !== 'stopping') addLog(`WebSocket closed ${event.code || ''} ${event.reason || ''}`.trim()); };
    } catch (e) { setStatus('error'); setError(e instanceof Error ? e.message : 'Could not start translator.'); }
  }

  async function stop() {
    setStatus('stopping'); addLog('Stopping.');
    stopMicTest();
    stopOutput();
    try { micRef.current?.disconnect(); sourceRef.current?.disconnect(); } catch {}
    streamRef.current?.getTracks().forEach((t) => t.stop());
    wsRef.current?.close();
    await ctxRef.current?.close();
    wsRef.current = null; streamRef.current = null; ctxRef.current = null; micRef.current = null; sourceRef.current = null; playAtRef.current = 0; startedRef.current = false; setMicLevel(0); setActiveMicLabel('not started');
    setStatus('idle');
  }

  return <main className="app-shell">
    <section className="hero-card">
      <div className="eyebrow">Hebrew to Russian - Live Audio</div>
      <h1>Hebrew to Russian voice translation in your headphones</h1>
      <p className="subtitle">{subtitle}</p>
      {error && <div className="error">{error}</div>}
      <div className="controls">
        <button className="primary" disabled={status !== 'idle' && status !== 'error'} onClick={start}>Start translation</button>
        <button className="secondary" disabled={status === 'idle' || status === 'stopping'} onClick={() => void stop()}>Stop</button>
        <button className="secondary" onClick={() => void refreshDevices()}>Refresh devices</button>
        <button className="secondary" onClick={() => void testMicrophone()}>Test microphone</button>
        <button className="secondary" onClick={stopMicTest}>Stop mic test</button>
        <button className="secondary" onClick={() => void playTestTone()}>Test speaker</button>
      </div>
      <div className={`status-pill ${status}`}><span />{status}</div>
    </section>

    <section className="grid">
      <div className="panel">
        <h2>Microphone</h2>
        <label className="field-label" htmlFor="mic-select">Input device</label>
        <select id="mic-select" value={selectedInputId} onChange={(event) => setSelectedInputId(event.target.value)} disabled={status === 'listening'}>
          <option value="">Default microphone</option>
          {audioInputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
        </select>
        <p>Active mic: {activeMicLabel}</p>
        <div className="meter"><div style={{ width: `${micLevel}%` }} /></div>
        <p>Mic level: {micLevel}%</p>
      </div>
      <div className="panel">
        <h2>Headphones / speaker</h2>
        <p>Audio output is controlled by iPhone / browser. Use iOS Control Center to choose AirPods before pressing Start.</p>
        <p>Detected outputs: {audioOutputs.length || 'browser does not expose outputs'}</p>
      </div>
    </section>

    <section className="grid">
      <div className="panel"><h2>Input speech</h2><p>{inputText || 'Input transcript will appear here.'}</p></div>
      <div className="panel"><h2>Russian translation</h2><p>{outputText || 'The main result is played as voice in your headphones.'}</p></div>
    </section>

    <section className="panel log-panel"><h2>Log</h2>{log.length ? <ul>{log.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p>Log is empty.</p>}</section>
  </main>;
}
