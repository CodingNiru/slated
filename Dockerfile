# Slated 24/7 Production Container
FROM node:20-alpine

# Security: Set NODE_ENV to production
ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

# Install dependencies with production flag
COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm install --production

# Copy application code
COPY . .

# Expose server port
EXPOSE 3000

# Health check to ensure 24/7 availability
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Run non-root user for security
USER node

# Start Slated server
CMD ["node", "server.js"]
