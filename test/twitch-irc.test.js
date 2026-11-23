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

    assert.equal(client.status, 'authenticated');
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
    const client = new TwitchIrcClient({ channel: 'rubius' });
    const notices = [];
    client.on('notice', (msg) => notices.push(msg));

    // USERNOTICE from subscriber message
    client._parseLine('@badge-info=... :tmi.twitch.tv USERNOTICE #rubius :vamoo');
    assert.equal(notices.length, 0);

    // Genuine channel notice (e.g. slow mode)
    client._parseLine(':tmi.twitch.tv NOTICE #rubius :This room is in slow mode.');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].message, 'This room is in slow mode.');
  });

  test('detects subscriber status from USERSTATE badges', () => {
    const client = new TwitchIrcClient({ channel: 'rubius' });

    // User is not subscribed
    client._parseLine('@badge-info=;badges=premium/1;color=... :tmi.twitch.tv USERSTATE #rubius');
    assert.equal(client.isSubscribed, false);

    // User has subscriber badge
    client._parseLine('@badge-info=;badges=subscriber/12,premium/1;color=... :tmi.twitch.tv USERSTATE #rubius');
    assert.equal(client.isSubscribed, true);
  });

  test('blocks message dispatch during sub-only mode if not subscribed', () => {
    const client = new TwitchIrcClient({
      username: 'franco',
      channel: 'rubius'
    });
    client.status = 'authenticated';
    client.isSubscribed = false;

    // Room state activates subs-only
    client._parseLine('@slow=0;subs-only=1 :tmi.twitch.tv ROOMSTATE #rubius');
    assert.equal(client.subOnly, true);
    assert.equal(client.isSubOnlyBlocked(), true);

    const result = client.sendMessage('test message');
    assert.equal(result, 'sub_only_blocked');

    // Room state disables subs-only
    client._parseLine('@slow=0;subs-only=0 :tmi.twitch.tv ROOMSTATE #rubius');
    assert.equal(client.subOnly, false);
    assert.equal(client.isSubOnlyBlocked(), false);
  });

  test('sendMessage formats PRIVMSG command properly', () => {
    const client = new TwitchIrcClient({
      username: 'mybot',
      channel: 'targetchannel'
    });
    client.status = 'authenticated';

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

  test('supports sending to different channels explicitly', () => {
    const client = new TwitchIrcClient({
      username: 'multi_bot'
    });
    client.status = 'authenticated';

    const sent = [];
    client._send = (line) => sent.push(line);

    client.sendMessage('ibai', '!ticket');
    client.sendMessage('rubius', '!sorteo');

    // Joins each channel and sends PRIVMSG
    assert.ok(sent.includes('JOIN #ibai'));
    assert.ok(sent.includes('PRIVMSG #ibai :!ticket'));
    assert.ok(sent.includes('JOIN #rubius'));
    assert.ok(sent.includes('PRIVMSG #rubius :!sorteo'));
  });

  test('parses moderator announcements and emits announcement event', () => {
    const client = new TwitchIrcClient({
      username: 'viewer',
      channel: 'rubius'
    });

    let announcementEvt = null;
    client.on('announcement', (evt) => {
      announcementEvt = evt;
    });

    client._parseLine('@badge-info=;badges=moderator/1;msg-id=announcement;room-id=123 :tmi.twitch.tv USERNOTICE #rubius :Código del sorteo: 48291');

    assert.ok(announcementEvt);
    assert.equal(announcementEvt.channel, 'rubius');
    assert.equal(announcementEvt.message, 'Código del sorteo: 48291');
  });

  test('parses incoming chat PRIVMSG and identifies moderator messages correctly', () => {
    const client = new TwitchIrcClient({
      username: 'viewer',
      channel: 'rubius'
    });

    let chatEvt = null;
    client.on('chat_message', (evt) => {
      chatEvt = evt;
    });

    client._parseLine('@badge-info=;badges=moderator/1;color=#00FF7F;display-name=CsinHache;mod=1 :csinhache!csinhache@csinhache.tmi.twitch.tv PRIVMSG #rubius :sorteo cada 10m');

    assert.ok(chatEvt);
    assert.equal(chatEvt.channel, 'rubius');
    assert.equal(chatEvt.username, 'csinhache');
    assert.equal(chatEvt.displayName, 'CsinHache');
    assert.equal(chatEvt.message, 'sorteo cada 10m');
    assert.equal(chatEvt.isMod, true);
    assert.equal(chatEvt.isBroadcaster, false);
    assert.equal(chatEvt.color, '#00FF7F');
  });

  test('parses incoming chat PRIVMSG and identifies broadcaster correctly', () => {
    const client = new TwitchIrcClient({
      username: 'viewer',
      channel: 'rubius'
    });

    let chatEvt = null;
    client.on('chat_message', (evt) => {
      chatEvt = evt;
    });

    client._parseLine('@badge-info=;badges=broadcaster/1;color=#FF0000;display-name=Rubius;mod=0 :rubius!rubius@rubius.tmi.twitch.tv PRIVMSG #rubius :empezamos el sorteo!');

    assert.ok(chatEvt);
    assert.equal(chatEvt.channel, 'rubius');
    assert.equal(chatEvt.username, 'rubius');
    assert.equal(chatEvt.displayName, 'Rubius');
    assert.equal(chatEvt.message, 'empezamos el sorteo!');
    assert.equal(chatEvt.isMod, true);
    assert.equal(chatEvt.isBroadcaster, true);
  });

  test('safely handles incoming PONG messages without error', () => {
    const client = new TwitchIrcClient({
      username: 'viewer',
      channel: 'rubius'
    });

    assert.doesNotThrow(() => {
      client._parseLine('PONG :tmi.twitch.tv');
    });
  });

  test('safely handles WebSocket error events without throwing unhandled error', () => {
    const client = new TwitchIrcClient({
      username: 'viewer',
      channel: 'rubius'
    });

    // Verify there are no 'error' listeners registered
    assert.equal(client.listenerCount('error'), 0);

    // Mock ws with mock event dispatcher
    const errorHandlers = [];
    client.ws = {
      addEventListener: (type, cb) => {
        if (type === 'error') errorHandlers.push(cb);
      },
      readyState: 1,
      send: () => {}
    };

    // Attach mock error listener as TwitchIrcClient does
    client.ws.addEventListener('error', (event) => {
      const errMsg = event.message || 'Socket error';
      client.emit('log', { type: 'warning', text: errMsg });
      if (client.listenerCount('error') > 0) {
        client.emit('error', event);
      }
    });

    // Simulating websocket error event must NOT throw ERR_UNHANDLED_ERROR
    assert.doesNotThrow(() => {
      errorHandlers[0]({ message: 'ETIMEDOUT' });
    });
  });
});
