FROM node:20-alpine

# Install build tools for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy dependency files first (better Docker cache)
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Remove devDependencies after build
RUN npm prune --production

# Create data directory for SQLite
RUN mkdir -p /app/data

# Set default DB path
ENV DB_PATH=/app/data/predictions.db

EXPOSE 3000

CMD ["node", "dist/index.js"]
