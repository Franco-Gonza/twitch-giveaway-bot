import { EventEmitter } from 'node:events';

/**
 * Scheduler coordinates periodic dispatch of random giveaway messages with jitter.
 */
export class MessageScheduler extends EventEmitter {
  constructor(options = {}) {
    super();
    this.messages = options.messages || ['!sorteo'];
    this.minInterval = options.minIntervalSeconds || 30;
    this.maxInterval = options.maxIntervalSeconds || 60;
    this.avoidConsecutiveRepeats = options.avoidConsecutiveRepeats ?? true;

    this.running = false;
    this.timerId = null;
    this.tickIntervalId = null;
    this.nextDispatchTime = 0;
    this.currentTotalIntervalSeconds = 0;
    this.lastMessage = null;
    this.stats = {
      sentCount: 0,
      startTime: null
    };
  }

  updateConfig(config = {}) {
    if (Array.isArray(config.messages) && config.messages.length > 0) {
      this.messages = config.messages;
    }
    if (typeof config.minIntervalSeconds === 'number') {
      this.minInterval = config.minIntervalSeconds;
    }
    if (typeof config.maxIntervalSeconds === 'number') {
      this.maxInterval = config.maxIntervalSeconds;
    }
    if (typeof config.avoidConsecutiveRepeats === 'boolean') {
      this.avoidConsecutiveRepeats = config.avoidConsecutiveRepeats;
    }
  }

  start() {
    if (this.running) return;
    if (!this.messages || this.messages.length === 0) {
      this.emit('error', new Error('No messages configured to dispatch'));
      return;
    }

    this.running = true;
    this.stats.startTime = Date.now();
    this.emit('status_change', { running: true });

    // Start 1-second countdown ticker for UI progress
    this._startCountdownTicker();

    // Schedule the first dispatch after initial interval
    this._scheduleNext();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this._clearTimers();
    this.nextDispatchTime = 0;
    this.currentTotalIntervalSeconds = 0;
    this.emit('status_change', { running: false });
    this.emit('countdown', { remainingSeconds: 0, totalSeconds: 0 });
  }

  pickRandomMessage() {
    if (!this.messages || this.messages.length === 0) return null;
    if (this.messages.length === 1) return this.messages[0];

    let candidates = this.messages;
    if (this.avoidConsecutiveRepeats && this.lastMessage) {
      candidates = this.messages.filter(m => m !== this.lastMessage);
      if (candidates.length === 0) {
        candidates = this.messages;
      }
    }

    const index = Math.floor(Math.random() * candidates.length);
    const chosen = candidates[index];
    this.lastMessage = chosen;
    return chosen;
  }

  calculateNextIntervalSeconds() {
    const min = Math.max(5, this.minInterval);
    const max = Math.max(min, this.maxInterval);
    // Include uniform random jitter between min and max
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  getState() {
    const remainingSeconds = this.running && this.nextDispatchTime > 0
      ? Math.max(0, Math.ceil((this.nextDispatchTime - Date.now()) / 1000))
      : 0;

    return {
      running: this.running,
      remainingSeconds,
      totalSeconds: this.currentTotalIntervalSeconds,
      sentCount: this.stats.sentCount,
      lastMessage: this.lastMessage,
      startTime: this.stats.startTime
    };
  }

  _scheduleNext() {
    if (!this.running) return;

    const intervalSec = this.calculateNextIntervalSeconds();
    this.currentTotalIntervalSeconds = intervalSec;
    this.nextDispatchTime = Date.now() + intervalSec * 1000;

    this.emit('scheduled', {
      intervalSeconds: intervalSec,
      nextDispatchTime: this.nextDispatchTime
    });

    this.timerId = setTimeout(() => {
      this._dispatch();
    }, intervalSec * 1000);
  }

  _dispatch() {
    if (!this.running) return;

    const message = this.pickRandomMessage();
    if (message) {
      this.stats.sentCount++;
      this.emit('dispatch', {
        message,
        sentCount: this.stats.sentCount,
        timestamp: new Date().toISOString()
      });
    }

    // Schedule next message
    this._scheduleNext();
  }

  _startCountdownTicker() {
    if (this.tickIntervalId) clearInterval(this.tickIntervalId);
    this.tickIntervalId = setInterval(() => {
      if (!this.running || this.nextDispatchTime <= 0) return;
      const remainingSeconds = Math.max(0, Math.ceil((this.nextDispatchTime - Date.now()) / 1000));
      this.emit('countdown', {
        remainingSeconds,
        totalSeconds: this.currentTotalIntervalSeconds
      });
    }, 1000);
  }

  _clearTimers() {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.tickIntervalId) {
      clearInterval(this.tickIntervalId);
      this.tickIntervalId = null;
    }
  }
}
