export interface Env {
  GEMINI_API_KEY: string;
  ASSETS: Fetcher;
}

const GEMINI_WS_ENDPOINT = 'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'hebrew-russian-live-translator' });
    if (url.pathname === '/ws') return handleWebSocketProxy(request, env);
    return env.ASSETS.fetch(request);
  }
};

function normalizeClientMessage(data: string | ArrayBuffer): string | ArrayBuffer {
  if (typeof data !== 'string') return data;

  try {
    const message = JSON.parse(data) as Record<string, unknown>;
    const maybeConfig = message.config;

    if (maybeConfig && typeof maybeConfig === 'object') {
      const config = maybeConfig as Record<string, unknown>;
      return JSON.stringify({
        setup: {
          model: config.model,
          generationConfig: {
            responseModalities: config.responseModalities ?? ['AUDIO']
          },
          systemInstruction: config.systemInstruction,
          inputAudioTranscription: config.inputAudioTranscription ?? {},
          outputAudioTranscription: config.outputAudioTranscription ?? {}
        }
      });
    }

    return data;
  } catch {
    return data;
  }
}

async function handleWebSocketProxy(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  if (!env.GEMINI_API_KEY) {
    console.error('Missing GEMINI_API_KEY secret');
    return new Response('Missing GEMINI_API_KEY secret', { status: 500 });
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(`${GEMINI_WS_ENDPOINT}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
      headers: { Upgrade: 'websocket' }
    });
  } catch (error) {
    console.error('Upstream websocket fetch failed', error instanceof Error ? error.message : String(error));
    return new Response('Upstream websocket fetch failed', { status: 502 });
  }

  const upstreamSocket = upstreamResponse.webSocket;
  if (!upstreamSocket) {
    const body = await upstreamResponse.text().catch(() => '');
    console.error('Upstream websocket handshake failed', upstreamResponse.status, body.slice(0, 500));
    return new Response('Upstream websocket handshake failed', { status: 502 });
  }

  const pair = new WebSocketPair();
  const clientSocket = pair[0];
  const serverSocket = pair[1];

  serverSocket.accept();
  upstreamSocket.accept();

  const closeBoth = (code = 1000, reason = 'closed') => {
    try { serverSocket.close(code, reason); } catch {}
    try { upstreamSocket.close(code, reason); } catch {}
  };

  serverSocket.addEventListener('message', (event) => {
    try {
      if (upstreamSocket.readyState === WebSocket.OPEN) upstreamSocket.send(normalizeClientMessage(event.data));
    } catch (error) {
      console.error('client-to-upstream failed', error instanceof Error ? error.message : String(error));
      closeBoth(1011, 'client-to-upstream failed');
    }
  });

  upstreamSocket.addEventListener('message', (event) => {
    try {
      if (serverSocket.readyState === WebSocket.OPEN) serverSocket.send(event.data);
    } catch (error) {
      console.error('upstream-to-client failed', error instanceof Error ? error.message : String(error));
      closeBoth(1011, 'upstream-to-client failed');
    }
  });

  serverSocket.addEventListener('close', (event) => closeBoth(event.code, event.reason));
  upstreamSocket.addEventListener('close', (event) => closeBoth(event.code, event.reason));
  serverSocket.addEventListener('error', () => closeBoth(1011, 'client socket error'));
  upstreamSocket.addEventListener('error', () => closeBoth(1011, 'upstream socket error'));

  return new Response(null, { status: 101, webSocket: clientSocket });
}
