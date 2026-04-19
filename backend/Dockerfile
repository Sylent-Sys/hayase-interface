FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN corepack enable
RUN pnpm install
COPY server.js .
EXPOSE 4000
CMD ["pnpm", "start"]
