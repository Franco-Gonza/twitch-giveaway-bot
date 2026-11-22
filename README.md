# Twitch Giveaway Auto-Commenter

Lightweight, zero-bloat Twitch giveaway auto-commenter with a modern web UI, direct Twitch IRC WebSocket client, and interval jitter to avoid spam filters. Built with Node.js 24 and standard Web APIs.

## Features

- **Modern Web Interface**: Responsive, accessible UI with native dark/light theme (`color-scheme: light dark`), native `<dialog>` controls, and real-time Server-Sent Events (SSE).
- **Twitch IRC Client**: Implemented using Node 24 native `WebSocket` (`wss://irc-ws.chat.twitch.tv:443`) with automatic `PING/PONG` keepalive and reconnect handling.
- **Random Message Scheduler**: Uniform random selection from a customizable message pool with anti-consecutive repeat protection.
- **Jittered Timing**: Configurable minimum and maximum interval bounds with random jitter to prevent bot detection and rate limit violations.
- **Zero Heavy Dependencies**: Pure Node.js standard library (`node:http`, `node:fs`, `node:events`, native `WebSocket`).
- **Docker Ready**: Alpine-based Docker container and Docker Compose configuration with volume persistence.

## Getting Started

### Local Development

1. Install Node.js (v22+ or v24+ recommended).
2. Start the application:
   ```bash
   npm start
   ```
3. Open your browser at `http://localhost:3000`.
4. Open **Settings**, configure your Twitch username, OAuth token (from [twitchapps.com/tmi/](https://twitchapps.com/tmi/)), and target channel.

### Running with Docker

```bash
docker compose up -d --build
```

The web dashboard will be accessible at `http://localhost:3000` (or `http://<server-ip>:3000`).

## Testing

Run unit tests using the Node.js native test runner:

```bash
npm test
```

## License

MIT
