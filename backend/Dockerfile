FROM node:24-alpine

# Build tools required by webtorrent's native dependency: node-datachannel
RUN apk add --no-cache python3 make g++ linux-headers

WORKDIR /app

COPY package*.json ./
COPY pnpm-lock.yaml ./

RUN corepack enable

# Install deps and allow native addons (node-datachannel, bufferutil, utp-native, etc.) to compile
RUN pnpm install
RUN pnpm approve-builds --yes

COPY server.js .

EXPOSE 4000

CMD ["pnpm", "start"]
