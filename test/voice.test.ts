import { describe, expect, it } from 'vitest';
import {
  VOICE_INSTALL_IDLE_POLLS, installSoundParams, nextVoiceIdlePolls, parseCurrentSound, parseSoundProgress, parseVoiceHistory,
  parseVoiceHistorySummary, parseVoicePackList, parseVoiceSwitch, voiceHistoryWindows, voiceInstallStep, voiceLanguageName,
  voiceSwitchParams, type CurrentSound,
} from '../shared/voice.js';

/* Cases copied from LocalRock's VoiceTest and VoicePacksTest. */

describe('voice assistant', () => {
  it('reads the switch and sends it back under the same key', () => {
    expect(parseVoiceSwitch({ data: 1 })).toEqual({ key: 'data', enabled: true });
    expect(parseVoiceSwitch([0])).toEqual({ key: null, enabled: false });
    expect(parseVoiceSwitch({ data: 3 })).toBeNull();
    expect(voiceSwitchParams('data', true)).toEqual({ data: 1 });
  });

  it('reads the chat summary and history, and pages it in windows of 100', () => {
    const expected = { minId: 1, maxId: 1, count: 1 };
    expect(parseVoiceHistorySummary({ min_id: 1, max_id: 1, count: 1 })).toEqual(expected);
    expect(parseVoiceHistorySummary([{ min_id: 1, max_id: 1, count: 1 }])).toEqual(expected);
    expect(parseVoiceHistorySummary(['ok'])).toBeNull();
    expect(parseVoiceHistorySummary(null)).toBeNull();
    const h = parseVoiceHistory({ history: [{ id: 1, ts: 1794594183, text: 'hi', speaker: 2 }, { ts: 3 }] })!;
    expect(h).toEqual([{ id: 1, ts: 1794594183, text: 'hi', speaker: 2 }]);
    expect(voiceHistoryWindows({ minId: 1, maxId: 250, count: 250 })).toEqual([[1, 101], [101, 201], [201, 301]]);
    expect(voiceHistoryWindows({ minId: 0, maxId: 0, count: 0 })).toEqual([]);
  });

  it('names languages as the official Language page does', () => {
    expect(voiceLanguageName('en')).toBe('English');
    expect(voiceLanguageName('en-uk')).toBe('English');
    expect(voiceLanguageName('es_la')).toBe('Español');
    expect(voiceLanguageName('xx')).toBe('xx');
  });
});

describe('voice packs', () => {
  const info = {
    voice_list: [
      { voice_id: 12, version: 1, voice_title: 'Deutsch', voice_pkg_url: 'u2', voice_pkg_md5: 'bb', voice_pri: 2, applicable: ['us', 'de'] },
      { voice_id: 3, version: 7, lang: 'en', voice_title: 'English', voice_sub_title: 'female voice', voice_pkg_url: 'u1', voice_pkg_md5: 'aa', voice_pri: 1, applicable: ['us'] },
      { voice_id: 1, version: 1, voice_title: '普通话', voice_pkg_url: 'u3', voice_pkg_md5: 'cc', voice_pri: 0, applicable: ['prc'] },
    ],
  };

  it('lists the packs for the robot\'s location, by priority', () => {
    const packs = parseVoicePackList(info, 'us')!;
    expect(packs.map((p) => p.id)).toEqual([3, 12]);
    expect(packs[0]).toMatchObject({ title: 'English', subTitle: 'female voice', version: 7, md5: 'aa', lang: 'en' });
    expect(parseVoicePackList(info, 'cn')!.map((p) => p.id)).toEqual([1]);
    expect(parseVoicePackList(info, 'CN')!.map((p) => p.id)).toEqual([1]);
    expect(parseVoicePackList({ code: 502 }, 'us')).toBeNull();
    expect(parseVoicePackList({ voice_list: [{ voice_id: 4, voice_title: 'x', voice_pkg_url: 'u', voice_pkg_md5: 'm' }] }, 'us')!.length).toBe(1);
  });

  it('reads the current sound and the install progress', () => {
    expect(parseCurrentSound([{ sid_in_use: 3, sid_version: 7, sid_in_progress: 0, location: 'us', language: 'en' }])).toEqual({ sidInUse: 3, sidVersion: 7, sidInProgress: 0, location: 'us', language: 'en' });
    expect(parseCurrentSound(['ok'])).toBeNull();
    expect(parseSoundProgress([{ sid_in_progress: 12, progress: 45, state: 1, error: 0 }])).toEqual({ sidInProgress: 12, progress: 45, state: 1, error: 0 });
    expect(parseSoundProgress([{ sid_in_progress: 12 }])).toBeNull();
  });

  it('follows an install like the plugin', () => {
    const idle: CurrentSound = { sidInUse: 3, sidVersion: 7, sidInProgress: 0, location: 'us', language: 'en' };
    const switched: CurrentSound = { ...idle, sidInUse: 12 };
    const p = (sid: number, progress: number, state: number, error: number) => ({ sidInProgress: sid, progress, state, error });
    expect(voiceInstallStep(p(12, 45, 1, 0), null, 12)).toEqual({ kind: 'working', percent: 45 });
    expect(voiceInstallStep(p(12, 100, 2, 0), null, 12)).toEqual({ kind: 'working', percent: 100 });
    expect(voiceInstallStep(p(12, 100, 3, 0), switched, 12)).toEqual({ kind: 'done' });
    expect(voiceInstallStep(null, switched, 12)).toEqual({ kind: 'done' });
    expect(voiceInstallStep(p(0, 0, 0, 0), idle, 12)).toEqual({ kind: 'working', percent: null });
    expect(voiceInstallStep(p(0, 0, 0, 0), idle, 12, VOICE_INSTALL_IDLE_POLLS - 1)).toEqual({ kind: 'working', percent: null });
    expect(voiceInstallStep(p(0, 0, 0, 0), idle, 12, VOICE_INSTALL_IDLE_POLLS)).toEqual({ kind: 'failed', installFailed: false });
    expect(voiceInstallStep(null, null, 12, VOICE_INSTALL_IDLE_POLLS)).toEqual({ kind: 'working', percent: null });
    expect(voiceInstallStep(p(12, 0, 4, 2), idle, 12)).toEqual({ kind: 'failed', installFailed: false });
    expect(voiceInstallStep(p(12, 0, 0, 13), idle, 12)).toEqual({ kind: 'failed', installFailed: false });
    expect(voiceInstallStep(p(12, 0, 4, 5), idle, 12)).toEqual({ kind: 'failed', installFailed: true });
    expect(nextVoiceIdlePolls({ kind: 'working', percent: null }, idle, VOICE_INSTALL_IDLE_POLLS - 2)).toBe(VOICE_INSTALL_IDLE_POLLS - 1);
    expect(nextVoiceIdlePolls({ kind: 'working', percent: null }, null, 2)).toBe(0);
    expect(nextVoiceIdlePolls({ kind: 'working', percent: 40 }, idle, 2)).toBe(0);
  });

  it('builds dnld_install_sound like the plugin', () => {
    const pack = parseVoicePackList(info, 'us')![0]!;
    expect(installSoundParams(pack)).toEqual({ sid: 3, url: 'u1', md5: 'aa', sver: 7, ota_url: '' });
  });
});
