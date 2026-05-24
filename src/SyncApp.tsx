import { useEffect, useState } from 'react';
import AppV3 from './AppV3';

const NativeWebSocket = window.WebSocket;
const SYNC_SEGMENT_MS = 520;
const SYNC_MIN_CHUNKS = 6;

function isOutgoingAudio(data: unknown): boolean {
  return typeof data === 'string' && data.includes('realtimeInput') && data.includes('audio') && !data.includes('audioStreamEnd');
}

export default function SyncApp() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    class SyncWebSocket extends NativeWebSocket {
      private lastEndAt = 0;
      private chunks = 0;

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        super.send(data);
        if (!isOutgoingAudio(data)) return;
        this.chunks += 1;
        const now = performance.now();
        if (this.chunks < SYNC_MIN_CHUNKS) return;
        if (now - this.lastEndAt < SYNC_SEGMENT_MS) return;
        if (this.readyState !== NativeWebSocket.OPEN) return;
        super.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        this.lastEndAt = now;
        this.chunks = 0;
      }
    }

    window.WebSocket = SyncWebSocket;
    setReady(true);
    return () => { window.WebSocket = NativeWebSocket; };
  }, []);

  return ready ? <AppV3 /> : null;
}
