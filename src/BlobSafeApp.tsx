import { useEffect, useState } from 'react';
import ChromeFastApp from './ChromeFastApp';

const NativeWebSocket = window.WebSocket;
const AUDIO_END_DELAY_MS = 1800;

async function normalizeMessageData(data: unknown): Promise<unknown> {
  if (typeof data === 'string') return data;
  const maybeBlob = data as { text?: () => Promise<string>; arrayBuffer?: () => Promise<ArrayBuffer> };
  if (maybeBlob && typeof maybeBlob.text === 'function') return await maybeBlob.text();
  if (maybeBlob && typeof maybeBlob.arrayBuffer === 'function') return new TextDecoder().decode(await maybeBlob.arrayBuffer());
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer);
  return data;
}

function isAudioChunk(data: unknown): boolean {
  return typeof data === 'string' && data.includes('realtimeInput') && data.includes('audio') && !data.includes('audioStreamEnd');
}

function adaptOutgoingMessage(data: string | ArrayBufferLike | Blob | ArrayBufferView): string | ArrayBufferLike | Blob | ArrayBufferView {
  if (typeof data !== 'string') return data;
  try {
    const msg = JSON.parse(data) as { realtimeInput?: { audio?: { data?: string; mimeType?: string }; mediaChunks?: unknown[]; audioStreamEnd?: boolean } };
    const audio = msg.realtimeInput?.audio;
    if (!audio) return data;
    delete msg.realtimeInput!.audio;
    msg.realtimeInput!.mediaChunks = [{ data: audio.data, mimeType: audio.mimeType }];
    return JSON.stringify(msg);
  } catch {
    return data;
  }
}

export default function BlobSafeApp() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    class BlobSafeWebSocket extends NativeWebSocket {
      private wrappedHandler: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
      private audioEndTimer: number | null = null;

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

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        const outgoing = adaptOutgoingMessage(data);
        super.send(outgoing);
        if (!isAudioChunk(data)) return;
        if (this.audioEndTimer !== null) window.clearTimeout(this.audioEndTimer);
        this.audioEndTimer = window.setTimeout(() => {
          if (this.readyState === NativeWebSocket.OPEN) {
            super.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
          }
          this.audioEndTimer = null;
        }, AUDIO_END_DELAY_MS);
      }

      close(code?: number, reason?: string): void {
        if (this.audioEndTimer !== null) window.clearTimeout(this.audioEndTimer);
        this.audioEndTimer = null;
        super.close(code, reason);
      }
    }

    window.WebSocket = BlobSafeWebSocket;
    setReady(true);
    return () => { window.WebSocket = NativeWebSocket; };
  }, []);

  return ready ? <ChromeFastApp /> : null;
}
