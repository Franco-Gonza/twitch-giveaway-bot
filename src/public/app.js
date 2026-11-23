// Twitch Multi-Bot Hub Client Controller

let appConfig = { defaultAccount: {}, bots: [] };
let botStates = {};
let dialogMessages = [];
let eventSource = null;

// DOM Elements
const headerAccountName = document.getElementById('header-account-name');
const openAccountBtn = document.getElementById('open-account-btn');
const addBotBtn = document.getElementById('add-bot-btn');
const botCountIndicator = document.getElementById('bot-count-indicator');
const botsGrid = document.getElementById('bots-grid');
const logsContainer = document.getElementById('logs-container');
const clearLogsBtn = document.getElementById('clear-logs-btn');

// Live Chat Elements
const chatChannelSelect = document.getElementById('chat-channel-select');
const chatMessagesContainer = document.getElementById('chat-messages-container');
const chatSendForm = document.getElementById('chat-send-form');
const chatSendInput = document.getElementById('chat-send-input');
const chatSendBtn = document.getElementById('chat-send-btn');
const toggleAutoscrollBtn = document.getElementById('toggle-autoscroll-btn');
const clearChatBtn = document.getElementById('clear-chat-btn');
const chatModeBadge = document.getElementById('chat-mode-badge');
const chatPinnedBanner = document.getElementById('chat-pinned-banner');
const pinnedMessageText = document.getElementById('pinned-message-text');
const dismissPinnedBtn = document.getElementById('dismiss-pinned-btn');
const chatSubWarning = document.getElementById('chat-sub-warning');

let selectedChatChannel = '';
let chatAutoScroll = true;
const chatBuffers = {}; // channel -> Array of { username, message, isSelf, timestamp }
let channelRoomStates = {}; // channel -> { subOnly, isSubscribed, blocked }
let channelAnnouncements = {}; // channel -> { message, timestamp }
const MAX_CLIENT_CHAT_LINES = 150;

// Account Dialog Elements
const accountDialog = document.getElementById('account-dialog');
const closeAccountDialogBtn = document.getElementById('close-account-dialog-btn');
const cancelAccountDialogBtn = document.getElementById('cancel-account-dialog-btn');
const accountForm = document.getElementById('account-form');
const accUsernameInput = document.getElementById('acc-username');
const accOauthInput = document.getElementById('acc-oauth');

// Bot Dialog Elements
const botDialog = document.getElementById('bot-dialog');
const botDialogTitle = document.getElementById('bot-dialog-title');
const closeBotDialogBtn = document.getElementById('close-bot-dialog-btn');
const cancelBotDialogBtn = document.getElementById('cancel-bot-dialog-btn');
const botForm = document.getElementById('bot-form');
const editBotIdInput = document.getElementById('edit-bot-id');
const botNameInput = document.getElementById('bot-name');
const botChannelInput = document.getElementById('bot-channel');
const botMinIntervalInput = document.getElementById('bot-min-interval');
const botMaxIntervalInput = document.getElementById('bot-max-interval');
const botAvoidRepeatsInput = document.getElementById('bot-avoid-repeats');
const botAutoTrendsInput = document.getElementById('bot-auto-trends');
const botNewMessageInput = document.getElementById('bot-new-message-input');
const dialogAddMsgBtn = document.getElementById('dialog-add-msg-btn');
const dialogMessagesList = document.getElementById('dialog-messages-list');

// Initialize SSE Stream
function initEventSource() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource('/api/stream');

  eventSource.addEventListener('init', (e) => {
    const data = JSON.parse(e.data);
    appConfig = data.config || { defaultAccount: {}, bots: [] };
    botStates = data.botStates || {};
    updateHeaderAccount();
    renderBotsGrid();
    if (data.recentChat) {
      for (const [chan, msgs] of Object.entries(data.recentChat)) {
        chatBuffers[chan] = msgs.slice(-MAX_CLIENT_CHAT_LINES);
      }
    }
    if (data.roomStates) {
      channelRoomStates = data.roomStates;
    }
    if (data.announcements) {
      channelAnnouncements = data.announcements;
    }
    updateChatChannelOptions();
    if (selectedChatChannel) {
      loadChannelState(selectedChatChannel);
    }
    if (data.trendStats) {
      for (const [botId, stats] of Object.entries(data.trendStats)) {
        updateBotCardTrend(botId, stats);
      }
    }
    if (data.logs) {
      logsContainer.innerHTML = '';
      data.logs.forEach(appendLog);
    }
  });

  eventSource.addEventListener('config', (e) => {
    appConfig = JSON.parse(e.data);
    updateHeaderAccount();
    renderBotsGrid();
    updateChatChannelOptions();
  });

  eventSource.addEventListener('bot_state', (e) => {
    const data = JSON.parse(e.data);
    botStates[data.botId] = {
      ...(botStates[data.botId] || {}),
      ...data
    };
    updateBotCardState(data.botId);
  });

  eventSource.addEventListener('bot_countdown', (e) => {
    const { botId, remainingSeconds, totalSeconds } = JSON.parse(e.data);
    if (!botStates[botId]) botStates[botId] = {};
    botStates[botId].remainingSeconds = remainingSeconds;
    botStates[botId].totalSeconds = totalSeconds;
    updateBotCardCountdown(botId, remainingSeconds, totalSeconds);
  });

  eventSource.addEventListener('bot_trend', (e) => {
    const { botId, stats } = JSON.parse(e.data);
    updateBotCardTrend(botId, stats);
  });

  eventSource.addEventListener('chat_message', (e) => {
    const msg = JSON.parse(e.data);
    appendChatMessage(msg);
  });

  eventSource.addEventListener('room_state', (e) => {
    const data = JSON.parse(e.data);
    const chan = (data.channel || '').toLowerCase();
    channelRoomStates[chan] = data;
    if (chan === selectedChatChannel) {
      updateChannelRoomStateUI();
    }
  });

  eventSource.addEventListener('announcement', (e) => {
    const data = JSON.parse(e.data);
    const chan = (data.channel || '').toLowerCase();
    channelAnnouncements[chan] = data;
    if (chan === selectedChatChannel) {
      updateChannelPinnedAnnouncementUI();
    }
  });

  eventSource.addEventListener('pinned_message', (e) => {
    const data = JSON.parse(e.data);
    const chan = (data.channel || '').toLowerCase();
    if (!data.text) {
      delete channelAnnouncements[chan];
    } else {
      channelAnnouncements[chan] = data;
    }
    if (chan === selectedChatChannel) {
      updateChannelPinnedAnnouncementUI();
    }
  });

  eventSource.addEventListener('log', (e) => {
    appendLog(JSON.parse(e.data));
  });
}

function updateHeaderAccount() {
  const acc = appConfig.defaultAccount || {};
  if (acc.username) {
    headerAccountName.textContent = `@${acc.username}`;
  } else {
    headerAccountName.textContent = '@not-configured';
  }
}

function renderBotsGrid() {
  botsGrid.innerHTML = '';
  const bots = appConfig.bots || [];
  botCountIndicator.textContent = bots.length;

  if (bots.length === 0) {
    const emptyNotice = document.createElement('div');
    emptyNotice.className = 'card';
    emptyNotice.style.gridColumn = '1 / -1';
    emptyNotice.style.textAlign = 'center';
    emptyNotice.style.padding = '3rem 1.5rem';
    emptyNotice.innerHTML = `
      <h3 style="margin-bottom:0.5rem;">No channel bots created yet</h3>
      <p style="color:var(--text-secondary); margin-bottom:1.5rem;">Create a bot instance for any Twitch channel giveaway.</p>
      <button class="btn btn-primary" onclick="document.getElementById('add-bot-btn').click()">+ Add First Channel Bot</button>
    `;
    botsGrid.appendChild(emptyNotice);
    return;
  }

  bots.forEach(bot => {
    const card = document.createElement('div');
    card.className = 'bot-card';
    card.id = `card-${bot.id}`;

    const state = botStates[bot.id] || { running: false, sentCount: 0 };

    card.innerHTML = `
      <div class="bot-card-header">
        <div class="bot-title-group">
          <h3>${escapeHtml(bot.name)}</h3>
          <div class="channel-links-row">
            <a href="https://twitch.tv/${escapeHtml(bot.channel)}" target="_blank" rel="noopener noreferrer" class="bot-channel-tag" title="Open ${bot.channel} on Twitch">
              #${escapeHtml(bot.channel || 'unassigned')} ↗
            </a>
            <a href="https://twitch.tv/popout/${escapeHtml(bot.channel)}/chat?popout=" target="_blank" rel="noopener noreferrer" class="chat-popout-link" title="Open Popout Chat">
              💬 Popout Chat
            </a>
          </div>
        </div>
        <div class="bot-header-controls">
          <span class="pill ${state.running ? 'pill-running' : 'pill-idle'}" id="status-pill-${bot.id}">
            ${state.running ? 'Running' : 'Stopped'}
          </span>
          <button class="btn btn-subtle icon-btn" title="Edit Bot" onclick="window.editBot('${bot.id}')">✏️</button>
          <button class="btn btn-subtle icon-btn" title="Delete Bot" onclick="window.deleteBot('${bot.id}')">🗑️</button>
        </div>
      </div>

      <div class="bot-timer-box">
        <div class="timer-countdown-row">
          <span class="timer-num" id="timer-num-${bot.id}">--</span>
          <span class="timer-sec">seconds</span>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="progress-bar-${bot.id}" style="width: 0%;"></div>
        </div>
      </div>

      <div class="bot-details-row">
        <span>Sent: <strong id="sent-count-${bot.id}">${state.sentCount || 0}</strong></span>
        <span>${bot.minIntervalSeconds}s - ${bot.maxIntervalSeconds}s</span>
        <span>${bot.autoDetectTrends ? '🔥 Crowd Mimic' : `${bot.messages.length} msgs`}</span>
      </div>

      ${bot.autoDetectTrends ? `
        <div class="crowd-radar-box" id="crowd-radar-${bot.id}">
          <div class="crowd-radar-header">
            <span class="crowd-radar-title">🔥 Crowd Mimic Radar</span>
            <span class="crowd-radar-volume" id="crowd-volume-${bot.id}">0 msgs/25s</span>
          </div>
          <div class="crowd-radar-body" id="crowd-body-${bot.id}">
            <span class="crowd-radar-status">Listening to chat...</span>
          </div>
          <div class="crowd-radar-chips" id="crowd-chips-${bot.id}"></div>
        </div>
      ` : ''}

      <div class="bot-card-actions">
        <button class="btn btn-primary" id="start-btn-${bot.id}" onclick="window.startBot('${bot.id}')" ${state.running ? 'disabled' : ''}>
          ▶ Start
        </button>
        <button class="btn btn-danger" id="stop-btn-${bot.id}" onclick="window.stopBot('${bot.id}')" ${!state.running ? 'disabled' : ''}>
          ⏹ Stop
        </button>
        <button class="btn btn-secondary" id="test-btn-${bot.id}" onclick="window.testBot('${bot.id}')">
          🚀 Send Now
        </button>
      </div>
    `;

    botsGrid.appendChild(card);
  });
}

function updateBotCardState(botId) {
  const state = botStates[botId];
  if (!state) return;

  const pill = document.getElementById(`status-pill-${botId}`);
  const startBtn = document.getElementById(`start-btn-${botId}`);
  const stopBtn = document.getElementById(`stop-btn-${botId}`);
  const sentCount = document.getElementById(`sent-count-${botId}`);

  if (pill) {
    pill.className = `pill ${state.running ? 'pill-running' : 'pill-idle'}`;
    pill.textContent = state.running ? 'Running' : 'Stopped';
  }
  if (startBtn) startBtn.disabled = Boolean(state.running);
  if (stopBtn) stopBtn.disabled = !Boolean(state.running);
  if (sentCount && typeof state.sentCount === 'number') {
    sentCount.textContent = state.sentCount;
  }
  if (!state.running) {
    const timerNum = document.getElementById(`timer-num-${botId}`);
    const progressBar = document.getElementById(`progress-bar-${botId}`);
    if (timerNum) timerNum.textContent = '--';
    if (progressBar) progressBar.style.width = '0%';
  }
}

function updateBotCardCountdown(botId, remaining, total) {
  const timerNum = document.getElementById(`timer-num-${botId}`);
  const progressBar = document.getElementById(`progress-bar-${botId}`);

  if (remaining > 0) {
    if (timerNum) timerNum.textContent = remaining;
    if (progressBar && total > 0) {
      const pct = Math.max(0, Math.min(100, ((total - remaining) / total) * 100));
      progressBar.style.width = `${pct}%`;
    }
  } else {
    if (timerNum) timerNum.textContent = '--';
    if (progressBar) progressBar.style.width = '0%';
  }
}

function updateBotCardTrend(botId, stats) {
  if (!stats) return;
  const volEl = document.getElementById(`crowd-volume-${botId}`);
  const bodyEl = document.getElementById(`crowd-body-${botId}`);
  const chipsEl = document.getElementById(`crowd-chips-${botId}`);

  if (volEl) {
    volEl.textContent = `${stats.totalInWindow || 0} msgs/${stats.windowSeconds || 25}s`;
  }

  if (bodyEl) {
    if (stats.topTrend) {
      const isReady = stats.topTrend.meetsThreshold;
      const tagClass = isReady ? 'radar-tag ready' : 'radar-tag leading';
      const label = isReady ? '⚡ Trigger Ready' : 'Top';
      bodyEl.innerHTML = `
        <span class="${tagClass}" title="${escapeHtml(stats.topTrend.text)}">
          ${label}: "${escapeHtml(stats.topTrend.text)}" (${stats.topTrend.percentage}% · ${stats.topTrend.count}x)
        </span>
      `;
    } else if (stats.totalInWindow > 0) {
      bodyEl.innerHTML = `<span class="crowd-radar-status">Chat varied (no dominant trend yet)</span>`;
    } else {
      bodyEl.innerHTML = `<span class="crowd-radar-status">Listening to chat...</span>`;
    }
  }

  if (chipsEl) {
    if (stats.topPhrases && stats.topPhrases.length > 0) {
      chipsEl.innerHTML = stats.topPhrases.map(p => `
        <span class="crowd-chip" title="${escapeHtml(p.text)}">
          ${escapeHtml(p.text)} <small>${p.percentage}%</small>
        </span>
      `).join('');
    } else {
      chipsEl.innerHTML = '';
    }
  }
}

function appendLog(entry) {
  const line = document.createElement('div');
  line.className = `log-entry log-${entry.type || 'info'}`;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = entry.timestamp || new Date().toLocaleTimeString();

  const msg = document.createElement('span');
  msg.className = 'log-text';
  msg.textContent = entry.text;

  line.appendChild(time);
  line.appendChild(msg);
  logsContainer.appendChild(line);

  logsContainer.scrollTop = logsContainer.scrollHeight;
}

// Global Bot Action Handlers
window.startBot = async (botId) => {
  try {
    const res = await fetch(`/api/bots/${botId}/start`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) alert(data.error || 'Failed to start bot');
  } catch {
    alert('Error connecting to server');
  }
};

window.stopBot = async (botId) => {
  try {
    const res = await fetch(`/api/bots/${botId}/stop`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) alert(data.error || 'Failed to stop bot');
  } catch {
    alert('Error connecting to server');
  }
};

window.testBot = async (botId) => {
  const btn = document.getElementById(`test-btn-${botId}`);
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/bots/${botId}/test`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) alert(data.error || 'Failed to send test message');
  } catch {
    alert('Error connecting to server');
  } finally {
    setTimeout(() => { if (btn) btn.disabled = false; }, 2000);
  }
};

window.deleteBot = async (botId) => {
  const bot = appConfig.bots.find(b => b.id === botId);
  const name = bot ? bot.name : botId;
  if (!confirm(`Are you sure you want to delete bot "${name}"?`)) return;

  try {
    const res = await fetch(`/api/bots/${botId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || 'Failed to delete bot');
    }
  } catch {
    alert('Error connecting to server');
  }
};

window.editBot = (botId) => {
  const bot = appConfig.bots.find(b => b.id === botId);
  if (!bot) return;

  botDialogTitle.textContent = `Edit Bot: ${bot.name}`;
  editBotIdInput.value = bot.id;
  botNameInput.value = bot.name;
  botChannelInput.value = bot.channel;
  botMinIntervalInput.value = bot.minIntervalSeconds;
  botMaxIntervalInput.value = bot.maxIntervalSeconds;
  botAvoidRepeatsInput.checked = bot.avoidConsecutiveRepeats;
  botAutoTrendsInput.checked = bot.autoDetectTrends ?? true;

  dialogMessages = [...(bot.messages || [])];
  renderDialogMessages();

  botDialog.showModal();
};

// Add New Bot trigger
addBotBtn.addEventListener('click', () => {
  botDialogTitle.textContent = 'Add New Channel Bot';
  editBotIdInput.value = '';
  botNameInput.value = `Bot #${(appConfig.bots.length || 0) + 1}`;
  botChannelInput.value = '';
  botMinIntervalInput.value = 30;
  botMaxIntervalInput.value = 60;
  botAvoidRepeatsInput.checked = true;
  botAutoTrendsInput.checked = true;

  dialogMessages = ['!sorteo', '!ticket', 'Participando!', 'Buena suerte!'];
  renderDialogMessages();

  botDialog.showModal();
});

// Message chips in Dialog
function renderDialogMessages() {
  dialogMessagesList.innerHTML = '';
  dialogMessages.forEach((msg, idx) => {
    const tag = document.createElement('div');
    tag.className = 'message-tag';
    tag.innerHTML = `
      <span>${escapeHtml(msg)}</span>
      <button type="button" class="delete-tag-btn" onclick="window.removeDialogMsg(${idx})">×</button>
    `;
    dialogMessagesList.appendChild(tag);
  });
}

window.removeDialogMsg = (idx) => {
  if (dialogMessages.length <= 1) {
    alert('At least one message is required in the pool!');
    return;
  }
  dialogMessages.splice(idx, 1);
  renderDialogMessages();
};

dialogAddMsgBtn.addEventListener('click', () => {
  const val = botNewMessageInput.value.trim();
  if (val && !dialogMessages.includes(val)) {
    dialogMessages.push(val);
    renderDialogMessages();
    botNewMessageInput.value = '';
    botNewMessageInput.focus();
  }
});

botNewMessageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    dialogAddMsgBtn.click();
  }
});

// Save Bot Form
botForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const botId = editBotIdInput.value;
  const name = botNameInput.value.trim();
  const channel = botChannelInput.value.trim();
  const minInterval = parseInt(botMinIntervalInput.value, 10);
  const maxInterval = parseInt(botMaxIntervalInput.value, 10);
  const avoidRepeats = botAvoidRepeatsInput.checked;
  const autoTrends = botAutoTrendsInput.checked;

  if (dialogMessages.length === 0) {
    alert('Please add at least one message to the pool.');
    return;
  }

  const payload = {
    name,
    channel,
    minIntervalSeconds: minInterval,
    maxIntervalSeconds: maxInterval,
    avoidConsecutiveRepeats: avoidRepeats,
    autoDetectTrends: autoTrends,
    messages: dialogMessages
  };

  try {
    let res;
    if (botId) {
      // Update existing bot in config.bots array
      const updatedBots = appConfig.bots.map(b => {
        if (b.id === botId) {
          return { ...b, ...payload };
        }
        return b;
      });
      res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bots: updatedBots })
      });
    } else {
      // Create new bot
      res = await fetch('/api/bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    if (res.ok) {
      botDialog.close();
    } else {
      const data = await res.json();
      alert(data.error || 'Failed to save bot');
    }
  } catch {
    alert('Error communicating with server');
  }
});

// Account Settings Modal
openAccountBtn.addEventListener('click', () => {
  const acc = appConfig.defaultAccount || {};
  accUsernameInput.value = acc.username || '';
  accOauthInput.value = acc.oauthTokenMasked || '';
  accountDialog.showModal();
});

accountForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = accUsernameInput.value.trim();
  const oauthToken = accOauthInput.value.trim();

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultAccount: {
          username,
          oauthToken
        }
      })
    });
    if (res.ok) {
      accountDialog.close();
    } else {
      const data = await res.json();
      alert(data.error || 'Failed to save account');
    }
  } catch {
    alert('Error connecting to server');
  }
});

// Dialog Dismissers
closeAccountDialogBtn.addEventListener('click', () => accountDialog.close());
cancelAccountDialogBtn.addEventListener('click', () => accountDialog.close());
closeBotDialogBtn.addEventListener('click', () => botDialog.close());
cancelBotDialogBtn.addEventListener('click', () => botDialog.close());

accountDialog.addEventListener('click', (e) => {
  if (e.target === accountDialog) accountDialog.close();
});
botDialog.addEventListener('click', (e) => {
  if (e.target === botDialog) botDialog.close();
});

clearLogsBtn.addEventListener('click', () => {
  logsContainer.innerHTML = '';
});

// Live Chat Functions & Listeners
function updateChatChannelOptions() {
  if (!chatChannelSelect) return;
  const bots = appConfig.bots || [];
  const channels = Array.from(new Set(bots.map(b => (b.channel || '').trim().toLowerCase()).filter(Boolean)));
  if (channels.length === 0) channels.push('rubius');

  const current = selectedChatChannel;
  chatChannelSelect.innerHTML = '';
  channels.forEach(ch => {
    const opt = document.createElement('option');
    opt.value = ch;
    opt.textContent = `#${ch}`;
    if (ch === current) opt.selected = true;
    chatChannelSelect.appendChild(opt);
  });

  if (!channels.includes(selectedChatChannel)) {
    selectedChatChannel = channels[0];
    chatChannelSelect.value = selectedChatChannel;
  }

  const accUser = appConfig.defaultAccount?.username || 'you';
  if (chatSendInput) {
    chatSendInput.placeholder = `Send comment to #${selectedChatChannel} as @${accUser}...`;
  }
  renderChannelChat();
  updateChannelRoomStateUI();
  updateChannelPinnedAnnouncementUI();
  if (selectedChatChannel) {
    loadChannelState(selectedChatChannel);
  }
}

function updateChannelRoomStateUI() {
  if (!chatModeBadge) return;
  const state = channelRoomStates[selectedChatChannel] || { subOnly: false, isSubscribed: false, blocked: false };
  const accUser = appConfig.defaultAccount?.username || 'you';

  if (state.blocked) {
    chatModeBadge.textContent = '🔒 Solo Suscriptores';
    chatModeBadge.className = 'room-mode-badge mode-subonly';
    if (chatSubWarning) chatSubWarning.style.display = 'block';
    if (chatSendInput) {
      chatSendInput.disabled = true;
      chatSendInput.placeholder = 'Modo solo suscriptores activo (comentarios en pausa preventiva)';
    }
    if (chatSendBtn) chatSendBtn.disabled = true;
  } else if (state.subOnly && state.isSubscribed) {
    chatModeBadge.textContent = '⭐ Sub-Only (Estás Suscripto)';
    chatModeBadge.className = 'room-mode-badge mode-open';
    if (chatSubWarning) chatSubWarning.style.display = 'none';
    if (chatSendInput) {
      chatSendInput.disabled = false;
      chatSendInput.placeholder = `Send comment to #${selectedChatChannel} as @${accUser}...`;
    }
    if (chatSendBtn) chatSendBtn.disabled = false;
  } else {
    chatModeBadge.textContent = '🔓 Chat Abierto';
    chatModeBadge.className = 'room-mode-badge mode-open';
    if (chatSubWarning) chatSubWarning.style.display = 'none';
    if (chatSendInput) {
      chatSendInput.disabled = false;
      chatSendInput.placeholder = `Send comment to #${selectedChatChannel} as @${accUser}...`;
    }
    if (chatSendBtn) chatSendBtn.disabled = false;
  }
}

function updateChannelPinnedAnnouncementUI() {
  if (!chatPinnedBanner || !pinnedMessageText) return;
  const ann = channelAnnouncements[selectedChatChannel];
  const pinnedAuthorBadge = document.getElementById('pinned-author-badge');

  const text = ann ? (ann.text || ann.message || '') : '';
  const author = ann ? (ann.pinnedBy || ann.author || 'Moderador') : '';

  if (text) {
    chatPinnedBanner.style.display = 'flex';
    pinnedMessageText.textContent = text;
    if (pinnedAuthorBadge) {
      pinnedAuthorBadge.innerHTML = `📌 Fijado por <span class="mod-icon" title="Moderador">⚔️</span> <strong>@${escapeHtml(author)}</strong>`;
    }
  } else {
    chatPinnedBanner.style.display = 'none';
  }
}

async function loadChannelState(chan) {
  if (!chan) return;
  try {
    const res = await fetch(`/api/chat/${encodeURIComponent(chan)}/state`);
    if (res.ok) {
      const data = await res.json();
      if (data.roomState) {
        channelRoomStates[chan] = data.roomState;
      }
      if (data.pinned) {
        channelAnnouncements[chan] = data.pinned;
      } else if (data.announcement) {
        channelAnnouncements[chan] = data.announcement;
      }
      if (chan === selectedChatChannel) {
        updateChannelRoomStateUI();
        updateChannelPinnedAnnouncementUI();
      }
    }
  } catch {}
}

function renderChannelChat() {
  if (!chatMessagesContainer) return;
  chatMessagesContainer.innerHTML = '';
  const msgs = chatBuffers[selectedChatChannel] || [];
  if (msgs.length === 0) {
    chatMessagesContainer.innerHTML = `<div class="chat-empty-state">No messages in #${escapeHtml(selectedChatChannel)} yet. Listening...</div>`;
    return;
  }
  msgs.forEach(msg => {
    renderChatLine(msg);
  });
  if (chatAutoScroll) {
    chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
  }
}

function renderChatLine(msg) {
  if (!chatMessagesContainer) return;
  const placeholder = chatMessagesContainer.querySelector('.chat-empty-state');
  if (placeholder) placeholder.remove();

  const myUsername = (appConfig.defaultAccount?.username || '').trim().toLowerCase();
  const authorName = (msg.username || '').trim().toLowerCase();
  const isMe = Boolean(msg.isSelf || (myUsername && authorName === myUsername));

  const line = document.createElement('div');
  line.className = `chat-line ${isMe ? 'chat-line-self' : ''}`;

  const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();

  const authorHtml = isMe
    ? `<span class="chat-author chat-author-self">⭐ @${escapeHtml(msg.username)} <span class="badge-self">TÚ</span>:</span>`
    : `<span class="chat-author">@${escapeHtml(msg.username || 'unknown')}:</span>`;

  line.innerHTML = `
    <span class="chat-time">${escapeHtml(timeStr)}</span>
    ${authorHtml}
    <span class="chat-text">${escapeHtml(msg.message || '')}</span>
  `;

  chatMessagesContainer.appendChild(line);

  while (chatMessagesContainer.children.length > MAX_CLIENT_CHAT_LINES) {
    chatMessagesContainer.removeChild(chatMessagesContainer.firstChild);
  }

  if (chatAutoScroll) {
    chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
  }
}

function appendChatMessage(msg) {
  const chan = (msg.channel || '').toLowerCase();
  if (!chatBuffers[chan]) chatBuffers[chan] = [];
  chatBuffers[chan].push(msg);
  if (chatBuffers[chan].length > MAX_CLIENT_CHAT_LINES) {
    chatBuffers[chan].shift();
  }

  if (chan === selectedChatChannel) {
    renderChatLine(msg);
  }
}

if (chatChannelSelect) {
  chatChannelSelect.addEventListener('change', () => {
    selectedChatChannel = chatChannelSelect.value;
    const accUser = appConfig.defaultAccount?.username || 'you';
    if (chatSendInput) {
      chatSendInput.placeholder = `Send comment to #${selectedChatChannel} as @${accUser}...`;
    }
    renderChannelChat();
    updateChannelRoomStateUI();
    updateChannelPinnedAnnouncementUI();
    loadChannelState(selectedChatChannel);
  });
}

if (dismissPinnedBtn) {
  dismissPinnedBtn.addEventListener('click', () => {
    delete channelAnnouncements[selectedChatChannel];
    updateChannelPinnedAnnouncementUI();
  });
}

if (toggleAutoscrollBtn) {
  toggleAutoscrollBtn.addEventListener('click', () => {
    chatAutoScroll = !chatAutoScroll;
    toggleAutoscrollBtn.textContent = `Auto-Scroll: ${chatAutoScroll ? 'ON' : 'OFF'}`;
    toggleAutoscrollBtn.classList.toggle('active', chatAutoScroll);
    if (chatAutoScroll && chatMessagesContainer) {
      chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
    }
  });
}

if (clearChatBtn) {
  clearChatBtn.addEventListener('click', () => {
    chatBuffers[selectedChatChannel] = [];
    renderChannelChat();
  });
}

if (chatSendForm) {
  chatSendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = (chatSendInput.value || '').trim();
    if (!text || !selectedChatChannel) return;

    chatSendInput.disabled = true;
    chatSendBtn.disabled = true;

    try {
      const res = await fetch('/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: selectedChatChannel,
          message: text
        })
      });

      if (res.ok) {
        chatSendInput.value = '';
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to send comment');
      }
    } catch {
      alert('Network error sending comment to Twitch IRC');
    } finally {
      chatSendInput.disabled = false;
      chatSendBtn.disabled = false;
      chatSendInput.focus();
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Boot
initEventSource();

// Periodic background sync for room mode and pinned chat
setInterval(() => {
  if (selectedChatChannel) {
    loadChannelState(selectedChatChannel);
  }
}, 20000);
