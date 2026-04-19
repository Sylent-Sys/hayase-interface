# Use a Node.js Alpine image for the builder stage
FROM node:24-alpine AS builder
WORKDIR /app

# Aktifkan pnpm menggunakan corepack
RUN apk add --no-cache git && corepack enable pnpm

# Salin package.json dan pnpm-lock.yaml (jika ada)
COPY package.json pnpm-lock.yaml* ./

# Install dependensi (setara dengan npm ci)
RUN pnpm install --frozen-lockfile

COPY . .

# Build aplikasi
RUN pnpm run build

# Hapus devDependencies untuk production (setara dengan npm prune --production)
RUN pnpm prune --prod

# Use another Node.js Alpine image for the final stage
FROM node:24-alpine
WORKDIR /app

COPY --from=builder /app/build build/
COPY --from=builder /app/node_modules node_modules/
COPY package.json .

EXPOSE 3000
ENV NODE_ENV=production
CMD [ "node", "build" ]