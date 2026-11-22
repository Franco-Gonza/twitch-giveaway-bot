import { EventEmitter } from 'node:events';

/**
 * Twitch IRC client implemented using Node 24 native WebSocket.
 * Connects to wss://irc-ws.chat.twitch.tv:443.
 * Zero external dependencies.
 */
export class TwitchIrcClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.serverUrl = options.serverUrl || 'wss://irc-ws.chat.twitch.tv:443';
    this.username = (options.username || '').toLowerCase();
    this.oauthToken = options.oauthToken || '';
    this.channel = (options.channel || '').replace(/^#/, '').toLowerCase();
    
    this.ws = null;
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'authenticated' | 'joined'
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectTimer = null;
    this.manualDisconnect = false;

    // Subscriber-only state tracking
    this.subOnly = false;
    this.isSubscribed = false;
  }

  isSubOnlyBlocked() {
    return Boolean(this.subOnly && !this.isSubscribed);
  }

  updateCredentials({ username, oauthToken, channel }) {
    if (username) this.username = username.toLowerCase();
    if (oauthToken) this.oauthToken = oauthToken;
    if (channel) this.channel = channel.replace(/^#/, '').toLowerCase();
  }

  connect() {
    if (this.status === 'connecting' || this.status === 'connected' || this.status === 'joined') {
      return;
    }

    if (!this.username || !this.oauthToken) {
      const err = new Error('Username and OAuth token are required to connect');
      this.emit('error', err);
      return;
    }

    this.manualDisconnect = false;
    this._setStatus('connecting');
    this.emit('log', { type: 'info', text: `Connecting to Twitch IRC (${this.serverUrl})...` });

    try {
      this.ws = new WebSocket(this.serverUrl);
    } catch (err) {
      this._setStatus('disconnected');
      this.emit('error', err);
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
      this._setStatus('disconnected');
      this.ws = null;

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
      this.emit('log', { type: 'error', text: `WebSocket error occurred: ${event.message || 'Unknown error'}` });
      this.emit('error', event);
    });
  }

  disconnect() {
    this.manualDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      if (this.status === 'joined' && this.channel) {
        this._send(`PART #${this.channel}`);
      }
      try {
        this.ws.close();
      } catch {
        // Ignore close errors during disconnect
      }
      this.ws = null;
    }
    this._setStatus('disconnected');
    this.emit('log', { type: 'info', text: 'Disconnected from Twitch IRC.' });
  }

  sendMessage(message) {
    if (!message || typeof message !== 'string') return false;
    const cleanMsg = message.trim();
    if (!cleanMsg) return false;

    if (this.status !== 'joined' && this.status !== 'authenticated') {
      this.emit('log', { 
        type: 'error', 
        text: `Cannot send message: not joined to channel #${this.channel} (Status: ${this.status})` 
      });
      return false;
    }

    if (!this.channel) {
      this.emit('log', { type: 'error', text: 'Cannot send message: no target channel configured' });
      return false;
    }

    if (this.isSubOnlyBlocked()) {
      this.emit('log', {
        type: 'warning',
        text: `[#${this.channel}] Postponed: Subscriber-only mode is active and @${this.username} is not a subscriber. Waiting for mode to end...`
      });
      return 'sub_only_blocked';
    }

    const command = `PRIVMSG #${this.channel} :${cleanMsg}`;
    this._send(command);
    this.emit('message_sent', {
      channel: this.channel,
      message: cleanMsg,
      timestamp: new Date().toISOString()
    });
    this.emit('log', {
      type: 'success',
      text: `[#${this.channel}] Sent: "${cleanMsg}"`
    });
    return true;
  }

  joinChannel(channel) {
    const clean = (channel || '').replace(/^#/, '').toLowerCase();
    if (!clean) return;

    if (this.channel && this.channel !== clean && this.status === 'joined') {
      this._send(`PART #${this.channel}`);
    }

    this.channel = clean;
    if (this.status === 'authenticated' || this.status === 'joined') {
      this._send(`JOIN #${this.channel}`);
      this._setStatus('joined');
      this.emit('log', { type: 'info', text: `Joining channel #${this.channel}...` });
    }
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

    // 2. Authentication success (001 numeric RPL_WELCOME)
    if (line.includes(' 001 ') && line.includes('GLHF')) {
      this._setStatus('authenticated');
      this.emit('log', { type: 'success', text: `Authenticated successfully as @${this.username}` });
      if (this.channel) {
        this._send(`JOIN #${this.channel}`);
        this._setStatus('joined');
        this.emit('log', { type: 'info', text: `Joined channel #${this.channel}` });
      }
      return;
    }

    // 3. Authentication failure
    if (line.includes('NOTICE') && (line.includes('Login authentication failed') || line.includes('Login unsuccessful'))) {
      this.emit('log', { 
        type: 'error', 
        text: 'Twitch authentication failed! Please check your username and OAuth token.' 
      });
      this.emit('auth_failed');
      this.disconnect();
      return;
    }

    // 4. Genuine system NOTICE messages (e.g. slowmode, bans, sub-only), ignoring USERNOTICE (subs/raids)
    if (!line.includes('USERNOTICE') && /(?:^|\s)NOTICE\s+/.test(line)) {
      if (line.includes('msg_subsonly') || line.includes('not a subscriber')) {
        this.subOnly = true;
        this.isSubscribed = false;
        this.emit('log', {
          type: 'warning',
          text: `[#${this.channel}] Twitch confirmed subscriber-only mode restriction. Auto-commenting paused until mode ends.`
        });
      }
      const match = line.match(/(?:^|\s)NOTICE\s+#?\w*\s*:(.*)$/);
      if (match) {
        this.emit('log', { type: 'warning', text: `Twitch Notice: ${match[1]}` });
        this.emit('notice', match[1]);
      }
      return;
    }

    // 5. ROOMSTATE (channel settings like subs-only, slow mode)
    if (line.includes(' ROOMSTATE ')) {
      const subMatch = line.match(/[;@]subs-only=([01])/);
      if (subMatch) {
        const newSubOnly = subMatch[1] === '1';
        if (this.subOnly !== newSubOnly) {
          this.subOnly = newSubOnly;
          if (this.subOnly) {
            this.emit('log', {
              type: 'warning',
              text: `[#${this.channel}] Subscriber-only mode activated.` +
                    (this.isSubscribed ? ' (You are subscribed, will keep commenting)' : ' (Not subscribed: auto-commenting paused)')
            });
          } else {
            this.emit('log', {
              type: 'info',
              text: `[#${this.channel}] Subscriber-only mode ended. Normal commenting will resume.`
            });
          }
        }
      }
      return;
    }

    // 6. USERSTATE / GLOBALUSERSTATE (user badges in channel, e.g. subscriber, moderator)
    if (line.includes(' USERSTATE ') || line.includes(' GLOBALUSERSTATE ')) {
      const badgeMatch = line.match(/[;@]badges=([^;]*)/);
      if (badgeMatch) {
        const badges = badgeMatch[1] || '';
        const isSub = /(?:subscriber|founder|moderator|broadcaster)\//.test(badges);
        this.isSubscribed = isSub;
      }
      return;
    }

    // 7. Successful join verification
    if (line.includes(`JOIN #${this.channel}`)) {
      this._setStatus('joined');
      this.emit('joined', this.channel);
      return;
    }
  }

  _scheduleReconnect() {
    if (this.manualDisconnect) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('log', { 
        type: 'error', 
        text: `Failed to reconnect after ${this.maxReconnectAttempts} attempts. Stopped.` 
      });
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 16000);
    this.emit('log', { 
      type: 'warning', 
      text: `Reconnecting in ${delay / 1000}s (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...` 
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}
