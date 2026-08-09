const crypto = require('crypto');

const {
  issueSessionToken,
  verifySessionToken,
  issueShareToken,
  verifyShareToken
} = require('../../lib/security-tokens');

const SECRET = 'test-session-secret';
const NOW = 1700000000000;
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

/**
 * Forge a token with an arbitrary payload string/object, signed with the given
 * secret, so shape checks are exercised independently of the MAC.
 */
function forge(payload, secret = SECRET) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const payloadPart = Buffer.from(raw, 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
  return payloadPart + '.' + signature;
}

describe('issueSessionToken / verifySessionToken', () => {
  test('round-trips a valid session token at a fixed time', () => {
    const token = issueSessionToken(SECRET, { now: NOW, ttlMs: WEEK });

    expect(verifySessionToken(token, SECRET, { now: NOW })).toBe(true);
    expect(verifySessionToken(token, SECRET, { now: NOW + WEEK - 1 })).toBe(true);
  });

  test('rejects at the exact expiry and after it', () => {
    const token = issueSessionToken(SECRET, { now: NOW, ttlMs: WEEK });

    expect(verifySessionToken(token, SECRET, { now: NOW + WEEK })).toBe(false);
    expect(verifySessionToken(token, SECRET, { now: NOW + WEEK + 1 })).toBe(false);
  });

  test('defaults to a seven-day lifetime', () => {
    const token = issueSessionToken(SECRET, { now: NOW });

    expect(verifySessionToken(token, SECRET, { now: NOW + WEEK - 1 })).toBe(true);
    expect(verifySessionToken(token, SECRET, { now: NOW + WEEK })).toBe(false);
  });

  test('uses the real clock when now is omitted', () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    try {
      const token = issueSessionToken(SECRET);
      jest.setSystemTime(NOW + WEEK - 1);
      expect(verifySessionToken(token, SECRET)).toBe(true);
      jest.setSystemTime(NOW + WEEK);
      expect(verifySessionToken(token, SECRET)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('produces a versioned payload.signature token with compact keys', () => {
    const token = issueSessionToken(SECRET, { now: NOW, ttlMs: WEEK });
    const [payloadPart, signaturePart] = token.split('.');

    expect(payloadPart).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signaturePart).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))).toEqual({
      v: 1,
      t: 'session',
      exp: NOW + WEEK
    });
  });

  test('rejects tampered payloads and signatures', () => {
    const token = issueSessionToken(SECRET, { now: NOW, ttlMs: WEEK });
    const [payloadPart, signaturePart] = token.split('.');

    const flippedPayloadChar = payloadPart.slice(0, -1) +
      (payloadPart[payloadPart.length - 1] === 'A' ? 'B' : 'A');
    expect(verifySessionToken(flippedPayloadChar + '.' + signaturePart, SECRET, { now: NOW })).toBe(false);

    const flippedSignatureChar = signaturePart.slice(0, -1) +
      (signaturePart[signaturePart.length - 1] === 'A' ? 'B' : 'A');
    expect(verifySessionToken(payloadPart + '.' + flippedSignatureChar, SECRET, { now: NOW })).toBe(false);
  });

  test('rejects tokens signed with a different secret', () => {
    const token = issueSessionToken(SECRET, { now: NOW, ttlMs: WEEK });

    expect(verifySessionToken(token, 'other-secret', { now: NOW })).toBe(false);
  });

  test('rejects empty, non-string, and wrong secrets without throwing', () => {
    const token = issueSessionToken(SECRET, { now: NOW, ttlMs: WEEK });

    expect(verifySessionToken(token, '', { now: NOW })).toBe(false);
    expect(verifySessionToken(token, 123, { now: NOW })).toBe(false);
    expect(verifySessionToken(token, null, { now: NOW })).toBe(false);
    expect(verifySessionToken(token, undefined, { now: NOW })).toBe(false);
  });

  test('rejects share tokens as session tokens', () => {
    const shareToken = issueShareToken(42, SECRET, { now: NOW, ttlMs: WEEK });

    expect(verifySessionToken(shareToken, SECRET, { now: NOW })).toBe(false);
  });

  test('rejects malformed token structures', () => {
    const badTokens = [
      '',
      'abc',
      'a.b.c',
      '.abc',
      'abc.',
      'a.b',
      'AA.AAAA',
      'AB.AAAA',
      'AA==.AAAA',
      'AA.A+AA',
      'AA.A/AA',
      'AAAAA.AAAA',
      null,
      undefined,
      42,
      {},
      ['a', 'b'],
      Symbol('token')
    ];
    for (const bad of badTokens) {
      expect(verifySessionToken(bad, SECRET, { now: NOW })).toBe(false);
    }
  });

  test('rejects non-canonical and non-JSON payloads even when signed', () => {
    const nonJsonPayload = Buffer.from('nope', 'utf8').toString('base64url');
    expect(verifySessionToken(forge('nope'), SECRET, { now: NOW })).toBe(false);
    expect(verifySessionToken(forge('[1, 2]'), SECRET, { now: NOW })).toBe(false);
    expect(verifySessionToken(forge('null'), SECRET, { now: NOW })).toBe(false);
    expect(verifySessionToken(forge('"hi"'), SECRET, { now: NOW })).toBe(false);
    expect(verifySessionToken(forge('42'), SECRET, { now: NOW })).toBe(false);
    expect(nonJsonPayload).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('rejects wrong versions, wrong types, and extra or missing fields even when signed', () => {
    expect(verifySessionToken(forge({ v: 2, t: 'session', exp: NOW + WEEK }), SECRET, { now: NOW })).toBe(false);
    expect(verifySessionToken(forge({ v: 1, t: 'admin', exp: NOW + WEEK }), SECRET, { now: NOW })).toBe(false);
    expect(verifySessionToken(forge({ v: 1, t: 'session', exp: NOW + WEEK, iat: NOW }), SECRET, { now: NOW })).toBe(false);
    expect(verifySessionToken(forge({ v: 1, t: 'session' }), SECRET, { now: NOW })).toBe(false);
    expect(verifySessionToken(forge({ v: 1, exp: NOW + WEEK }), SECRET, { now: NOW })).toBe(false);
  });

  test('rejects malformed expiry values even when signed', () => {
    const badExpiries = [
      0,
      -5,
      1.5,
      '604800000',
      null,
      Number.MAX_SAFE_INTEGER + 1
    ];
    for (const exp of badExpiries) {
      expect(verifySessionToken(forge({ v: 1, t: 'session', exp }), SECRET, { now: NOW })).toBe(false);
    }
  });

  test('rejects signatures of the wrong length', () => {
    const token = issueSessionToken(SECRET, { now: NOW, ttlMs: WEEK });
    const payloadPart = token.split('.')[0];

    // 42 chars decode to 31 bytes (short), 43 chars decode to 32 bytes (wrong bytes).
    expect(verifySessionToken(payloadPart + '.' + 'A'.repeat(42), SECRET, { now: NOW })).toBe(false);
    expect(verifySessionToken(payloadPart + '.' + 'A'.repeat(43), SECRET, { now: NOW })).toBe(false);
  });

  test('never throws for attacker-controlled input', () => {
    const garbage = [
      'x',
      '.',
      '..',
      '.'.repeat(600),
      'A'.repeat(600) + '.AAAA',
      'A'.repeat(513),
      { token: 'x' },
      ['x'],
      Buffer.from('x'),
      0,
      -1,
      NaN,
      Infinity,
      true,
      Symbol('x'),
      () => 'x'
    ];
    for (const bad of garbage) {
      expect(() => verifySessionToken(bad, SECRET, { now: NOW })).not.toThrow();
      expect(() => verifySessionToken('AA.AAAA', bad, { now: NOW })).not.toThrow();
      expect(() => verifySessionToken('AA.AAAA', SECRET, { now: bad })).not.toThrow();
    }
  });

  test('throws clear errors for programmer misuse of issueSessionToken', () => {
    expect(() => issueSessionToken('', { now: NOW })).toThrow(RangeError);
    expect(() => issueSessionToken('', { now: NOW })).toThrow(/non-empty string/);
    expect(() => issueSessionToken(123, { now: NOW })).toThrow(TypeError);
    expect(() => issueSessionToken(null, { now: NOW })).toThrow(TypeError);
    expect(() => issueSessionToken(SECRET, null)).toThrow(TypeError);
    expect(() => issueSessionToken(SECRET, 'options')).toThrow(TypeError);
    expect(() => issueSessionToken(SECRET, { now: NOW, ttlMs: 0 })).toThrow(RangeError);
    expect(() => issueSessionToken(SECRET, { now: NOW, ttlMs: -1000 })).toThrow(RangeError);
    expect(() => issueSessionToken(SECRET, { now: NOW, ttlMs: 1.5 })).toThrow(RangeError);
    expect(() => issueSessionToken(SECRET, { now: NOW, ttlMs: '1000' })).toThrow(TypeError);
    expect(() => issueSessionToken(SECRET, { now: 'now', ttlMs: WEEK })).toThrow(TypeError);
    expect(() => issueSessionToken(SECRET, { now: 1.5, ttlMs: WEEK })).toThrow(RangeError);
    expect(() => issueSessionToken(SECRET, { now: Number.MAX_SAFE_INTEGER, ttlMs: 1000 })).toThrow(RangeError);
  });
});

describe('issueShareToken / verifyShareToken', () => {
  test('round-trips a valid share token and binds the video id', () => {
    const token = issueShareToken(42, SECRET, { now: NOW, ttlMs: WEEK });

    expect(verifyShareToken(token, SECRET, { now: NOW })).toEqual({ videoId: 42, expiresAt: NOW + WEEK });
    expect(verifyShareToken(token, SECRET, { now: NOW + WEEK - 1 })).toEqual({ videoId: 42, expiresAt: NOW + WEEK });
    expect(Object.keys(verifyShareToken(token, SECRET, { now: NOW }))).toEqual(['videoId', 'expiresAt']);
  });

  test('rejects share tokens at the exact expiry and after it', () => {
    const token = issueShareToken(42, SECRET, { now: NOW, ttlMs: WEEK });

    expect(verifyShareToken(token, SECRET, { now: NOW + WEEK })).toBeNull();
    expect(verifyShareToken(token, SECRET, { now: NOW + WEEK + 1 })).toBeNull();
  });

  test('rejects session tokens as share tokens', () => {
    const sessionToken = issueSessionToken(SECRET, { now: NOW, ttlMs: WEEK });

    expect(verifyShareToken(sessionToken, SECRET, { now: NOW })).toBeNull();
  });

  test('rejects tampered share tokens and wrong secrets', () => {
    const token = issueShareToken(42, SECRET, { now: NOW, ttlMs: WEEK });
    const [payloadPart, signaturePart] = token.split('.');

    const flipped = signaturePart.slice(0, -1) +
      (signaturePart[signaturePart.length - 1] === 'A' ? 'B' : 'A');
    expect(verifyShareToken(payloadPart + '.' + flipped, SECRET, { now: NOW })).toBeNull();
    expect(verifyShareToken(token, 'other-secret', { now: NOW })).toBeNull();
  });

  test('rejects invalid video ids at issue time', () => {
    expect(() => issueShareToken(0, SECRET, { now: NOW })).toThrow(RangeError);
    expect(() => issueShareToken(-1, SECRET, { now: NOW })).toThrow(RangeError);
    expect(() => issueShareToken(1.5, SECRET, { now: NOW })).toThrow(RangeError);
    expect(() => issueShareToken(NaN, SECRET, { now: NOW })).toThrow(RangeError);
    expect(() => issueShareToken(Infinity, SECRET, { now: NOW })).toThrow(RangeError);
    expect(() => issueShareToken('42', SECRET, { now: NOW })).toThrow(TypeError);
    expect(() => issueShareToken(null, SECRET, { now: NOW })).toThrow(TypeError);
    expect(() => issueShareToken(undefined, SECRET, { now: NOW })).toThrow(TypeError);
    expect(() => issueShareToken(42, '', { now: NOW })).toThrow(RangeError);
  });

  test('rejects invalid video ids in tokens even when signed', () => {
    const badVideoIds = [0, -3, 1.5, '42', null];
    for (const vid of badVideoIds) {
      expect(verifyShareToken(forge({ v: 1, t: 'share', exp: NOW + WEEK, vid }), SECRET, { now: NOW })).toBeNull();
    }
    expect(verifyShareToken(forge({ v: 1, t: 'share', exp: NOW + WEEK }), SECRET, { now: NOW })).toBeNull();
  });
});
