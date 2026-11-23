import { useSyncExternalStore } from 'react';

/*
 * Hash routes, so the server only ever serves one page. Every page has its own address, so links
 * can be bookmarked, opened in a new tab and walked with the browser's back and forward.
 */

/** The tabs of a robot's workspace. */
export type VacTab = 'overview' | 'edit' | 'schedule' | 'history' | 'maintenance' | 'settings' | 'camera' | 'remote';
/** What a click on the overview map does: pick rooms, draw zones, or set a Pin & Go target. */
export type MapTool = 'rooms' | 'zones' | 'pin';

export type Route =
  | { name: 'devices' }
  | { name: 'settings' }
  | { name: 'add' }
  | { name: 'vacuum'; duid: string; tab: VacTab; tool?: Exclude<MapTool, 'rooms'> };

const TABS: VacTab[] = ['edit', 'schedule', 'history', 'maintenance', 'settings', 'camera', 'remote'];

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'add') return { name: 'add' };
  if (parts[0] === 'vac' && parts[1]) {
    const duid = parts[1];
    const sub = parts[2];
    if (sub === 'zones' || sub === 'pin') return { name: 'vacuum', duid, tab: 'overview', tool: sub };
    // Older addresses like settings/dock land on the one Settings tab, whose sections they were.
    const tab = TABS.find((t) => t === sub);
    if (tab) return { name: 'vacuum', duid, tab };
    return { name: 'vacuum', duid, tab: 'overview' };
  }
  return { name: 'devices' };
}

export function href(route: Route): string {
  switch (route.name) {
    case 'devices': return '#/';
    case 'settings': return '#/settings';
    case 'add': return '#/add';
    case 'vacuum': {
      const base = `#/vac/${encodeURIComponent(route.duid)}`;
      if (route.tab === 'overview') return route.tool ? `${base}/${route.tool}` : base;
      return `${base}/${route.tab}`;
    }
  }
}

export function vacRoute(duid: string, tab: VacTab = 'overview'): Route {
  return { name: 'vacuum', duid, tab };
}

/**
 * A page with unsaved work can hold navigation. The guard gets the target and returns false to
 * stop it; the page then asks and calls navigate again with force.
 */
type Guard = (to: Route) => boolean;
let guard: Guard | null = null;

export function setLeaveGuard(g: Guard): () => void {
  guard = g;
  return () => { if (guard === g) guard = null; };
}

export function navigate(route: Route, replace = false, force = false): void {
  if (!force && guard && !guard(route)) return;
  const target = href(route);
  if (target === location.hash || (target === '#/' && location.hash === '')) return;
  if (replace) history.replaceState(null, '', target);
  else history.pushState(null, '', target);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (l) => { window.addEventListener('hashchange', l); return () => window.removeEventListener('hashchange', l); },
    () => location.hash,
  );
  return parseRoute(hash);
}
/**
 * Which robot to open on launch, like the app: one paired robot opens at once; with several, the last
 * one opened (remembered in this browser); otherwise the list.
 */
export function launchRobotTarget(paired: string[], last: string | null): string | null {
  if (paired.length === 1) return paired[0]!;
  return last && paired.includes(last) ? last : null;
}
