import { useEffect, useState } from 'react';
import BlobSafeApp from './BlobSafeApp';

const NativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
const NativeEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);

function isAirPodsLabel(label?: string): boolean {
  return (label || '').toLowerCase().includes('airpods');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

function streamLabel(stream: MediaStream): string {
  return stream.getAudioTracks().map((track) => track.label).join(' ');
}

function withDeviceId(constraints: MediaStreamConstraints, deviceId: string): MediaStreamConstraints {
  const baseAudio = typeof constraints.audio === 'object' && constraints.audio !== null ? constraints.audio : {};
  return { ...constraints, audio: { ...baseAudio, deviceId: { exact: deviceId } } };
}

async function preferNonAirPodsStream(constraints: MediaStreamConstraints): Promise<MediaStream> {
  const first = await NativeGetUserMedia(constraints);
  await wait(350);
  const firstLabel = streamLabel(first);
  if (!isAirPodsLabel(firstLabel)) return first;

  stopStream(first);
  const devices = await NativeEnumerateDevices();
  const candidates = devices.filter((device) => device.kind === 'audioinput' && !isAirPodsLabel(device.label));

  for (const candidate of candidates) {
    try {
      const stream = await NativeGetUserMedia(withDeviceId(constraints, candidate.deviceId));
      await wait(350);
      const label = streamLabel(stream) || candidate.label;
      if (!isAirPodsLabel(label)) return stream;
      stopStream(stream);
    } catch {
      // Try next candidate.
    }
  }

  throw new Error('iPhone microphone was not available. Disconnect AirPods, press Start listening, then reconnect AirPods as output.');
}

export default function MicPreferIphoneApp() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      if (!constraints?.audio) return NativeGetUserMedia(constraints);
      return preferNonAirPodsStream(constraints);
    };
    setReady(true);
    return () => { navigator.mediaDevices.getUserMedia = NativeGetUserMedia; };
  }, []);

  return ready ? <BlobSafeApp /> : null;
}
