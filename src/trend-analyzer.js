/**
 * TrendAnalyzer tracks incoming chat messages within a sliding time window
 * to detect hype spikes, giveaways, and crowd chants in real time.
 */
export class TrendAnalyzer {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 25000; // 25 seconds sliding window
    this.history = new Map(); // channel -> Array<{ text: string, time: number, username: string }>
  }

  recordMessage(channel, text, username = '') {
    if (!channel || !text || typeof text !== 'string') return;
    const cleanChan = channel.replace(/^#/, '').toLowerCase();
    const cleanText = text.trim();
    if (cleanText.length < 2 || cleanText.length > 150) return;

    if (!this.history.has(cleanChan)) {
      this.history.set(cleanChan, []);
    }

    const now = Date.now();
    const list = this.history.get(cleanChan);
    list.push({ text: cleanText, time: now, username: (username || '').toLowerCase() });

    // Prune entries outside the time window
    this.prune(cleanChan);
  }

  prune(channel) {
    const cleanChan = channel.replace(/^#/, '').toLowerCase();
    const list = this.history.get(cleanChan);
    if (!list || list.length === 0) return;

    const cutoff = Date.now() - this.windowMs;
    // Fast in-place binary or slice filter
    const firstValidIdx = list.findIndex(m => m.time >= cutoff);
    if (firstValidIdx === -1) {
      list.length = 0;
    } else if (firstValidIdx > 0) {
      list.splice(0, firstValidIdx);
    }
  }

  getTopTrend(channel, options = {}) {
    const cleanChan = channel.replace(/^#/, '').toLowerCase();
    this.prune(cleanChan);
    const list = this.history.get(cleanChan);
    if (!list || list.length < 5) return null;

    const minOccurrences = options.minOccurrences || 4;
    const minRatio = options.minRatio || 0.15; // At least 15% of chat in window

    // Frequency map
    const counts = new Map();
    for (const item of list) {
      // Normalize comparison (case-insensitive for clustering)
      const norm = item.text.toLowerCase();
      const existing = counts.get(norm);
      if (existing) {
        existing.count++;
      } else {
        counts.set(norm, { text: item.text, count: 1 });
      }
    }

    let top = null;
    for (const item of counts.values()) {
      if (!top || item.count > top.count) {
        top = item;
      }
    }

    if (!top) return null;

    const total = list.length;
    const ratio = top.count / total;

    if (top.count >= minOccurrences && ratio >= minRatio) {
      return {
        text: top.text,
        count: top.count,
        totalInWindow: total,
        percentage: Math.round(ratio * 100)
      };
    }

    return null;
  }

  getChannelStats(channel, options = {}) {
    const cleanChan = (channel || '').replace(/^#/, '').toLowerCase();
    this.prune(cleanChan);
    const list = this.history.get(cleanChan);
    const windowSecs = Math.round(this.windowMs / 1000);

    if (!list || list.length === 0) {
      return {
        totalInWindow: 0,
        windowSeconds: windowSecs,
        topTrend: null,
        topPhrases: []
      };
    }

    const minOccurrences = options.minOccurrences || 4;
    const minRatio = options.minRatio || 0.15;

    const counts = new Map();
    for (const item of list) {
      const norm = item.text.toLowerCase();
      const existing = counts.get(norm);
      if (existing) {
        existing.count++;
      } else {
        counts.set(norm, { text: item.text, count: 1 });
      }
    }

    const sorted = Array.from(counts.values()).sort((a, b) => b.count - a.count);
    const top = sorted[0] || null;
    const total = list.length;
    const ratio = top ? top.count / total : 0;
    const meetsThreshold = top ? (top.count >= minOccurrences && ratio >= minRatio) : false;

    return {
      totalInWindow: total,
      windowSeconds: windowSecs,
      topTrend: top ? {
        text: top.text,
        count: top.count,
        percentage: Math.round(ratio * 100),
        meetsThreshold
      } : null,
      topPhrases: sorted.slice(0, 4).map(p => ({
        text: p.text,
        count: p.count,
        percentage: Math.round((p.count / total) * 100)
      }))
    };
  }

  clear(channel) {
    if (channel) {
      this.history.delete(channel.replace(/^#/, '').toLowerCase());
    } else {
      this.history.clear();
    }
  }
}
