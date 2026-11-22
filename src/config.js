import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CONFIG_PATH = process.env.CONFIG_PATH || join(__dirname, '..', 'config.json');

export const DEFAULT_CONFIG = {
  channel: '',
  username: '',
  oauthToken: '',
  minIntervalSeconds: 30,
  maxIntervalSeconds: 60,
  avoidConsecutiveRepeats: true,
  messages: [
    '!sorteo',
    '!ticket',
    'Participando en el sorteo!',
    'Mucha suerte a todos!'
  ]
};

export async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return normalizeConfig({ ...DEFAULT_CONFIG, ...parsed });
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

export function normalizeConfig(config) {
  const channel = (config.channel || '').trim().replace(/^#/, '').toLowerCase();
  const username = (config.username || '').trim().toLowerCase();
  
  let token = (config.oauthToken || '').trim();
  if (token && !token.startsWith('oauth:')) {
    token = `oauth:${token}`;
  }

  let minInterval = Number.parseInt(config.minIntervalSeconds, 10);
  if (Number.isNaN(minInterval) || minInterval < 5) {
    minInterval = 5; // Safety lower bound to prevent rapid chat flooding
  }

  let maxInterval = Number.parseInt(config.maxIntervalSeconds, 10);
  if (Number.isNaN(maxInterval) || maxInterval < minInterval) {
    maxInterval = minInterval + 15;
  }

  const rawMessages = Array.isArray(config.messages) ? config.messages : [];
  const messages = rawMessages
    .map(m => String(m).trim())
    .filter(m => m.length > 0);

  return {
    channel,
    username,
    oauthToken: token,
    minIntervalSeconds: minInterval,
    maxIntervalSeconds: maxInterval,
    avoidConsecutiveRepeats: Boolean(config.avoidConsecutiveRepeats),
    messages: messages.length > 0 ? messages : ['!sorteo']
  };
}

export function sanitizeConfigForClient(config) {
  const safe = { ...config };
  if (safe.oauthToken) {
    // Mask token for client view, keeping oauth: prefix and trailing 4 chars
    const raw = safe.oauthToken.replace(/^oauth:/, '');
    const masked = raw.length > 6 
      ? `oauth:••••••••${raw.slice(-4)}` 
      : 'oauth:••••••••';
    safe.oauthTokenMasked = masked;
    safe.hasToken = true;
  } else {
    safe.oauthTokenMasked = '';
    safe.hasToken = false;
  }
  delete safe.oauthToken;
  return safe;
}
