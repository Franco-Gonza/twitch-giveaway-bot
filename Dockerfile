FROM node:24-alpine

WORKDIR /app

# Copy package descriptors and source
COPY package*.json ./
COPY src/ ./src/

# Default environment variables
ENV PORT=3000
ENV NODE_ENV=production
ENV CONFIG_PATH=/app/data/config.json

# Create data directory for persistent configuration
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/server.js"]
