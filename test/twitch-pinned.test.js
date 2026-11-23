import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTwitchChannelId, fetchPinnedChatMessage } from '../src/twitch-pinned.js';

describe('TwitchPinnedChat Unit Tests', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns null for empty or invalid channel login', async () => {
    const res1 = await fetchPinnedChatMessage('');
    const res2 = await fetchPinnedChatMessage(null);
    const id1 = await getTwitchChannelId('');

    assert.equal(res1, null);
    assert.equal(res2, null);
    assert.equal(id1, null);
  });

  test('fetches and parses pinned chat message successfully', async () => {
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);

      // Handle user ID resolution query
      if (body.query) {
        return {
          ok: true,
          json: async () => ({
            data: { user: { id: '39276140', displayName: 'Rubius' } }
          })
        };
      }

      // Handle GetPinnedChat persisted query
      if (Array.isArray(body) && body[0].operationName === 'GetPinnedChat') {
        return {
          ok: true,
          json: async () => ([
            {
              data: {
                channel: {
                  pinnedChatMessages: {
                    edges: [
                      {
                        node: {
                          id: 'pin-12345',
                          updatedAt: '2026-11-22T20:00:00Z',
                          pinnedBy: { displayName: 'csinhache', login: 'csinhache' },
                          pinnedMessage: {
                            sender: { displayName: 'csinhache', login: 'csinhache' },
                            content: {
                              text: 'sorteo cada 10m entre gente del chat'
                            }
                          }
                        }
                      }
                    ]
                  }
                }
              }
            }
          ])
        };
      }

      return { ok: false, json: async () => ({}) };
    };

    const pinned = await fetchPinnedChatMessage('rubius');
    assert.ok(pinned);
    assert.equal(pinned.id, 'pin-12345');
    assert.equal(pinned.channel, 'rubius');
    assert.equal(pinned.pinnedBy, 'csinhache');
    assert.equal(pinned.text, 'sorteo cada 10m entre gente del chat');
  });

  test('returns null when channel has no pinned chat message', async () => {
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.query) {
        return {
          ok: true,
          json: async () => ({
            data: { user: { id: '999999', displayName: 'EmptyChannel' } }
          })
        };
      }
      return {
        ok: true,
        json: async () => ([
          {
            data: {
              channel: {
                pinnedChatMessages: {
                  edges: []
                }
              }
            }
          }
        ])
      };
    };

    const pinned = await fetchPinnedChatMessage('emptychannel');
    assert.equal(pinned, null);
  });
});
