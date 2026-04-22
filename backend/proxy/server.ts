import express from "express";
import cors from "cors";
import os from "node:os";
import { createProxyMiddleware } from "http-proxy-middleware";
import Metadata from "matroska-metadata";
import EventEmitter from "node:events";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

// ─── Critical Error Handling ────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("[CRITICAL] Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error(
    "[CRITICAL] Unhandled Rejection at:",
    promise,
    "reason:",
    reason,
  );
});

const app = express();
const GO_BACKEND_URL = process.env.GO_BACKEND_URL || "http://localhost:5000";
const PORT = Number(process.env.PORT || 4000);
const SESSION_COOKIE = "hayase_sid";
const BACKEND_TIMEOUT_MS = Number(process.env.BACKEND_TIMEOUT_MS || 15000);
const STREAM_CONNECT_TIMEOUT_MS = Number(
  process.env.STREAM_CONNECT_TIMEOUT_MS || 15000,
);
const MAX_CONCURRENT_STREAMS = Number(process.env.MAX_CONCURRENT_STREAMS || 40);
const MAX_CONCURRENT_STREAMS_PER_SESSION = Number(
  process.env.MAX_CONCURRENT_STREAMS_PER_SESSION || 10,
);
const METADATA_CACHE_TTL_MS = Number(
  process.env.METADATA_CACHE_TTL_MS || 10 * 60 * 1000,
);
const MAX_METADATA_CACHE_ENTRIES = Number(
  process.env.MAX_METADATA_CACHE_ENTRIES || 128,
);

let activeStreams = 0;

// Maps sessionId → Map<fileKey, count> for active streams.
// This allows multiplexing multiple range requests for the same file.
const sessionActiveFiles = new Map<string, Map<string, number>>();

app.use(cors());

type MetadataEntry = {
  meta: any;
  lastAccess: number;
};

type GoStatusResponse = {
  infoHash: string;
  name: string;
  progress: number;
  total: number;
  downloaded: number;
  uploaded: number;
  downSpeed: number;
  upSpeed: number;
  peers: number;
  ready: boolean;
  pieces: number;
  pieceSize: number;
};

type GoAddFile = {
  name: string;
  path: string;
  length: number;
  index: number;
};

type GoAddResponse = {
  infoHash: string;
  name: string;
  files: GoAddFile[];
};

type AttachmentItem = {
  filename: string;
  mimetype: string;
};

type ProxyMetricsResponse = {
  activeStreams: number;
  sessionActiveFilesSize: number;
  metadataCacheSize: number;
  limits: {
    maxConcurrentStreams: number;
    maxConcurrentStreamsPerSession: number;
    metadataCacheTtlMs: number;
    maxMetadataCacheEntries: number;
  };
  sessionStreams: Array<{ sessionId: string; activeStreams: number }>;
  updatedAt: string;
};

// Bounded cache to avoid unlimited parser growth over time.
const metadatamap = new Map<string, MetadataEntry>();

// Mock WebTorrent File for matroska-metadata
class MockWebTorrentFile extends EventEmitter {
  name: string;
  sessionId: string;
  hash: string;
  fileId: string;

  constructor(sessionId: string, hash: string, fileId: string) {
    super();
    this.name = `file_${fileId}.mkv`;
    this.sessionId = sessionId;
    this.hash = hash;
    this.fileId = fileId;
  }

  async *[Symbol.asyncIterator](opts?: { start?: number; end?: number }) {
    const headers: Record<string, string> = {};
    if (opts?.start !== undefined) {
      const end = opts.end !== undefined ? opts.end : "";
      headers.range = `bytes=${opts.start}-${end}`;
    }

    const targetUrl = `${GO_BACKEND_URL}/stream/${this.hash}/${this.fileId}`;
    const res = await fetchWithTimeout(
      targetUrl,
      {
        headers: withSessionHeader(this.sessionId, headers),
      },
      BACKEND_TIMEOUT_MS,
    );

    if (!res.ok && res.status !== 206) {
      throw new Error(`Backend streaming returned ${res.status}`);
    }

    if (res.body) {
      yield* Readable.fromWeb(res.body as import("stream/web").ReadableStream);
    }
  }
}

// Helpers
function parseCookieValue(
  cookieHeader: string | undefined,
  key: string,
): string | null {
  if (!cookieHeader) return null;
  const items = cookieHeader.split(";");
  for (const item of items) {
    const [k, v] = item.trim().split("=");
    if (k === key && v) {
      return decodeURIComponent(v);
    }
  }
  return null;
}

function getSessionId(req: express.Request, res: express.Response): string {
  const fromHeader = req.header("x-session-id");
  if (fromHeader?.trim()) {
    return fromHeader.trim();
  }

  const fromCookie = parseCookieValue(req.header("cookie"), SESSION_COOKIE);
  if (fromCookie) {
    return fromCookie;
  }

  const generated = randomUUID();
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(generated)}; Path=/; HttpOnly; SameSite=Lax`,
  );
  return generated;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = BACKEND_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function withSessionHeader(
  sessionId: string,
  headers: HeadersInit = {},
): HeadersInit {
  const merged = new Headers(headers);
  merged.set("X-Session-Id", sessionId);
  return merged;
}

function pruneMetadataCache(now = Date.now()) {
  for (const [key, entry] of metadatamap.entries()) {
    if (now - entry.lastAccess > METADATA_CACHE_TTL_MS) {
      entry.meta.removeAllListeners?.();
      metadatamap.delete(key);
    }
  }

  while (metadatamap.size > MAX_METADATA_CACHE_ENTRIES) {
    const oldest = metadatamap.keys().next().value;
    if (!oldest) break;
    const entry = metadatamap.get(oldest);
    entry?.meta.removeAllListeners?.();
    metadatamap.delete(oldest);
  }
}

function getOrCreateMetadata(sessionId: string, hash: string, fileId: string) {
  pruneMetadataCache();
  const key = `${sessionId}-${hash}-${fileId}`;
  const existing = metadatamap.get(key);
  if (existing) {
    existing.lastAccess = Date.now();
    // Move to end for insertion-order LRU behavior.
    metadatamap.delete(key);
    metadatamap.set(key, existing);
    return existing.meta;
  }

  if (!metadatamap.has(key)) {
    const mockFile = new MockWebTorrentFile(sessionId, hash, fileId);
    const meta = new Metadata(mockFile as any);
    metadatamap.set(key, { meta, lastAccess: Date.now() });
    pruneMetadataCache();
  }
  return metadatamap.get(key)?.meta;
}

// ─── Native API Endpoints ──────────────────────────────────────────────────────

app.get("/health", (req, res) => res.send("OK"));

app.get("/version", (req, res) => {
  res.json({ version: "6.4.58" });
});

app.get("/device/info", (req, res) => {
  const cpus = os.cpus();
  const { model, speed } = cpus[0] || { model: "Unknown", speed: 0 };
  res.json({
    features: {
      gpu_0: {
        vendorId: 0,
        deviceId: 0,
        driverVendor: "Emulated",
        driverVersion: "1.0",
      },
    },
    cpu: { model, speed },
    ram: os.totalmem(),
  });
});

app.get("/protocol/status", (req, res) => {
  res.json({
    dht: true, // Offloaded to Go
    lsd: false,
    pex: true,
    nat: true,
    forwarding: false,
    persisting: true,
    streaming: true,
  });
});

app.get("/metrics", (_req, res) => {
  const sessionStreams = Array.from(sessionActiveFiles.entries())
    .map(([sessionId, filesMap]) => ({ sessionId, activeStreams: filesMap.size }))
    .sort((a, b) => b.activeStreams - a.activeStreams);

  const payload: ProxyMetricsResponse = {
    activeStreams,
    sessionActiveFilesSize: sessionActiveFiles.size,
    metadataCacheSize: metadatamap.size,
    limits: {
      maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
      maxConcurrentStreamsPerSession: MAX_CONCURRENT_STREAMS_PER_SESSION,
      metadataCacheTtlMs: METADATA_CACHE_TTL_MS,
      maxMetadataCacheEntries: MAX_METADATA_CACHE_ENTRIES,
    },
    sessionStreams,
    updatedAt: new Date().toISOString(),
  };

  res.json(payload);
});

// ─── CORS Proxy ────────────────────────────────────────────────────────────
app.use("/proxy", (req, res, next) => {
  const target = req.query.url;
  if (!target || typeof target !== "string") {
    return res
      .status(400)
      .send("No URL specified in the ?url= query parameter");
  }

  try {
    // Guard against malformed URL input to avoid undefined proxy behavior.
    const url = new URL(target);
    if (!["http:", "https:"].includes(url.protocol)) {
      return res.status(400).send("Only http/https proxy targets are allowed");
    }
  } catch {
    return res.status(400).send("Invalid proxy target URL");
  }

  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: () => "",
    router: () => target,
    on: {
      proxyReq: (proxyReq) => {
        proxyReq.setHeader("origin", "https://hayase.app");
        proxyReq.setHeader("referer", "https://hayase.app/");
        proxyReq.setHeader(
          "user-agent",
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) hayase/6.4.58 Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36",
        );
      },
      proxyRes: (proxyRes) => {
        proxyRes.headers["Access-Control-Allow-Origin"] = "*";
        proxyRes.headers["Access-Control-Allow-Methods"] =
          "GET, POST, PUT, DELETE, OPTIONS";
        proxyRes.headers["Access-Control-Allow-Headers"] =
          "X-Requested-With, content-type, Authorization";
      },
      error: (err, _req, proxyRes) => {
        console.error("Proxy Error:", err.message);
        (proxyRes as express.Response)
          .status(500)
          .send("Proxy Error: " + err.message);
      },
    },
  })(req, res, next);
});

// ─── WebTorrent API Endpoints Proxy ────────────────────────────────────────

app.get("/torrent/:hash/status", async (req, res) => {
  const { hash } = req.params;
  const sessionId = getSessionId(req, res);
  try {
    const response = await fetchWithTimeout(
      `${GO_BACKEND_URL}/status/${hash}`,
      {
        headers: withSessionHeader(sessionId),
      },
    );
    if (!response.ok)
      return res.status(response.status).send(await response.text());

    const goStatus = (await response.json()) as GoStatusResponse;

    res.json({
      name: goStatus.name,
      progress: goStatus.progress,
      size: {
        total: goStatus.total,
        downloaded: goStatus.downloaded,
        uploaded: goStatus.uploaded,
      },
      speed: {
        down: goStatus.downSpeed,
        up: goStatus.upSpeed,
      },
      time: {
        remaining: 0,
        elapsed: 0,
      },
      peers: {
        seeders: goStatus.peers,
        leechers: 0,
        wires: goStatus.peers,
      },
      pieces: {
        total: goStatus.pieces,
        size: goStatus.pieceSize,
      },
      hash: goStatus.infoHash,
      ready: goStatus.ready,
      paused: false,
      done: goStatus.progress === 1,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

app.get("/torrent/:hash", async (req, res) => {
  const { hash } = req.params;
  const sessionId = getSessionId(req, res);
  const magnetQuery = req.query.magnet || `magnet:?xt=urn:btih:${hash}`;

  try {
    // Forward the POST /add to Go service
    const response = await fetchWithTimeout(
      `${GO_BACKEND_URL}/add?magnet=${encodeURIComponent(String(magnetQuery))}`,
      {
        method: "POST",
        headers: withSessionHeader(sessionId),
      },
    );

    if (!response.ok)
      return res.status(response.status).send(await response.text());

    const goAddResponse = (await response.json()) as GoAddResponse;

    // Map Go's FileInfo to frontend's expected TorrentFile
    const mappedFiles = goAddResponse.files.map((file: GoAddFile) => {
      const ext = file.name.split(".").pop()?.toLowerCase();
      const mimeTypes: Record<string, string> = {
        mkv: "video/x-matroska",
        mp4: "video/mp4",
        webm: "video/webm",
        avi: "video/x-msvideo",
        mov: "video/quicktime",
        ass: "text/x-ass",
        srt: "text/srt",
        ssa: "text/x-ssa",
      };

      const streamUrl = `/api/stream/${goAddResponse.infoHash}/${file.index}`;

      return {
        name: file.name,
        hash: goAddResponse.infoHash,
        type: mimeTypes[ext ?? ""] || "application/octet-stream",
        size: file.length,
        path: file.path,
        url: streamUrl,
        lan: streamUrl,
        id: file.index,
      };
    });

    res.json(mappedFiles);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

app.delete("/torrent/:hash", async (req, res) => {
  const { hash } = req.params;
  const sessionId = getSessionId(req, res);
  try {
    const response = await fetchWithTimeout(
      `${GO_BACKEND_URL}/remove?hash=${encodeURIComponent(hash)}`,
      {
        method: "POST",
        headers: withSessionHeader(sessionId),
      },
    );
    if (!response.ok) {
      return res.status(response.status).send(await response.text());
    }
    return res.json(await response.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.delete("/torrent", async (req, res) => {
  const sessionId = getSessionId(req, res);
  try {
    const response = await fetchWithTimeout(`${GO_BACKEND_URL}/remove-all`, {
      method: "POST",
      headers: withSessionHeader(sessionId),
    });
    if (!response.ok) {
      return res.status(response.status).send(await response.text());
    }
    return res.json(await response.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

// ─── WebTorrent: Range-based video streaming ────────────────────────────────
app.get("/stream/:hash/:fileId", async (req, res) => {
  const sessionId = getSessionId(req, res);
  if (activeStreams >= MAX_CONCURRENT_STREAMS) {
    return res.status(503).json({ error: "stream capacity reached" });
  }

  const { hash, fileId } = req.params;
  const fileKey = `${hash}-${fileId}`;

  // Track active files per session with reference counting.
  // Modern browsers open multiple concurrent range requests for the same media file.
  let activeFiles = sessionActiveFiles.get(sessionId);
  if (!activeFiles) {
    activeFiles = new Map<string, number>();
    sessionActiveFiles.set(sessionId, activeFiles);
  }

  const isSameFile = activeFiles.has(fileKey);
  if (!isSameFile && activeFiles.size >= MAX_CONCURRENT_STREAMS_PER_SESSION) {
    return res.status(429).json({
      error: "session stream limit reached",
      limit: MAX_CONCURRENT_STREAMS_PER_SESSION,
    });
  }

  // Increment reference count for this file in the session.
  activeFiles.set(fileKey, (activeFiles.get(fileKey) ?? 0) + 1);

  activeStreams++;
  let cleaned = false;
  let nodeStream: Readable | null = null;
  let interceptedStream: Readable | null = null;
  const streamController = new AbortController();

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    activeStreams = Math.max(0, activeStreams - 1);

    const files = sessionActiveFiles.get(sessionId);
    if (files) {
      const count = files.get(fileKey) ?? 0;
      if (count <= 1) {
        files.delete(fileKey);
      } else {
        files.set(fileKey, count - 1);
      }
      if (files.size === 0) sessionActiveFiles.delete(sessionId);
    }

    streamController.abort();
    interceptedStream?.destroy();
    nodeStream?.destroy();
  };

  // Register cleanup immediately after incrementing counts to prevent leaks if requests abort early
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("finish", cleanup);

  try {
    const connectTimeout = setTimeout(
      () => streamController.abort(),
      STREAM_CONNECT_TIMEOUT_MS,
    );
    const fetchRes = await fetch(`${GO_BACKEND_URL}/stream/${hash}/${fileId}`, {
      headers: {
        range: String(req.headers.range || ""),
        "X-Session-Id": sessionId,
      },
      signal: streamController.signal,
    });
    clearTimeout(connectTimeout);

    if (!fetchRes.ok) {
      cleanup();
      return res.status(fetchRes.status).send(await fetchRes.text());
    }

    for (const [key, value] of fetchRes.headers.entries()) {
      res.setHeader(key, value);
    }

    res.status(fetchRes.status);

    if (!fetchRes.body) {
      cleanup();
      return res.end();
    }

    // Convert the web stream to a node stream
    nodeStream = Readable.fromWeb(
      fetchRes.body as import("stream/web").ReadableStream,
    );

    // Attach matroska parser transparently to the stream pipe for ALL streams
    // Create a fresh parser instance for each request to avoid state corruption
    // during parallel range requests, while delegating events to the shared meta.
    const meta = getOrCreateMetadata(sessionId, hash, fileId);
    const parser = new Metadata(new MockWebTorrentFile(sessionId, hash, fileId) as any);
    parser.on("subtitle", (s, t) => meta.emit("subtitle", s, t));

    // intercept stream bytes and push them through parser
    interceptedStream = Readable.from(parser.parseStream(nodeStream));

    // Pipe intercepted readable stream straight to the client
    interceptedStream.pipe(res);

    interceptedStream.on("end", cleanup);

    interceptedStream.on("error", (err) => {
      console.error("[stream intercept] error:", err.message);
      if (!res.headersSent) res.status(500).end();
      cleanup();
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[stream] fetch error:", message);
    if (!res.headersSent) res.status(500).end();
    cleanup();
  }
});

// ─── Native Bridges: Subtitles, Tracks & Attachments ─────────────────────────

app.get("/subtitles/:hash/:fileId", async (req, res) => {
  const { hash, fileId } = req.params;
  const sessionId = getSessionId(req, res);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  console.log(`[subtitles] SSE connection opened for ${hash}/${fileId}`);

  try {
    const meta = getOrCreateMetadata(sessionId, hash, fileId);

    const onSubtitle = (subtitle: unknown, trackNumber: number) => {
      res.write(
        `data: ${JSON.stringify({ sub: subtitle, track: trackNumber })}\n\n`,
      );
    };

    meta.on("subtitle", onSubtitle);

    req.on("close", () => {
      meta.off("subtitle", onSubtitle);
      console.log(`[subtitles] SSE connection closed for ${hash}/${fileId}`);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[subtitles] Error: ${message}`);
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  }
});

app.get("/tracks/:hash/:fileId", async (req, res) => {
  const { hash, fileId } = req.params;
  const sessionId = getSessionId(req, res);
  try {
    const meta = getOrCreateMetadata(sessionId, hash, fileId);
    const tracks = await meta.getTracks();
    res.json(tracks);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[tracks] Error: ${message}`);
    res.status(500).json({ error: message });
  }
});

app.get("/attachments/:hash/:fileId", async (req, res) => {
  const { hash, fileId } = req.params;
  const sessionId = getSessionId(req, res);
  const lan = "localhost";

  try {
    const meta = getOrCreateMetadata(sessionId, hash, fileId);
    const attachments = (await meta.getAttachments()) as AttachmentItem[];

    const formatted = attachments.map(
      ({ filename, mimetype }: AttachmentItem, index: number) => {
        const suffix = `:${PORT}/${hash}${fileId}/${index}`;
        return {
          filename,
          mimetype,
          id: parseInt(fileId),
          url: `http://localhost${suffix}`,
          lan: `http://${lan}${suffix}`,
        };
      },
    );

    res.json(formatted);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[attachments] Error: ${message}`);
    res.status(500).json({ error: message });
  }
});

// ─── Start Server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(
    `Backend CORS proxy + Streaming service Proxy running on port ${PORT}`,
  );
});
