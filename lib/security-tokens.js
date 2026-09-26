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

/**
 * Check that a string is canonical unpadded base64url: only the base64url
 * alphabet, a length that can represent whole bytes, and zero padding bits.
 * Decoding is lenient, so a re-encode round trip rejects everything else.
 * @param {string} str - Candidate string
 * @returns {boolean} True when the string is canonical base64url
 */
function isCanonicalBase64Url(str) {
  return str.length > 0 && Buffer.from(str, 'base64url').toString('base64url') === str;
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

function signToken(payload, secret) {
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
  return payloadPart + '.' + signature;
}

function issueSessionToken(secret, options) {
  const { exp } = validateIssueOptions(secret, options);
  return signToken({ v: TOKEN_VERSION, t: 'session', exp }, secret);
}

/** A share token is scoped to one video id. */
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

function verifySessionToken(token, secret, options) {
  return verifyToken(token, secret, 'session', options) !== null;
}

/** @returns {{ videoId: number, expiresAt: number }|null} */
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
