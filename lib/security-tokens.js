/**
 * Security tokens: versioned, expiring HMAC-SHA256 tokens for sessions and shares.
 *
 * Token format: <base64url(payload)>.<base64url(hmac-sha256(secret, payload))>
 *
 * The payload is a compact JSON object with fixed keys only:
 *   session: { v: 1, t: 'session', exp: <expiry in ms> }
 *   share:   { v: 1, t: 'share', exp: <expiry in ms>, vid: <video id> }
 *
 * Issuance validates its inputs and throws TypeError/RangeError for programmer
 * misuse. Verification never throws: anything malformed is rejected with
 * `false` / `null`.
 */

const crypto = require('crypto');

const TOKEN_VERSION = 1;
// Default lifetime for session and share tokens: 7 days.
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Bounds the work verification will do on attacker-supplied tokens.
const MAX_TOKEN_LENGTH = 512;

// Unpadded RFC 4648 base64url alphabet.
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
// Valid last characters when the encoded length is 2 mod 4 (2 significant bits,
// 4 unused bits that must be zero for canonical encoding).
const B64URL_LAST_2 = 'AQgw';
// Valid last characters when the encoded length is 3 mod 4 (4 significant bits,
// 2 unused bits that must be zero for canonical encoding).
const B64URL_LAST_3 = 'AEIMQUYcgkosw048';

/**
 * Check that a string is canonical unpadded base64url: only the base64url
 * alphabet, a length that can represent whole bytes, and zero padding bits.
 * @param {string} str - Candidate string
 * @returns {boolean} True when the string is canonical base64url
 */
function isCanonicalBase64Url(str) {
  if (!B64URL_RE.test(str)) {
    return false;
  }
  const remainder = str.length % 4;
  if (remainder === 1) {
    return false;
  }
  if (remainder === 2) {
    return B64URL_LAST_2.includes(str[str.length - 1]);
  }
  if (remainder === 3) {
    return B64URL_LAST_3.includes(str[str.length - 1]);
  }
  return true;
}

/**
 * Resolve the verification clock. Returns null when an explicitly provided
 * `now` is not a safe integer, which fails verification.
 * @param {Object} [options] - Verify options
 * @returns {number|null} Verification time in milliseconds
 */
function resolveNow(options) {
  if (options && typeof options === 'object' && options.now !== undefined) {
    return Number.isSafeInteger(options.now) ? options.now : null;
  }
  return Date.now();
}

/**
 * Validate issuance inputs and derive the expiry. Throws TypeError for wrong
 * types and RangeError for out-of-range values.
 * @param {string} secret - Signing secret (non-empty string)
 * @param {Object} [options] - Issue options: deterministic `now` (ms) and `ttlMs`
 * @param {number} [videoId] - Video id for share tokens (positive safe integer)
 * @returns {{ exp: number }} Expiry in milliseconds
 */
function validateIssueOptions(secret, options, videoId) {
  if (typeof secret !== 'string') {
    throw new TypeError('secret must be a non-empty string');
  }
  if (secret.length === 0) {
    throw new RangeError('secret must be a non-empty string');
  }
  if (videoId !== undefined) {
    if (typeof videoId !== 'number') {
      throw new TypeError('videoId must be a positive safe integer');
    }
    if (!Number.isSafeInteger(videoId) || videoId <= 0) {
      throw new RangeError('videoId must be a positive safe integer');
    }
  }
  if (options === undefined) {
    options = {};
  } else if (options === null || typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }
  let now = options.now;
  let ttlMs = options.ttlMs;
  if (now === undefined) {
    now = Date.now();
  } else if (typeof now !== 'number') {
    throw new TypeError('options.now must be a number of milliseconds');
  } else if (!Number.isSafeInteger(now)) {
    throw new RangeError('options.now must be a safe integer number of milliseconds');
  }
  if (ttlMs === undefined) {
    ttlMs = DEFAULT_TTL_MS;
  } else if (typeof ttlMs !== 'number') {
    throw new TypeError('options.ttlMs must be a positive number of milliseconds');
  } else if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError('options.ttlMs must be a positive number of milliseconds');
  }
  const exp = now + ttlMs;
  if (!Number.isSafeInteger(exp)) {
    throw new RangeError('token expiry exceeds the safe integer range');
  }
  return { exp };
}

/**
 * Sign a payload into a token string.
 * @param {Object} payload - Compact payload with fixed keys
 * @param {string} secret - Signing secret
 * @returns {string} `payload.signature` token
 */
function signToken(payload, secret) {
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
  return payloadPart + '.' + signature;
}

/**
 * Issue a session token.
 * @param {string} secret - Session signing secret (SESSION_SECRET)
 * @param {Object} [options] - Options with deterministic `now` (ms) and `ttlMs`
 * @returns {string} Session token
 * @throws {TypeError|RangeError} For invalid secrets or options
 */
function issueSessionToken(secret, options) {
  const { exp } = validateIssueOptions(secret, options);
  return signToken({ v: TOKEN_VERSION, t: 'session', exp }, secret);
}

/**
 * Issue a scoped share token for a single video.
 * @param {number} videoId - Positive safe integer video id
 * @param {string} secret - Share signing secret (SHARE_TOKEN_SECRET)
 * @param {Object} [options] - Options with deterministic `now` (ms) and `ttlMs`
 * @returns {string} Share token
 * @throws {TypeError|RangeError} For invalid video ids, secrets, or options
 */
function issueShareToken(videoId, secret, options) {
  if (videoId === undefined) {
    throw new TypeError('videoId must be a positive safe integer');
  }
  const { exp } = validateIssueOptions(secret, options, videoId);
  return signToken({ v: TOKEN_VERSION, t: 'share', exp, vid: videoId }, secret);
}

/**
 * Verify a token against its expected type. Never throws; any malformed or
 * forged input is rejected.
 * @param {*} token - Token to verify (attacker-controlled)
 * @param {*} secret - Signing secret (attacker-controlled, rejected when invalid)
 * @param {string} expectedType - 'session' or 'share'
 * @param {Object} [options] - Verify options with deterministic `now` (ms)
 * @returns {{ exp: number, vid: number|null }|null} Verified expiry and video id, or null
 */
function verifyToken(token, secret, expectedType, options) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    return null;
  }
  const now = resolveNow(options);
  if (now === null) {
    return null;
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot >= token.length - 1) {
    return null;
  }
  const payloadPart = token.slice(0, dot);
  const signaturePart = token.slice(dot + 1);
  if (
    signaturePart.indexOf('.') !== -1 ||
    !isCanonicalBase64Url(payloadPart) ||
    !isCanonicalBase64Url(signaturePart)
  ) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const expectedKeys = expectedType === 'session' ? 'exp,t,v' : 'exp,t,v,vid';
  if (Object.keys(payload).sort().join(',') !== expectedKeys) {
    return null;
  }
  if (payload.v !== TOKEN_VERSION || payload.t !== expectedType) {
    return null;
  }
  if (expectedType === 'share' && (!Number.isSafeInteger(payload.vid) || payload.vid <= 0)) {
    return null;
  }
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= 0) {
    return null;
  }
  const provided = Buffer.from(signaturePart, 'base64url');
  const expected = crypto.createHmac('sha256', secret).update(payloadPart).digest();
  if (provided.length !== expected.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(provided, expected)) {
    return null;
  }
  if (now >= payload.exp) {
    return null;
  }
  return { exp: payload.exp, vid: expectedType === 'share' ? payload.vid : null };
}

/**
 * Verify a session token.
 * @param {*} token - Token to verify
 * @param {*} secret - Session signing secret (SESSION_SECRET)
 * @param {Object} [options] - Verify options with deterministic `now` (ms)
 * @returns {boolean} True when the token is authentic, well-formed, and unexpired
 */
function verifySessionToken(token, secret, options) {
  return verifyToken(token, secret, 'session', options) !== null;
}

/**
 * Verify a scoped share token.
 * @param {*} token - Token to verify
 * @param {*} secret - Share signing secret (SHARE_TOKEN_SECRET)
 * @param {Object} [options] - Verify options with deterministic `now` (ms)
 * @returns {{ videoId: number, expiresAt: number }|null} Verified video id and expiry, or null
 */
function verifyShareToken(token, secret, options) {
  const verified = verifyToken(token, secret, 'share', options);
  if (verified === null) {
    return null;
  }
  return { videoId: verified.vid, expiresAt: verified.exp };
}

module.exports = {
  issueSessionToken,
  verifySessionToken,
  issueShareToken,
  verifyShareToken
};
