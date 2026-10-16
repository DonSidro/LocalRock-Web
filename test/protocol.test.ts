import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { crc32 } from '../server/protocol/crc32.js';
import { aesCbcEncrypt, aesEcbDecrypt, aesEcbEncrypt } from '../server/protocol/crypto.js';
import {
  Protocol, RoborockProtocolError, SALT, decodeMessages, deriveToken, encodeMessage, encodeTimestamp,
  type RoborockMessage,
} from '../server/protocol/codec.js';
import { decodeDpsPush, decodeResponse, encodeRequest, isProvisionalRetry } from '../server/protocol/envelope.js';
import { JsonDouble, writeJson } from '../server/protocol/json.js';
import { hawkAuthorizationHeader, hawkMac, isHawkPublicPath, type HawkCreds } from '../server/protocol/hawk.js';
import { MqttCredsError, deriveMqttCreds, mqttTopicsFor, type Rriot } from '../server/protocol/mqttCreds.js';
import { createSecurityData, decodeMapResponse, type SecurityData } from '../server/protocol/mapResponse.js';

/*
 * Vectors copied from LocalRock's commonTest (Crc32Test, TokenTest, RoborockCodecTest,
 * V1EnvelopeTest, Aes128Test, HawkTest, MqttCredsTest, SecurityDataTest), which pin them against
 * python-roborock and the local server.
 */

const hex = (s: string) => Buffer.from(s, 'hex');

describe('crc32', () => {
  it('matches zlib values', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.from('a'))).toBe(0xe8b7be43);
    expect(crc32(Buffer.from('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
    const data = Buffer.from('garbage_123456789_trailing');
    expect(crc32(data, 'garbage_'.length, 9)).toBe(0xcbf43926);
  });
});

describe('token', () => {
  it('encodes timestamps like python-roborock', () => {
    expect(encodeTimestamp(0x00000000).toString()).toBe('00000000');
    expect(encodeTimestamp(0x00000001).toString()).toBe('00010000');
    expect(encodeTimestamp(0x01234567).toString()).toBe('56371204');
    expect(encodeTimestamp(0x89abcdef).toString()).toBe('debf9a8c');
    expect(encodeTimestamp(0xdeadbeef).toString()).toBe('eedfeadb');
    expect(encodeTimestamp(0x65f3a200).toString()).toBe('20305f6a');
  });

  it('has the expected salt', () => {
    expect(SALT.toString('hex')).toBe('5458646675246a795a23545a48736734');
  });

  it('derives tokens like python-roborock', () => {
    expect(deriveToken('0123456789abcdef', 0x65f3a200).toString('hex')).toBe('32d050fa0344d54409a480dc01881cfd');
    expect(deriveToken('local_key', 0x00000001).toString('hex')).toBe('2dbdc6120e609595eec9432fae91d4bb');
    expect(deriveToken('zzzzzzzzzzzzzzzz', 0x10203040).toString('hex')).toBe('a544301d156fbfe770cd2faede0135e3');
  });
});

describe('aes', () => {
  it('matches FIPS-197 C.1 for the first block', () => {
    const key = hex('000102030405060708090a0b0c0d0e0f');
    const ct = aesEcbEncrypt(hex('00112233445566778899aabbccddeeff'), key);
    expect(ct.subarray(0, 16).toString('hex')).toBe('69c4e0d86a7b0430d8cdb78070b4c55a');
    expect(ct.length).toBe(32);
    expect(aesEcbDecrypt(ct, key).toString('hex')).toBe('00112233445566778899aabbccddeeff');
  });

  it('round-trips ECB for every length', () => {
    const key = hex('0123456789abcdef0123456789abcdef');
    for (let len = 0; len <= 40; len++) {
      const pt = Buffer.from(Array.from({ length: len }, (_, i) => i ^ 0x5a));
      const ct = aesEcbEncrypt(pt, key);
      expect(ct.length).toBe(len === 0 ? 0 : (Math.floor(len / 16) + 1) * 16);
      expect(aesEcbDecrypt(ct, key).equals(pt)).toBe(true);
    }
  });

  it('matches RFC 3602 case 1 for CBC', () => {
    const ct = aesCbcEncrypt(Buffer.from('Single block msg'), hex('06a9214036b8a15b512e03d534120006'), hex('3dafba429d9eb430b422da802c9fac41'));
    expect(ct.subarray(0, 16).toString('hex')).toBe('e353779c1079aeb82708942dbe77181a');
  });
});

describe('codec', () => {
  it('encodes and decodes golden vector 1 (MQTT)', () => {
    const msg: RoborockMessage = {
      protocol: Protocol.RPC_REQUEST,
      payload: hex('7b226964223a312c226d6574686f64223a226765745f737461747573222c22706172616d73223a5b5d7d'),
      seq: 42, random: 12345, timestamp: 0x65f3a200,
    };
    const expected = '312e300000002a0000303965f3a200006500303e1446a698dd03df8245c4c0a4bb077624f06b4838d63be7fddb946e68ec87bfb8f641897d2bf479c7df520ca1ffb25872b4663e';
    expect(encodeMessage('0123456789abcdef', msg).toString('hex')).toBe(expected);
    const decoded = decodeMessages('0123456789abcdef', hex(expected));
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.payload.equals(msg.payload)).toBe(true);
    expect(decoded[0]!.seq).toBe(42);
    expect(decoded[0]!.random).toBe(12345);
    expect(decoded[0]!.timestamp).toBe(0x65f3a200);
    expect(decoded[0]!.protocol).toBe(101);
  });

  it('encodes golden vectors 2 and 3 (length-prefixed)', () => {
    expect(encodeMessage('local_key', {
      protocol: 101, payload: Buffer.from('test_payload'), seq: 1, random: 123, timestamp: 0x65f3a300,
    }, true).toString('hex')).toBe('00000027312e30000000010000007b65f3a300006500109b8a775a746e2433f2d9088a3496a0deca5abf55');
    expect(encodeMessage('0123456789abcdef', {
      protocol: 101,
      payload: hex('7b226964223a322c226d6574686f64223a226170705f7374617274222c22706172616d73223a5b5d7d'),
      seq: 7, random: 99, timestamp: 0x65f3a400,
    }, true).toString('hex')).toBe('00000047312e30000000070000006365f3a4000065003061f54f987001fb90a1aa770f9f4ea78fd519b9852a4c1344dc0f57160365e1affc1957a204b506ef24c2f44fcab0ff4e2c637c05');
  });

  it('skips leading garbage and rejects a bad CRC', () => {
    const msg = { protocol: 101, payload: Buffer.from('test'), seq: 9, random: 200, timestamp: 0x65f3a500 };
    const encoded = encodeMessage('0123456789abcdef', msg);
    const decoded = decodeMessages('0123456789abcdef', Buffer.concat([hex('deadbeefcafe'), encoded]));
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.payload.toString()).toBe('test');
    const broken = Buffer.from(encoded);
    broken[broken.length - 1] ^= 0xff;
    expect(() => decodeMessages('0123456789abcdef', broken)).toThrow(RoborockProtocolError);
  });
});

describe('envelope', () => {
  it('matches python-roborock request goldens', () => {
    expect(encodeRequest(12345, 'app_start', [], 1710465536).toString())
      .toBe('{"dps":{"101":"{\\"id\\":12345,\\"method\\":\\"app_start\\",\\"params\\":[]}"},"t":1710465536}');
    expect(encodeRequest(42, 'get_status', [], 1710465600).toString())
      .toBe('{"dps":{"101":"{\\"id\\":42,\\"method\\":\\"get_status\\",\\"params\\":[]}"},"t":1710465600}');
    expect(encodeRequest(9999, 'set_custom_mode', [103], 1710465700).toString())
      .toBe('{"dps":{"101":"{\\"id\\":9999,\\"method\\":\\"set_custom_mode\\",\\"params\\":[103]}"},"t":1710465700}');
  });

  it('puts extra inner fields after params', () => {
    const s = encodeRequest(1, 'get_map_v1', [], 5, { security: { endpoint: 'abc', nonce: '00' } }).toString();
    expect(JSON.parse(JSON.parse(s).dps['101'])).toEqual({ id: 1, method: 'get_map_v1', params: [], security: { endpoint: 'abc', nonce: '00' } });
    expect(JSON.parse(s).dps['101']).toBe('{"id":1,"method":"get_map_v1","params":[],"security":{"endpoint":"abc","nonce":"00"}}');
  });

  it('writes doubles the way Kotlin does', () => {
    expect(writeJson({ velocity: new JsonDouble(0.3), omega: new JsonDouble(0), duration: 1500 }))
      .toBe('{"velocity":0.3,"omega":0.0,"duration":1500}');
    expect(writeJson([new JsonDouble(-0.3)])).toBe('[-0.3]');
  });

  it('decodes results, errors and pushes', () => {
    const ok = decodeResponse(Buffer.from('{"dps":{"102":"{\\"id\\":42,\\"result\\":[\\"ok\\"]}"}}'));
    expect(ok.id).toBe(42);
    expect(ok.result).toEqual(['ok']);
    expect(ok.error).toBeNull();
    const err = decodeResponse(Buffer.from('{"dps":{"102":"{\\"id\\":7,\\"error\\":{\\"code\\":-10007,\\"message\\":\\"invalid status\\"}}"}}'));
    expect(err.id).toBe(7);
    expect(err.result).toBeNull();
    expect(err.error).toEqual({ code: -10007, message: 'invalid status' });
    const push = decodeDpsPush(Buffer.from('{"dps":{"121":8,"122":97,"123":102}}'))!;
    expect(push.get(121)).toBe(8);
    expect(push.get(122)).toBe(97);
    expect(decodeDpsPush(Buffer.from('not json'))).toBeNull();
    expect(isProvisionalRetry({ id: 1, result: ['retry'], error: null })).toBe(true);
    expect(isProvisionalRetry({ id: 1, result: ['ok'], error: null })).toBe(false);
  });
});

describe('hawk', () => {
  const creds: HawkCreds = { id: 'user-anon', session: 'session-anon', key: 'contract-hawk-secret' };
  const ts = 1712345678;

  it('matches the server reference vectors', () => {
    expect(hawkMac(creds, '/user/app/info', ts, 'contract-0', {}, {
      channelToken: 'anon-app-token-0001', lang: 'en', locale: 'en-US', osType: 'IOS', pushChannel: 'APNS',
    })).toBe('pKZxsTCABg6kF0sEiodrNPow4QPejIDollJu2PBIpAc=');
    expect(hawkMac(creds, '/user/inbox/latest', ts, 'contract-1')).toBe('MoX7siZAJBmLK6wK7p5idlA2LITGFZaaW8BlmRdlQlo=');
    expect(hawkMac(creds, '/v3/user/homes/424242', ts, 'contract-2')).toBe('6etEC/Ty110CGu6cPmBQcA6aZyU8G6KEWOaLImJAn1g=');
    expect(hawkMac(creds, '/user/scene/order', ts, 'contract-3', { homeId: '424242' })).toBe('B5dKZVbK2jjgagNQHizyPA+XyOQ+tlKVqd22yv3KohU=');
    expect(hawkMac(creds, '/user/scene/home/424242', ts, 'contract-4')).toBe('JE8XTdMSXHeRxNu2mGnYKTS37GcGNaEoryWo3DHw5uE=');
    expect(hawkAuthorizationHeader(creds, '/v3/user/homes/424242', ts, 'contract-2')).toBe(
      'Hawk id="user-anon",s="session-anon",ts="1712345678",nonce="contract-2",mac="6etEC/Ty110CGu6cPmBQcA6aZyU8G6KEWOaLImJAn1g="',
    );
  });

  it('knows the public paths', () => {
    expect(isHawkPublicPath('/api/v5/auth/email/login/code')).toBe(true);
    expect(isHawkPublicPath('/nc/prepare')).toBe(true);
    expect(isHawkPublicPath('/v3/user/homes/1')).toBe(false);
    expect(isHawkPublicPath('/user/homes/1/rooms')).toBe(false);
  });
});

describe('mqtt credentials', () => {
  const rriot = (u: string, s: string, k: string, m: string): Rriot => ({
    u, s, k, h: 'https://api.example.com', r: { r: 'EU', a: 'https://a.example', m, l: 'https://l.example' },
  });

  it('derives the same credentials as the app', () => {
    const a = deriveMqttCreds(rriot('1234567890', 'abcdef0123456789abcdef0123456789', 'zzzzzzzzzzzzzzzz', 'ssl://mqtt-eu-3.roborock.com:8883'));
    expect(a).toEqual({ host: 'mqtt-eu-3.roborock.com', port: 8883, tls: true, username: 'c9cc7cc8', password: '898bf7dbb1fe7823' });
    const b = deriveMqttCreds(rriot('42', '0123456789abcdef', '0123456789abcdef', 'mqtt://api.roborock.kodraliu.com:1883'));
    expect(b).toEqual({ host: 'api.roborock.kodraliu.com', port: 1883, tls: false, username: 'f7996f89', password: '99dc9b40748c5354' });
    const c = deriveMqttCreds(rriot('user-id', 'session-secret', 'some-key-value', 'ssl://broker.local:8884'));
    expect(c.username).toBe('4d905a77');
    expect(c.password).toBe('bdcdeaa264143c7c');
  });

  it('rejects malformed broker URLs', () => {
    expect(() => deriveMqttCreds(rriot('u', 's', 'k', 'broker.local:1883'))).toThrow(MqttCredsError);
    expect(() => deriveMqttCreds(rriot('u', 's', 'k', 'ssl://broker.local'))).toThrow(MqttCredsError);
    expect(() => deriveMqttCreds(rriot('u', 's', 'k', 'ssl://broker.local:abc'))).toThrow(MqttCredsError);
  });

  it('lays out topics', () => {
    expect(mqttTopicsFor('42', 'c9cc7cc8', 'ABCDEF1234')).toEqual({
      publishTopic: 'rr/m/i/42/c9cc7cc8/ABCDEF1234',
      subscribeTopic: 'rr/m/o/42/c9cc7cc8/ABCDEF1234',
    });
  });
});

describe('map response', () => {
  it('derives endpoints like python-roborock', () => {
    expect(createSecurityData('0123456789abcdef').endpoint).toBe('kG5Y4GcU');
    expect(createSecurityData('zzzzzzzzzzzzzzzz').endpoint).toBe('HiZUpbbX');
    expect(createSecurityData('some-session-key').endpoint).toBe('G1eGiCNK');
    expect(createSecurityData('a'.repeat(32)).endpoint).toBe('zUOuSN/e');
    const a = createSecurityData('k');
    expect(a.nonce.length).toBe(16);
    expect(a.nonce.equals(createSecurityData('k').nonce)).toBe(false);
  });

  const security: SecurityData = { endpoint: 'ABCDEFGH', nonce: hex('0123456789abcdef0123456789abcdef') };
  const payload = (endpoint: string, requestId: number, body: Buffer) => {
    const header = Buffer.alloc(24);
    header.write(endpoint.substring(0, 8), 0, 'latin1');
    header[16] = requestId & 0xff;
    header[17] = (requestId >>> 8) & 0xff;
    return Buffer.concat([header, body]);
  };

  it('decrypts and gunzips a map reply', () => {
    const body = aesCbcEncrypt(gzipSync(Buffer.from('hello-roborock-map')), security.nonce, Buffer.alloc(16));
    const r = decodeMapResponse({ protocol: 301, payload: payload('ABCDEFGH', 0x1234, body), seq: 1, random: 1, timestamp: 0 }, security)!;
    expect(r.requestId).toBe(0x1234);
    expect(r.data.toString()).toBe('hello-roborock-map');
  });

  it('ignores other endpoints and rejects short payloads', () => {
    const body = aesCbcEncrypt(gzipSync(Buffer.from('x')), security.nonce, Buffer.alloc(16));
    expect(decodeMapResponse({ protocol: 301, payload: payload('ZZZZZZZZ', 7, body), seq: 1, random: 1, timestamp: 0 }, security)).toBeNull();
    expect(() => decodeMapResponse({ protocol: 301, payload: Buffer.alloc(10), seq: 1, random: 1, timestamp: 0 }, security)).toThrow();
  });
});
