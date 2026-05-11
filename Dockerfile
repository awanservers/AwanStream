FROM node:20-bookworm-slim

# Install ffmpeg + build tools for better-sqlite3 native addon
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies (layer cached unless package*.json changes)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application code
COPY . .

# Create runtime directories
RUN mkdir -p db logs public/uploads

# Default port
EXPOSE 7575

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http=require('http');http.get('http://localhost:7575/login',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "app.js"]
