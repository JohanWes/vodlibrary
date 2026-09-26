/** Positive integer from an environment-style value, or `fallback`. */
function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Canonical safe-integer string (no sign, leading zeros, spaces, decimals or
 * exponents) as a number, or null. Positive only unless `allowZero`.
 */
function parseCanonicalInt(raw, { allowZero = false } = {}) {
  if (typeof raw !== 'string' || !(allowZero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

module.exports = { parsePositiveInt, parseCanonicalInt };
