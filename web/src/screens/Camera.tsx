import { useEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  CAMERA_CLEANING_LABEL, CAMERA_VIDEO_TESTS, OEM_MATCH, cameraAllowsRobotControls, cameraCanConnect, cameraCleaningAction,
  cameraModelSupport, type CameraVideoQuality, type CameraVideoTest, type DriveDirection,
} from '../../../shared/camera';
import { describeState } from '../../../shared/codes';
import { MotionController } from '../camera/motion';
import { useCameraAvailable, useVideoEnabled } from '../camera/prefs';
import { LiveSession } from '../camera/session';
import { Icon } from '../icons';
import { MapView } from '../map/MapView';
import { useVacuum } from '../store';
import { ConfirmDialog, Dialog, Field, IconButton, Link, Spinner } from '../ui';

/*
 * Camera live view, ported from LocalRock's CameraLiveViewScreen.kt, CameraVideoControls.kt and
 * CameraCleaningButton.kt (app 1.5.0).
 *
 * Only models with official remote viewing get here: the S7 MaxV is tested and keeps its robot
 * controls; the others need an opt-in that starts unchecked every visit, and get video and audio
 * only. The existing PIN or pattern is checked before the viewer opens; it is kept in memory while
 * this page is open and visible, and never stored or reset. Hiding or leaving the page closes video.
 */

type FitMode = 'fill' | 'fit';
const VOLUMES = [25, 50, 75, 100];

export function CameraScreen({ duid }: { duid: string }) {
  const { snap, map } = useVacuum(duid);
  const enabled = useVideoEnabled();
  const available = useCameraAvailable(snap?.model);
  const support = cameraModelSupport(snap?.model);
  const controls = cameraAllowsRobotControls(support);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const [testing, setTesting] = useState(false);
  // Read through refs: the session outlives renders, and the robot's model may arrive after the first one.
  const testingRef = useRef(false);
  testingRef.current = testing;
  const supportRef = useRef(support);
  supportRef.current = support;
  const allowed = () => cameraCanConnect(supportRef.current, testingRef.current);
  const lastStream = useRef<MediaStream | null>(null);

  const [typed, setTyped] = useState(false);
  const [pin, setPin] = useState('');
  const [checking, setChecking] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  const checkGen = useRef(0);
  const [viewer, setViewer] = useState(false);
  const [fit, setFit] = useState<FitMode>('fill');
  const [options, setOptions] = useState(false);
  const [panel, setPanel] = useState<'none' | 'map' | 'drive'>('none');
  const [target, setTarget] = useState<[number, number] | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmHome, setConfirmHome] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const session = useRef<LiveSession | null>(null);
  const motion = useRef<MotionController | null>(null);

  if (!session.current) {
    session.current = new LiveSession(duid, rerender, (stream) => {
      lastStream.current = stream;
      const v = videoRef.current;
      if (v && v.srcObject !== stream) v.srcObject = stream;
    }, allowed);
  }
  // The controller is made for what the model allows; a model that arrives later gets a new one.
  const motionFor = useRef<boolean | null>(null);
  if (!motion.current || motionFor.current !== controls) {
    motion.current?.dispose();
    motion.current = new MotionController(duid, () => session.current?.streaming ?? false, rerender, controls);
    motionFor.current = controls;
  }
  const s = session.current;
  const m = motion.current;

  /** Clears the credential and closes video, as leaving or hiding the app does. */
  const reset = () => {
    checkGen.current++;
    setChecking(false);
    setEntryError(null);
    setPin('');
    setViewer(false);
    setPanel('none');
    setTarget(null);
    void s.endVoice();
    void s.stop();
  };

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      motion.current?.dispose();
      motion.current = null;
      setTesting(false);
      reset();
      rerender();
    };
    const onFs = () => setFullscreen(document.fullscreenElement === stageRef.current && !!stageRef.current);
    document.addEventListener('visibilitychange', onHide);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      document.removeEventListener('fullscreenchange', onFs);
      motion.current?.dispose();
      void session.current?.stop();
      session.current = null;
      motion.current = null;
    };
  }, [duid]); // eslint-disable-line react-hooks/exhaustive-deps

  // The robot's audio plays only during a call; the element stays muted so video can start on its own.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.srcObject !== lastStream.current) v.srcObject = lastStream.current;
    v.muted = !(s.voice.active && !s.voice.robotMuted);
  });

  if (!snap) return <div className="tab-page"><div className="empty"><Spinner big /></div></div>;
  if (!available) {
    return (
      <div className="tab-page">
        <Message text={
          !enabled ? 'Video is experimental and off. Turn on Experimental video in Settings to use it on supported robots.'
            : typeof RTCPeerConnection === 'undefined' ? "This browser has no WebRTC, so the live view can't run here."
              : `${snap.modelName ?? snap.model ?? 'This robot'} has no remote viewing that LocalRock recognises.`
        }>
          {!enabled && <Link to={{ name: 'settings' }} className="btn secondary">Open Settings</Link>}
        </Message>
      </div>
    );
  }

  const submit = (credential: string) => {
    if (!credential.trim() || checking || !allowed()) return;
    const gen = ++checkGen.current;
    setChecking(true);
    setEntryError(null);
    void s.checkCredential(credential).then(() => {
      if (checkGen.current !== gen) return;
      setViewer(true);
      s.start(credential, OEM_MATCH, 'HD');
    }).catch((e: Error) => {
      if (checkGen.current === gen) setEntryError(e.message || 'Could not check the camera credential. Check the connection and try again.');
    }).finally(() => { if (checkGen.current === gen) setChecking(false); });
  };

  const restart = (test: CameraVideoTest, quality: CameraVideoQuality) => {
    void s.stop().then(() => s.start(pin, test, quality));
  };

  const endVideo = async (dock: boolean) => {
    setConfirmEnd(false);
    setConfirmHome(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    if (controls) await m.endViewing(dock);
    reset();
  };

  const st = snap.status;
  const action = controls ? cameraCleaningAction(st.state, st.inCleaning, st.errorCode) : null;
  const streaming = s.state.kind === 'streaming';
  const docked = st.state === 8 || st.state === 100;

  if (!viewer) {
    return (
      <div className="tab-page camera-tab">
        <div className="camera-stage">
          <div className="col camera-entry">
            {support === 'EXPERIMENTAL' && (
              <div className="callout small">
                <Icon name="info" />
                <div className="col tight">
                  <span>Video on this model is untested with LocalRock. Driving, Go, docking and cleaning controls stay off here.</span>
                  <label className="row small" style={{ gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={testing}
                      onChange={(e) => {
                        setTesting(e.target.checked);
                        // Unchecking cancels a pending check and clears the entry.
                        if (!e.target.checked) reset();
                      }}
                    />
                    Enable video and audio testing for this robot
                  </label>
                </div>
              </div>
            )}
            <p>
              Enter the camera {typed ? 'PIN' : 'pattern'} you set for this robot in the official app. LocalRock checks it with the
              robot and keeps it only while this page is open.
            </p>
            <p className="muted small mono">{snap.model ?? 'unknown model'}{snap.firmware ? ` · firmware ${snap.firmware}` : ''}</p>
            {typed ? (
              <form className="col" onSubmit={(e) => { e.preventDefault(); submit(pin); }}>
                <Field label="Camera PIN">
                  <input className="input" type="password" inputMode="numeric" autoComplete="off" value={pin} disabled={!allowed() || checking} onChange={(e) => setPin(e.target.value)} />
                </Field>
                <button type="submit" className="btn" disabled={!pin || !allowed() || checking}>Open video</button>
              </form>
            ) : (
              <>
                {/* An accepted pattern opens the viewer at once. */}
                <PatternInput disabled={!allowed() || checking} onPattern={(p) => { setPin(p); submit(p); }} />
                <p className="small muted">Draw a pattern of at least 4 dots</p>
              </>
            )}
            {checking && <div className="row small"><Spinner /><span>Checking with the robot...</span></div>}
            {entryError && <div className="callout error small"><Icon name="error" /><span>{entryError}</span></div>}
            <button type="button" className="btn ghost" onClick={() => { setTyped((t) => !t); setPin(''); setEntryError(null); checkGen.current++; setChecking(false); }}>
              {typed ? 'Draw a pattern instead' : 'Use a numeric PIN'}
            </button>
            <p className="muted tiny">
              Remote viewing has to be switched on once in the official Roborock app, while the robot is on Roborock's servers.
              Driving and Pin-and-Go are available on the S7 MaxV.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const hold = (d: DriveDirection) => (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    m.hold(d);
  };
  const release = () => m.release();
  const drivePad = (
    <div className="drive-pad" aria-label="Drive">
      {(['FORWARD', 'LEFT', 'RIGHT', 'BACKWARD'] as DriveDirection[]).map((d) => (
        <button
          key={d}
          type="button"
          className={`drive-btn ${d.toLowerCase()}`}
          disabled={!streaming || (m.state.busy && !m.state.manual)}
          aria-label={`Hold to drive ${d.toLowerCase()}`}
          onPointerDown={hold(d)}
          onPointerUp={release}
          onPointerCancel={release}
          onLostPointerCapture={release}
          onContextMenu={(e) => e.preventDefault()}
        >
          <Icon name={d === 'FORWARD' ? 'chevronUp' : d === 'BACKWARD' ? 'chevronDown' : d === 'LEFT' ? 'chevronLeft' : 'chevronRight'} />
        </button>
      ))}
    </div>
  );

  return (
    <div className="tab-page camera-tab">
      <div ref={stageRef} className={`camera-stage viewer ${fullscreen ? 'fullscreen' : ''}`}>
        <video ref={videoRef} autoPlay playsInline muted className={`${streaming ? '' : 'hidden'} ${fit}`} />
        <div className="camera-top">
          <span className="chip">{describeState(st.state ?? -1)}{st.battery !== undefined ? ` · ${st.battery}%` : ''}</span>
          {streaming && <span className="live-tag">LIVE</span>}
          {s.voice.active && <span className="chip"><Icon name="mic" size={14} /> Call</span>}
        </div>

        {s.state.kind === 'connecting' && (
          <div className="col camera-center"><Spinner big /><p>{s.state.stage}</p>
            {controls && docked && <p className="small muted">The robot can't stream while docked. Choose a point on the map and Go to move it off the dock.</p>}
          </div>
        )}
        {s.state.kind === 'stopping' && <div className="col camera-center"><Spinner big /><p>Closing video...</p></div>}
        {s.state.kind === 'failed' && (
          <div className="col camera-center" style={{ maxWidth: 520, textAlign: 'center' }}>
            <Icon name="videocamOff" size={48} />
            <p>{s.state.message}</p>
            <div className="btn-row">
              <button type="button" className="btn" onClick={() => restart(OEM_MATCH, 'HD')}>Retry</button>
              <button type="button" className="btn secondary" onClick={() => restart(OEM_MATCH, 'SD')}>Retry in SD</button>
            </div>
          </div>
        )}
        {s.state.kind === 'idle' && (
          <div className="col camera-center">
            <p>Video is closed.</p>
            <button type="button" className="btn" onClick={() => restart(OEM_MATCH, 'HD')}>Open video</button>
          </div>
        )}

        {panel === 'map' && controls && map && (
          <div className="camera-map">
            <MapView
              map={map}
              showLabels={false}
              overlayKey={target}
              onTap={(p) => setTarget(p.mm)}
              overlay={({ ctx, api }) => {
                if (!target) return;
                const q = api.toScreen(target[0], target[1]);
                ctx.fillStyle = '#e53935';
                ctx.beginPath(); ctx.arc(q.x, q.y, 8, 0, Math.PI * 2); ctx.fill();
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
              }}
            />
            <div className="btn-row camera-map-actions">
              <button type="button" className="btn sm" disabled={!target || m.state.busy} onClick={() => { if (target) m.goTo(target[0], target[1], snap.currentFloorFlag); }}>Go</button>
              <button type="button" className="btn secondary sm" onClick={() => setPanel('none')}>Close map</button>
            </div>
          </div>
        )}
        {panel === 'drive' && controls && <div className="camera-drive">{drivePad}</div>}

        <div className="camera-bar">
          {controls && (
            <>
              {action && action !== 'START' && (
                <button type="button" className="btn secondary sm" disabled={m.state.busy} onClick={() => m.cleaning(action)}>
                  <Icon name={action === 'PAUSE' ? 'pause' : 'play'} />{CAMERA_CLEANING_LABEL[action]}
                </button>
              )}
              <button type="button" className="btn secondary sm" aria-pressed={panel === 'map'} onClick={() => setPanel(panel === 'map' ? 'none' : 'map')}><Icon name="map" />Map</button>
              <button type="button" className="btn secondary sm" aria-pressed={panel === 'drive'} disabled={!streaming} onClick={() => setPanel(panel === 'drive' ? 'none' : 'drive')}><Icon name="gamepad" />Controls</button>
              <button type="button" className="btn secondary sm" disabled={m.state.busy && !m.state.manual} onClick={() => m.stop(true)}><Icon name="stop" />Stop movement</button>
              <button type="button" className="btn secondary sm" disabled={m.state.busy} onClick={() => setConfirmHome(true)}><Icon name="home" />Home</button>
            </>
          )}
          <span className="grow" />
          <IconButton
            icon={s.voice.active ? 'callEnd' : 'mic'}
            label={s.voice.active ? 'End call' : 'Start call'}
            variant={s.voice.active ? 'danger' : 'filled'}
            disabled={!streaming || s.voice.busy}
            onClick={() => void (s.voice.active ? s.endVoice() : s.startVoice())}
          />
          <IconButton icon={fullscreen ? 'fullscreenExit' : 'fullscreen'} label={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
            else void stageRef.current?.requestFullscreen().catch(() => undefined);
          }} />
          <IconButton icon="tune" label="Video options" onClick={() => setOptions(true)} />
          <button type="button" className="btn danger sm" onClick={() => (controls && m.state.startedActivity ? setConfirmEnd(true) : void endVideo(false))}>End video</button>
        </div>
        {(m.state.progress || m.state.error || s.voice.error || s.cleanupWarning) && (
          <div className="camera-notes">
            {m.state.progress && <div className="callout small"><Spinner /><span>{m.state.progress}</span></div>}
            {m.state.error && <div className="callout error small"><Icon name="error" /><span>{m.state.error}</span></div>}
            {s.voice.error && <div className="callout error small"><Icon name="error" /><span>{s.voice.error}</span></div>}
            {s.cleanupWarning && <div className="callout small"><Icon name="warning" /><span>{s.cleanupWarning}</span></div>}
          </div>
        )}
      </div>

      {options && (
        <Dialog title="Video options" onClose={() => setOptions(false)} actions={<button type="button" className="btn" onClick={() => setOptions(false)}>Done</button>}>
            <div className="col">
              <p className="muted small">
                Requested quality: {s.quality}. Received frames: {s.diagnostics.width && s.diagnostics.height ? `${s.diagnostics.width} × ${s.diagnostics.height}` : 'not yet'}.
                Switching quality live is not reliable on the S7 MaxV, so it reconnects instead.
              </p>
              <div className="segmented block" role="group" aria-label="Framing">
                <button type="button" aria-pressed={fit === 'fill'} onClick={() => setFit('fill')}>Fill</button>
                <button type="button" aria-pressed={fit === 'fit'} onClick={() => setFit('fit')}>Fit</button>
              </div>
              <button type="button" className="btn secondary sm" onClick={() => { setOptions(false); restart(OEM_MATCH, 'SD'); }}>Reconnect in SD</button>

              <h4>Voice call</h4>
              <p className="muted small">Audio is off when video starts. A call uses this browser's microphone and plays the robot's sound here; nothing is recorded.</p>
              <div className="btn-row">
                <button type="button" className="btn secondary sm" disabled={!streaming || s.voice.busy} onClick={() => void (s.voice.active ? s.endVoice() : s.startVoice())}>{s.voice.active ? 'End call' : 'Start call'}</button>
                <label className="row small"><input type="checkbox" disabled={!s.voice.active} checked={!s.voice.micMuted} onChange={(e) => s.muteMic(!e.target.checked)} /> Microphone</label>
                <label className="row small"><input type="checkbox" disabled={!s.voice.active} checked={!s.voice.robotMuted} onChange={(e) => s.muteRobot(!e.target.checked)} /> Robot audio</label>
              </div>
              <span className="field-label">Robot speaker volume</span>
              <div className="segmented block" role="group" aria-label="Robot speaker volume">
                {VOLUMES.map((v) => (
                  <button key={v} type="button" aria-pressed={s.voice.volume === v} disabled={!s.voice.active || s.voice.volumeBusy} onClick={() => void s.setSpeakerVolume(v)}>{v}%</button>
                ))}
              </div>

              <h4>Connection tests (SD)</h4>
              <p className="muted small">If video won't connect, try another signalling choice. Each one reconnects.</p>
              <div className="col tight">
                {CAMERA_VIDEO_TESTS.map((t) => (
                  <button key={t.code} type="button" className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => { setOptions(false); restart(t, 'SD'); }}>
                    {t.code} · {t.label} <span className="muted small">{t.description}</span>
                  </button>
                ))}
              </div>
            </div>
        </Dialog>
      )}
      {confirmEnd && (
        <Dialog
          title="End video?"
          onClose={() => setConfirmEnd(false)}
          actions={(
            <>
              <button type="button" className="btn secondary" onClick={() => setConfirmEnd(false)}>Cancel</button>
              <button type="button" className="btn secondary" onClick={() => void endVideo(false)}>End video</button>
              <button type="button" autoFocus className="btn" onClick={() => void endVideo(true)}>End and return to dock</button>
            </>
          )}
        >
          <p>You moved the robot from this viewer. Ending video stops that movement; a cleaning task that was already running continues.</p>
        </Dialog>
      )}
      {confirmHome && (
        <ConfirmDialog
          title="Return to dock?"
          text="This ends video and sends the robot back to its dock."
          confirm="Return to dock"
          onConfirm={() => void endVideo(true)}
          onClose={() => setConfirmHome(false)}
        />
      )}
    </div>
  );
}

function Message({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="col" style={{ alignItems: 'center', padding: 24, textAlign: 'center' }}>
      <Icon name="videocamOff" size={48} />
      <p className="center" style={{ maxWidth: 460 }}>{text}</p>
      {children}
    </div>
  );
}

/**
 * Newer robots take the camera PIN as a pattern on a 3x3 grid; the dots are numbered 1-9 row by
 * row and the drawn order becomes the digit string.
 */
function PatternInput({ onPattern, disabled }: { onPattern: (digits: string) => void; disabled?: boolean }) {
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
      style={disabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
      aria-label="Pattern grid"
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
