import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BotManager } from '../src/bot-manager.js';

describe('BotManager Unit Tests', () => {
  test('initializes and manages multiple bots', () => {
    const manager = new BotManager({
      defaultAccount: {
        username: 'testuser',
        oauthToken: 'oauth:sampletoken'
      },
      bots: [
        {
          id: 'bot-1',
          name: 'Rubius Bot',
          channel: 'rubius',
          minIntervalSeconds: 30,
          maxIntervalSeconds: 60,
          messages: ['!sorteo', 'GG']
        },
        {
          id: 'bot-2',
          name: 'Ibai Bot',
          channel: 'ibai',
          minIntervalSeconds: 20,
          maxIntervalSeconds: 40,
          messages: ['!ticket', 'Vamooo']
        }
      ]
    });

    assert.equal(manager.bots.size, 2);
    assert.ok(manager.bots.has('bot-1'));
    assert.ok(manager.bots.has('bot-2'));

    const states = manager.getAllStates();
    assert.equal(states['bot-1'].running, false);
    assert.equal(states['bot-2'].running, false);
  });

  test('resolves default account vs custom account for bot', () => {
    const manager = new BotManager({
      defaultAccount: { username: 'default_user', oauthToken: 'oauth:default' }
    });

    const bot1 = { id: 'b1', name: 'Bot 1' };
    const acc1 = manager.getAccountForBot(bot1);
    assert.equal(acc1.username, 'default_user');

    const bot2 = {
      id: 'b2',
      name: 'Bot 2',
      customAccount: { username: 'custom_user', oauthToken: 'oauth:custom' }
    };
    const acc2 = manager.getAccountForBot(bot2);
    assert.equal(acc2.username, 'custom_user');
  });

  test('starts and stops individual bots independently', () => {
    const manager = new BotManager({
      defaultAccount: { username: 'test_user', oauthToken: 'oauth:sample' },
      bots: [
        { id: 'b1', name: 'B1', channel: 'ch1', messages: ['m1'] },
        { id: 'b2', name: 'B2', channel: 'ch2', messages: ['m2'] }
      ]
    });

    // Mock client creation
    manager.getOrCreateClient = () => ({
      status: 'authenticated',
      connect: () => {},
      joinChannel: () => {},
      sendMessage: () => true
    });

    const state1 = manager.startBot('b1');
    assert.equal(state1.running, true);
    assert.equal(manager.bots.get('b2').scheduler.getState().running, false);

    const stopState1 = manager.stopBot('b1');
    assert.equal(stopState1.running, false);
  });
});
