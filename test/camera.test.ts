import { describe, expect, it } from 'vitest';
import {
  cameraAllowsRobotControls, cameraCanConnect, cameraCleaningAction, cameraCleaningCommand, cameraModelSupport, cameraOwner,
  cameraPinAccepted, cameraPinRejected, decodeCameraAnswer, encodeCameraOffer, isAck, rankedCodecs,
} from '../shared/camera.js';

/* Ported from the app's CameraModelSupportTest, CameraCleaningTest, CameraSdpEnvelopeTest and CameraLiveSessionTest (PIN replies). */

describe('camera models', () => {
  it('the S7 MaxV is tested, a known list is experimental, everything else is hidden', () => {
    expect(cameraModelSupport('roborock.vacuum.a27')).toBe('TESTED');
    expect(cameraModelSupport('roborock.vacuum.a144')).toBe('EXPERIMENTAL');
    expect(cameraModelSupport('roborock.vacuum.a70')).toBe('UNAVAILABLE');
    expect(cameraModelSupport(null)).toBe('UNAVAILABLE');
  });

  it('an experimental model connects only after opting in, and never gets robot controls', () => {
    expect(cameraCanConnect('EXPERIMENTAL', false)).toBe(false);
    expect(cameraCanConnect('EXPERIMENTAL', true)).toBe(true);
    expect(cameraCanConnect('TESTED', false)).toBe(true);
    expect(cameraCanConnect('UNAVAILABLE', true)).toBe(false);
    expect(cameraAllowsRobotControls('EXPERIMENTAL')).toBe(false);
    expect(cameraAllowsRobotControls('TESTED')).toBe(true);
  });
});

describe('cleaning from the viewer', () => {
  it('offers pause while cleaning and resume for a paused task, with its own resume command', () => {
    expect(cameraCleaningAction(18, 3, 0)).toBe('PAUSE');
    expect(cameraCleaningAction(10, 3, 0)).toBe('RESUME');
    expect(cameraCleaningAction(10, 0, 0)).toBe('START');
    expect(cameraCleaningAction(8, 0, 0)).toBe('START');
    expect(cameraCleaningAction(8, 0, 5)).toBeNull();
    expect(cameraCleaningCommand('RESUME', 10, 2, 0)).toBe('resume_zoned_clean');
    expect(cameraCleaningCommand('RESUME', 10, 3, 0)).toBe('resume_segment_clean');
    expect(cameraCleaningCommand('RESUME', 10, 1, 0)).toBe('app_start');
  });

  it('a stale button never turns into a different command', () => {
    expect(cameraCleaningCommand('START', 5, 1, 0)).toBeNull();
    expect(cameraCleaningCommand('PAUSE', 10, 1, 0)).toBeNull();
  });
});

describe('signalling envelope', () => {
  const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=x:"q"\\r\r\n';
  const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

  it('keeps sdp before type, and the OEM variant leaves the CRLF line breaks literal', () => {
    const literal = decode(encodeCameraOffer(sdp, true));
    expect(literal.startsWith('{"sdp":"v=0\r\no=-')).toBe(true);
    expect(literal.endsWith('","type":"offer"}')).toBe(true);
    // A literal backslash-r in a line stays escaped.
    expect(literal).toContain('a=x:\\"q\\"\\\\r\r\n');
    expect(JSON.parse(decode(encodeCameraOffer(sdp, false)))).toEqual({ sdp, type: 'offer' });
  });

  it('reads both answer encodings without rewriting the SDP', () => {
    const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
    expect(decodeCameraAnswer(b64(JSON.stringify({ type: 'answer', sdp })))).toBe(sdp);
    expect(decodeCameraAnswer(b64(`{"type":"answer","sdp":"v=0\r\nm=video 9\r\n"}`))).toBe('v=0\r\nm=video 9\r\n');
    expect(() => decodeCameraAnswer(b64(JSON.stringify({ type: 'offer', sdp })))).toThrow(/invalid video answer/);
    expect(() => decodeCameraAnswer('%%%')).toThrow(/invalid video answer/);
    expect(() => decodeCameraAnswer(b64(JSON.stringify({ type: 'answer', sdp: ' ' })))).toThrow(/invalid video answer/);
  });
});

describe('camera replies', () => {
  it('a PIN counts as accepted only for the exact replies the robots give', () => {
    expect(cameraPinAccepted(['ok'])).toBe(true);
    expect(cameraPinAccepted([1])).toBe(true);
    expect(cameraPinAccepted(true)).toBe(true);
    expect(cameraPinAccepted('ok')).toBe(false);
    expect(cameraPinAccepted(['ok', 'ok'])).toBe(false);
    expect(cameraPinAccepted(['yes'])).toBe(false);
    expect(cameraPinRejected([0])).toBe(true);
    expect(cameraPinRejected(['no'])).toBe(false);
  });

  it('reads the camera owner and acknowledgements', () => {
    expect(cameraOwner([{ client_id: 'none' }])).toBe('none');
    expect(cameraOwner([{ client_id: ' ' }])).toBeNull();
    expect(cameraOwner([])).toBeNull();
    expect(isAck(['ok'])).toBe(true);
    expect(isAck('ok')).toBe(true);
    expect(isAck(['ok', 1])).toBe(false);
  });
});

describe('offer codecs', () => {
  const caps = [
    { mimeType: 'video/VP8', clockRate: 90000 },
    { mimeType: 'video/rtx', clockRate: 90000, sdpFmtpLine: 'apt=96' },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=640c1f' },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=0;profile-level-id=42e01f' },
    { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=2' },
  ];

  it('puts high then baseline H.264 first, drops what the robot does not take, and keeps RTX', () => {
    const ranked = rankedCodecs('video', caps, false)!;
    expect(ranked.map((c) => `${c.mimeType} ${c.sdpFmtpLine ?? ''}`)).toEqual([
      'video/H264 packetization-mode=1;profile-level-id=640c1f',
      'video/H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
      'video/VP8 ',
      'video/rtx apt=96',
    ]);
    expect(rankedCodecs('video', caps, true)!.map((c) => c.mimeType)).toEqual(['video/H264', 'video/rtx']);
  });

  it("keeps the browser's own order when it lacks baseline H.264 or stereo Opus", () => {
    expect(rankedCodecs('video', [caps[0]!], false)).toBeNull();
    expect(rankedCodecs('audio', [{ mimeType: 'audio/opus', clockRate: 48000, channels: 1 }], false)).toBeNull();
    expect(rankedCodecs('audio', [{ mimeType: 'audio/PCMU', clockRate: 8000 }, { mimeType: 'audio/opus', clockRate: 48000, channels: 2 }], false)!.map((c) => c.mimeType)).toEqual(['audio/opus']);
  });
});
