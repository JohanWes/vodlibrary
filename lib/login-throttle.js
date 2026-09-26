const net = require('net');

/**
 * Throttle key for a client address: the IPv4 address itself (IPv4-mapped
 * IPv6 included), or the /64 prefix of an IPv6 address, because a single
 * IPv6 client can rotate freely through its /64.
 */
function throttleKey(ip) {
  const address = String(ip || '').split('%')[0]; // drop an IPv6 zone id
  const mapped = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : null;
  if (mapped && net.isIPv4(mapped)) {
    return mapped;
  }
  if (!net.isIPv6(address)) {
    return address || 'unknown';
  }

  const toGroups = (part) => (part ? part.split(':') : []).flatMap((group) => {
    if (!group.includes('.')) {
      return [group];
    }
    const [a, b, c, d] = group.split('.').map(Number); // embedded IPv4 tail
    return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
  });
  const [head, tail] = address.split('::');
  const headGroups = toGroups(head);
  const tailGroups = tail === undefined ? [] : toGroups(tail);
  const groups = [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups];

  const prefix = Buffer.alloc(8);
  groups.slice(0, 4).forEach((group, index) => prefix.writeUInt16BE(Number.parseInt(group, 16), index * 2));
  return `${prefix.toString('hex')}/64`;
}

/**
 * In-memory, bounded login failure throttle: `maxFailures` failures within
 * `lockoutMs` lock the key out for `lockoutMs`. A full table evicts the oldest
 * unlocked entry; locked entries are never evicted, so an attacker cannot
 * flush their own lock by filling the table.
 */
function createLoginThrottle({ maxFailures = 5, lockoutMs = 15 * 60 * 1000, maxEntries = 10000 } = {}) {
  const entries = new Map();

  const lockoutRemaining = (ip, now) => {
    const key = throttleKey(ip);
    const entry = entries.get(key);
    if (!entry) {
      return 0;
    }
    if (entry.lockedUntil > now) {
      return entry.lockedUntil - now;
    }
    if (entry.lockedUntil || now - entry.firstFailureAt > lockoutMs) {
      entries.delete(key);
    }
    return 0;
  };

  const evictOldestUnlocked = (now) => {
    for (const [key, entry] of entries) { // Map iterates in insertion order
      if (entry.lockedUntil <= now) {
        return entries.delete(key);
      }
    }
    return false;
  };

  const recordFailure = (ip, now) => {
    const key = throttleKey(ip);
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= maxEntries && !evictOldestUnlocked(now)) {
        return; // every tracked client is locked out; don't track new ones
      }
      entry = { count: 0, firstFailureAt: now, lockedUntil: 0 };
      entries.set(key, entry);
    }
    entry.count += 1;
    if (entry.count >= maxFailures) {
      entry.lockedUntil = now + lockoutMs;
    }
  };

  return {
    lockoutRemaining,
    recordFailure,
    clear: (ip) => entries.delete(throttleKey(ip)),
    reset: () => entries.clear(),
    size: () => entries.size
  };
}

module.exports = { createLoginThrottle, throttleKey };
