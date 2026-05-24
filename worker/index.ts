export interface Env {
  GEMINI_API_KEY: string;
  ASSETS: Fetcher;
}

const GEMINI_WS_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'hebrew-russian-live-translator' });
    if (url.pathname === '/ws') return handleWebSocketProxy(request, env);
    return env.ASSETS.fetch(request);
  }
};

async function handleWebSocketProxy(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket upgrade', { status: 426 });
  if (!env.GEMINI_API_KEY) return new Response('Missing GEMINI_API_KEY secret', { status: 500 });

  const pair = new WebSocketPair();
  const clientSocket = pair[0];
  const serverSocket = pair[1];
  serverSocket.accept();

  const upstreamResponse = await fetch(`${GEMINI_WS_ENDPOINT}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
    headers: { Upgrade: 'websocket', 'x-goog-api-key': env.GEMINI_API_KEY }
  });

  const upstreamSocket = upstreamResponse.webSocket;
  if (!upstreamSocket) {
    serverSocket.close(1011, 'Gemini websocket handshake failed');
    return new Response('Gemini websocket handshake failed', { status: 502 });
  }
  upstreamSocket.accept();

  const closeBoth = (code = 1000, reason = 'closed') => {
    try { serverSocket.close(code, reason); } catch {}
    try { upstreamSocket.close(code, reason); } catch {}
  };

  serverSocket.addEventListener('message', (event) => { try { if (upstreamSocket.readyState === WebSocket.OPEN) upstreamSocket.send(event.data); } catch { closeBoth(1011, 'client-to-upstream failed'); } });
  upstreamSocket.addEventListener('message', (event) => { try { if (serverSocket.readyState === WebSocket.OPEN) serverSocket.send(event.data); } catch { closeBoth(1011, 'upstream-to-client failed'); } });
  serverSocket.addEventListener('close', (event) => closeBoth(event.code, event.reason));
  upstreamSocket.addEventListener('close', (event) => closeBoth(event.code, event.reason));
  serverSocket.addEventListener('error', () => closeBoth(1011, 'client socket error'));
  upstreamSocket.addEventListener('error', () => closeBoth(1011, 'upstream socket error'));

  return new Response(null, { status: 101, webSocket: clientSocket });
}
