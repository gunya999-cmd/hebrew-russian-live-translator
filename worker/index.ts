export interface Env {
  GEMINI_API_KEY: string;
  ASSETS: Fetcher;
}

const GEMINI_WS_ENDPOINT = 'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const WORKER_VERSION = 'receiver-text-first-1';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, version: WORKER_VERSION });
    if (url.pathname === '/debug') return Response.json({ ok: true, version: WORKER_VERSION, hasGeminiKey: Boolean(env.GEMINI_API_KEY), geminiKeyLength: env.GEMINI_API_KEY?.length || 0 });
    if (url.pathname === '/ws') return handleWs(request, env);
    return env.ASSETS.fetch(request);
  }
};

function toGeminiSetup(data: string | ArrayBuffer): string | ArrayBuffer {
  if (typeof data !== 'string') return data;
  try {
    const msg = JSON.parse(data) as Record<string, unknown>;
    const config = msg.config as Record<string, unknown> | undefined;
    if (!config) return data;
    return JSON.stringify({
      setup: {
        model: config.model,
        generationConfig: { responseModalities: ['TEXT'] },
        systemInstruction: config.systemInstruction,
        realtimeInputConfig: {
          activityHandling: 'NO_INTERRUPTION',
          turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
          automaticActivityDetection: {
            startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
            endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
            prefixPaddingMs: 20,
            silenceDurationMs: 250
          }
        },
        inputAudioTranscription: config.inputAudioTranscription ?? {},
        outputAudioTranscription: config.outputAudioTranscription ?? {}
      }
    });
  } catch {
    return data;
  }
}

async function toText(data: unknown): Promise<string | ArrayBuffer> {
  if (typeof data === 'string') return data;
  try {
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer);
    const maybeBlob = data as { text?: () => Promise<string>; arrayBuffer?: () => Promise<ArrayBuffer> };
    if (maybeBlob && typeof maybeBlob.text === 'function') return await maybeBlob.text();
    if (maybeBlob && typeof maybeBlob.arrayBuffer === 'function') return new TextDecoder().decode(await maybeBlob.arrayBuffer());
  } catch {}
  return data instanceof ArrayBuffer ? data : String(data);
}

async function handleWs(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket upgrade', { status: 426 });
  if (!env.GEMINI_API_KEY) return new Response('Missing GEMINI_API_KEY secret', { status: 500 });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(`${GEMINI_WS_ENDPOINT}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, { headers: { Upgrade: 'websocket' } });
  } catch (err) {
    return new Response(`Gemini websocket failed: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
  }

  const upstream = upstreamResponse.webSocket;
  if (!upstream) {
    const body = await upstreamResponse.text().catch(() => '');
    return new Response(`Gemini handshake failed: ${upstreamResponse.status} ${body.slice(0, 500)}`, { status: 502 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  upstream.accept();

  const closeBoth = (code = 1000, reason = 'closed') => {
    try { server.close(code, reason); } catch {}
    try { upstream.close(code, reason); } catch {}
  };

  server.addEventListener('message', (event) => {
    try {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(toGeminiSetup(event.data));
    } catch (err) {
      closeBoth(1011, `client-to-gemini failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  upstream.addEventListener('message', async (event) => {
    try {
      const data = await toText(event.data);
      if (server.readyState === WebSocket.OPEN) server.send(data);
    } catch (err) {
      closeBoth(1011, `gemini-to-client failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  server.addEventListener('close', (event) => closeBoth(event.code, event.reason));
  upstream.addEventListener('close', (event) => closeBoth(event.code, event.reason));
  server.addEventListener('error', () => closeBoth(1011, 'client socket error'));
  upstream.addEventListener('error', () => closeBoth(1011, 'gemini socket error'));

  return new Response(null, { status: 101, webSocket: client });
}
