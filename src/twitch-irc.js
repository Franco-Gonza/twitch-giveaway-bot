import { EventEmitter } from 'node:events';

/**
 * Twitch IRC client implemented using Node 24 native WebSocket.
 * Connects to wss://irc-ws.chat.twitch.tv:443.
 * Supports multiple channel joins per connection.
 * Zero external dependencies.
 */
export class TwitchIrcClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.serverUrl = options.serverUrl || 'wss://irc-ws.chat.twitch.tv:443';
    this.username = (options.username || '').toLowerCase();
    this.oauthToken = options.oauthToken || '';
    
    // Multi-channel tracking
    this.channels = new Set();
    if (options.channel) {
      this.channels.add(options.channel.replace(/^#/, '').toLowerCase());
    }
    this.channelStates = new Map(); // channel -> { subOnly: boolean, isSubscribed: boolean, joined: boolean }

    this.ws = null;
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'authenticated'
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.manualDisconnect = false;
  }

  // Backward compatibility property for single-channel access
  get channel() {
    return Array.from(this.channels)[0] || '';
  }

  set channel(ch) {
    if (ch) this.joinChannel(ch);
  }

  get subOnly() {
    const state = this.channelStates.get(this.channel);
    return state ? state.subOnly : false;
  }

  set subOnly(val) {
    const state = this._getOrCreateChannelState(this.channel);
    state.subOnly = Boolean(val);
  }

  get isSubscribed() {
    const state = this.channelStates.get(this.channel);
    return state ? state.isSubscribed : false;
  }

  set isSubscribed(val) {
    const state = this._getOrCreateChannelState(this.channel);
    state.isSubscribed = Boolean(val);
  }

  _getOrCreateChannelState(channel) {
    const clean = (channel || '').replace(/^#/, '').toLowerCase();
    if (!this.channelStates.has(clean)) {
      this.channelStates.set(clean, {
        subOnly: false,
        isSubscribed: false,
        joined: false
      });
    }
    return this.channelStates.get(clean);
  }

  isSubOnlyBlocked(channel = this.channel) {
    const state = this._getOrCreateChannelState(channel);
    return Boolean(state.subOnly && !state.isSubscribed);
  }

  getChannelState(channel = this.channel) {
    const state = this._getOrCreateChannelState(channel);
    return {
      subOnly: Boolean(state.subOnly),
      isSubscribed: Boolean(state.isSubscribed),
      blocked: Boolean(state.subOnly && !state.isSubscribed)
    };
  }

  updateCredentials({ username, oauthToken }) {
    if (username) this.username = username.toLowerCase();
    if (oauthToken) this.oauthToken = oauthToken;
  }

  connect() {
    if (this.status === 'connecting' || this.status === 'connected' || this.status === 'authenticated') {
      return;
    }

    if (!this.username || !this.oauthToken) {
      const err = new Error('Username and OAuth token are required to connect');
      this.emit('error', err);
      return;
    }

    this.manualDisconnect = false;
    this._setStatus('connecting');
    this.emit('log', { type: 'info', text: `Connecting to Twitch IRC (${this.username})...` });

    try {
      this.ws = new WebSocket(this.serverUrl);
    } catch (err) {
      this._setStatus('disconnected');
      this.emit('log', { type: 'error', text: `Failed to open WebSocket: ${err.message}` });
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
      this._scheduleReconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      this._setStatus('connected');
      this.reconnectAttempts = 0;
      this.emit('log', { type: 'info', text: 'Connected to Twitch IRC. Authenticating...' });

      // Request capabilities and authenticate
      this._send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      const pass = this.oauthToken.startsWith('oauth:') ? this.oauthToken : `oauth:${this.oauthToken}`;
      this._send(`PASS ${pass}`);
      this._send(`NICK ${this.username}`);
    });

    this.ws.addEventListener('message', (event) => {
      this._handleRawMessage(event.data);
    });

    this.ws.addEventListener('close', (event) => {
      const wasConnected = this.status !== 'disconnected';
      this._stopPingInterval();
      this._setStatus('disconnected');
      this.ws = null;

      // Mark all channels as not joined
      for (const state of this.channelStates.values()) {
        state.joined = false;
      }

      if (wasConnected) {
        this.emit('log', { 
          type: 'warning', 
          text: `IRC connection closed (Code: ${event.code}, Reason: ${event.reason || 'None'})` 
        });
      }

      if (!this.manualDisconnect) {
        this._scheduleReconnect();
      }
    });

    this.ws.addEventListener('error', (event) => {
      const errMsg = event.message || (event.error && event.error.message) || 'Socket closed or network reset';
      this.emit('log', { type: 'warning', text: `WebSocket notice: ${errMsg}` });
      if (this.listenerCount('error') > 0) {
        this.emit('error', event);
      }
    });
  }

  _stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  _startPingInterval() {
    this._stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.status === 'authenticated') {
        this._send('PING :tmi.twitch.tv');
      }
    }, 45000);
    if (this.pingInterval.unref) this.pingInterval.unref();
  }

  disconnect() {
    this.manualDisconnect = true;
    this._stopPingInterval();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      for (const ch of this.channels) {
        this._send(`PART #${ch}`);
      }
      try {
        this.ws.close();
      } catch {
        // Ignore close errors during disconnect
      }
      this.ws = null;
    }
    this._setStatus('disconnected');
    this.emit('log', { type: 'info', text: `Disconnected from Twitch IRC (@${this.username}).` });
  }

  joinChannel(channel) {
    const clean = (channel || '').replace(/^#/, '').toLowerCase();
    if (!clean) return;

    this.channels.add(clean);
    const state = this._getOrCreateChannelState(clean);

    if (this.status === 'authenticated' && !state.joined) {
      this._send(`JOIN #${clean}`);
      this.emit('log', { type: 'info', text: `Joining channel #${clean}...` });
    }
  }

  leaveChannel(channel) {
    const clean = (channel || '').replace(/^#/, '').toLowerCase();
    if (!clean) return;

    this.channels.delete(clean);
    const state = this.channelStates.get(clean);
    if (state) state.joined = false;

    if (this.status === 'authenticated') {
      this._send(`PART #${clean}`);
      this.emit('log', { type: 'info', text: `Left channel #${clean}` });
    }
  }

  sendMessage(channelOrMsg, maybeMsg) {
    let targetChannel = '';
    let cleanMsg = '';

    if (maybeMsg !== undefined) {
      targetChannel = (channelOrMsg || '').replace(/^#/, '').toLowerCase();
      cleanMsg = (maybeMsg || '').trim();
    } else {
      targetChannel = this.channel;
      cleanMsg = (channelOrMsg || '').trim();
    }

    if (!cleanMsg) return false;

    if (!targetChannel) {
      this.emit('log', { type: 'error', text: 'Cannot send message: no target channel specified' });
      return false;
    }

    if (this.status !== 'authenticated') {
      this.emit('log', { 
        type: 'error', 
        text: `Cannot send message: IRC not authenticated for @${this.username} (Status: ${this.status})` 
      });
      return false;
    }

    // Ensure we are joined
    if (!this.channels.has(targetChannel)) {
      this.joinChannel(targetChannel);
    }

    if (this.isSubOnlyBlocked(targetChannel)) {
      this.emit('log', {
        type: 'warning',
        text: `[#${targetChannel}] Postponed: Subscriber-only mode is active and @${this.username} is not subscribed. Waiting for mode to end...`
      });
      return 'sub_only_blocked';
    }

    const command = `PRIVMSG #${targetChannel} :${cleanMsg}`;
    this._send(command);
    this.emit('message_sent', {
      channel: targetChannel,
      message: cleanMsg,
      timestamp: new Date().toISOString()
    });
    this.emit('log', {
      type: 'success',
      text: `[#${targetChannel}] Sent: "${cleanMsg}"`
    });
    return true;
  }

  _setStatus(newStatus) {
    this.status = newStatus;
    this.emit('status_change', this.status);
  }

  _send(line) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(`${line}\r\n`);
    }
  }

  _handleRawMessage(data) {
    const text = typeof data === 'string' ? data : data.toString('utf-8');
    const lines = text.split('\r\n').filter(Boolean);

    for (const line of lines) {
      this._parseLine(line);
    }
  }

  _parseLine(line) {
    // 1. PING keep-alive response
    if (line.startsWith('PING')) {
      const pingPayload = line.slice(4).trim();
      this._send(`PONG ${pingPayload}`);
      return;
    }

    if (line.startsWith('PONG')) {
      return;
    }

    // 2. Authentication success (001 numeric RPL_WELCOME)
    if (line.includes(' 001 ') && line.includes('GLHF')) {
      this._setStatus('authenticated');
      this._startPingInterval();
      this.emit('log', { type: 'success', text: `Authenticated successfully as @${this.username}` });
      
      // Join all registered channels
      for (const ch of this.channels) {
        this._send(`JOIN #${ch}`);
        this.emit('log', { type: 'info', text: `Joined channel #${ch}` });
      }
      return;
    }

    // 3. Authentication failure
    if (line.includes('NOTICE') && (line.includes('Login authentication failed') || line.includes('Login unsuccessful'))) {
      this.emit('log', { 
        type: 'error', 
        text: `Twitch authentication failed for @${this.username}! Check token.` 
      });
      this.emit('auth_failed');
      this.disconnect();
      return;
    }

    // Extract target channel if present in IRC line
    const chanMatch = line.match(/(?:JOIN|PART|ROOMSTATE|USERSTATE|USERNOTICE|NOTICE)\s+#(\w+)/);
    const lineChannel = chanMatch ? chanMatch[1].toLowerCase() : this.channel;
    const channelState = this._getOrCreateChannelState(lineChannel);

    // 4a. Moderator Announcements (/announce or pinned messages broadcasted as USERNOTICE)
    if (line.includes('USERNOTICE') && line.includes('msg-id=announcement')) {
      const match = line.match(/(?:^|\s)USERNOTICE\s+#\w*\s*:(.*)$/);
      if (match) {
        const announcementText = match[1];
        this.emit('announcement', {
          channel: lineChannel,
          message: announcementText,
          timestamp: Date.now()
        });
        this.emit('log', {
          type: 'info',
          text: `[#${lineChannel}] 📌 Moderator Announcement: "${announcementText}"`
        });
      }
      return;
    }

    // 4b. Genuine system NOTICE messages (e.g. slowmode, bans, sub-only), ignoring other USERNOTICE (subs/raids)
    if (!line.includes('USERNOTICE') && /(?:^|\s)NOTICE\s+/.test(line)) {
      if (line.includes('msg_subsonly') || line.includes('not a subscriber')) {
        channelState.subOnly = true;
        channelState.isSubscribed = false;
        this.emit('room_state', { channel: lineChannel, ...this.getChannelState(lineChannel) });
        this.emit('log', {
          type: 'warning',
          text: `[#${lineChannel}] Twitch confirmed subscriber-only mode restriction. Auto-commenting paused.`
        });
      }
      const match = line.match(/(?:^|\s)NOTICE\s+#?\w*\s*:(.*)$/);
      if (match) {
        this.emit('log', { type: 'warning', text: `Twitch Notice [#${lineChannel}]: ${match[1]}` });
        this.emit('notice', { channel: lineChannel, message: match[1] });
      }
      return;
    }

    // 5. ROOMSTATE (channel settings like subs-only, slow mode)
    if (line.includes(' ROOMSTATE ')) {
      const subMatch = line.match(/[;@]subs-only=([01])/);
      if (subMatch) {
        const newSubOnly = subMatch[1] === '1';
        if (channelState.subOnly !== newSubOnly) {
          channelState.subOnly = newSubOnly;
          this.emit('room_state', { channel: lineChannel, ...this.getChannelState(lineChannel) });
          if (channelState.subOnly) {
            this.emit('log', {
              type: 'warning',
              text: `[#${lineChannel}] Subscriber-only mode activated.` +
                    (channelState.isSubscribed ? ' (You are subscribed, will keep commenting)' : ' (Not subscribed: auto-commenting paused)')
            });
          } else {
            this.emit('log', {
              type: 'info',
              text: `[#${lineChannel}] Subscriber-only mode ended. Normal commenting will resume.`
            });
          }
        }
      }
      return;
    }

    // 6. USERSTATE (user badges in channel, e.g. subscriber, moderator)
    if (line.includes(' USERSTATE ')) {
      const badgeMatch = line.match(/[;@]badges=([^;]*)/);
      if (badgeMatch) {
        const badges = badgeMatch[1] || '';
        const isSub = /(?:subscriber|founder|moderator|broadcaster)\//.test(badges);
        channelState.isSubscribed = isSub;
        this.emit('room_state', { channel: lineChannel, ...this.getChannelState(lineChannel) });
      }
      return;
    }

    // 7. Incoming chat messages (PRIVMSG #channel :message)
    if (line.includes(' PRIVMSG ')) {
      const match = line.match(/:(\w+)![\w@.]+\s+PRIVMSG\s+#(\w+)\s*:(.*)$/);
      if (match) {
        const chatter = match[1].toLowerCase();
        const chan = match[2].toLowerCase();
        const msgText = match[3];

        if (chatter !== this.username) {
          const isBroadcaster = /[;@]badges=[^;\s]*broadcaster\//.test(line) || chatter === chan;
          const isMod = isBroadcaster || /[;@]mod=1(?=[;\s]|$)/.test(line) || /[;@]badges=[^;\s]*moderator\//.test(line);

          const colorMatch = line.match(/[;@]color=([^;\s]+)/);
          const color = colorMatch && colorMatch[1] ? colorMatch[1] : null;

          const displayNameMatch = line.match(/[;@]display-name=([^;\s]+)/);
          const displayName = displayNameMatch && displayNameMatch[1] ? displayNameMatch[1] : chatter;

          this.emit('chat_message', {
            channel: chan,
            username: chatter,
            displayName,
            message: msgText,
            isMod,
            isBroadcaster,
            color
          });
        }
      }
      return;
    }

    // 8. Successful join verification
    if (line.includes(`JOIN #${lineChannel}`)) {
      channelState.joined = true;
      this.emit('joined', lineChannel);
      return;
    }
  }

  _scheduleReconnect() {
    if (this.manualDisconnect) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('log', { 
        type: 'error', 
        text: `Failed to reconnect @${this.username} after ${this.maxReconnectAttempts} attempts.` 
      });
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 16000);
    this.emit('log', { 
      type: 'warning', 
      text: `Reconnecting @${this.username} in ${delay / 1000}s (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...` 
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}
