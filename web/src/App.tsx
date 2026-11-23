import { useEffect, useState } from 'react';
import type { DeviceSummary } from '../../shared/api';
import { get, post } from './api';
import { Icon } from './icons';
import { batteryColor, statusLine } from './robotStatus';
import { launchRobotTarget, navigate, parseRoute, useRoute, vacRoute, type Route } from './router';
import { attempt, connect, disconnect, useStore } from './store';
import { ConfirmDialog, IconButton, Link, Spinner, Toasts } from './ui';
import { LoginScreen, PasswordScreen, ServerScreen } from './screens/Setup';
import { DeviceListScreen } from './screens/Devices';
import { AppSettingsScreen } from './screens/AppSettings';
import { AddVacuumScreen } from './screens/AddVacuum';
import { VacuumWorkspace } from './screens/Vacuum';

type Gate = 'checking' | 'password' | 'open';

export function App() {
  const [gate, setGate] = useState<Gate>('checking');

  useEffect(() => {
    const check = () => {
      get<{ required: boolean; signedIn: boolean }>('/api/auth')
        .then((r) => setGate(r.required && !r.signedIn ? 'password' : 'open'))
        .catch(() => setTimeout(check, 2_000));
    };
    check();
    const onAuth = () => { disconnect(); setGate('password'); };
    window.addEventListener('lrw-auth-required', onAuth);
    return () => window.removeEventListener('lrw-auth-required', onAuth);
  }, []);

  useEffect(() => {
    if (gate === 'open') connect();
  }, [gate]);

  return (
    <>
      {gate === 'checking' && <Splash />}
      {gate === 'password' && <PasswordScreen onDone={() => setGate('open')} />}
      {gate === 'open' && <Main />}
      <Toasts />
    </>
  );
}

function Splash({ text }: { text?: string }) {
  return (
    <div className="splash">
      <Icon name="robot" size={48} className="muted" />
      <Spinner big />
      {text ? <p className="muted">{text}</p> : null}
    </div>
  );
}

function Main() {
  const app = useStore((s) => s.app);
  const connected = useStore((s) => s.connected);
  if (!app) return <Splash text={connected ? undefined : 'Connecting to LocalRock Web...'} />;
  if (!app.serverBaseUrl) return <ServerScreen />;
  if (!app.signedIn) return <LoginScreen />;
  return <Shell />;
}

/** Set when the page loaded on the robot list, so the launch decision is made once, against that first page. */
const launchedOnList = parseRoute(location.hash).name === 'devices';
let launchDecided = false;

/** Opens the robot directly on launch (see launchRobotTarget); only once per page load, so the list stays one click away. */
function useLaunchRobot(route: Route): void {
  const devices = useStore((s) => s.devices);
  useEffect(() => {
    if (route.name === 'vacuum') { try { localStorage.setItem('localrock.lastRobot', route.duid); } catch { /* not kept */ } }
  }, [route]);
  useEffect(() => {
    if (launchDecided || devices.length === 0) return;
    launchDecided = true;
    if (!launchedOnList || route.name !== 'devices') return;
    let last: string | null = null;
    try { last = localStorage.getItem('localrock.lastRobot'); } catch { /* none */ }
    const target = launchRobotTarget(devices.filter((d) => d.paired && !d.unpaired).map((d) => d.duid), last);
    // Pushed, not replaced, so Back returns to the list.
    if (target) navigate(vacRoute(target));
  }, [devices]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Sidebar with the robots on the left, the page on the right. Narrow windows get a drawer. */
function Shell() {
  const route = useRoute();
  const [drawer, setDrawer] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const routeKey = JSON.stringify(route);
  useEffect(() => setDrawer(false), [routeKey]);
  useLaunchRobot(route);

  return (
    <div className={`shell ${drawer ? 'drawer-open' : ''}`}>
      <Sidebar route={route} onSignOut={() => setConfirmLogout(true)} />
      <div className="drawer-scrim" onClick={() => setDrawer(false)} />
      <div className="main">
        <div className="mobile-bar">
          <IconButton icon="menu" label="Open navigation" onClick={() => setDrawer(true)} />
          <span className="strong">LocalRock</span>
        </div>
        <Banners />
        <Routes route={route} />
      </div>
      {confirmLogout && (
        <ConfirmDialog
          title="Sign out?"
          text="You'll need the email and login code again to control your vacuums."
          confirm="Sign out"
          danger
          onConfirm={() => void attempt(() => post('/api/logout'))}
          onClose={() => setConfirmLogout(false)}
        />
      )}
    </div>
  );
}

function Sidebar({ route, onSignOut }: { route: Route; onSignOut: () => void }) {
  const devices = useStore((s) => s.devices);
  const refreshing = useStore((s) => s.devicesRefreshing);
  const homeName = useStore((s) => s.app?.homeName);
  const current = route.name === 'vacuum' ? route.duid : null;
  return (
    <nav className="sidebar" aria-label="Main">
      <Link to={{ name: 'devices' }} className="brand">
        <span className="brand-mark"><Icon name="robot" /></span>
        <span className="col tight" style={{ gap: 0, minWidth: 0 }}>
          <span className="strong">LocalRock</span>
          {homeName ? <span className="muted tiny ellipsis">{homeName}</span> : null}
        </span>
      </Link>
      <Link to={{ name: 'devices' }} className="nav-item" current={route.name === 'devices'}>
        <Icon name="grid" />All vacuums
      </Link>
      <div className="nav-section">
        <span className="grow">Vacuums</span>
        <IconButton icon="refresh" label="Refresh the list" busy={refreshing} disabled={refreshing} onClick={() => void attempt(() => post('/api/devices/refresh'))} />
      </div>
      <div className="nav-robots">
        {devices.map((d) => <RobotNavItem key={d.duid} device={d} current={d.duid === current} />)}
        {devices.length === 0 && !refreshing && <p className="muted tiny" style={{ padding: '4px 12px' }}>No vacuums yet.</p>}
      </div>
      <Link to={{ name: 'add' }} className="nav-item" current={route.name === 'add'}>
        <Icon name="add" />Add vacuum
      </Link>
      <div className="grow" />
      <Link to={{ name: 'settings' }} className="nav-item" current={route.name === 'settings'}>
        <Icon name="settings" />Settings
      </Link>
      <button type="button" className="nav-item" onClick={onSignOut}>
        <Icon name="logout" />Sign out
      </button>
    </nav>
  );
}

function RobotNavItem({ device, current }: { device: DeviceSummary; current: boolean }) {
  const snap = useStore((s) => s.vacs[device.duid]);
  const offlineText = device.unpaired ? 'Not paired yet' : !device.paired ? 'Setup incomplete' : device.reachability === 'CHECKING' ? 'Checking...' : device.online ? 'Online' : 'Offline';
  const dot = device.unpaired || !device.paired ? 'var(--error)' : device.online ? 'var(--good)' : 'var(--outline)';
  const line = snap && device.online ? statusLine(snap) : null;
  const battery = snap?.status.battery;
  const inner = (
    <>
      <span className="dot" style={{ background: line?.active ? 'var(--primary)' : dot }} />
      <span className="grow col" style={{ gap: 0, minWidth: 0 }}>
        <span className="ellipsis">{device.name}</span>
        <span className="tiny ellipsis" style={{ color: line?.error ? 'var(--error)' : 'var(--on-surface-variant)' }}>{line?.text ?? offlineText}</span>
      </span>
      {battery !== undefined && device.online && <span className="tiny strong" style={{ color: batteryColor(battery) }}>{battery}%</span>}
    </>
  );
  // A robot the server has never heard from opens Add vacuum with it chosen.
  if (device.unpaired) return <Link to={{ name: 'add', duid: device.duid }} className="nav-item robot" current={false}>{inner}</Link>;
  if (!device.paired) return <div className="nav-item robot disabled" title="This robot has no local key yet. Re-run pairing on your server to control it.">{inner}</div>;
  return <Link to={vacRoute(device.duid)} className="nav-item robot" current={current}>{inner}</Link>;
}

/** Link and session problems, shown above every page. */
function Banners() {
  const app = useStore((s) => s.app)!;
  const connected = useStore((s) => s.connected);
  const [offlineLong, setOfflineLong] = useState(false);
  const linkDown = app.mqttStarted && !app.mqttConnected;

  // The link is down for a moment on every start; only a real outage shows the banner.
  useEffect(() => {
    if (!linkDown) {
      setOfflineLong(false);
      return;
    }
    const t = setTimeout(() => setOfflineLong(true), 5_000);
    return () => clearTimeout(t);
  }, [linkDown]);

  if (!connected) {
    return <div className="banner warn"><Spinner /><span className="grow">Lost the connection to LocalRock Web. Reconnecting...</span></div>;
  }
  if (app.sessionProblem) {
    return <div className="banner error"><Icon name="error" /><span className="grow">{app.sessionProblem}</span></div>;
  }
  if (offlineLong) {
    return (
      <div className="banner warn">
        <Icon name="wifi" />
        <span className="grow">Offline: can't reach the robots' message broker. Reconnecting...</span>
        <button type="button" className="btn secondary sm" onClick={() => void attempt(() => post('/api/mqtt/retry'))}>Retry now</button>
      </div>
    );
  }
  return null;
}

function Routes({ route }: { route: Route }) {
  switch (route.name) {
    case 'devices': return <DeviceListScreen />;
    case 'settings': return <AppSettingsScreen />;
    case 'add': return <AddVacuumScreen />;
    case 'vacuum': return <VacuumWorkspace key={route.duid} duid={route.duid} tab={route.tab} tool={route.tool ?? 'rooms'} />;
  }
}
