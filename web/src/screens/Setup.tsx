import { useState, type FormEvent, type ReactNode } from 'react';
import { post } from '../api';
import { Icon } from '../icons';
import { attempt, useStore } from '../store';
import { Field, Switch } from '../ui';

/* First run: the page password (when set), the server address, then sign in. */

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="row" style={{ gap: 12 }}>
          <span className="brand-mark big"><Icon name="robot" /></span>
          <div>
            <h1>LocalRock</h1>
            <p className="muted small">Your Roborock vacuums, on your own network</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PasswordScreen({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/login', { password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Centered>
      <form className="col" onSubmit={submit}>
        <h2>Unlock</h2>
        <p className="muted small">This LocalRock Web is protected with a password (LOCALROCK_PASSWORD).</p>
        <Field label="Password" invalid={!!error} hint={error ?? undefined}>
          <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button type="submit" className="btn block" disabled={busy || !password}>{busy ? 'Checking...' : 'Unlock'}</button>
      </form>
    </Centered>
  );
}

export function ServerScreen({ onDone, onCancel }: { onDone?: () => void; onCancel?: () => void }) {
  const app = useStore((s) => s.app);
  const [url, setUrl] = useState(app?.serverBaseUrl ?? '');
  const [selfSigned, setSelfSigned] = useState(app?.allowSelfSigned ?? false);
  const [busy, setBusy] = useState(false);
  const trimmed = url.trim();
  const looksValid = /^https?:\/\/\S+/i.test(trimmed);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await attempt(() => post('/api/server', { url: trimmed, allowSelfSigned: selfSigned }));
    setBusy(false);
    if (ok) onDone?.();
  };
  return (
    <Centered>
      <form className="col" onSubmit={submit}>
        <h2>Connect to your server</h2>
        <p className="muted small">
          LocalRock talks to your self-hosted local_roborock_server instead of Roborock's cloud. Enter the address
          you set it up with, for example https://192.168.1.10:555.
        </p>
        <Field label="Server address" invalid={trimmed.length > 0 && !looksValid} hint={trimmed.length > 0 && !looksValid ? 'Start with http:// or https://' : undefined}>
          <input type="url" autoFocus placeholder="https://192.168.1.10:555" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <div className="row" style={{ gap: 12 }}>
          <div className="grow">
            <div>Allow self-signed certificates</div>
            <div className="muted small">Only if your server uses a certificate this computer does not trust. Prefer LOCALROCK_CA_FILE.</div>
          </div>
          <Switch label="Allow self-signed certificates" checked={selfSigned} onChange={setSelfSigned} />
        </div>
        <div className="btn-row">
          <button type="submit" className="btn grow" disabled={busy || !looksValid}>{busy ? 'Saving...' : 'Continue'}</button>
          {onCancel && <button type="button" className="btn secondary" onClick={onCancel}>Cancel</button>}
        </div>
        <a href="https://github.com/Python-roborock/local_roborock_server" target="_blank" rel="noreferrer noopener" className="small center">Server setup guide</a>
      </form>
    </Centered>
  );
}

export function LoginScreen() {
  const app = useStore((s) => s.app)!;
  const [email, setEmail] = useState(app.email ?? '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editServer, setEditServer] = useState(false);
  if (editServer) return <ServerScreen onDone={() => setEditServer(false)} onCancel={() => setEditServer(false)} />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/login', { email: email.trim(), code: code.trim() });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Centered>
      <form className="col" onSubmit={submit}>
        <h2>Sign in</h2>
        <p className="muted small">Use the email and login code from your server setup.</p>
        <Field label="Email">
          <input type="email" autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Login code" invalid={!!error} hint={error ?? undefined}>
          <input type="password" autoComplete="current-password" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <button type="submit" className="btn block" disabled={busy || !email.trim() || !code.trim()}>{busy ? 'Signing in...' : 'Sign in'}</button>
        <div className="row between small">
          <span className="muted ellipsis">Server: {app.serverBaseUrl}</span>
          <button type="button" className="btn ghost sm" onClick={() => setEditServer(true)}>Change</button>
        </div>
      </form>
    </Centered>
  );
}
