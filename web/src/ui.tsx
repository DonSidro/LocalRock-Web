import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { href, navigate, type Route } from './router';
import { dismissToast, useStore } from './store';

/* Shared building blocks for a desktop-first web page. */

/** A real link: middle-click and Ctrl-click open a new tab, a plain click stays in the page. */
export function Link({ to, replace, className, title, children, current }: {
  to: Route;
  replace?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
  current?: boolean;
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to, replace);
  };
  return (
    <a href={href(to)} className={className} title={title} onClick={onClick} aria-current={current ? 'page' : undefined}>
      {children}
    </a>
  );
}

export function PageHeader({ title, sub, actions, children }: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-title">
        <h1 className="ellipsis">{title}</h1>
        {sub ? <span className="muted small ellipsis">{sub}</span> : null}
        {children}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function IconButton({ icon, label, onClick, disabled, variant, busy, shortcut }: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'outlined' | 'filled' | 'danger';
  busy?: boolean;
  /** Shown in the tooltip. */
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${variant ?? ''}`}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      onClick={onClick}
      disabled={disabled}
    >
      {busy ? <span className="spinner" /> : <Icon name={icon} />}
    </button>
  );
}

export function Switch({ checked, onChange, disabled, label }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span className="thumb" />
    </span>
  );
}

/** A centred window over the page. Escape and a click outside close it. */
export function Modal({ title, onClose, children, footer, wide }: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEscape(onClose);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2 className="grow">{title}</h2>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Dialog({ title, onClose, children, actions }: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
}) {
  useEscape(onClose);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal small" role="alertdialog" aria-modal="true">
        <div className="modal-head"><h2>{title}</h2></div>
        <div className="modal-body col">{children}</div>
        <div className="modal-foot">{actions}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, text, confirm, danger, onConfirm, onClose }: {
  title: string;
  text: ReactNode;
  confirm: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="button" autoFocus className={`btn ${danger ? 'danger' : ''}`} onClick={() => { onClose(); onConfirm(); }}>{confirm}</button>
        </>
      )}
    >
      <p>{text}</p>
    </Dialog>
  );
}

/** One choice out of a few, all visible. */
export function Segmented<T extends string | number>({ label, options, value, onChange, disabled, block }: {
  label: string;
  options: Array<[T, string]>;
  value: T | null | undefined;
  onChange: (v: T) => void;
  disabled?: boolean;
  block?: boolean;
}) {
  return (
    <div className={`segmented ${block ? 'block' : ''}`} role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={String(v)} type="button" aria-pressed={v === value} disabled={disabled} onClick={() => { if (v !== value) onChange(v); }}>{l}</button>
      ))}
    </div>
  );
}

/** A native drop-down. A value the robot reports but the list doesn't know shows as "Other". */
export function Select<T extends string | number>({ label, options, value, onChange, disabled }: {
  label: string;
  options: Array<[T, string]>;
  value: T | null | undefined;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const index = options.findIndex(([v]) => v === value);
  return (
    <select
      className="select"
      aria-label={label}
      value={index}
      disabled={disabled}
      onChange={(e) => { const o = options[Number(e.target.value)]; if (o) onChange(o[0]); }}
    >
      {index < 0 && <option value={-1} disabled>Other</option>}
      {options.map(([v, l], i) => <option key={String(v)} value={i}>{l}</option>)}
    </select>
  );
}

export function Field({ label, hint, invalid, children }: { label: string; hint?: ReactNode; invalid?: boolean; children: ReactNode }) {
  return (
    <label className={`field ${invalid ? 'invalid' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

/** A titled box in a page or the inspector column. */
export function Panel({ title, actions, children, className, id }: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`panel ${className ?? ''}`} id={id}>
      {title !== undefined && (
        <div className="panel-head">
          <h2 className="grow">{title}</h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** A settings line: what it is on the left, the control on the right. */
export function SettingRow({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="grow">
        <div className="setting-title">{title}</div>
        {sub ? <div className="muted small">{sub}</div> : null}
      </div>
      {children ? <div className="setting-control">{children}</div> : null}
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** A button that opens a small menu below it. */
export function MenuButton({ label, icon = 'more', text, items }: { label: string; icon?: IconName; text?: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {text ? (
        <button type="button" className="btn secondary" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name={icon} />{text}<Icon name="arrowDropDown" />
        </button>
      ) : (
        <button type="button" className="icon-btn outlined" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name={icon} />
        </button>
      )}
      {open && (
        <div className="menu" role="menu">
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" disabled={it.disabled} className={it.danger ? 'danger' : ''} onClick={() => { setOpen(false); it.onClick(); }}>
              {it.icon ? <Icon name={it.icon} /> : <span style={{ width: 18 }} />}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Empty({ icon, title, text, children }: { icon: IconName; title: string; text?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <h3>{title}</h3>
      {text ? <p className="muted small">{text}</p> : null}
      {children}
    </div>
  );
}

export function Spinner({ big }: { big?: boolean }) {
  return <span className={`spinner ${big ? 'big' : ''}`} role="status" aria-label="Loading" />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
          <Icon name={t.error ? 'error' : 'checkCircle'} />
          <span className="grow">{t.text}</span>
          <IconButton icon="close" label="Dismiss" onClick={() => dismissToast(t.id)} />
        </div>
      ))}
    </div>
  );
}

export function useEscape(onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** A text field or drop-down has the keyboard; a checkbox or switch does not. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  if (!t) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'range'].includes((t as HTMLInputElement).type);
}

/** Single-key shortcuts, ignored while typing in a field or with a window open. */
export function useShortcuts(keys: Record<string, () => void>, enabled = true): void {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (isTypingTarget(e.target) || document.querySelector('.scrim')) return;
      const action = ref.current[e.key];
      if (action) {
        e.preventDefault();
        action();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatArea(mm2: number): string {
  const tenths = Math.floor(mm2 / 100_000);
  return `${Math.floor(tenths / 10)}.${tenths % 10} m²`;
}
