const { createLoginThrottle, throttleKey } = require('../../lib/login-throttle');

describe('throttleKey', () => {
  test.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2::1', '20010db800010002/64'],
    ['2001:db8:1:2:ffff:ffff:ffff:ffff', '20010db800010002/64'],
    ['2001:DB8:1:2:0:0:0:1', '20010db800010002/64'],
    ['2001:db8::', '20010db800000000/64'],
    ['::1', '0000000000000000/64'],
    ['fe80::1%eth0', 'fe80000000000000/64'],
    ['64:ff9b::192.0.2.1', '0064ff9b00000000/64'],
    ['', 'unknown'],
    [undefined, 'unknown']
  ])('%s -> %s', (ip, key) => {
    expect(throttleKey(ip)).toBe(key);
  });
});

describe('createLoginThrottle', () => {
  const lockoutMs = 1000;

  test('locks after maxFailures and unlocks after lockoutMs', () => {
    const throttle = createLoginThrottle({ maxFailures: 2, lockoutMs });
    throttle.recordFailure('1.1.1.1', 0);
    expect(throttle.lockoutRemaining('1.1.1.1', 1)).toBe(0);
    throttle.recordFailure('1.1.1.1', 1);
    expect(throttle.lockoutRemaining('1.1.1.1', 1)).toBe(lockoutMs);
    expect(throttle.lockoutRemaining('1.1.1.1', 1 + lockoutMs)).toBe(0);
    expect(throttle.size()).toBe(0);
  });

  test('a full table evicts the oldest unlocked entry, never a locked one', () => {
    const throttle = createLoginThrottle({ maxFailures: 2, lockoutMs, maxEntries: 3 });
    throttle.recordFailure('10.0.0.1', 0); // locked below
    throttle.recordFailure('10.0.0.1', 0);
    throttle.recordFailure('10.0.0.2', 0); // oldest unlocked
    throttle.recordFailure('10.0.0.3', 0);

    throttle.recordFailure('10.0.0.4', 10);

    expect(throttle.size()).toBe(3);
    expect(throttle.lockoutRemaining('10.0.0.1', 10)).toBeGreaterThan(0);
    throttle.recordFailure('10.0.0.3', 10); // still tracked: second failure locks
    expect(throttle.lockoutRemaining('10.0.0.3', 10)).toBeGreaterThan(0);
    expect(throttle.lockoutRemaining('10.0.0.2', 10)).toBe(0); // evicted
  });

  test('when every entry is locked, new failures are not tracked and locks survive', () => {
    const throttle = createLoginThrottle({ maxFailures: 1, lockoutMs, maxEntries: 2 });
    throttle.recordFailure('10.0.0.1', 0);
    throttle.recordFailure('10.0.0.2', 0);

    throttle.recordFailure('10.0.0.3', 1);

    expect(throttle.size()).toBe(2);
    expect(throttle.lockoutRemaining('10.0.0.1', 1)).toBeGreaterThan(0);
    expect(throttle.lockoutRemaining('10.0.0.2', 1)).toBeGreaterThan(0);
    expect(throttle.lockoutRemaining('10.0.0.3', 1)).toBe(0);
  });
});
