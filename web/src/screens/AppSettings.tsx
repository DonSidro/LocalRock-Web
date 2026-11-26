import { useEffect, useState } from 'react';
import { get, post } from '../api';
import { attempt, toast, useStore } from '../store';
import { setThemeMode, useThemeMode, type ThemeMode } from '../theme';
import { ConfirmDialog, PageHeader, Panel, Segmented, SettingRow, Switch } from '../ui';
import { setVideoEnabled, useVideoEnabled } from '../camera/prefs';
import { ServerScreen } from './Setup';

/* App-wide settings: server, appearance, robot alerts, this page, about. */

export function AppSettingsScreen() {
  const app = useStore((s) => s.app)!;
  const theme = useThemeMode();
  const video = useVideoEnabled();
  const [editServer, setEditServer] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [pagePassword, setPagePassword] = useState(false);
  const [permission, setPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

  useEffect(() => {
    get<{ required: boolean }>('/api/auth').then((r) => setPagePassword(r.required)).catch(() => undefined);
  }, []);

  if (editServer) return <ServerScreen onDone={() => setEditServer(false)} onCancel={() => setEditServer(false)} />;

  const notify = (change: Record<string, boolean>) => void attempt(() => post('/api/notify', change));

  const enableAlerts = async (on: boolean) => {
    if (!on) return notify({ enabled: false });
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      const result = await Notification.requestPermission();
      setPermission(result);
    }
    notify({ enabled: true });
  };

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <div className="page-body narrow col">
        <Panel title="Server">
          <div className="setting-list">
            <SettingRow title="Server address" sub={<span className="mono">{app.serverBaseUrl}</span>}>
              <button type="button" className="btn secondary sm" onClick={() => setEditServer(true)}>Change</button>
            </SettingRow>
            <SettingRow title="Self-signed certificates" sub={app.allowSelfSigned ? 'Allowed' : 'Not allowed (recommended)'}>
              <button type="button" className="btn secondary sm" onClick={() => setEditServer(true)}>Change</button>
            </SettingRow>
            <SettingRow title="Account" sub={app.email ? `Signed in as ${app.email}` : 'Signed in'}>
              <button type="button" className="btn secondary sm" onClick={() => setConfirmLogout(true)}>Sign out</button>
            </SettingRow>
          </div>
        </Panel>

        <Panel title="Appearance">
          <SettingRow title="Theme" sub="System follows your computer's light or dark setting.">
            <Segmented
              label="Theme"
              options={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as Array<[ThemeMode, string]>}
              value={theme}
              onChange={setThemeMode}
            />
          </SettingRow>
        </Panel>

        <Panel title="Video">
          <SettingRow
            title="Experimental video"
            sub="Show the Camera tab on robots with official remote viewing. Needs a server with camera support and a reachable TURN endpoint. Kept in this browser."
          >
            <Switch label="Experimental video" checked={video} onChange={setVideoEnabled} />
          </SettingRow>
        </Panel>

        <Panel title="Robot alerts">
          <div className="setting-list">
            <SettingRow
              title="Alerts"
              sub="Errors, finished cleans and dock problems. LocalRock Web watches your robots while it runs and shows alerts in any open tab."
            >
              <Switch label="Alerts" checked={app.notify.enabled} onChange={(v) => void enableAlerts(v)} />
            </SettingRow>
            {app.notify.enabled && (
              <>
                <SettingRow title="Errors and stuck robot">
                  <Switch label="Errors and stuck robot" checked={app.notify.errors} onChange={(v) => notify({ errors: v })} />
                </SettingRow>
                <SettingRow title="Cleaning finished">
                  <Switch label="Cleaning finished" checked={app.notify.finished} onChange={(v) => notify({ finished: v })} />
                </SettingRow>
                <SettingRow title="Dock problems" sub="Water tank empty, dirty tank full, dust bag missing.">
                  <Switch label="Dock problems" checked={app.notify.dock} onChange={(v) => notify({ dock: v })} />
                </SettingRow>
                <SettingRow
                  title="Desktop notifications"
                  sub={
                    permission === 'granted' ? 'Alerts also appear as system notifications while this tab is in the background.'
                      : permission === 'denied' ? 'This browser blocks notifications for this page, so alerts only show inside the page.'
                        : permission === 'unsupported' ? 'This browser has no notifications, so alerts only show inside the page.'
                          : 'Show alerts as system notifications while this tab is in the background.'
                  }
                >
                  {permission === 'default' && (
                    <button type="button" className="btn secondary sm" onClick={() => void Notification.requestPermission().then(setPermission)}>Allow</button>
                  )}
                </SettingRow>
              </>
            )}
          </div>
        </Panel>

        {pagePassword && (
          <Panel title="This page">
            <SettingRow title="Lock LocalRock Web" sub="Ask for the page password again in this browser.">
              <button type="button" className="btn secondary sm" onClick={() => void post('/api/auth/logout').then(() => location.reload(), () => toast('Could not lock', true))}>Lock</button>
            </SettingRow>
          </Panel>
        )}

        <Panel title="About">
          <p><span className="strong">LocalRock Web</span> <span className="muted">{__APP_VERSION__}</span></p>
          <p className="muted small">
            A web version of LocalRock for robot vacuums on a self-hosted local_roborock_server. Not affiliated with
            or endorsed by Roborock. Settings and the server session are stored in the server's data folder.
          </p>
          <div className="btn-row">
            <a className="btn secondary sm" href="https://github.com/DonSidro/LocalRock" target="_blank" rel="noreferrer noopener">LocalRock on GitHub</a>
            <a className="btn secondary sm" href="https://github.com/Python-roborock/local_roborock_server" target="_blank" rel="noreferrer noopener">Server project</a>
          </div>
        </Panel>
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
