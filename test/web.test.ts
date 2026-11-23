import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { md5Hex } from '../web/src/md5.js';
import { parseRoute, href } from '../web/src/router.js';

describe('browser md5', () => {
  it('matches node for the strings the camera hashes', () => {
    for (const s of ['', 'a', '1234', '7412', '123456789', 'The quick brown fox jumps over the lazy dog', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'æøå PIN', '9'.repeat(200)]) {
      expect(md5Hex(s)).toBe(createHash('md5').update(s, 'utf8').digest('hex'));
    }
  });
});

describe('routes', () => {
  it('round-trips every route', () => {
    const routes = [
      { name: 'devices' }, { name: 'settings' }, { name: 'add' },
      { name: 'vacuum', duid: 'A/B c', tab: 'overview' },
      { name: 'vacuum', duid: 'X', tab: 'overview', tool: 'zones' }, { name: 'vacuum', duid: 'X', tab: 'overview', tool: 'pin' },
      ...(['edit', 'schedule', 'history', 'maintenance', 'settings', 'camera', 'remote'] as const).map((tab) => ({ name: 'vacuum', duid: 'X', tab }) as const),
    ] as const;
    for (const r of routes) expect(parseRoute(href(r))).toEqual(r);
    expect(parseRoute('#/nonsense')).toEqual({ name: 'devices' });
  });

  it('sends the old settings sub-pages to the Settings tab', () => {
    expect(parseRoute('#/vac/X/settings/dnd')).toEqual({ name: 'vacuum', duid: 'X', tab: 'settings' });
    expect(parseRoute('#/vac/X/unknown')).toEqual({ name: 'vacuum', duid: 'X', tab: 'overview' });
  });
});

describe('launch', () => {
  it('opens the only robot, or the last one opened', async () => {
    const { launchRobotTarget } = await import('../web/src/router.js');
    expect(launchRobotTarget(['a'], null)).toBe('a');
    expect(launchRobotTarget(['a', 'b'], 'b')).toBe('b');
    expect(launchRobotTarget(['a', 'b'], 'gone')).toBeNull();
    expect(launchRobotTarget(['a', 'b'], null)).toBeNull();
    expect(launchRobotTarget([], 'a')).toBeNull();
  });
});
