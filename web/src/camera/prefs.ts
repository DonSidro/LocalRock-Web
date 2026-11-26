import { useSyncExternalStore } from 'react';
import { cameraShowsEntry, cameraModelSupport } from '../../../shared/camera';

/*
 * The "Experimental video" preference (the app's AppSettings.videoEnabled), kept in this browser and
 * off by default. Video shows only with it on, on a model with official remote viewing, in a browser
 * with WebRTC.
 */

const KEY = 'lrw-video';
const listeners = new Set<() => void>();

function read(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setVideoEnabled(on: boolean): void {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* not kept */ }
  listeners.forEach((l) => l());
}

export function useVideoEnabled(): boolean {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, read, () => false);
}

export const liveViewSupported = () => typeof RTCPeerConnection !== 'undefined';

export function useCameraAvailable(model: string | null | undefined): boolean {
  const enabled = useVideoEnabled();
  return enabled && liveViewSupported() && cameraShowsEntry(cameraModelSupport(model));
}
