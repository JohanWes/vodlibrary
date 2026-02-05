const { scanLibrary, getScanStatus } = require('../../lib/scanner');

describe('scanLibrary environment guards', () => {
  test('marks scan as skipped when VIDEO_LIBRARY is not configured', async () => {
    const previous = process.env.VIDEO_LIBRARY;
    delete process.env.VIDEO_LIBRARY;

    try {
      await scanLibrary({});
      const status = getScanStatus();

      expect(status.status).toBe('completed');
      expect(status.message).toContain('VIDEO_LIBRARY is not configured');
      expect(status.endTime).not.toBeNull();
    } finally {
      process.env.VIDEO_LIBRARY = previous;
    }
  });

  test('marks scan as skipped when VIDEO_LIBRARY is empty', async () => {
    const previous = process.env.VIDEO_LIBRARY;
    process.env.VIDEO_LIBRARY = '   ';

    try {
      await scanLibrary({});
      const status = getScanStatus();

      expect(status.status).toBe('completed');
      expect(status.message).toContain('VIDEO_LIBRARY is not configured');
    } finally {
      process.env.VIDEO_LIBRARY = previous;
    }
  });
});
