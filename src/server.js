import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, sanitizeConfigForClient } from './config.js';
import { TwitchIrcClient } from './twitch-irc.js';
import { MessageScheduler } from './scheduler.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Initialize state
let config = await loadConfig();
const ircClient = new TwitchIrcClient({
  username: config.username,
  oauthToken: config.oauthToken,
  channel: config.channel
});

const scheduler = new MessageScheduler({
  messages: config.messages,
  minIntervalSeconds: config.minIntervalSeconds,
  maxIntervalSeconds: config.maxIntervalSeconds,
  avoidConsecutiveRepeats: config.avoidConsecutiveRepeats
});

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

// Log history buffer for new client connects
const logHistory = [];
const MAX_LOG_HISTORY = 50;

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

// Wire IRC client events
ircClient.on('log', ({ type, text }) => logEntry(type, text));
ircClient.on('status_change', (status) => {
  broadcast('irc_status', { status });
});

// Wire Scheduler events
scheduler.on('dispatch', ({ message, sentCount }) => {
  const sent = ircClient.sendMessage(message);
  if (!sent) {
    logEntry('warning', `Skipped message dispatch (IRC not connected to #${config.channel})`);
  }
  broadcast('bot_state', scheduler.getState());
});

scheduler.on('countdown', (countdown) => {
  broadcast('countdown', countdown);
});

scheduler.on('status_change', () => {
  broadcast('bot_state', scheduler.getState());
});

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
        reject(new Error('Request payload too large'));
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

  // CORS headers for local dev convenience
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE Stream Endpoint
  if (pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    sseClients.add(res);

    // Initial state bundle
    const initData = {
      config: sanitizeConfigForClient(config),
      ircStatus: ircClient.status,
      botState: scheduler.getState(),
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

  // REST API: GET /api/config
  if (pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sanitizeConfigForClient(config)));
    return;
  }

  // REST API: POST /api/config
  if (pathname === '/api/config' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      
      // If oauthToken is masked or not provided in update, retain existing
      if (!body.oauthToken || body.oauthToken.includes('••••')) {
        body.oauthToken = config.oauthToken;
      }

      config = await saveConfig(body);
      
      // Update IRC client credentials & channel
      ircClient.updateCredentials({
        username: config.username,
        oauthToken: config.oauthToken,
        channel: config.channel
      });

      // Update Scheduler parameters
      scheduler.updateConfig({
        messages: config.messages,
        minIntervalSeconds: config.minIntervalSeconds,
        maxIntervalSeconds: config.maxIntervalSeconds,
        avoidConsecutiveRepeats: config.avoidConsecutiveRepeats
      });

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

  // REST API: POST /api/bot/start
  if (pathname === '/api/bot/start' && req.method === 'POST') {
    if (!config.username || !config.oauthToken || !config.channel) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'Please configure your Twitch username, OAuth token, and target channel first.' 
      }));
      return;
    }

    if (ircClient.status !== 'joined' && ircClient.status !== 'authenticated') {
      ircClient.connect();
    }

    scheduler.start();
    logEntry('info', `Giveaway auto-commenter started for channel #${config.channel}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, botState: scheduler.getState() }));
    return;
  }

  // REST API: POST /api/bot/stop
  if (pathname === '/api/bot/stop' && req.method === 'POST') {
    scheduler.stop();
    ircClient.disconnect();
    logEntry('info', 'Giveaway auto-commenter stopped.');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, botState: scheduler.getState() }));
    return;
  }

  // REST API: POST /api/bot/test
  if (pathname === '/api/bot/test' && req.method === 'POST') {
    if (!config.channel) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Target channel is not configured.' }));
      return;
    }

    // Ensure connection before test dispatch
    if (ircClient.status !== 'joined' && ircClient.status !== 'authenticated') {
      ircClient.connect();
      // Allow brief moment for auth if just triggered
      setTimeout(() => {
        const msg = scheduler.pickRandomMessage() || '!sorteo';
        const ok = ircClient.sendMessage(msg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok, message: msg }));
      }, 1500);
      return;
    }

    const msg = scheduler.pickRandomMessage() || '!sorteo';
    const ok = ircClient.sendMessage(msg);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok, message: msg }));
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
  console.log(`  Twitch Giveaway Bot UI: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
  logEntry('info', `Server initialized on port ${PORT}`);
});

export { server, ircClient, scheduler };
