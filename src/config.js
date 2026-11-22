import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CONFIG_PATH = process.env.CONFIG_PATH || join(__dirname, '..', 'config.json');

export const DEFAULT_CONFIG = {
  defaultAccount: {
    username: '',
    oauthToken: ''
  },
  bots: []
};

export async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ...DEFAULT_CONFIG };
    }
    console.error('Error loading config file:', err);
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(updates) {
  const current = await loadConfig();
  const merged = normalizeConfig({ ...current, ...updates });
  await writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

export function normalizeAccount(acc = {}) {
  const username = (acc.username || '').trim().toLowerCase();
  let token = (acc.oauthToken || '').trim();
  if (token && !token.startsWith('oauth:')) {
    token = `oauth:${token}`;
  }
  return { username, oauthToken: token };
}

export function normalizeBot(bot, index = 0) {
  const id = bot.id || `bot_${Date.now()}_${index}`;
  const name = (bot.name || `Bot #${index + 1}`).trim();
  const channel = (bot.channel || '').trim().replace(/^#/, '').toLowerCase();

  let minInterval = Number.parseInt(bot.minIntervalSeconds, 10);
  if (Number.isNaN(minInterval) || minInterval < 5) minInterval = 5;

  let maxInterval = Number.parseInt(bot.maxIntervalSeconds, 10);
  if (Number.isNaN(maxInterval) || maxInterval < minInterval) {
    maxInterval = minInterval + 15;
  }

  const rawMessages = Array.isArray(bot.messages) ? bot.messages : [];
  const messages = rawMessages
    .map(m => String(m).trim())
    .filter(m => m.length > 0);

  let customAccount = null;
  if (bot.customAccount && (bot.customAccount.username || bot.customAccount.oauthToken)) {
    customAccount = normalizeAccount(bot.customAccount);
  }

  return {
    id,
    name,
    channel,
    minIntervalSeconds: minInterval,
    maxIntervalSeconds: maxInterval,
    avoidConsecutiveRepeats: Boolean(bot.avoidConsecutiveRepeats ?? true),
    autoDetectTrends: Boolean(bot.autoDetectTrends ?? true),
    messages: messages.length > 0 ? messages : ['!sorteo'],
    customAccount
  };
}

export function normalizeConfig(config = {}) {
  // Migration for legacy single-bot config:
  let defaultAccount = { username: '', oauthToken: '' };
  if (config.defaultAccount) {
    defaultAccount = normalizeAccount(config.defaultAccount);
  } else if (config.username || config.oauthToken) {
    defaultAccount = normalizeAccount({
      username: config.username,
      oauthToken: config.oauthToken
    });
  }

  let bots = [];
  if (Array.isArray(config.bots)) {
    bots = config.bots.map((b, i) => normalizeBot(b, i));
  } else if (config.channel || (Array.isArray(config.messages) && config.messages.length > 0)) {
    // Migrate legacy single bot entry into the bots list
    bots = [
      normalizeBot({
        id: 'default_bot',
        name: config.channel ? `Sorteo #${config.channel}` : 'Canal Principal',
        channel: config.channel || '',
        minIntervalSeconds: config.minIntervalSeconds || 30,
        maxIntervalSeconds: config.maxIntervalSeconds || 60,
        avoidConsecutiveRepeats: config.avoidConsecutiveRepeats ?? true,
        messages: config.messages || ['!sorteo']
      }, 0)
    ];
  }

  return {
    defaultAccount,
    bots
  };
}

export function maskToken(token) {
  if (!token) return '';
  const raw = token.replace(/^oauth:/, '');
  return raw.length > 6 ? `oauth:••••••••${raw.slice(-4)}` : 'oauth:••••••••';
}

export function sanitizeConfigForClient(config) {
  const safe = {
    defaultAccount: {
      username: config.defaultAccount.username,
      hasToken: Boolean(config.defaultAccount.oauthToken),
      oauthTokenMasked: maskToken(config.defaultAccount.oauthToken)
    },
    bots: config.bots.map(b => ({
      ...b,
      customAccount: b.customAccount ? {
        username: b.customAccount.username,
        hasToken: Boolean(b.customAccount.oauthToken),
        oauthTokenMasked: maskToken(b.customAccount.oauthToken)
      } : null
    }))
  };
  return safe;
}
