import { useEffect, useRef, useState } from 'react';
import {
  countdownText, groupedManualCode, matterCanRenewCode, matterCodeAgeKnown, matterFailed, matterFailureText, matterHasCodes,
  matterNeedsKey, matterPollIsDone, type MatterInfo,
} from '../../../shared/matter';
import { encodeQr } from '../../../shared/qr';
import { call } from '../api';
import { toast } from '../store';
import { ConfirmDialog, Modal, Spinner } from '../ui';

/*
 * The Matter setup code as a QR image, from LocalRock's MatterScreen.kt. It follows KeyNotExit,
 * KeyDownloading, Ready and Joined, asking the robot for its key when it has none.
 */

const MAX_POLLS = 45;
const POLL_MS = 2_000;
const CODE_LIFETIME_S = 15 * 60;

/** The QR symbol as SVG squares, with the four-module quiet zone. */
export function QrImage({ text, size = 220 }: { text: string; size?: number }) {
  let qr;
  try { qr = encodeQr(text); } catch { return <p className="error-text">The setup code is too long to show as a QR code.</p>; }
  const n = qr.size + 8;
  let d = '';
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.get(x, y)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" role="img" aria-label="Matter setup QR code" style={{ background: '#fff', borderRadius: 8 }}>
      <path d={d} fill="#000" />
    </svg>
  );
}

export function MatterDialog({ duid, onClose }: { duid: string; onClose: () => void }) {
  const [info, setInfo] = useState<MatterInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [polling, setPolling] = useState(true);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const wantNewCode = useRef(false);
  const infoRef = useRef<MatterInfo | null>(null);
  // Set only when this page watched the code appear, so its age is known; a code found already waiting has an unknown age.
  const [codeMadeAt, setCodeMadeAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // A first look reports a failed key as it is; a retry asks the robot for the key again.
  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    void (async () => {
      setError(null);
      setPolling(true);
      let asked = false;
      const renewing = wantNewCode.current;
      wantNewCode.current = false;
      const oldQr = infoRef.current?.qrPayload ?? null;
      if (renewing) setCodeMadeAt(null);
      let sawWorking = false;
      let pollsSinceAsk = 0;
      try {
        for (let i = 0; i < MAX_POLLS; i++) {
          let current: MatterInfo | null;
          try {
            current = await call<MatterInfo | null>(duid, 'matterStatus');
          } catch (e) {
            if (!cancelled) setError((e as Error).message || 'The robot did not answer');
            return;
          }
          if (cancelled) return;
          infoRef.current = current;
          setInfo(current);
          const state = current?.state ?? null;
          if (state === null) { setError('The robot gave no Matter status'); return; }
          if (!matterHasCodes(state) && !matterFailed(state)) sawWorking = true;
          if (asked) pollsSinceAsk++;
          const unchanged = current!.qrPayload === oldQr;
          if (matterPollIsDone(state, renewing, asked, unchanged, pollsSinceAsk)) {
            if (matterCodeAgeKnown(state, sawWorking, renewing, asked, unchanged)) setCodeMadeAt(Date.now());
            return;
          }
          if (matterNeedsKey(state, attempt, renewing, asked) && !asked) {
            asked = true;
            try {
              await call(duid, 'matterRequestKey');
            } catch (e) {
              if (!cancelled) setError((e as Error).message || 'The robot refused the key request');
              return;
            }
          } else if (matterFailed(state)) {
            return;
          }
          await sleep(POLL_MS);
          if (cancelled) return;
        }
        setError('The robot is still preparing its setup code. Try again in a moment.');
      } finally {
        if (!cancelled) setPolling(false);
      }
    })();
    return () => { cancelled = true; };
  }, [attempt, duid]);

  // Ticks once a second while a code with a known age is on screen.
  useEffect(() => {
    if (codeMadeAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [codeMadeAt]);

  const state = info?.state ?? null;
  const remaining = codeMadeAt !== null ? CODE_LIFETIME_S - (now - codeMadeAt) / 1000 : null;
  const expired = remaining !== null && remaining <= 0;
  const failed = state !== null && matterFailed(state) && !polling;

  return (
    <Modal title="Matter" onClose={onClose} footer={<button type="button" className="btn secondary" onClick={onClose}>Close</button>}>
      <div className="col">
        <p className="muted small">Add the robot to Apple Home, Google Home, Alexa, SmartThings, Home Assistant or any app that supports Matter.</p>
        {error && <div className="callout error"><span>{error}</span></div>}
        {failed && !error && <div className="callout error"><span>{matterFailureText(state)}</span></div>}
        {state === 'Joined' ? (
          <>
            <p>This robot has joined a Matter platform. To add it to another one, share it from the app it joined.</p>
            <button type="button" className="btn secondary danger" onClick={() => setConfirmLeave(true)}>Leave the Matter platform</button>
          </>
        ) : state !== null && matterHasCodes(state) && info?.qrPayload ? (
          <div className="col" style={{ alignItems: 'center' }}>
            <QrImage text={info.qrPayload} />
            {info.manualCode && <div className="strong mono" style={{ fontSize: 20 }}>{groupedManualCode(info.manualCode)}</div>}
            <p className="muted small" style={{ textAlign: 'center' }}>
              {expired ? 'This code has expired. Get a new one to add the robot.'
                : remaining !== null ? `The code is valid for another ${countdownText(remaining)}.`
                  : 'The code is valid for 15 minutes from when the robot made it. Get a new code for a fresh 15 minutes.'}
            </p>
            <div className="btn-row">
              {info.manualCode && <button type="button" className="btn secondary sm" onClick={() => { void navigator.clipboard?.writeText(info.manualCode!).then(() => toast('Code copied')); }}>Copy code</button>}
              {matterCanRenewCode(state) && <button type="button" className="btn secondary sm" disabled={polling} onClick={() => { wantNewCode.current = true; setAttempt((a) => a + 1); }}>Get a new code</button>}
            </div>
          </div>
        ) : polling ? (
          <div className="row"><Spinner /><span>Getting the setup code...</span></div>
        ) : (
          <button type="button" className="btn" onClick={() => setAttempt((a) => a + 1)}>Try again</button>
        )}
      </div>
      {confirmLeave && (
        <ConfirmDialog
          title="Leave the Matter platform?"
          text="The robot is removed from the platform it joined. You can add it again afterwards."
          confirm="Leave"
          danger
          onConfirm={() => {
            void call(duid, 'matterReset').then(() => setAttempt((a) => a + 1)).catch((e: Error) => setError(e.message || 'The robot refused to reset Matter'));
          }}
          onClose={() => setConfirmLeave(false)}
        />
      )}
    </Modal>
  );
}
