import { describe, expect, it } from 'vitest';
import {
  RsaKeyPair, buildFrame, buildHelloPacket, buildWifiConfigPacket, parseFrame, parseHelloResponse, sanitizeStackServer,
  posixTzFromIana, countryDomainFromIana,
} from '../server/onboarding/packets.js';

/* Vectors from LocalRock's tests/fixtures/onboarding_vectors.json (generated with python). */

const PUB = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCN8BT5/dAwonKT4LR3dRVedVyj
cNmXh28d7N8cE5j9UN84Y5Ih1DyFVcRCbXKzbT0ccoaxbxCeuiELNbmPNes9SviH
a1tmHv4O4fSXNFoedXQGLbmtyuNu1/ZjuFqTcFvzQFINChSigJXQ6Fg7sTQA1yKr
EVzWS4eunp6qD/l56wIDAQAB
-----END PUBLIC KEY-----`;

const PRIV_PKCS8 = `-----BEGIN PRIVATE KEY-----
MIICdQIBADANBgkqhkiG9w0BAQEFAASCAl8wggJbAgEAAoGBAI3wFPn90DCicpPg
tHd1FV51XKNw2ZeHbx3s3xwTmP1Q3zhjkiHUPIVVxEJtcrNtPRxyhrFvEJ66IQs1
uY816z1K+IdrW2Ye/g7h9Jc0Wh51dAYtua3K427X9mO4WpNwW/NAUg0KFKKAldDo
WDuxNADXIqsRXNZLh66enqoP+XnrAgMBAAECgYADbawkCbRwqEvaNJBHXmWgvXb6
X6xx04ykjWcqN3L3k2+A3i7WcFjx44t1C0289cOHH2EPgh5FpztLGQYdZnEDJck0
bnRiqKleAIRTuTY6m0ZvUo1IiX5KlieCHDh8DHCCjQbEg/+qhAG4zd5JpRwzgj0T
cfI2BKK/ay3vG3PguQJBALm3xN6YunTNokr5NpOY+fYQe4XuDxFdzLP0gL9MdoUi
3jBD6PwhSFPfd8Qu9oJxWjNnc6BoPP300IUQVIWLLG0CQQDDpu5E008nhD+mnYq/
z+NnxXI89p9oXf/de54f7tuY0WwkYVaMYof+bCZtkQKm8SAuOrOjJMvyFDu/GTQq
DJi3AkAYqk97QM2CtczYKEEXWTnZdFbzcqqNo+eL/u0aew1CoV7hCiPnWIRCn2tI
ovQaXvOb4CF7LFztXZZUFdcj5VgBAkB/p4L+1QBoQBlnlJLa48D0DBelPyRy7CHt
WKKrIyWUZ8+vTPMzVXZ1wgqwolSgp+LfRt2+LFwE7r6syL0IUn+xAkBORthl/Jb7
pA/SXsLjkEVovd2qaYkoQ8D+vE2rGQZvft8cnpZ9vDLm98FBjAshL46LlO70CVO8
KwtiJBRD2gVU
-----END PRIVATE KEY-----`;

describe('cfgwifi frames', () => {
  it('matches the python frames', () => {
    expect(buildFrame(16, Buffer.alloc(0)).toString('hex')).toBe('312e300000000100100000dc805c41');
    expect(buildFrame(1, Buffer.from('hello world!')).toString('hex')).toBe('312e30000000010001000c68656c6c6f20776f726c6421a9c33061');
    const parsed = parseFrame(Buffer.from('312e30000000010001000c68656c6c6f20776f726c6421a9c33061', 'hex'));
    expect(parsed.commandId).toBe(1);
    expect(parsed.payload.toString()).toBe('hello world!');
  });

  it('builds the hello and wifi packets byte for byte', () => {
    expect(buildHelloPacket(PUB).toString('hex')).toBe('312e300000000100100150e7e5119ca33f24c03b6491521c511db68d47ee26364222946b1df1d61fc8d00de838d8b72adcea4b1f5024eb2aeae6cc947031b140f7d9777eb9a9db6a4d72d215af332fd976f182699044d55dbaa8dceb3b34ff314a56c09864afc54f73b03e30425f46c76b3482cdd2e4d2056ef98fdcd6224be4c43fcd5e4a729c85b64abebe5cb7426033f4a9497c2a765338dbedbd66a008f31222b9d4011be08d8701038ee6227c3302b8b9c04c3460c1962fe37252a713c913d353f46cd00a66d37536c9d3f75aee5bcd66496d18cf63d57564ffb9d189410a6fcb439562487bff4f96dfb9a22337a7c9fff850673609e1922b97156cec179882060c7d0a10a30994ba4ff3dca204e7e38aee24216ee40d3145c5a3d3c5d3aa32c576daa8a37a075cbd566ef9617df9c501a7aee6bc1bf2833194330da4aee20146f51f0bfa63e20238fad456e4fda05ef7a47ab3c2ef56828c6cf78cc3');
    expect(buildWifiConfigPacket('abcdef0123456789', {
      ssid: 'my-home-wifi', password: 'hunter2!', serverStack: 'api-roborock.example.com/', timezone: 'America/New_York',
      posixTz: 'EST5EDT,M3.2.0,M11.1.0', countryDomain: 'us', tokenS: 'S_TOKEN_aaaa', tokenT: 'T_TOKEN_bbbb',
    }).toString('hex')).toBe('312e3000000001000100e0eed860a7584481fa64ac3b78eae227121e588afdb0ed9897f2917ec4f30f38b0fb6b5abf6e1eb1cf53eb3103d7b973e06b5379a525766c3c50fbce8e9072a55d68bd390406ed629ab96b8dd82cd51991f822d75ea00394849a16ef275d41b7fafb6a7d378c551d50694d3f78a91ecec57d4ec7a45711e5a68fd6b789a12109fede349f86485f0abc2c68e6c427ec7db7fcddfcf96d6b03eea7340b9a09274324b3fd7ee2014a4cbea60377a5bd68fc92c5c37bd2f838c48f8adffcc2d24b7c65ae6eb560d643be89c4f7ee6ed2d0699476465e0c19ecb5cc1441fb9d9f5f24a79ef02c37');
  });
});

describe('rsa hello exchange', () => {
  const keys = RsaKeyPair.fromPem(PRIV_PKCS8);

  it('exports the same public key as the fixture', () => {
    expect(keys.publicKeyPem).toBe(PUB);
  });

  it('decrypts both captured hello responses', () => {
    for (const hex of [
      '312e3000000001001000805e27b4e50e3ebc50c9a54be1ebf73c24c0966a6b5272279194e61a52358b30324e03dd41e39d3c0a636ccaa569aaa7a5112679d286eed6944ec3981d5cc854afe1408b26fe458ceff39395b6c6ce1659028f3108099f053aa43c5b45f34f0616f06a8173ca5a046c95fd7279b2933eacf3b8b789777d5ab92569e4bc8eaa717be03d51fa',
      '312e3000000001001000804ba65e7ff9063c6835ef14190cdf5708b1bb854ad07d54c0f4e7b76b08df88fd79bab483f71c03ab92ec73365d64fa5436ccb3df205fb02de40c50c0117d48bca634b1e14776fd29e193f8cebeb22de9a781d91923f81cc94bec942110ca4365608b9ce9681dd59c9b77d20ddf5dd1e32d8a6fda556e53b5887b3cf6b7b6ff4d660f9e1b',
    ]) {
      expect(parseHelloResponse(Buffer.from(hex, 'hex'), keys)).toBe('abcdef0123456789');
    }
  });

  it('generates usable key pairs', () => {
    const k = RsaKeyPair.generate();
    expect(k.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----\n')).toBe(true);
    expect(k.publicKeyPem.endsWith('-----END PUBLIC KEY-----')).toBe(true);
  });
});

describe('server stack and timezones', () => {
  it('sanitizes the server address like the app', () => {
    expect(sanitizeStackServer('https://api-roborock.example.com')).toBe('roborock.example.com/');
    expect(sanitizeStackServer('https://192.168.1.10:555/admin')).toBe('192.168.1.10:555/');
    expect(() => sanitizeStackServer('  ')).toThrow();
  });

  it('maps timezones', () => {
    expect(posixTzFromIana('Europe/Berlin')).toBe('CET-1CEST,M3.5.0,M10.5.0/3');
    expect(countryDomainFromIana('Europe/London')).toBe('gb');
    expect(posixTzFromIana('Mars/Base')).toBe('EST5EDT,M3.2.0,M11.1.0');
  });
});

describe('pairing keys', () => {
  it('takes the last 16 characters of a _miap hotspot name', async () => {
    const { ssidPreKey, posixTzFromIana, countryDomainFromIana } = await import('../server/onboarding/packets.js');
    expect(ssidPreKey('roborock-vacuum-a70_miap1A2B')).toBe('uum-a70_miap1A2B');
    expect(ssidPreKey('roborock-vacuum-a70_miap1A2B')).toHaveLength(16);
    expect(ssidPreKey('"roborock-vacuum-a70_miap1A2B"')).toBe(ssidPreKey('roborock-vacuum-a70_miap1A2B'));
    expect(ssidPreKey('roborock-vacuum-a70')).toBeNull();
    expect(posixTzFromIana('America/Puerto_Rico')).toBe('AST4');
    expect(countryDomainFromIana('America/Puerto_Rico')).toBe('us');
  });
});
