# Use a Node.js Debian-slim image for the builder stage
FROM node:24-slim AS builder
WORKDIR /app

# Enable pnpm using corepack and install git
RUN apt-get update && apt-get install -y git && corepack enable pnpm

# Salin package.json dan pnpm-lock.yaml (jika ada)
COPY package.json pnpm-lock.yaml* ./

# Install dependensi (setara dengan npm ci)
RUN pnpm install --frozen-lockfile

COPY . .

# Build aplikasi
RUN pnpm run build

# Hapus devDependencies untuk production (setara dengan npm prune --production)
RUN pnpm prune --prod

# Use another Node.js Debian-slim image for the final stage
FROM node:24-slim
WORKDIR /app

# Install 'serve' statically to serve the SPA
RUN npm install -g serve

COPY --from=builder /app/build build/

EXPOSE 3000
ENV NODE_ENV=production
# -s flag is for Single Page Application (redirects 404 to index.html)
# -l tcp://0.0.0.0:3000 listens on port 3000
CMD [ "serve", "-s", "build", "-l", "tcp://0.0.0.0:3000" ]