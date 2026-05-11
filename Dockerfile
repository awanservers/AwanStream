# ─── Stage 1: Build native dependencies ─────────────────────────────────────
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ─── Stage 2: Production image ──────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copy compiled node_modules from builder (includes native better-sqlite3)
COPY --from=builder /app/node_modules ./node_modules

# Copy application code
COPY package*.json ./
COPY . .

# Create runtime directories and non-root user
RUN addgroup -S awanstream && adduser -S awanstreamuser -G awanstream \
    && mkdir -p db logs public/uploads \
    && chown -R awanstreamuser:awanstream /app

USER awanstreamuser

# Default port
EXPOSE 7575

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http=require('http');http.get('http://localhost:7575/login',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "app.js"]
