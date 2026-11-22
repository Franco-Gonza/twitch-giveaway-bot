import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TrendAnalyzer } from '../src/trend-analyzer.js';

describe('TrendAnalyzer Unit Tests', () => {
  test('detects top trend when phrase exceeds threshold', () => {
    const analyzer = new TrendAnalyzer({ windowMs: 10000 });

    // Simulate 10 chat messages where 6 are '!sorteo'
    analyzer.recordMessage('rubius', '!sorteo', 'user1');
    analyzer.recordMessage('rubius', '!sorteo', 'user2');
    analyzer.recordMessage('rubius', 'hola', 'user3');
    analyzer.recordMessage('rubius', '!sorteo', 'user4');
    analyzer.recordMessage('rubius', 'buenas', 'user5');
    analyzer.recordMessage('rubius', '!sorteo', 'user6');
    analyzer.recordMessage('rubius', '!sorteo', 'user7');
    analyzer.recordMessage('rubius', '!sorteo', 'user8');

    const trend = analyzer.getTopTrend('rubius', { minOccurrences: 4, minRatio: 0.2 });

    assert.ok(trend);
    assert.equal(trend.text.toLowerCase(), '!sorteo');
    assert.equal(trend.count, 6);
    assert.ok(trend.percentage >= 60);
  });

  test('returns null when chat is varied and no spike exists', () => {
    const analyzer = new TrendAnalyzer({ windowMs: 10000 });

    analyzer.recordMessage('rubius', 'hola', 'u1');
    analyzer.recordMessage('rubius', 'buenas', 'u2');
    analyzer.recordMessage('rubius', 'como andan', 'u3');
    analyzer.recordMessage('rubius', 'todo bien', 'u4');
    analyzer.recordMessage('rubius', 'saludos', 'u5');
    analyzer.recordMessage('rubius', 'GG', 'u6');

    const trend = analyzer.getTopTrend('rubius', { minOccurrences: 4, minRatio: 0.2 });
    assert.equal(trend, null);
  });

  test('computes channel stats with top phrases and volume', () => {
    const analyzer = new TrendAnalyzer({ windowMs: 10000 });

    analyzer.recordMessage('rubius', 'GG', 'u1');
    analyzer.recordMessage('rubius', 'GG', 'u2');
    analyzer.recordMessage('rubius', 'DinoDance', 'u3');
    analyzer.recordMessage('rubius', 'GG', 'u4');
    analyzer.recordMessage('rubius', 'hola', 'u5');

    const stats = analyzer.getChannelStats('rubius');
    assert.equal(stats.totalInWindow, 5);
    assert.ok(stats.topTrend);
    assert.equal(stats.topTrend.text, 'GG');
    assert.equal(stats.topTrend.count, 3);
    assert.equal(stats.topTrend.percentage, 60);
    assert.ok(stats.topPhrases.length >= 2);
    assert.equal(stats.topPhrases[0].text, 'GG');
  });
});
