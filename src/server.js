import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, sanitizeConfigForClient, normalizeBot } from './config.js';
import { BotManager } from './bot-manager.js';
import { fetchPinnedChatMessage } from './twitch-pinned.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Initialize state
let config = await loadConfig();
const botManager = new BotManager(config);

// SSE subscriber connections
const sseClients = new Set();

function broadcast(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Log history buffer
const logHistory = [];
const MAX_LOG_HISTORY = 60;

function logEntry(type, text) {
  const entry = {
    type,
    text,
    timestamp: new Date().toLocaleTimeString()
  };
  logHistory.push(entry);
  if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift();
  broadcast('log', entry);
}

// Live Channel Chat buffers
const channelChatBuffers = new Map(); // channel -> Array<{ channel, username, message, isSelf, timestamp }>
const channelAnnouncements = new Map(); // channel -> { message, timestamp }
const MAX_CHAT_BUFFER = 100;

function addChatMessage(msg) {
  const chan = (msg.channel || '').toLowerCase();
  if (!channelChatBuffers.has(chan)) {
    channelChatBuffers.set(chan, []);
  }
  const buf = channelChatBuffers.get(chan);
  buf.push(msg);
  if (buf.length > MAX_CHAT_BUFFER) buf.shift();

  broadcast('chat_message', msg);
}

// Wire BotManager events
botManager.on('log', ({ type, text }) => logEntry(type, text));
botManager.on('bot_state', (state) => broadcast('bot_state', state));
botManager.on('bot_countdown', (countdown) => broadcast('bot_countdown', countdown));
botManager.on('bot_trend', (trend) => broadcast('bot_trend', trend));
botManager.on('chat_message', (msg) => addChatMessage(msg));
botManager.on('announcement', (ann) => {
  const chan = (ann.channel || '').toLowerCase();
  channelAnnouncements.set(chan, ann);
  broadcast('announcement', ann);
});
botManager.on('room_state', (state) => {
  broadcast('room_state', state);
});
botManager.on('client_status', (status) => broadcast('client_status', status));

// Pinned Chat Synchronizer (Polls Twitch GQL for pinned messages every 20s)
async function syncPinnedChatForChannels() {
  const channels = new Set((config.bots || []).map(b => (b.channel || '').replace(/^[#/]+/, '').toLowerCase()).filter(Boolean));
  for (const bot of botManager.bots.values()) {
    if (bot.channel) channels.add(bot.channel.replace(/^[#/]+/, '').toLowerCase());
  }
  if (channels.size === 0) channels.add('rubius');

  for (const ch of channels) {
    try {
      const pinned = await fetchPinnedChatMessage(ch);
      const existing = channelAnnouncements.get(ch);
      if (pinned) {
        if (!existing || existing.id !== pinned.id || existing.text !== pinned.text) {
          channelAnnouncements.set(ch, pinned);
          broadcast('pinned_message', pinned);
        }
      } else if (existing) {
        channelAnnouncements.delete(ch);
        broadcast('pinned_message', { channel: ch, text: null, pinnedBy: null });
      }
    } catch {
      // Best-effort non-blocking
    }
  }
}

const pinnedSyncTimer = setInterval(syncPinnedChatForChannels, 20000);
if (pinnedSyncTimer.unref) pinnedSyncTimer.unref();
syncPinnedChatForChannels();

// MIME types for static assets
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

async function handleStatic(req, res, pathname) {
  let filePath = pathname === '/' ? 'index.html' : pathname;
  filePath = join(PUBLIC_DIR, filePath);

  try {
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('500 Internal Server Error');
    }
  }
}

async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE Stream
  if (pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    sseClients.add(res);

    const initData = {
      config: sanitizeConfigForClient(config),
      botStates: botManager.getAllStates(),
      trendStats: botManager.getAllTrendStats(),
      roomStates: botManager.getAllRoomStates(),
      announcements: Object.fromEntries(channelAnnouncements.entries()),
      recentChat: Object.fromEntries(channelChatBuffers.entries()),
      logs: logHistory
    };
    res.write(`event: init\ndata: ${JSON.stringify(initData)}\n\n`);

    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  // GET /api/config
  if (pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sanitizeConfigForClient(config)));
    return;
  }

  // POST /api/config (Updates default account or multiple bots)
  if (pathname === '/api/config' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);

      // Preserve masked tokens if unchanged
      if (body.defaultAccount) {
        if (!body.defaultAccount.oauthToken || body.defaultAccount.oauthToken.includes('••••')) {
          body.defaultAccount.oauthToken = config.defaultAccount?.oauthToken || '';
        }
      }

      if (Array.isArray(body.bots)) {
        body.bots = body.bots.map(incomingBot => {
          const existing = config.bots.find(b => b.id === incomingBot.id);
          if (incomingBot.customAccount && existing?.customAccount) {
            if (!incomingBot.customAccount.oauthToken || incomingBot.customAccount.oauthToken.includes('••••')) {
              incomingBot.customAccount.oauthToken = existing.customAccount.oauthToken;
            }
          }
          return incomingBot;
        });
      }

      config = await saveConfig(body);
      botManager.updateConfig(config);

      logEntry('info', 'Configuration updated successfully');
      broadcast('config', sanitizeConfigForClient(config));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, config: sanitizeConfigForClient(config) }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/bots (Create new bot)
  if (pathname === '/api/bots' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const newBot = normalizeBot(body, config.bots.length);
      config.bots.push(newBot);

      config = await saveConfig(config);
      botManager.updateConfig(config);

      logEntry('info', `Created new bot "${newBot.name}" for #${newBot.channel || 'unassigned'}`);
      broadcast('config', sanitizeConfigForClient(config));

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bot: newBot, config: sanitizeConfigForClient(config) }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // DELETE /api/bots/:id
  const deleteMatch = pathname.match(/^\/api\/bots\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const botId = deleteMatch[1];
    config.bots = config.bots.filter(b => b.id !== botId);

    config = await saveConfig(config);
    botManager.updateConfig(config);

    logEntry('info', `Deleted bot instance "${botId}"`);
    broadcast('config', sanitizeConfigForClient(config));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, config: sanitizeConfigForClient(config) }));
    return;
  }

  // Bot Actions: /api/bots/:id/start, /api/bots/:id/stop, /api/bots/:id/test
  const actionMatch = pathname.match(/^\/api\/bots\/([^/]+)\/(start|stop|test)$/);
  if (actionMatch && req.method === 'POST') {
    const [, botId, action] = actionMatch;
    try {
      if (action === 'start') {
        const state = botManager.startBot(botId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state }));
      } else if (action === 'stop') {
        const state = botManager.stopBot(botId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state }));
      } else if (action === 'test') {
        const result = botManager.testBot(botId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/bots/:id/trend
  const trendMatch = pathname.match(/^\/api\/bots\/([^/]+)\/trend$/);
  if (trendMatch && req.method === 'GET') {
    const botId = trendMatch[1];
    const stats = botManager.getBotTrendStats(botId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats || { totalInWindow: 0, windowSeconds: 25, topTrend: null, topPhrases: [] }));
    return;
  }

  // POST /api/chat/send (Send manual chat message via IRC)
  if (pathname === '/api/chat/send' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const result = botManager.sendManualMessage(body.channel, body.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/chat/:channel (Fetch recent messages for channel)
  const chatMatch = pathname.match(/^\/api\/chat\/([^/]+)$/);
  if (chatMatch && req.method === 'GET') {
    const chan = chatMatch[1].toLowerCase();
    const messages = channelChatBuffers.get(chan) || [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ channel: chan, messages }));
    return;
  }

  // GET /api/chat/:channel/state (Fetch channel room state and pinned announcement)
  const chatStateMatch = pathname.match(/^\/api\/chat\/([^/]+)\/state$/);
  if (chatStateMatch && req.method === 'GET') {
    const chan = chatStateMatch[1].toLowerCase();
    let pinned = channelAnnouncements.get(chan) || null;
    if (!pinned) {
      try {
        pinned = await fetchPinnedChatMessage(chan);
        if (pinned) channelAnnouncements.set(chan, pinned);
      } catch {}
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      channel: chan,
      roomState: botManager.getChannelRoomState(chan),
      pinned,
      announcement: pinned
    }));
    return;
  }

  // Backward compatibility legacy endpoints for single-bot (defaults to first bot)
  if (pathname === '/api/bot/start' && req.method === 'POST') {
    const firstBot = config.bots[0];
    if (!firstBot) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No bots configured.' }));
      return;
    }
    try {
      const state = botManager.startBot(firstBot.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, botState: state }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/api/bot/stop' && req.method === 'POST') {
    const firstBot = config.bots[0];
    if (!firstBot) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const state = botManager.stopBot(firstBot.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, botState: state }));
    return;
  }

  // Default: Static File Serving
  if (req.method === 'GET') {
    await handleStatic(req, res, pathname);
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  Twitch Giveaway Multi-Bot Hub: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
  logEntry('info', `Multi-Bot Hub running on port ${PORT}`);
});

export { server, botManager };
