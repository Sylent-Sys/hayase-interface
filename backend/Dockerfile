FROM node:24-alpine

# Build tools required by webtorrent's native dependency: node-datachannel
RUN apk add --no-cache python3 make g++ linux-headers

WORKDIR /app

COPY package*.json ./
COPY pnpm-lock.yaml ./

RUN corepack enable

# pnpm.onlyBuiltDependencies in package.json pre-approves native addon compilation
RUN pnpm install

COPY server.js .

EXPOSE 4000

CMD ["pnpm", "start"]
