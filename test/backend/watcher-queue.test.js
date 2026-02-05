const { createWatcherQueue } = require('../../server');

describe('Watcher queue', () => {
  test('coalesces rapid events for the same path', async () => {
    const queue = createWatcherQueue({ concurrency: 1, debounceMs: 10 });
    const events = [];

    queue.schedule('/tmp/file.mp4', async () => {
      events.push('first');
    });

    queue.schedule('/tmp/file.mp4', async () => {
      events.push('second');
    });

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(events).toEqual(['second']);
    queue.shutdown();
  });

  test('limits concurrent task execution', async () => {
    const queue = createWatcherQueue({ concurrency: 1, debounceMs: 0 });
    let active = 0;
    let maxActive = 0;

    const task = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    };

    queue.schedule('/tmp/a.mp4', task);
    queue.schedule('/tmp/b.mp4', task);
    queue.schedule('/tmp/c.mp4', task);

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(maxActive).toBe(1);
    queue.shutdown();
  });
});
