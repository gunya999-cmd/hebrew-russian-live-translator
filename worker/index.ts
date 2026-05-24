export interface Env {
  GEMINI_API_KEY: string;
  ASSETS: Fetcher;
}

const GEMINI_WS_ENDPOINT = 'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const WORKER_VERSION = 'chrome-clean-1';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'hebrew-russian-live-translator', version: WORKER_VERSION });
    }

    if (url.pathname === '/debug') {
      return Response.json({
        ok: true,
        version: WORKER_VERSION,
        hasGeminiKey: Boolean(env.GEMINI_API_KEY),
        geminiKeyLength: env.GEMINI_API_KEY ? env.GEMINI_API_KEY.length : 0
      });
    }

    if (url.pathname === '/ws') return handleWebSocketProxy(request, env);
    return env.ASSETS.fetch(request);
  }
};

async function handleWebSocketProxy(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  if (!env.GEMINI_API_KEY) {
    return new Response('Missing GEMINI_API_KEY secret', { status: 500 });
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(`${GEMINI_WS_ENDPOINT}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
      headers: { Upgrade: 'websocket' }
    });
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

  const closeBoth = (code = 1000, reason = 'closed') => {
    try { serverSocket.close(code, reason); } catch {}
    try { upstreamSocket.close(code, reason); } catch {}
  };

  serverSocket.addEventListener('message', (event) => {
    try {
      if (upstreamSocket.readyState === WebSocket.OPEN) upstreamSocket.send(event.data);
    } catch (error) {
      closeBoth(1011, `client-to-upstream failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  upstreamSocket.addEventListener('message', (event) => {
    try {
      if (serverSocket.readyState === WebSocket.OPEN) serverSocket.send(event.data);
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
