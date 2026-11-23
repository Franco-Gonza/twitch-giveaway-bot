import { EventEmitter } from 'node:events';
import { TwitchIrcClient } from './twitch-irc.js';
import { MessageScheduler } from './scheduler.js';
import { TrendAnalyzer } from './trend-analyzer.js';

export class BotManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.defaultAccount = config.defaultAccount || { username: '', oauthToken: '' };
    this.clients = new Map(); // username -> TwitchIrcClient
    this.bots = new Map(); // botId -> { botConfig, scheduler, state }
    this.trendAnalyzer = new TrendAnalyzer();

    // Initialize configured bots
    if (Array.isArray(config.bots)) {
      for (const bot of config.bots) {
        this._initBot(bot);
      }
    }

    this._startTrendTicker();
  }

  _startTrendTicker() {
    if (this._trendTicker) return;
    this._trendTicker = setInterval(() => {
      for (const [botId, runner] of this.bots.entries()) {
        const state = runner.scheduler.getState();
        if (state.running && runner.botConfig.autoDetectTrends && runner.botConfig.channel) {
          const stats = this.trendAnalyzer.getChannelStats(runner.botConfig.channel);
          this.emit('bot_trend', {
            botId,
            channel: runner.botConfig.channel,
            stats
          });
        }
      }
    }, 2000);

    if (this._trendTicker.unref) {
      this._trendTicker.unref();
    }
  }

  updateConfig(config) {
    if (config.defaultAccount) {
      this.defaultAccount = config.defaultAccount;
    }

    if (Array.isArray(config.bots)) {
      const incomingIds = new Set(config.bots.map(b => b.id));

      // Remove deleted bots
      for (const [id, runner] of this.bots.entries()) {
        if (!incomingIds.has(id)) {
          runner.scheduler.stop();
          this.bots.delete(id);
        }
      }

      // Update or create bots
      for (const botConfig of config.bots) {
        if (this.bots.has(botConfig.id)) {
          this._updateBot(botConfig.id, botConfig);
        } else {
          this._initBot(botConfig);
        }
      }
    }
  }

  getAccountForBot(botConfig) {
    if (botConfig.customAccount && botConfig.customAccount.username && botConfig.customAccount.oauthToken) {
      return botConfig.customAccount;
    }
    return this.defaultAccount;
  }

  getOrCreateClient(account) {
    const user = (account.username || '').toLowerCase();
    if (!user) return null;

    if (!this.clients.has(user)) {
      const client = new TwitchIrcClient({
        username: user,
        oauthToken: account.oauthToken
      });

      client.on('log', (entry) => {
        this.emit('log', { ...entry, username: user });
      });

      client.on('status_change', (status) => {
        this.emit('client_status', { username: user, status });
      });

      client.on('chat_message', (payload) => {
        const { channel, username, message, isMod, isBroadcaster, displayName, color } = payload;
        this.trendAnalyzer.recordMessage(channel, message, username);
        this.emit('chat_message', {
          ...payload,
          channel,
          username,
          message,
          isSelf: username === user,
          isMod: Boolean(isMod),
          isBroadcaster: Boolean(isBroadcaster),
          displayName: displayName || username,
          color: color || null,
          timestamp: Date.now()
        });
      });

      client.on('message_sent', ({ channel, message }) => {
        this.emit('chat_message', {
          channel,
          username: user,
          displayName: user,
          message,
          isSelf: true,
          isMod: false,
          isBroadcaster: false,
          color: null,
          timestamp: Date.now()
        });
      });

      client.on('room_state', (data) => {
        this.emit('room_state', data);
      });

      client.on('announcement', (data) => {
        this.emit('announcement', data);
      });

      this.clients.set(user, client);
    } else {
      // Update token if changed
      const existing = this.clients.get(user);
      if (account.oauthToken && account.oauthToken !== existing.oauthToken) {
        existing.updateCredentials(account);
      }
    }

    return this.clients.get(user);
  }

  _initBot(botConfig) {
    const scheduler = new MessageScheduler({
      messages: botConfig.messages,
      minIntervalSeconds: botConfig.minIntervalSeconds,
      maxIntervalSeconds: botConfig.maxIntervalSeconds,
      avoidConsecutiveRepeats: botConfig.avoidConsecutiveRepeats
    });

    const runner = {
      botConfig,
      scheduler
    };

    scheduler.on('dispatch', ({ message }) => {
      this._dispatchBotMessage(botConfig.id, message);
    });

    scheduler.on('countdown', (countdown) => {
      this.emit('bot_countdown', {
        botId: botConfig.id,
        ...countdown
      });
    });

    scheduler.on('status_change', () => {
      this.emit('bot_state', {
        botId: botConfig.id,
        ...scheduler.getState()
      });
    });

    this.bots.set(botConfig.id, runner);
  }

  _updateBot(botId, newConfig) {
    const runner = this.bots.get(botId);
    if (!runner) return;

    runner.botConfig = newConfig;
    runner.scheduler.updateConfig({
      messages: newConfig.messages,
      minIntervalSeconds: newConfig.minIntervalSeconds,
      maxIntervalSeconds: newConfig.maxIntervalSeconds,
      avoidConsecutiveRepeats: newConfig.avoidConsecutiveRepeats
    });
  }

  _dispatchBotMessage(botId, defaultMessage) {
    const runner = this.bots.get(botId);
    if (!runner) return;

    const account = this.getAccountForBot(runner.botConfig);
    const client = this.getOrCreateClient(account);

    if (!client) {
      this.emit('log', {
        type: 'error',
        text: `[${runner.botConfig.name}] No valid Twitch credentials configured.`
      });
      return;
    }

    if (client.status !== 'authenticated') {
      client.connect();
    }

    // Proactive Sub-Only Mode check: never send suspicious / rejected attempts to Twitch IRC
    if (client.isSubOnlyBlocked(runner.botConfig.channel)) {
      this.emit('log', {
        type: 'warning',
        text: `[#${runner.botConfig.channel}] ⏸ Modo Suscriptores activo: bot en pausa preventiva para evitar envíos sospechosos.`
      });
      return;
    }

    // Hybrid Trend Detection: Check if there is an active crowd trend
    let messageToSend = defaultMessage;
    if (runner.botConfig.autoDetectTrends) {
      const trend = this.trendAnalyzer.getTopTrend(runner.botConfig.channel);
      if (trend) {
        messageToSend = trend.text;
        this.emit('log', {
          type: 'info',
          text: `[#${runner.botConfig.channel}] 🔥 Crowd Mimic: Detected trend "${trend.text}" (${trend.percentage}% of chat)`
        });
      }
    }

    const sent = client.sendMessage(runner.botConfig.channel, messageToSend);
    if (sent === 'sub_only_blocked') {
      // Logged in client
    } else if (!sent) {
      this.emit('log', {
        type: 'warning',
        text: `[${runner.botConfig.name}] Dispatch skipped (connection not ready).`
      });
    }

    this.emit('bot_state', {
      botId: runner.botConfig.id,
      ...runner.scheduler.getState()
    });
  }

  startBot(botId) {
    const runner = this.bots.get(botId);
    if (!runner) throw new Error(`Bot ${botId} not found`);

    const account = this.getAccountForBot(runner.botConfig);
    if (!account.username || !account.oauthToken) {
      throw new Error(`Bot "${runner.botConfig.name}" requires configured Twitch account credentials.`);
    }

    if (!runner.botConfig.channel) {
      throw new Error(`Bot "${runner.botConfig.name}" has no target channel configured.`);
    }

    const client = this.getOrCreateClient(account);
    if (client.status !== 'authenticated' && client.status !== 'connecting') {
      client.connect();
    }
    client.joinChannel(runner.botConfig.channel);

    runner.scheduler.start();
    this.emit('log', {
      type: 'info',
      text: `Started bot "${runner.botConfig.name}" for channel #${runner.botConfig.channel}`
    });

    return runner.scheduler.getState();
  }

  stopBot(botId) {
    const runner = this.bots.get(botId);
    if (!runner) throw new Error(`Bot ${botId} not found`);

    runner.scheduler.stop();
    this.emit('log', {
      type: 'info',
      text: `Stopped bot "${runner.botConfig.name}".`
    });

    return runner.scheduler.getState();
  }

  testBot(botId) {
    const runner = this.bots.get(botId);
    if (!runner) throw new Error(`Bot ${botId} not found`);

    const account = this.getAccountForBot(runner.botConfig);
    const client = this.getOrCreateClient(account);
    if (!client) throw new Error('No Twitch account configured');

    if (client.status !== 'authenticated') {
      client.connect();
    }
    client.joinChannel(runner.botConfig.channel);

    const msg = runner.scheduler.pickRandomMessage() || '!sorteo';
    const ok = client.sendMessage(runner.botConfig.channel, msg);
    return { ok, message: msg };
  }

  sendManualMessage(channel, text) {
    const cleanChan = (channel || '').replace(/^[#/]+/, '').toLowerCase();
    const cleanMsg = (text || '').trim();
    if (!cleanChan) throw new Error('Channel name is required');
    if (!cleanMsg) throw new Error('Message cannot be empty');

    // Find custom account if assigned to a bot for this channel, otherwise use defaultAccount
    let account = this.defaultAccount;
    for (const runner of this.bots.values()) {
      if (runner.botConfig.channel && runner.botConfig.channel.toLowerCase() === cleanChan) {
        account = this.getAccountForBot(runner.botConfig);
        break;
      }
    }

    const client = this.getOrCreateClient(account);
    if (!client) throw new Error('No Twitch account configured');

    if (client.status !== 'authenticated') {
      client.connect();
    }
    client.joinChannel(cleanChan);

    const sent = client.sendMessage(cleanChan, cleanMsg);
    if (sent === 'sub_only_blocked') {
      throw new Error(`Channel #${cleanChan} is in subscriber-only mode and @${client.username} is not subscribed.`);
    }
    if (!sent) {
      throw new Error(`Failed to send message: IRC client not ready (Status: ${client.status})`);
    }

    return { ok: true, channel: cleanChan, message: cleanMsg, username: client.username };
  }

  getAllStates() {
    const states = {};
    for (const [id, runner] of this.bots.entries()) {
      states[id] = runner.scheduler.getState();
    }
    return states;
  }

  getBotTrendStats(botId) {
    const runner = this.bots.get(botId);
    if (!runner || !runner.botConfig.channel) return null;
    return this.trendAnalyzer.getChannelStats(runner.botConfig.channel);
  }

  getAllTrendStats() {
    const stats = {};
    for (const [id, runner] of this.bots.entries()) {
      if (runner.botConfig.autoDetectTrends && runner.botConfig.channel) {
        stats[id] = this.trendAnalyzer.getChannelStats(runner.botConfig.channel);
      }
    }
    return stats;
  }

  getChannelRoomState(channel) {
    const cleanChan = (channel || '').replace(/^[#/]+/, '').toLowerCase();
    for (const client of this.clients.values()) {
      return client.getChannelState(cleanChan);
    }
    return { subOnly: false, isSubscribed: false, blocked: false };
  }

  getAllRoomStates() {
    const map = {};
    for (const [id, runner] of this.bots.entries()) {
      if (runner.botConfig.channel) {
        map[runner.botConfig.channel.toLowerCase()] = this.getChannelRoomState(runner.botConfig.channel);
      }
    }
    return map;
  }
}
