import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TwitchIrcClient } from '../src/twitch-irc.js';

describe('TwitchIrcClient Unit Tests', () => {
  test('initializes with default options and normalizes channel', () => {
    const client = new TwitchIrcClient({
      username: 'TestUser',
      oauthToken: 'oauth:sampletoken123',
      channel: '#SampleChannel'
    });

    assert.equal(client.username, 'testuser');
    assert.equal(client.channel, 'samplechannel');
    assert.equal(client.status, 'disconnected');
  });

  test('correctly responds to PING with PONG', () => {
    const client = new TwitchIrcClient();
    const sent = [];
    client._send = (line) => sent.push(line);

    client._parseLine('PING :tmi.twitch.tv');

    assert.equal(sent.length, 1);
    assert.equal(sent[0], 'PONG :tmi.twitch.tv');
  });

  test('authenticates on 001 message and joins channel', () => {
    const client = new TwitchIrcClient({
      username: 'botuser',
      channel: 'streamer'
    });
    const sent = [];
    client._send = (line) => sent.push(line);

    client._parseLine(':tmi.twitch.tv 001 botuser :Welcome, GLHF!');

    assert.equal(client.status, 'joined');
    assert.ok(sent.includes('JOIN #streamer'));
  });

  test('emits auth_failed on login failure notice', () => {
    const client = new TwitchIrcClient();
    let authFailedEmitted = false;
    client.on('auth_failed', () => {
      authFailedEmitted = true;
    });

    client._parseLine(':tmi.twitch.tv NOTICE * :Login authentication failed');

    assert.equal(authFailedEmitted, true);
    assert.equal(client.status, 'disconnected');
  });

  test('ignores USERNOTICE events and captures genuine NOTICE', () => {
    const client = new TwitchIrcClient();
    const notices = [];
    client.on('notice', (msg) => notices.push(msg));

    // USERNOTICE from subscriber message
    client._parseLine('@badge-info=... :tmi.twitch.tv USERNOTICE #rubius :vamoo');
    assert.equal(notices.length, 0);

    // Genuine channel notice (e.g. slow mode)
    client._parseLine(':tmi.twitch.tv NOTICE #rubius :This room is in slow mode.');
    assert.equal(notices.length, 1);
    assert.equal(notices[0], 'This room is in slow mode.');
  });

  test('sendMessage formats PRIVMSG command properly', () => {
    const client = new TwitchIrcClient({
      username: 'mybot',
      channel: 'targetchannel'
    });
    client.status = 'joined';

    const sent = [];
    client._send = (line) => sent.push(line);

    let messageSentEvent = null;
    client.on('message_sent', (evt) => {
      messageSentEvent = evt;
    });

    const success = client.sendMessage('!sorteo');

    assert.equal(success, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0], 'PRIVMSG #targetchannel :!sorteo');
    assert.equal(messageSentEvent.message, '!sorteo');
    assert.equal(messageSentEvent.channel, 'targetchannel');
  });
});
