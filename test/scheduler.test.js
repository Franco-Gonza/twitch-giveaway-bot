import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MessageScheduler } from '../src/scheduler.js';

describe('MessageScheduler Unit Tests', () => {
  test('calculates interval within configured bounds', () => {
    const scheduler = new MessageScheduler({
      minIntervalSeconds: 10,
      maxIntervalSeconds: 20
    });

    for (let i = 0; i < 50; i++) {
      const interval = scheduler.calculateNextIntervalSeconds();
      assert.ok(interval >= 10, `Interval ${interval} should be >= 10`);
      assert.ok(interval <= 20, `Interval ${interval} should be <= 20`);
    }
  });

  test('enforces minimum safety interval of 5 seconds', () => {
    const scheduler = new MessageScheduler({
      minIntervalSeconds: 1, // Below safety threshold
      maxIntervalSeconds: 2
    });

    const interval = scheduler.calculateNextIntervalSeconds();
    assert.ok(interval >= 5, `Expected interval to clamp to >= 5, got ${interval}`);
  });

  test('picks random message from pool', () => {
    const pool = ['!sorteo', '!ticket', 'suerte'];
    const scheduler = new MessageScheduler({ messages: pool });

    const picked = scheduler.pickRandomMessage();
    assert.ok(pool.includes(picked));
  });

  test('avoids consecutive repeats when configured and pool > 1', () => {
    const pool = ['MSG_A', 'MSG_B'];
    const scheduler = new MessageScheduler({
      messages: pool,
      avoidConsecutiveRepeats: true
    });

    let previous = null;
    for (let i = 0; i < 30; i++) {
      const current = scheduler.pickRandomMessage();
      if (previous !== null) {
        assert.notEqual(current, previous, `Message "${current}" repeated consecutively`);
      }
      previous = current;
    }
  });

  test('tracks state and report correctly', () => {
    const scheduler = new MessageScheduler({
      messages: ['!participar']
    });

    assert.equal(scheduler.getState().running, false);
    assert.equal(scheduler.getState().sentCount, 0);

    scheduler.start();
    assert.equal(scheduler.getState().running, true);

    scheduler.stop();
    assert.equal(scheduler.getState().running, false);
  });
});
