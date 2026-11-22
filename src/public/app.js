// Twitch Giveaway Bot Client Controller

let appConfig = null;
let currentMessages = [];
let eventSource = null;

// DOM Elements
const ircStatusBadge = document.getElementById('irc-status-badge');
const botStatusPill = document.getElementById('bot-status-pill');
const displayChannel = document.getElementById('display-channel');
const displayUser = document.getElementById('display-user');
const displayInterval = document.getElementById('display-interval');
const countdownSeconds = document.getElementById('countdown-seconds');
const progressBarFill = document.getElementById('progress-bar-fill');
const sentCountEl = document.getElementById('sent-count');
const messageCountBadge = document.getElementById('message-count-badge');
const messagesList = document.getElementById('messages-list');
const logsContainer = document.getElementById('logs-container');

const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const testBtn = document.getElementById('test-btn');
const clearLogsBtn = document.getElementById('clear-logs-btn');
const openSettingsBtn = document.getElementById('open-settings-btn');
const closeDialogBtn = document.getElementById('close-dialog-btn');
const cancelDialogBtn = document.getElementById('cancel-dialog-btn');
const settingsDialog = document.getElementById('settings-dialog');
const settingsForm = document.getElementById('settings-form');
const addMessageForm = document.getElementById('add-message-form');
const newMessageInput = document.getElementById('new-message-input');

// Initialize SSE connection
function initEventSource() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource('/api/stream');

  eventSource.addEventListener('init', (e) => {
    const data = JSON.parse(e.data);
    applyConfig(data.config);
    updateIrcStatus(data.ircStatus);
    updateBotState(data.botState);
    if (data.logs) {
      logsContainer.innerHTML = '';
      data.logs.forEach(appendLog);
    }
  });

  eventSource.addEventListener('config', (e) => {
    applyConfig(JSON.parse(e.data));
  });

  eventSource.addEventListener('irc_status', (e) => {
    const { status } = JSON.parse(e.data);
    updateIrcStatus(status);
  });

  eventSource.addEventListener('bot_state', (e) => {
    updateBotState(JSON.parse(e.data));
  });

  eventSource.addEventListener('countdown', (e) => {
    const { remainingSeconds, totalSeconds } = JSON.parse(e.data);
    updateCountdown(remainingSeconds, totalSeconds);
  });

  eventSource.addEventListener('log', (e) => {
    appendLog(JSON.parse(e.data));
  });

  eventSource.onerror = () => {
    updateIrcStatus('disconnected');
  };
}

function applyConfig(cfg) {
  appConfig = cfg;
  currentMessages = [...(cfg.messages || [])];

  displayChannel.textContent = cfg.channel ? `#${cfg.channel}` : '#not-configured';
  displayUser.textContent = cfg.username ? `as @${cfg.username}` : '(not configured)';
  displayInterval.textContent = `${cfg.minIntervalSeconds}s - ${cfg.maxIntervalSeconds}s`;

  // Populate settings form inputs
  document.getElementById('cfg-username').value = cfg.username || '';
  document.getElementById('cfg-oauth').value = cfg.oauthTokenMasked || '';
  document.getElementById('cfg-channel').value = cfg.channel || '';
  document.getElementById('cfg-min-interval').value = cfg.minIntervalSeconds || 30;
  document.getElementById('cfg-max-interval').value = cfg.maxIntervalSeconds || 60;
  document.getElementById('cfg-avoid-repeats').checked = cfg.avoidConsecutiveRepeats ?? true;

  renderMessagesList();
}

function updateIrcStatus(status) {
  ircStatusBadge.className = 'badge';
  const textEl = ircStatusBadge.querySelector('.status-text');

  switch (status) {
    case 'joined':
      ircStatusBadge.classList.add('badge-connected');
      textEl.textContent = `Chat Connected (#${appConfig?.channel || ''})`;
      break;
    case 'authenticated':
      ircStatusBadge.classList.add('badge-connected');
      textEl.textContent = 'Authenticated';
      break;
    case 'connecting':
      ircStatusBadge.classList.add('badge-connecting');
      textEl.textContent = 'Connecting...';
      break;
    default:
      ircStatusBadge.classList.add('badge-disconnected');
      textEl.textContent = 'Disconnected';
      break;
  }
}

function updateBotState(state) {
  if (!state) return;

  if (state.running) {
    botStatusPill.className = 'pill pill-running';
    botStatusPill.textContent = 'Running';
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    botStatusPill.className = 'pill pill-idle';
    botStatusPill.textContent = 'Stopped';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    countdownSeconds.textContent = '--';
    progressBarFill.style.width = '0%';
  }

  if (typeof state.sentCount === 'number') {
    sentCountEl.textContent = state.sentCount;
  }
}

function updateCountdown(remaining, total) {
  if (remaining > 0) {
    countdownSeconds.textContent = remaining;
    if (total > 0) {
      const percent = Math.max(0, Math.min(100, ((total - remaining) / total) * 100));
      progressBarFill.style.width = `${percent}%`;
    }
  } else {
    countdownSeconds.textContent = '--';
    progressBarFill.style.width = '0%';
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

  // Auto-scroll to bottom
  logsContainer.scrollTop = logsContainer.scrollHeight;
}

function renderMessagesList() {
  messagesList.innerHTML = '';
  messageCountBadge.textContent = `${currentMessages.length} message${currentMessages.length === 1 ? '' : 's'}`;

  currentMessages.forEach((msg, idx) => {
    const tag = document.createElement('div');
    tag.className = 'message-tag';

    const text = document.createElement('span');
    text.textContent = msg;

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-tag-btn';
    delBtn.title = 'Remove message';
    delBtn.innerHTML = '×';
    delBtn.onclick = () => removeMessage(idx);

    tag.appendChild(text);
    tag.appendChild(delBtn);
    messagesList.appendChild(tag);
  });
}

async function addMessage(msg) {
  const clean = msg.trim();
  if (!clean || currentMessages.includes(clean)) return;

  currentMessages.push(clean);
  renderMessagesList();
  await syncMessagesToServer();
}

async function removeMessage(index) {
  if (currentMessages.length <= 1) {
    alert('You need at least one message in the giveaway pool!');
    return;
  }
  currentMessages.splice(index, 1);
  renderMessagesList();
  await syncMessagesToServer();
}

async function syncMessagesToServer() {
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: currentMessages })
    });
  } catch (err) {
    console.error('Failed to sync messages:', err);
  }
}

// Bot Control Handlers
startBtn.addEventListener('click', async () => {
  if (!appConfig?.hasToken || !appConfig?.channel || !appConfig?.username) {
    settingsDialog.showModal();
    return;
  }
  try {
    const res = await fetch('/api/bot/start', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) alert(data.error || 'Failed to start bot');
  } catch (err) {
    alert('Error connecting to server');
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/bot/stop', { method: 'POST' });
  } catch (err) {
    alert('Error connecting to server');
  }
});

testBtn.addEventListener('click', async () => {
  if (!appConfig?.hasToken || !appConfig?.channel) {
    settingsDialog.showModal();
    return;
  }
  testBtn.disabled = true;
  try {
    const res = await fetch('/api/bot/test', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) alert(data.error || 'Test message failed');
  } catch (err) {
    alert('Error connecting to server');
  } finally {
    setTimeout(() => { testBtn.disabled = false; }, 2000);
  }
});

clearLogsBtn.addEventListener('click', () => {
  logsContainer.innerHTML = '';
});

// Message Form
addMessageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = newMessageInput.value;
  if (val) {
    addMessage(val);
    newMessageInput.value = '';
    newMessageInput.focus();
  }
});

// Dialog (Modern Web Guidance modal handling)
openSettingsBtn.addEventListener('click', () => {
  settingsDialog.showModal();
});

closeDialogBtn.addEventListener('click', () => {
  settingsDialog.close();
});

cancelDialogBtn.addEventListener('click', () => {
  settingsDialog.close();
});

// Light dismiss: click outside dialog backdrop closes modal
settingsDialog.addEventListener('click', (e) => {
  if (e.target === settingsDialog) {
    settingsDialog.close();
  }
});

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(settingsForm);

  const payload = {
    username: formData.get('username'),
    oauthToken: formData.get('oauthToken'),
    channel: formData.get('channel'),
    minIntervalSeconds: parseInt(formData.get('minIntervalSeconds'), 10),
    maxIntervalSeconds: parseInt(formData.get('maxIntervalSeconds'), 10),
    avoidConsecutiveRepeats: formData.get('avoidConsecutiveRepeats') === 'on'
  };

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      settingsDialog.close();
    } else {
      alert(data.error || 'Failed to save configuration');
    }
  } catch (err) {
    alert('Error saving configuration');
  }
});

// Boot
initEventSource();
