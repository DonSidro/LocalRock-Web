import {
  CameraFailure, OEM_MATCH, cameraErrorHint, cameraOwner, cameraPinAccepted, cameraPinRejected, decodeCameraAnswer,
  encodeCameraOffer, isAck, rankedCodecs, type CameraVideoQuality, type CameraVideoTest,
} from '../../../shared/camera';
import { call } from '../api';
import { md5Hex } from '../md5';

/*
 * Camera live view in the browser, ported from LocalRock's CameraLiveSession.kt and CameraVoiceCall.kt.
 * The robot is asked over MQTT (through the server) to stream with WebRTC; the browser is the peer.
 *
 * Each attempt has its own random client id and only ever stops its own preview: when another viewer
 * holds the camera the attempt fails instead of taking it over. Frames must arrive before it counts as
 * live. Robot replies, SDP and ICE are never shown, since they can hold connection details.
 */

export type CamState =
  | { kind: 'idle' }
  | { kind: 'connecting'; stage: string }
  | { kind: 'streaming' }
  | { kind: 'stopping' }
  | { kind: 'failed'; message: string };

export interface VoiceState { active: boolean; busy: boolean; micMuted: boolean; robotMuted: boolean; volume: number | null; volumeBusy: boolean; error: string | null }
export const VOICE_IDLE: VoiceState = { active: false, busy: false, micMuted: true, robotMuted: true, volume: null, volumeBusy: false, error: null };

interface Rpc { result: unknown; error: { code?: number; message?: string } | null }

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
});

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new CameraFailure(`${what} timed out. Check the robot and local server, then retry.`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const b64 = (json: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
};

function decodeObject(value: string, what: string): Record<string, unknown> {
  try {
    const bin = atob(value);
    const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as unknown;
    if (typeof o === 'object' && o !== null && !Array.isArray(o)) return o as Record<string, unknown>;
  } catch { /* below */ }
  throw new CameraFailure(`The robot returned an invalid ${what}.`);
}

function objectResult(r: unknown): Record<string, unknown> | null {
  const v = Array.isArray(r) ? (r.length === 1 ? r[0] : null) : r;
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

const randomClientId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');

export interface Diagnostics { width: number | null; height: number | null; framesDecoded: number }

/** The browser's stats for the received video, without anything that could identify the connection. */
async function readDiagnostics(pc: RTCPeerConnection): Promise<Diagnostics> {
  let out: Diagnostics = { width: null, height: null, framesDecoded: 0 };
  const stats = await pc.getStats();
  stats.forEach((s) => {
    const r = s as { type?: string; kind?: string; frameWidth?: number; frameHeight?: number; framesDecoded?: number };
    if (r.type === 'inbound-rtp' && r.kind === 'video') {
      out = { width: r.frameWidth ?? null, height: r.frameHeight ?? null, framesDecoded: r.framesDecoded ?? 0 };
    }
  });
  return out;
}

export class LiveSession {
  state: CamState = { kind: 'idle' };
  voice: VoiceState = VOICE_IDLE;
  diagnostics: Diagnostics = { width: null, height: null, framesDecoded: 0 };
  cleanupWarning: string | null = null;
  quality: CameraVideoQuality = 'HD';
  private pc: RTCPeerConnection | null = null;
  private audioSender: RTCRtpSender | null = null;
  private remoteAudio: MediaStreamTrack | null = null;
  private mic: MediaStream | null = null;
  private clientId: string | null = null;
  private attempt: AbortController | null = null;
  private running: Promise<void> | null = null;
  /** A call whose robot cleanup could not be confirmed: this connection must not start another. */
  private voiceBlocked = false;
  private voiceRequested = false;

  constructor(
    private readonly duid: string,
    private readonly onChange: () => void,
    private readonly onStream: (stream: MediaStream | null) => void,
    private readonly accessAllowed: () => boolean = () => true,
  ) {}

  private set(patch: Partial<Pick<LiveSession, 'state' | 'voice' | 'diagnostics' | 'cleanupWarning'>>) {
    Object.assign(this, patch);
    this.onChange();
  }

  private setVoice(patch: Partial<VoiceState>) { this.set({ voice: { ...this.voice, ...patch } }); }

  private async command(method: string, params: Record<string, unknown> | [] = []): Promise<Rpc> {
    const resp = await call<Rpc>(this.duid, 'cameraRpc', { method, params });
    if (resp.error) throw new CameraFailure(cameraErrorHint(method, typeof resp.error.code === 'number' ? resp.error.code : null));
    return resp;
  }

  private async owner(): Promise<string> {
    const id = cameraOwner((await this.command('get_homesec_connect_status')).result);
    if (!id) throw new CameraFailure('Camera availability could not be verified. No preview was taken over.');
    return id;
  }

  /** Checks a PIN or pattern without opening a preview or allocating a connection. */
  async checkCredential(pin: string): Promise<void> {
    await withTimeout(this.checkedPinHash(pin), 10_000, 'Checking the camera credential');
  }

  private async checkedPinHash(pin: string): Promise<string> {
    if (!this.accessAllowed()) throw new CameraFailure('Enable video and audio testing for this robot before connecting.');
    if (!pin.trim()) throw new CameraFailure('Enter your existing camera PIN or pattern.');
    const hash = md5Hex(pin);
    const result = (await this.command('check_homesec_password', { password: hash })).result;
    if (!cameraPinAccepted(result)) {
      throw new CameraFailure(cameraPinRejected(result)
        ? 'The robot rejected this camera PIN or pattern. Enter the existing credential again.'
        : 'The robot returned an unrecognized PIN-check response. Camera access was not started.');
    }
    if (!this.accessAllowed()) throw new CameraFailure('Video and audio testing is no longer enabled for this robot.');
    return hash;
  }

  start(pin: string, test: CameraVideoTest = OEM_MATCH, quality: CameraVideoQuality = 'HD'): void {
    if (this.attempt || !this.accessAllowed()) return;
    const ctrl = new AbortController();
    this.attempt = ctrl;
    this.quality = quality;
    this.voiceBlocked = false;
    this.set({ state: { kind: 'connecting', stage: 'Preparing...' }, cleanupWarning: null, diagnostics: { width: null, height: null, framesDecoded: 0 } });
    const id = randomClientId();
    this.clientId = id;
    const flags = { previewRequested: false, startAcknowledged: false, stage: 'Preparing' };
    this.running = (async () => {
      let failure: string | null = null;
      try {
        await this.connect(ctrl.signal, id, pin, test, quality, flags);
      } catch (e) {
        if (!ctrl.signal.aborted) {
          failure = e instanceof CameraFailure ? e.message : `${flags.stage} failed. Check the robot and local server, then retry.`;
        }
      } finally {
        this.set({ state: { kind: 'stopping' } });
        await this.endVoice();
        this.closePeer();
        await this.releaseOwnedPreview(id, flags);
        this.attempt = null;
        this.clientId = null;
        this.set({ state: failure ? { kind: 'failed', message: failure } : { kind: 'idle' } });
      }
    })();
  }

  private async connect(signal: AbortSignal, id: string, pin: string, test: CameraVideoTest, quality: CameraVideoQuality,
    flags: { previewRequested: boolean; startAcknowledged: boolean; stage: string }): Promise<void> {
    const stage = (s: string) => { flags.stage = s; this.set({ state: { kind: 'connecting', stage: `${s}...` } }); };
    const live = () => { if (signal.aborted) throw new DOMException('aborted', 'AbortError'); };
    const deadline = Date.now() + 60_000;
    const inTime = () => { if (Date.now() > deadline) throw new CameraFailure(`${flags.stage} timed out. Check the robot and local server, then retry.`); };

    stage('Checking PIN');
    const hash = await this.checkedPinHash(pin);
    live();
    stage('Checking camera availability');
    if ((await this.owner()) !== 'none') throw new CameraFailure('Camera in use. Close live view in the other app, then retry.');
    live();
    stage('Starting camera');
    flags.previewRequested = true;
    let started: Rpc;
    try {
      started = await withTimeout(this.command('start_camera_preview', { client_id: id, quality, password: hash }), 10_000, 'Starting the camera');
    } catch (e) {
      // An explicit refusal differs from a lost or late acknowledgement, which still gets an ownership check.
      if (e instanceof CameraFailure && !/timed out/.test(e.message)) flags.previewRequested = false;
      throw e;
    }
    if (!isAck(started.result)) throw new CameraFailure('Camera start was not acknowledged by the robot.');
    flags.startAcknowledged = true;
    live();
    if ((await this.owner()) !== id) throw new CameraFailure('Camera ownership could not be confirmed. Close other viewers and retry.');

    stage('Obtaining TURN configuration');
    const turn = objectResult((await this.command('get_turn_server')).result);
    if (!turn) throw new CameraFailure("The robot returned no TURN configuration. Check the server's camera support.");
    const url = typeof turn['url'] === 'string' && /^turns?:/.test(turn['url']) ? turn['url'] : null;
    if (!url) throw new CameraFailure('The robot returned an unsupported TURN configuration.');
    const user = typeof turn['user'] === 'string' ? turn['user'] : '';
    const pwd = typeof turn['pwd'] === 'string' ? turn['pwd'] : '';
    if (!user.trim() || !pwd.trim()) throw new CameraFailure('The robot returned incomplete TURN configuration.');

    stage('Creating video connection');
    const pc = new RTCPeerConnection({ iceServers: [{ urls: url, username: user, credential: pwd }] });
    this.pc = pc;
    // Both directions, as the app offers: the microphone joins the existing connection only during a call.
    const audio = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const video = pc.addTransceiver('video', { direction: 'sendrecv' });
    this.audioSender = audio.sender;
    const prefer = (t: RTCRtpTransceiver, kind: 'audio' | 'video') => {
      const caps = typeof RTCRtpReceiver.getCapabilities === 'function' ? RTCRtpReceiver.getCapabilities(kind) : null;
      const ranked = caps ? rankedCodecs(kind, caps.codecs, test.compactCodecs) : null;
      if (ranked && typeof t.setCodecPreferences === 'function') {
        try { t.setCodecPreferences(ranked); } catch { /* the browser keeps its own order */ }
      }
    };
    prefer(audio, 'audio');
    prefer(video, 'video');
    const stream = new MediaStream();
    pc.ontrack = (ev) => {
      if (ev.track.kind === 'audio') {
        this.remoteAudio = ev.track;
        // Robot audio stays off until a call starts.
        ev.track.enabled = this.voice.active && !this.voice.robotMuted;
      }
      stream.addTrack(ev.track);
      this.onStream(stream);
    };

    let offerSent = false;
    const pendingLocal: RTCIceCandidate[] = [];
    const sendIce = (c: RTCIceCandidate) => {
      void this.command('send_ice_to_robot', {
        app_ice: b64({ candidate: c.candidate, sdpMLineIndex: c.sdpMLineIndex ?? 0, sdpMid: c.sdpMid ?? '0' }),
      }).catch(() => undefined);
    };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !ev.candidate.candidate) return;
      if (offerSent) sendIce(ev.candidate); else pendingLocal.push(ev.candidate);
    };

    stage('Sending video offer');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.command('send_sdp_to_robot', { app_sdp: encodeCameraOffer(offer.sdp ?? '', test.literalSdpLineBreaks) });
    offerSent = true;
    pendingLocal.splice(0).forEach(sendIce);
    live();

    // Ask for the robot's ICE while its answer is pending, as the OEM does; the candidates wait for the answer.
    let answered = false;
    const queued: RTCIceCandidateInit[] = [];
    const seen = new Set<string>();
    let iceFailure: unknown = null;
    const pollIce = async () => {
      try {
        while (!signal.aborted && this.pc === pc) {
          const entries = objectResult((await this.command('get_device_ice')).result)?.['dev_ice'];
          if (Array.isArray(entries)) {
            for (const raw of entries) {
              if (typeof raw !== 'string') throw new CameraFailure('The robot returned invalid video candidates.');
              if (seen.has(raw)) continue;
              seen.add(raw);
              if (seen.size > 256) throw new CameraFailure('The robot returned too many video candidates.');
              const o = decodeObject(raw, 'video candidate');
              if (typeof o['candidate'] !== 'string') throw new CameraFailure('The robot returned an invalid video candidate.');
              const c: RTCIceCandidateInit = { candidate: o['candidate'], sdpMid: typeof o['sdpMid'] === 'string' ? o['sdpMid'] : null, sdpMLineIndex: typeof o['sdpMLineIndex'] === 'number' ? o['sdpMLineIndex'] : 0 };
              if (answered) await pc.addIceCandidate(c).catch(() => undefined); else queued.push(c);
            }
          } else if (entries !== 'retry' && entries !== undefined) {
            throw new CameraFailure('The robot returned invalid video candidates.');
          }
          await sleep(1_000, signal);
        }
      } catch (e) {
        if (!signal.aborted) iceFailure = e;
      }
    };
    let icePolling: Promise<void> | null = test.earlyRemoteIce ? pollIce() : null;

    stage('Waiting for robot answer');
    let answer: string | null = null;
    while (answer === null) {
      inTime();
      const raw = objectResult((await this.command('get_device_sdp')).result)?.['dev_sdp'];
      if (typeof raw !== 'string') throw new CameraFailure('The robot returned an invalid video answer.');
      if (raw === 'retry') { await sleep(1_000, signal); continue; }
      answer = decodeCameraAnswer(raw);
    }
    stage('Applying robot answer');
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    answered = true;
    for (const c of queued.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
    if (!icePolling) icePolling = pollIce();

    stage('Connecting video');
    while (pc.connectionState !== 'connected') {
      inTime();
      if (iceFailure) throw iceFailure;
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) throw new CameraFailure('Video connection failed. Check connectivity and retry.');
      await sleep(250, signal);
    }
    stage('Waiting for video frames');
    for (;;) {
      inTime();
      if (pc.connectionState !== 'connected') throw new CameraFailure('Video connection lost before receiving frames.');
      this.set({ diagnostics: await readDiagnostics(pc).catch(() => this.diagnostics) });
      if (this.diagnostics.framesDecoded > 0) break;
      await sleep(1_000, signal);
    }
    this.set({ state: { kind: 'streaming' } });
    // Trickle ICE stays alive for the whole session; the first connected event need not be the last.
    while (!signal.aborted) {
      if (iceFailure) throw iceFailure;
      if (pc.connectionState !== 'connected') throw new CameraFailure('Video connection lost. Retry to start a new viewing session.');
      this.set({ diagnostics: await readDiagnostics(pc).catch(() => this.diagnostics) });
      await sleep(2_000, signal).catch(() => undefined);
    }
  }

  /** Stops only this attempt's own preview, and says so when the release can't be confirmed. */
  private async releaseOwnedPreview(id: string, flags: { previewRequested: boolean; startAcknowledged: boolean }): Promise<void> {
    if (!flags.previewRequested) return;
    try {
      await withTimeout((async () => {
        const current = await this.owner();
        if (current === id) {
          if (!isAck((await this.command('stop_camera_preview', { client_id: id })).result)) throw new Error('not acknowledged');
          if ((await this.owner()) === id) throw new Error('still owned');
        } else if (!flags.startAcknowledged && current === 'none') {
          // An unanswered start can still arrive late, so this is not a confirmed release.
          throw new Error('start not acknowledged');
        }
      })(), 12_000, 'Releasing the camera');
    } catch {
      this.set({ cleanupWarning: 'The local video connection is closed, but robot preview release could not be confirmed. Wait for the robot to release it before retrying.' });
    }
  }

  private closePeer(): void {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    try { this.pc?.close(); } catch { /* closing anyway */ }
    this.pc = null;
    this.audioSender = null;
    this.remoteAudio = null;
    this.onStream(null);
  }

  /** Stops the attempt; the robot preview is released before the session returns to idle. */
  stop(): Promise<void> {
    if (this.attempt) {
      this.set({ state: { kind: 'stopping' } });
      this.attempt.abort();
    } else if (this.state.kind !== 'idle') {
      this.set({ state: { kind: 'idle' } });
    }
    return this.running ?? Promise.resolve();
  }

  get streaming(): boolean { return this.state.kind === 'streaming' && this.pc !== null; }

  // ---- Voice call ------------------------------------------------------------------------------

  /** Starts two-way audio over the open connection: the browser's microphone and the robot's speaker. */
  async startVoice(): Promise<void> {
    if (this.voice.busy || this.voice.active || !this.streaming || !this.accessAllowed()) return;
    const id = this.clientId, sender = this.audioSender;
    if (!id || !sender) return;
    if (this.voiceBlocked) {
      this.setVoice({ error: 'The previous call could not be confirmed. End video and reconnect before trying again.' });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setVoice({ error: 'This browser can only use the microphone on a secure page (HTTPS or localhost).' });
      return;
    }
    this.setVoice({ busy: true, error: null, volume: null });
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    } catch {
      this.setVoice({ busy: false, error: 'Microphone permission was not granted. Allow it for this page in the browser to make a call.' });
      return;
    }
    const current = () => this.streaming && this.clientId === id && this.audioSender === sender;
    try {
      if (!current()) throw new Error('gone');
      if ((await withTimeout(this.owner(), 5_000, 'Call setup')) !== id) throw new Error('not owner');
      this.voiceRequested = true;
      const ack = await withTimeout(this.command('start_voice_chat', { record: true, play: true }), 5_000, 'Call setup');
      if (!isAck(ack.result)) throw new Error('not acknowledged');
      if (!current()) throw new Error('gone');
      await sender.replaceTrack(mic.getAudioTracks()[0] ?? null);
      this.mic = mic;
      if (this.remoteAudio) this.remoteAudio.enabled = true;
      this.setVoice({ active: true, busy: false, micMuted: false, robotMuted: false });
    } catch (e) {
      mic.getTracks().forEach((t) => t.stop());
      const timedOut = e instanceof CameraFailure && /timed out/.test(e.message);
      if (timedOut && this.voiceRequested) this.voiceBlocked = true;
      this.setVoice({ busy: false, error: timedOut ? 'Call setup timed out. End video and reconnect before retrying.' : 'The voice call could not start. Video remains available.' });
      await this.endVoice();
    }
  }

  /** Local audio stops at once; the robot is then asked to end its side. */
  async endVoice(): Promise<void> {
    void this.audioSender?.replaceTrack(null).catch(() => undefined);
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    if (this.remoteAudio) this.remoteAudio.enabled = false;
    const requested = this.voiceRequested;
    this.voiceRequested = false;
    this.setVoice({ active: false, micMuted: true, robotMuted: true, busy: requested });
    if (!requested) return;
    try {
      await withTimeout((async () => {
        if ((await this.owner()) === this.clientId && !isAck((await this.command('stop_voice_chat')).result)) throw new Error('not acknowledged');
      })(), 5_000, 'Ending the call');
    } catch {
      this.voiceBlocked = true;
      this.setVoice({ error: 'Browser audio is off, but the robot did not confirm call cleanup. End video before retrying.' });
    } finally {
      this.setVoice({ busy: false });
    }
  }

  muteMic(muted: boolean): void {
    if (!this.voice.active) return;
    this.mic?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    this.setVoice({ micMuted: muted });
  }

  muteRobot(muted: boolean): void {
    if (!this.voice.active) return;
    if (this.remoteAudio) this.remoteAudio.enabled = !muted;
    this.setVoice({ robotMuted: muted });
  }

  /** The volume heard at the robot; it changes only when picked, never when a call starts. */
  async setSpeakerVolume(volume: number): Promise<void> {
    if (!this.voice.active || this.voice.volumeBusy || volume < 0 || volume > 100) return;
    const id = this.clientId;
    this.setVoice({ volumeBusy: true });
    try {
      await withTimeout((async () => {
        if ((await this.owner()) !== id) throw new Error('not owner');
        if (!isAck((await this.command('set_voice_chat_volume', { volume })).result)) throw new Error('not acknowledged');
      })(), 5_000, 'The speaker volume change');
      if (this.voice.active) this.setVoice({ volume });
    } catch {
      this.setVoice({ error: 'The robot did not confirm the speaker volume change.' });
    } finally {
      this.setVoice({ volumeBusy: false });
    }
  }
}
