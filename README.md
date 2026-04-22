# Interface

This repository contains the interface components and related code for the Hayase project.

## **Building and Development**

Requires `Node 20` or above and `pnpm`. VSCode is recommended.

```js
pnpm i // to install
pnpm run dev // to develop
pnpm run build // to build
pnpm run sync && pnpm run lint && pnpm run gql:check && pnpm run check // to test
```

> [!IMPORTANT]
> The developer(s) of this application does not have any affiliation with the content providers available, and this application hosts zero content.

## Torrent backend environment variables

The Go torrent backend (`/backend/torrent`) supports:

- `MAX_TORRENTS` (default: `200`)
- `SESSION_TTL_SECONDS` (default: `1800`)
- `CLEANUP_INTERVAL_SECONDS` (default: `300`)
- `SHUTDOWN_TIMEOUT_SECONDS` (default: `15`) - graceful HTTP shutdown timeout
- `DRAIN_TORRENTS_ON_SHUTDOWN` (default: `false`) - when enabled, drops active torrents before client close
