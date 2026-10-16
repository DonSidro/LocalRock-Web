import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { call } from '../api';
import { Icon } from '../icons';
import { md5Hex } from '../md5';
import { Field, Spinner } from '../ui';

/*
 * Camera live view, ported from LocalRock's CameraLiveSession.kt / CameraLiveViewScreen.kt. The
 * robot is asked over MQTT (through the server) to stream with WebRTC; the browser is the peer.
 */

const CLIENT_ID = '7661636c6f63616c'; // hex("vaclocal"), what the app uses
const NO_CLIENT = 'none';
const ERR_PASSWORD_DISABLED = -1007;
const ERR_CAMERA_PREVIEW_DENIED = -10012;
const ERR_TURN_SERVER_FAILED = -10014;
const PASSWORD_DISABLED_HINT = 'This robot reports the camera PIN feature is disabled (-1007). Enable remote viewing for this vacuum once in the manufacturer\'s own app, then try again here.';
const TURN_SERVER_HINT = "The robot couldn't get a video relay from the server (-10014). The camera needs a local server with camera (TURN) support set up, and the robot paired so that it can find it. See the server's camera documentation.";

type CamState = { kind: 'idle' } | { kind: 'connecting'; stage: string } | { kind: 'streaming' } | { kind: 'failed'; message: string };
interface Rpc { result: unknown; error: { code?: number; message?: string } | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function b64(json: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function unb64(s: string): string {
  try {
    const bin = atob(s);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return s;
  }
}

function firstObject(r: unknown): Record<string, unknown> | null {
  const v = Array.isArray(r) ? r[0] : r;
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function firstInt(r: unknown): number | null {
  const v = Array.isArray(r) ? r[0] : r;
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

class LiveSession {
  pc: RTCPeerConnection | null = null;
  private cancelled = false;

  constructor(private readonly duid: string, private readonly onState: (s: CamState) => void, private readonly onStream: (s: MediaStream) => void) {}

  private rpc(method: string, params: Record<string, string> | [] = []): Promise<Rpc> {
    return call<Rpc>(this.duid, 'cameraRpc', { method, params });
  }

  private check(): void {
    if (this.cancelled) throw new Error('cancelled');
  }

  async setPinAndStart(pin: string): Promise<void> {
    this.onState({ kind: 'connecting', stage: 'Setting PIN on robot...' });
    try {
      const password = md5Hex(pin);
      const first = await this.rpc('set_homesec_password', { password }).catch(() => null);
      if (!first || first.error) {
        await this.rpc('reset_homesec_password').catch(() => null);
        const retry = await this.rpc('set_homesec_password', { password });
        if (retry.error) {
          if (retry.error.code === ERR_PASSWORD_DISABLED) throw new Error(PASSWORD_DISABLED_HINT);
          throw new Error(`Robot refused to set the PIN: ${JSON.stringify(retry.error)}`);
        }
      }
      await this.connect(pin);
    } catch (e) {
      this.fail(e);
    }
  }

  async start(pin: string): Promise<void> {
    try {
      await this.connect(pin);
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    if (this.cancelled) return;
    this.onState({ kind: 'failed', message: (e as Error).message || 'Unknown error' });
    this.closePeer();
  }

  private async connect(pin: string): Promise<void> {
    const password = md5Hex(pin);
    this.onState({ kind: 'connecting', stage: 'Checking PIN...' });
    const check = await this.rpc('check_homesec_password', { password });
    this.check();
    if (check.error) {
      if (check.error.code === ERR_PASSWORD_DISABLED) throw new Error(PASSWORD_DISABLED_HINT);
      throw new Error(`PIN check failed: ${JSON.stringify(check.error)}`);
    }
    const ok = firstInt(check.result);
    if (ok !== null && ok !== 1) throw new Error('Wrong camera PIN');

    // If another client (the official app) holds the camera, ask it to let go.
    this.onState({ kind: 'connecting', stage: 'Claiming camera...' });
    for (let kicks = 0; kicks < 5; kicks++) {
      const status = await this.rpc('get_homesec_connect_status').catch(() => null);
      const other = firstObject(status?.result)?.['client_id'];
      if (typeof other !== 'string' || !other.trim() || other === NO_CLIENT || other === CLIENT_ID) break;
      await this.rpc('stop_camera_preview', { client_id: other }).catch(() => null);
      await sleep(1_000);
      this.check();
    }

    this.onState({ kind: 'connecting', stage: 'Starting camera...' });
    const started = await this.rpc('start_camera_preview', { client_id: CLIENT_ID, quality: 'HD', password });
    this.check();
    if (started.error) {
      if (started.error.code === ERR_CAMERA_PREVIEW_DENIED) {
        const status = await this.rpc('get_camera_status').catch(() => null);
        throw new Error(`Remote viewing is not enabled on this robot (-10012, camera_status=${firstInt(status?.result) ?? 'unknown'}). It can only be switched on from the manufacturer's own app while the robot is connected to the manufacturer's cloud, and the setting is lost when the robot is moved back to a local server.`);
      }
      if (started.error.code === ERR_TURN_SERVER_FAILED) throw new Error(TURN_SERVER_HINT);
      throw new Error(`Robot refused camera preview: ${JSON.stringify(started.error)}`);
    }

    this.onState({ kind: 'connecting', stage: 'Negotiating...' });
    const iceServers: RTCIceServer[] = [];
    const turn = firstObject((await this.rpc('get_turn_server').catch(() => null))?.result);
    if (turn && typeof turn['url'] === 'string') {
      iceServers.push({ urls: turn['url'], username: String(turn['user'] ?? ''), credential: String(turn['pwd'] ?? '') });
    }

    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const stream = new MediaStream();
    pc.ontrack = (ev) => {
      stream.addTrack(ev.track);
      this.onStream(stream);
    };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !ev.candidate.candidate) return;
      void this.rpc('send_ice_to_robot', {
        app_ice: b64({ candidate: ev.candidate.candidate, sdpMLineIndex: ev.candidate.sdpMLineIndex ?? 0, sdpMid: ev.candidate.sdpMid ?? '0' }),
      }).catch(() => null);
    };
    const connected = new Promise<void>((resolve, reject) => {
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          this.onState({ kind: 'streaming' });
          resolve();
        } else if (pc.connectionState === 'failed') {
          reject(new Error('Video connection failed'));
          this.fail(new Error('Video connection failed'));
        } else if (pc.connectionState === 'disconnected') {
          this.fail(new Error('Video connection lost'));
        }
      };
    });
    connected.catch(() => undefined);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.rpc('send_sdp_to_robot', { app_sdp: b64({ type: 'offer', sdp: offer.sdp }) });

    let answer: string | null = null;
    for (let tries = 0; tries < 15 && !answer; tries++) {
      this.check();
      const devSdp = firstObject((await this.rpc('get_device_sdp').catch(() => null))?.result)?.['dev_sdp'];
      if (typeof devSdp === 'string' && devSdp && devSdp !== 'retry') {
        try {
          const sdp = (JSON.parse(unb64(devSdp)) as { sdp?: unknown }).sdp;
          if (typeof sdp === 'string') answer = sdp;
        } catch {
          // keep polling
        }
      }
      if (!answer) await sleep(1_000);
    }
    if (!answer) throw new Error('Robot did not answer. Does this model have a camera?');
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });

    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      this.check();
      if (pc.connectionState === 'connected') break;
      const entries = firstObject((await this.rpc('get_device_ice').catch(() => null))?.result)?.['dev_ice'];
      if (Array.isArray(entries)) {
        for (const raw of entries) {
          if (typeof raw !== 'string' || seen.has(raw)) continue;
          seen.add(raw);
          try {
            const o = JSON.parse(unb64(raw)) as { candidate?: string; sdpMid?: string; sdpMLineIndex?: number };
            if (o.candidate) await pc.addIceCandidate({ candidate: o.candidate, sdpMid: o.sdpMid ?? null, sdpMLineIndex: o.sdpMLineIndex ?? 0 });
          } catch {
            // skip a candidate the browser can't use
          }
        }
      }
      await sleep(1_000);
    }
  }

  private closePeer(): void {
    this.pc?.close();
    this.pc = null;
  }

  stop(): void {
    this.cancelled = true;
    this.closePeer();
    void this.rpc('stop_camera_preview', { client_id: CLIENT_ID }).catch(() => null);
  }
}

export function CameraScreen({ duid }: { duid: string }) {
  const [state, setState] = useState<CamState>({ kind: 'idle' });
  const [pin, setPin] = useState('');
  const [typed, setTyped] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const session = useRef<LiveSession | null>(null);

  const begin = (p: string, setOnRobot: boolean) => {
    session.current?.stop();
    const s = new LiveSession(duid, setState, (stream) => {
      if (videoRef.current && videoRef.current.srcObject !== stream) videoRef.current.srcObject = stream;
    });
    session.current = s;
    void call(duid, 'setCameraPin', { pin: p }).catch(() => undefined);
    if (setOnRobot) void s.setPinAndStart(p);
    else {
      setState({ kind: 'connecting', stage: 'Preparing...' });
      void s.start(p);
    }
  };

  // A saved PIN connects straight away.
  useEffect(() => {
    let alive = true;
    void call<string | null>(duid, 'getCameraPin').then((saved) => {
      if (alive && saved) {
        setPin(saved);
        begin(saved, false);
      }
    }).catch(() => undefined);
    return () => {
      alive = false;
      session.current?.stop();
      session.current = null;
    };
  }, [duid]); // eslint-disable-line react-hooks/exhaustive-deps

  const supported = typeof RTCPeerConnection !== 'undefined';

  return (
    <div className="tab-page camera-tab">
      <div className="camera-stage">
        {/* Muted so autoplay works without a click; the controls unmute the robot's microphone. */}
        <video ref={videoRef} autoPlay playsInline muted controls className={state.kind === 'streaming' ? '' : 'hidden'} />
        {state.kind === 'streaming' && <span className="live-tag">LIVE</span>}
        {!supported && <Message icon text="This browser has no WebRTC, so the live view can't run here." />}
        {supported && state.kind === 'idle' && (
          <div className="col" style={{ alignItems: 'center', padding: 32, maxWidth: 420, textAlign: 'center' }}>
            <p>
              The live view is protected by a camera PIN stored on the robot.
              {typed ? ' Enter your existing PIN, or pick a new one and register it on the robot.' : ' Draw your existing pattern, or draw a new one and register it on the robot.'}
            </p>
            {typed ? (
              <Field label="Camera PIN">
                <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
              </Field>
            ) : (
              <>
                <PatternInput onPattern={setPin} />
                <p className="small" style={{ opacity: 0.7 }}>{pin ? 'Pattern captured' : 'Draw a pattern of at least 4 dots'}</p>
              </>
            )}
            <button type="button" className="btn" disabled={!pin} onClick={() => begin(pin, false)}>Start live view</button>
            <button type="button" className="btn ghost" disabled={!pin} onClick={() => begin(pin, true)}>Set as new PIN on robot</button>
            <button type="button" className="btn ghost" style={{ opacity: 0.7 }} onClick={() => { setTyped((t) => !t); setPin(''); }}>{typed ? 'Draw a pattern instead' : 'Type a PIN instead'}</button>
          </div>
        )}
        {state.kind === 'connecting' && (
          <div className="col" style={{ alignItems: 'center' }}><Spinner big /><p>{state.stage}</p></div>
        )}
        {state.kind === 'failed' && (
          <div className="col" style={{ alignItems: 'center', padding: 24, maxWidth: 520, textAlign: 'center' }}>
            <Icon name="videocamOff" size={48} />
            <p>{state.message}</p>
            <button type="button" className="btn" onClick={() => begin(pin, false)} disabled={!pin}>Retry</button>
            <button type="button" className="btn ghost" onClick={() => {
              session.current?.stop();
              session.current = null;
              void call(duid, 'setCameraPin', { pin: null }).catch(() => undefined);
              setPin('');
              setState({ kind: 'idle' });
            }}>Change PIN</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Message({ text }: { icon: boolean; text: string }) {
  return (
    <div className="col" style={{ alignItems: 'center', padding: 24 }}>
      <Icon name="videocamOff" size={48} />
      <p className="center">{text}</p>
    </div>
  );
}

/**
 * Newer robots take the camera PIN as a pattern on a 3x3 grid; the dots are numbered 1-9 row by
 * row and the drawn order becomes the digit string.
 */
function PatternInput({ onPattern }: { onPattern: (digits: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const SIZE = 260;
  const centers = Array.from({ length: 9 }, (_, i) => ({ x: ((i % 3) + 0.5) * (SIZE / 3), y: (Math.floor(i / 3) + 0.5) * (SIZE / 3) }));

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = SIZE * dpr;
    c.height = SIZE * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    const r = (SIZE / 3) * 0.12;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = r * 0.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    selected.forEach((d, i) => (i === 0 ? ctx.moveTo(centers[d]!.x, centers[d]!.y) : ctx.lineTo(centers[d]!.x, centers[d]!.y)));
    if (cursor && selected.length) ctx.lineTo(cursor.x, cursor.y);
    ctx.stroke();
    centers.forEach((p, i) => {
      const on = selected.includes(i);
      ctx.fillStyle = on ? '#fff' : 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (on) {
        ctx.lineWidth = r * 0.35;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = r * 0.5;
      }
    });
  }, [selected, cursor]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (x: number, y: number, current: number[]): number[] => {
    const hitR = (SIZE / 3) * 0.34;
    const hit = centers.findIndex((p) => Math.hypot(p.x - x, p.y - y) <= hitR);
    if (hit < 0 || current.includes(hit)) return current;
    const next = [...current];
    const prev = next[next.length - 1];
    if (prev !== undefined) {
      // Dragging straight across a dot picks it up too.
      const rowSum = Math.floor(prev / 3) + Math.floor(hit / 3);
      const colSum = (prev % 3) + (hit % 3);
      if (rowSum % 2 === 0 && colSum % 2 === 0) {
        const between = (rowSum / 2) * 3 + colSum / 2;
        if (between !== prev && !next.includes(between)) next.push(between);
      }
    }
    next.push(hit);
    return next;
  };

  const pos = (e: ReactPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * SIZE, y: ((e.clientY - r.top) / r.height) * SIZE };
  };
  const drag = useRef<number[] | null>(null);

  return (
    <canvas
      ref={ref}
      className="pattern"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = pos(e);
        drag.current = pick(p.x, p.y, []);
        setSelected(drag.current);
        setCursor(p);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const p = pos(e);
        drag.current = pick(p.x, p.y, drag.current);
        setSelected(drag.current);
        setCursor(p);
      }}
      onPointerUp={() => {
        const done = drag.current ?? [];
        drag.current = null;
        setCursor(null);
        setSelected([]);
        if (done.length >= 4) onPattern(done.map((d) => d + 1).join(''));
      }}
    />
  );
}
