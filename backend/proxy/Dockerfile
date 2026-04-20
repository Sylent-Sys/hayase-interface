FROM node:24-slim

# Build tools required by webtorrent's native dependencies (Debian/glibc based)
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    make \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY pnpm-lock.yaml ./
COPY internal_modules ./internal_modules

RUN corepack enable

# pnpm.onlyBuiltDependencies in package.json pre-approves native addon compilation
RUN pnpm install

COPY server.ts .

EXPOSE 4000

CMD ["pnpm", "start"]
