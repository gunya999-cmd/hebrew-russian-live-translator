export interface Env {
  GEMINI_API_KEY: string;
  ASSETS: Fetcher;
}

const GEMINI_WS_ENDPOINT = 'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const WORKER_VERSION = 'chrome-clean-6';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'hebrew-russian-live-translator', version: WORKER_VERSION });
    }

    if (url.pathname === '/debug') {
      return Response.json({ ok: true, version: WORKER_VERSION, hasGeminiKey: Boolean(env.GEMINI_API_KEY), geminiKeyLength: env.GEMINI_API_KEY ? env.GEMINI_API_KEY.length : 0 });
    }

    if (url.pathname === '/ws') return handleWebSocketProxy(request, env);
    return env.ASSETS.fetch(request);
  }
};

function normalizeClientMessage(data: string | ArrayBuffer): string | ArrayBuffer {
  if (typeof data !== 'string') return data;
  try {
    const message = JSON.parse(data) as Record<string, unknown>;
    const config = message.config as Record<string, unknown> | undefined;
    if (!config || typeof config !== 'object') return data;
    return JSON.stringify({ setup: { model: config.model, generationConfig: { responseModalities: config.responseModalities ?? ['AUDIO'] }, systemInstruction: config.systemInstruction, inputAudioTranscription: config.inputAudioTranscription ?? {}, outputAudioTranscription: config.outputAudioTranscription ?? {} } });
  } catch { return data; }
}

async function normalizeUpstreamMessage(data: unknown): Promise<string | ArrayBuffer> {
  if (typeof data === 'string') return data;
  try {
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer);
    const maybeBlob = data as { text?: () => Promise<string>; arrayBuffer?: () => Promise<ArrayBuffer> };
    if (maybeBlob && typeof maybeBlob.text === 'function') return await maybeBlob.text();
    if (maybeBlob && typeof maybeBlob.arrayBuffer === 'function') return new TextDecoder().decode(await maybeBlob.arrayBuffer());
  } catch {}
  return String(data);
}

function clientNote(text: string): string {
  return JSON.stringify({ serverContent: { outputTranscription: { text } } });
}

async function handleWebSocketProxy(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  if (!env.GEMINI_API_KEY) {
    return new Response('Missing GEMINI_API_KEY secret', { status: 500 });
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(`${GEMINI_WS_ENDPOINT}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, { headers: { Upgrade: 'websocket' } });
  } catch (error) {
    return new Response(`Upstream websocket fetch failed: ${error instanceof Error ? error.message : String(error)}`, { status: 502 });
  }

  const upstreamSocket = upstreamResponse.webSocket;
  if (!upstreamSocket) {
    const body = await upstreamResponse.text().catch(() => '');
    return new Response(`Upstream websocket handshake failed: ${upstreamResponse.status} ${body.slice(0, 500)}`, { status: 502 });
  }

  const pair = new WebSocketPair();
  const clientSocket = pair[0];
  const serverSocket = pair[1];

  serverSocket.accept();
  upstreamSocket.accept();

  let clientAudioChunks = 0;
  let upstreamMessages = 0;

  const sendNote = (text: string) => {
    try {
      if (serverSocket.readyState === WebSocket.OPEN) serverSocket.send(clientNote(text));
    } catch {}
  };

  const closeBoth = (code = 1000, reason = 'closed') => {
    try { serverSocket.close(code, reason); } catch {}
    try { upstreamSocket.close(code, reason); } catch {}
  };

  serverSocket.addEventListener('message', (event) => {
    try {
      const normalized = normalizeClientMessage(event.data);
      if (upstreamSocket.readyState === WebSocket.OPEN) upstreamSocket.send(normalized);

      const raw = typeof event.data === 'string' ? event.data : '';
      const normalizedText = typeof normalized === 'string' ? normalized : '';
      if (normalizedText.includes('"setup"')) sendNote('worker: setup forwarded to upstream');
      if (raw.includes('realtimeInput')) {
        clientAudioChunks += 1;
        if (clientAudioChunks === 1 || clientAudioChunks % 50 === 0) sendNote(`worker: audio chunks forwarded ${clientAudioChunks}`);
      }
    } catch (error) {
      closeBoth(1011, `client-to-upstream failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  upstreamSocket.addEventListener('message', async (event) => {
    try {
      upstreamMessages += 1;
      const normalized = await normalizeUpstreamMessage(event.data);
      if (serverSocket.readyState === WebSocket.OPEN) {
        if (upstreamMessages === 1 || upstreamMessages % 10 === 0) serverSocket.send(clientNote(`worker: upstream messages ${upstreamMessages}`));
        if (typeof event.data !== 'string' && typeof normalized === 'string') serverSocket.send(clientNote('worker: decoded binary/blob upstream message'));
        serverSocket.send(normalized);
      }
    } catch (error) {
      closeBoth(1011, `upstream-to-client failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  serverSocket.addEventListener('close', (event) => closeBoth(event.code, event.reason));
  upstreamSocket.addEventListener('close', (event) => closeBoth(event.code, event.reason));
  serverSocket.addEventListener('error', () => closeBoth(1011, 'client socket error'));
  upstreamSocket.addEventListener('error', () => closeBoth(1011, 'upstream socket error'));

  return new Response(null, { status: 101, webSocket: clientSocket });
}
