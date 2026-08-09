const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Video Cache Module', () => {
  let cache;

  beforeEach(() => {
    jest.resetModules();
    cache = require('../../lib/cache');
    cache.clearCache();
    cache.updateConfig({
      maxCacheSize: 1024,
      popularityThreshold: 0,
      maxSegmentsPerVideo: 10
    });
  });

  afterEach(() => {
    cache.clearCache();
  });

  test('builds cache keys with namespace, quality and byte-range identity', () => {
    const key = cache.buildCacheKey('42', 3, {
      namespace: 'preview-segment',
      quality: 'high',
      startByte: 1024,
      endByte: 2047
    });

    expect(key).toContain('video_42');
    expect(key).toContain('ns_preview-segment');
    expect(key).toContain('segment_3');
    expect(key).toContain('q_high');
    expect(key).toContain('r_1024-2047');
  });

  test('does not mix segments across quality variants', () => {
    const lowBuffer = Buffer.alloc(10, 1);
    const highBuffer = Buffer.alloc(10, 2);

    cache.cacheSegment('1', 0, lowBuffer, {
      namespace: 'preview-segment',
      quality: 'low',
      startByte: 0,
      endByte: 9
    });

    cache.cacheSegment('1', 0, highBuffer, {
      namespace: 'preview-segment',
      quality: 'high',
      startByte: 0,
      endByte: 9
    });

    const low = cache.getCachedSegment('1', 0, {
      namespace: 'preview-segment',
      quality: 'low',
      startByte: 0,
      endByte: 9
    });

    const high = cache.getCachedSegment('1', 0, {
      namespace: 'preview-segment',
      quality: 'high',
      startByte: 0,
      endByte: 9
    });

    expect(low.equals(lowBuffer)).toBe(true);
    expect(high.equals(highBuffer)).toBe(true);
  });

  test('evicts least recently used entries when max size is exceeded', () => {
    const first = Buffer.alloc(600, 1);
    const second = Buffer.alloc(600, 2);

    cache.cacheSegment('1', 0, first, {
      namespace: 'stream',
      quality: 'fixed_2mb',
      startByte: 0,
      endByte: 599
    });

    // Make sure first key is older than second.
    const firstRead = cache.getCachedSegment('1', 0, {
      namespace: 'stream',
      quality: 'fixed_2mb',
      startByte: 0,
      endByte: 599
    });
    expect(firstRead).not.toBeNull();

    cache.cacheSegment('1', 1, second, {
      namespace: 'stream',
      quality: 'fixed_2mb',
      startByte: 600,
      endByte: 1199
    });

    const evicted = cache.getCachedSegment('1', 0, {
      namespace: 'stream',
      quality: 'fixed_2mb',
      startByte: 0,
      endByte: 599
    });

    const retained = cache.getCachedSegment('1', 1, {
      namespace: 'stream',
      quality: 'fixed_2mb',
      startByte: 600,
      endByte: 1199
    });

    expect(evicted).toBeNull();
    expect(retained).not.toBeNull();
  });

  test('records request access by namespace', () => {
    cache.recordAccess('1', { namespace: 'stream' });
    cache.recordAccess('1', { namespace: 'stream' });
    cache.recordAccess('1', { namespace: 'preview-segment' });

    const stats = cache.getCacheStats();
    expect(stats.videoAccess['1:stream']).toBe(2);
    expect(stats.videoAccess['1:preview-segment']).toBe(1);
  });

  test('cacheSegmentFromFile starts caching only after request popularity threshold is reached', async () => {
    cache.updateConfig({
      popularityThreshold: 2,
      maxSegmentsPerVideo: 10
    });

    const tempFilePath = path.join(os.tmpdir(), `cache-module-${Date.now()}-${Math.random()}.bin`);
    fs.writeFileSync(tempFilePath, Buffer.alloc(16, 7));

    try {
      const beforeThreshold = await cache.cacheSegmentFromFile('9', 0, tempFilePath, 0, 7, {
        namespace: 'stream',
        quality: 'fixed_2mb'
      });
      expect(beforeThreshold).toBe(false);

      cache.recordAccess('9', { namespace: 'stream' });
      cache.recordAccess('9', { namespace: 'stream' });

      const afterThreshold = await cache.cacheSegmentFromFile('9', 0, tempFilePath, 0, 7, {
        namespace: 'stream',
        quality: 'fixed_2mb'
      });
      expect(afterThreshold).toBe(true);

      const cached = cache.getCachedSegment('9', 0, {
        namespace: 'stream',
        quality: 'fixed_2mb',
        startByte: 0,
        endByte: 7
      });
      expect(Buffer.isBuffer(cached)).toBe(true);
      expect(cached.length).toBe(8);
    } finally {
      fs.unlinkSync(tempFilePath);
    }
  });

  test('expired entries release byte and per-video accounting', async () => {
    cache.updateConfig({ stdTTL: 0.01, maxSegmentsPerVideo: 1 });
    const options = {
      namespace: 'stream',
      quality: 'fixed_2mb',
      startByte: 0,
      endByte: 7
    };

    expect(cache.cacheSegment('1', 0, Buffer.alloc(8), options)).toBe(true);
    expect(cache.getCacheStats()).toMatchObject({ size: 8, lruEntries: 1 });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.getCachedSegment('1', 0, options)).toBeNull();
    expect(cache.getCacheStats()).toMatchObject({ size: 0, lruEntries: 0 });

    expect(cache.cacheSegment('1', 1, Buffer.alloc(8), {
      ...options,
      startByte: 8,
      endByte: 15
    })).toBe(true);
  });

  test('coalesces concurrent fills for one cache key', async () => {
    const tempFilePath = path.join(os.tmpdir(), `cache-coalesce-${Date.now()}-${Math.random()}.bin`);
    fs.writeFileSync(tempFilePath, Buffer.alloc(16, 7));
    const readStreamSpy = jest.spyOn(fs, 'createReadStream');
    const options = {
      namespace: 'stream',
      quality: 'fixed_2mb'
    };

    try {
      const results = await Promise.all([
        cache.cacheSegmentFromFile('10', 0, tempFilePath, 0, 7, options),
        cache.cacheSegmentFromFile('10', 0, tempFilePath, 0, 7, options)
      ]);

      expect(results).toEqual([true, true]);
      expect(readStreamSpy).toHaveBeenCalledTimes(1);
      expect(cache.getCacheStats()).toMatchObject({ size: 8, lruEntries: 1 });
    } finally {
      readStreamSpy.mockRestore();
      fs.unlinkSync(tempFilePath);
    }
  });
});
