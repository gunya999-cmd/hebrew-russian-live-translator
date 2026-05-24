import { useEffect, useState } from 'react';
import ChromeFastApp from './ChromeFastApp';

const NativeWebSocket = window.WebSocket;

async function normalizeMessageData(data: unknown): Promise<unknown> {
  if (typeof data === 'string') return data;
  const maybeBlob = data as { text?: () => Promise<string>; arrayBuffer?: () => Promise<ArrayBuffer> };
  if (maybeBlob && typeof maybeBlob.text === 'function') return await maybeBlob.text();
  if (maybeBlob && typeof maybeBlob.arrayBuffer === 'function') return new TextDecoder().decode(await maybeBlob.arrayBuffer());
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer);
  return data;
}

export default function BlobSafeApp() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    class BlobSafeWebSocket extends NativeWebSocket {
      private wrappedHandler: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;

      set onmessage(handler: ((this: WebSocket, ev: MessageEvent) => unknown) | null) {
        this.wrappedHandler = handler;
        super.onmessage = async (event: MessageEvent) => {
          const data = await normalizeMessageData(event.data);
          const normalizedEvent = new MessageEvent('message', { data, origin: event.origin, lastEventId: event.lastEventId, source: event.source, ports: event.ports });
          this.wrappedHandler?.call(this, normalizedEvent);
        };
      }

      get onmessage() {
        return this.wrappedHandler;
      }
    }

    window.WebSocket = BlobSafeWebSocket;
    setReady(true);
    return () => { window.WebSocket = NativeWebSocket; };
  }, []);

  return ready ? <ChromeFastApp /> : null;
}
