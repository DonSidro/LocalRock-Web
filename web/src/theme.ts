import { useSyncExternalStore } from 'react';

/* Light / dark / system, remembered in this browser like the app's Theme setting. */

export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'lrw-theme';
const media = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = new Set<() => void>();

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // storage unavailable
  }
  return 'system';
}

let mode: ThemeMode = readMode();

function apply(): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', isDark() ? '#0f1315' : '#f4f6f7');
}

export function isDark(): boolean {
  return mode === 'dark' || (mode === 'system' && !!media?.matches);
}

export function setThemeMode(next: ThemeMode): void {
  mode = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // remembered for this visit only
  }
  apply();
  for (const l of listeners) l();
}

media?.addEventListener('change', () => {
  apply();
  for (const l of listeners) l();
});
apply();

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => mode);
}

export function useDark(): boolean {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, isDark);
}
