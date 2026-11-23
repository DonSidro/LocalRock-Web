import { useEffect, useState } from 'react';
import type { OnboardingDevice, OnboardingState } from '../../../shared/api';
import { get, post } from '../api';
import { Icon } from '../icons';
import { navigate } from '../router';
import { attempt } from '../store';
import { Field, PageHeader, Spinner } from '../ui';

/*
 * Add vacuum, from LocalRock's AddVacuumScreen.kt. The phone app joins the robot's hotspot by
 * itself; a computer can't, so the steps are split where you switch networks.
 */

interface OnboardingInfo {
  /** The name the robot will remember for the server, and the limit its camera and Matter requests have. */
  stackName?: string | null;
  stackNameLimit?: number;
  state: OnboardingState;
  timezones: string[];
  hasAdminPassword: boolean;
}

export function AddVacuumScreen({ preselect = null }: { preselect?: string | null }) {
  const [info, setInfo] = useState<OnboardingInfo | null>(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [devices, setDevices] = useState<OnboardingDevice[]>([]);
  const [duid, setDuid] = useState<string | null>(preselect);
  // The home Wi-Fi name is remembered in this browser for the next robot (the password is not).
  const [ssid, setSsid] = useState(() => { try { return localStorage.getItem('localrock.wifiSsid') ?? ''; } catch { return ''; } });
  const [hotspot, setHotspot] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [busy, setBusy] = useState(false);

  const refresh = () => get<OnboardingInfo>('/api/onboarding').then(setInfo).catch(() => undefined);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(t);
  }, []);
  // The robot only knows a short list of zones; use one with the same UTC offset as this browser.
  useEffect(() => {
    if (!info || info.timezones.includes(timezone)) return;
    const local = offsetMinutes(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setTimezone(info.timezones.find((tz) => offsetMinutes(tz) === local) ?? 'America/New_York');
  }, [info, timezone]);

  const state = info?.state;
  const step = state?.step ?? 'idle';
  const prepared = step === 'prepared' || step === 'sending-hello' || step === 'sending-wifi' || step === 'waiting' || step === 'done';

  const loadDevices = async () => {
    setBusy(true);
    await attempt(async () => {
      const list = await post<OnboardingDevice[]>('/api/onboarding/devices', { adminPassword: adminPassword.trim() });
      setDevices(list);
      if (!duid || !list.some((d) => d.duid === duid)) setDuid(list[0]?.duid ?? null);
      if (list.length === 0) throw new Error('No vacuums are available for onboarding yet. Finish the cloud import / fetch-data step on the server first.');
    });
    setBusy(false);
  };

  const prepare = async () => {
    setBusy(true);
    await attempt(() => post('/api/onboarding/prepare', { duid }), 'Pairing session started on the server');
    await refresh();
    setBusy(false);
  };

  const send = async () => {
    setBusy(true);
    try { localStorage.setItem('localrock.wifiSsid', ssid.trim()); } catch { /* not kept */ }
    await attempt(() => post('/api/onboarding/send', { ssid: ssid.trim(), password: wifiPassword, timezone, hotspot: hotspot.trim() || null }));
    await refresh();
    setBusy(false);
  };

  return (
    <div className="page">
      <PageHeader title="Add vacuum" sub="Put the robot in pairing mode, then connect it to your home Wi-Fi through your server." />
      <div className="page-body narrow col loose">

        <section className="panel col">
          <h3>1. Pick the vacuum on your server</h3>
          <p className="muted small">The server's admin password. The vacuum must already be in the server's inventory (cloud import).</p>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="grow">
              <Field label="Admin password" hint={info?.hasAdminPassword && !adminPassword ? 'Saved. Leave empty to use it.' : undefined}>
                <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
              </Field>
            </div>
            <button type="button" className="btn secondary" style={{ marginBottom: info?.hasAdminPassword && !adminPassword ? 22 : 0 }} disabled={busy || state?.running} onClick={() => void loadDevices()}>Load vacuums</button>
          </div>
          {devices.length > 0 && (
            <Field label="Vacuum">
              <select value={duid ?? ''} onChange={(e) => setDuid(e.target.value)} disabled={busy || state?.running}>
                {devices.map((d) => <option key={d.duid} value={d.duid}>{d.name}{d.connected ? ' (connected)' : ''}{d.hasPublicKey ? '' : ' (no key yet)'}</option>)}
              </select>
            </Field>
          )}
          <button type="button" className="btn" disabled={busy || !duid || state?.running} onClick={() => void prepare()}>Start pairing session</button>
          {prepared && <p className="good-text small row"><Icon name="checkCircle" size={18} />Session started.</p>}
        </section>

        <section className="panel col" style={{ opacity: prepared ? 1 : 0.6 }}>
          <h3>2. Send your Wi-Fi to the robot</h3>
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Put the robot in pairing mode (see the robot's manual; usually hold the two outer buttons until it announces Wi-Fi reset).</li>
            <li>Connect this computer to the robot's Wi-Fi, named like <b>roborock-vacuum-...</b>. A computer with a wired network connection can keep it while doing this.</li>
            <li>Enter your home Wi-Fi below and press Send.</li>
          </ol>
          <Field label="Home Wi-Fi name (SSID)">
            <input value={ssid} onChange={(e) => setSsid(e.target.value)} disabled={!prepared || state?.running} />
          </Field>
          <Field label="Home Wi-Fi password">
            <div className="row">
              <input className="input grow"
                type={showPassword ? 'text' : 'password'} value={wifiPassword} onChange={(e) => setWifiPassword(e.target.value)} disabled={!prepared || state?.running} />
              <button type="button" className="btn secondary" onClick={(e) => { e.preventDefault(); setShowPassword((v) => !v); }}>{showPassword ? 'Hide' : 'Show'}</button>
            </div>
          </Field>
          <Field label="Timezone">
            <select value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={!prepared || state?.running}>
              {(info?.timezones ?? []).map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </Field>
          <Field label="Robot hotspot name (optional)" hint="Some robots only answer with a key taken from their hotspot name (ending in _miap...). LocalRock reads it from this computer's Wi-Fi when it can.">
            <input value={hotspot} placeholder="roborock-vacuum-a70_miap1A2B" onChange={(e) => setHotspot(e.target.value)} disabled={!prepared || state?.running} />
          </Field>
          {info?.stackName && info.stackNameLimit && info.stackName.length > info.stackNameLimit && (
            <p className="muted small">The robot will remember this server as "{info.stackName}". Pairing works with that name, but the robot's camera and Matter requests are limited to {info.stackNameLimit} characters including the trailing slash, with no port. A name like api-r.example.com on port 443 fits.</p>
          )}
          <button type="button" className="btn" disabled={busy || !prepared || state?.running || !ssid.trim() || !wifiPassword} onClick={() => void send()}>Send to robot</button>
        </section>

        <section className="panel col">
          <h3>3. Wait for the robot</h3>
          <p className="muted small">Reconnect this computer to your home network. The robot joins your Wi-Fi and reports to the server; this page follows the server for about 5 minutes.</p>
          <div className="row">
            {state?.running && <Spinner />}
            <span className="small">{stepText(step)}</span>
          </div>
          {state?.serverStatus && <p className="small muted">{state.serverStatus}</p>}
          {state?.running && <button type="button" className="btn secondary" onClick={() => void attempt(() => post('/api/onboarding/cancel')).then(refresh)}>Stop waiting</button>}
        </section>

        {state?.error && (
          <div className="callout error col">
            <h3>Pairing failed</h3>
            <p>{state.error}</p>
          </div>
        )}
        {state?.result && (
          <div className="callout primary col">
            <h3>Robot connected</h3>
            <p>{state.result}</p>
            <button type="button" className="btn" onClick={() => { void post('/api/devices/refresh').catch(() => undefined); navigate({ name: 'devices' }); }}>Go to my vacuums</button>
          </div>
        )}
      </div>
    </div>
  );
}

function offsetMinutes(timeZone: string): number | null {
  try {
    const now = new Date();
    const at = (tz: string) => Date.parse(now.toLocaleString('en-US', { timeZone: tz }));
    return Math.round((at(timeZone) - at('UTC')) / 60_000);
  } catch {
    return null;
  }
}

function stepText(step: string): string {
  switch (step) {
    case 'preparing': return 'Starting the session on the server...';
    case 'prepared': return 'Ready to send the Wi-Fi details.';
    case 'sending-hello': return 'Saying hello to the robot...';
    case 'sending-wifi': return 'Sending the Wi-Fi details...';
    case 'waiting': return 'Waiting for the robot to reach the server...';
    case 'done': return 'Finished.';
    default: return 'Not started.';
  }
}
