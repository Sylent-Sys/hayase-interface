import express from 'express';
import cors from 'cors';
import os from 'node:os';
import { createProxyMiddleware } from 'http-proxy-middleware';
import Metadata from 'matroska-metadata';
import EventEmitter from 'node:events';
import { Readable } from 'node:stream';

// ─── Critical Error Handling ────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
const GO_BACKEND_URL = process.env.GO_BACKEND_URL || 'http://localhost:5000';

app.use(cors());

// Map to uniquely store metadata parsers for specific hash and fileId combinations
const metadatamap = new Map();

// Mock WebTorrent File for matroska-metadata
class MockWebTorrentFile extends EventEmitter {
  name: string;
  hash: string;
  fileId: string;

  constructor(hash: string, fileId: string) {
    super();
    this.name = `file_${fileId}.mkv`;
    this.hash = hash;
    this.fileId = fileId;
  }

  async *[Symbol.asyncIterator](opts?: { start?: number; end?: number }) {
    const headers: Record<string, string> = {};
    if (opts?.start !== undefined) {
      const end = opts.end !== undefined ? opts.end : '';
      headers.range = `bytes=${opts.start}-${end}`;
    }

    const targetUrl = `${GO_BACKEND_URL}/stream/${this.hash}/${this.fileId}`;
    const res = await fetch(targetUrl, { headers });
    
    if (!res.ok && res.status !== 206) {
      throw new Error(`Backend streaming returned ${res.status}`);
    }

    if (res.body) {
      yield* Readable.fromWeb(res.body as import('stream/web').ReadableStream);
    }
  }
}

// Helpers
function getOrCreateMetadata(hash: string, fileId: string) {
  const key = `${hash}-${fileId}`;
  if (!metadatamap.has(key)) {
    const mockFile = new MockWebTorrentFile(hash, fileId);
    const meta = new Metadata(mockFile as any);
    metadatamap.set(key, meta);
  }
  return metadatamap.get(key);
}

// ─── Native API Endpoints ──────────────────────────────────────────────────────

app.get('/health', (req, res) => res.send('OK'));

app.get('/version', (req, res) => {
  res.json({ version: '6.4.58' });
});

app.get('/device/info', (req, res) => {
  const cpus = os.cpus();
  const { model, speed } = cpus[0] || { model: 'Unknown', speed: 0 };
  res.json({
    features: {
      gpu_0: {
        vendorId: 0,
        deviceId: 0,
        driverVendor: 'Emulated',
        driverVersion: '1.0'
      }
    },
    cpu: { model, speed },
    ram: os.totalmem()
  });
});

app.get('/protocol/status', (req, res) => {
  res.json({
    dht: true, // Offloaded to Go
    lsd: false,
    pex: true,
    nat: true,
    forwarding: false,
    persisting: true,
    streaming: true
  });
});

// ─── CORS Proxy ────────────────────────────────────────────────────────────
app.use('/proxy', (req, res, next) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).send('No URL specified in the ?url= query parameter');
  }

  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: () => '',
    router: () => target,
    on: {
      proxyReq: (proxyReq) => {
        proxyReq.setHeader('origin', 'https://hayase.app');
        proxyReq.setHeader('referer', 'https://hayase.app/');
        proxyReq.setHeader('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) hayase/6.4.58 Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36');
      },
      proxyRes: (proxyRes) => {
        proxyRes.headers['Access-Control-Allow-Origin'] = '*';
        proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
        proxyRes.headers['Access-Control-Allow-Headers'] = 'X-Requested-With, content-type, Authorization';
      },
      error: (err, req, res) => {
        console.error('Proxy Error:', err.message);
        res.status(500).send('Proxy Error: ' + err.message);
      }
    }
  })(req, res, next);
});

// ─── WebTorrent API Endpoints Proxy ────────────────────────────────────────

app.get('/torrent/:hash/status', async (req, res) => {
  const { hash } = req.params;
  try {
    const response = await fetch(`${GO_BACKEND_URL}/status/${hash}`);
    if (!response.ok) return res.status(response.status).send(await response.text());
    
    const goStatus = await response.json();
    
    res.json({
      name: goStatus.name,
      progress: goStatus.progress,
      size: {
        total: goStatus.total,
        downloaded: goStatus.downloaded,
        uploaded: goStatus.uploaded
      },
      speed: {
        down: goStatus.downSpeed,
        up: goStatus.upSpeed
      },
      time: {
        remaining: 0,
        elapsed: 0 
      },
      peers: {
        seeders: goStatus.peers,
        leechers: 0,
        wires: goStatus.peers
      },
      pieces: {
        total: goStatus.pieces,
        size: goStatus.pieceSize
      },
      hash: goStatus.infoHash,
      ready: goStatus.ready,
      paused: false,
      done: goStatus.progress === 1
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/torrent/:hash', async (req, res) => {
  const { hash } = req.params;
  const magnetQuery = req.query.magnet || `magnet:?xt=urn:btih:${hash}`;
  
  try {
    // Forward the POST /add to Go service
    const response = await fetch(`${GO_BACKEND_URL}/add?magnet=${encodeURIComponent(magnetQuery)}`, {
      method: 'POST'
    });
    
    if (!response.ok) return res.status(response.status).send(await response.text());
    
    const goAddResponse = await response.json();
    
    // Map Go's FileInfo to frontend's expected TorrentFile
    const mappedFiles = goAddResponse.files.map((file) => {
      const ext = file.name.split('.').pop()?.toLowerCase();
      const mimeTypes = {
        mkv: 'video/x-matroska',
        mp4: 'video/mp4',
        webm: 'video/webm',
        avi: 'video/x-msvideo',
        mov: 'video/quicktime',
        ass: 'text/x-ass',
        srt: 'text/srt',
        ssa: 'text/x-ssa',
      };
      
      const streamUrl = `/api/stream/${goAddResponse.infoHash}/${file.index}`;
      
      return {
        name: file.name,
        hash: goAddResponse.infoHash,
        type: mimeTypes[ext] || 'application/octet-stream',
        size: file.length,
        path: file.path,
        url: streamUrl,
        lan: streamUrl,
        id: file.index,
      };
    });

    res.json(mappedFiles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WebTorrent: Range-based video streaming ────────────────────────────────
app.get('/stream/:hash/:fileId', async (req, res) => {
  const { hash, fileId } = req.params;
  
  try {
    const fetchRes = await fetch(`${GO_BACKEND_URL}/stream/${hash}/${fileId}`, {
      headers: {
        range: req.headers.range || ''
      }
    });

    if (!fetchRes.ok) {
      return res.status(fetchRes.status).send(await fetchRes.text());
    }

    for (const [key, value] of fetchRes.headers.entries()) {
      res.setHeader(key, value);
    }
    
    res.status(fetchRes.status);
    
    if (!fetchRes.body) {
      return res.end();
    }

    // Convert the web stream to a node stream
    const nodeStream = Readable.fromWeb(fetchRes.body);

    // Identify if the request asks for specific parts. Subtitles parsing is most robust
    // when streaming from the beginning since MKV stores attachments heavily in headers/blocks.
    let isFullStream = !req.headers.range || req.headers.range === 'bytes=0-';
    
    if (isFullStream) {
       // Attach matroska parser transparently to the stream pipe
       const meta = getOrCreateMetadata(hash, fileId);
       
       // intercept stream bytes and push them through parser
       // `meta.parseStream` requires AsyncIterable and returns AsyncIterable.
       const interceptedStream = Readable.from(meta.parseStream(nodeStream));
       
       // Pipe intercepted readable stream straight to the client
       interceptedStream.pipe(res);
       
       interceptedStream.on('error', (err) => {
          console.error('[stream intercept] error:', err.message);
          res.end();
       });
    } else {
       // If it's a seek operation, don't pass through matroska-metadata since it breaks the parser state
       nodeStream.pipe(res);
       nodeStream.on('error', (err) => {
          console.error('[stream proxy] error:', err.message);
          res.end();
       });
    }

  } catch (err) {
    console.error('[stream] fetch error:', err.message);
    if (!res.headersSent) res.status(500).end();
  }
});

// ─── Native Bridges: Subtitles, Tracks & Attachments ─────────────────────────

app.get('/subtitles/:hash/:fileId', async (req, res) => {
  const { hash, fileId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  console.log(`[subtitles] SSE connection opened for ${hash}/${fileId}`);

  try {
    const meta = getOrCreateMetadata(hash, fileId);
    
    // Clear previous connection listeners (only 1 active connection allowed per file generally)
    meta.removeAllListeners('subtitle');
    
    meta.on('subtitle', (subtitle, trackNumber) => {
      res.write(`data: ${JSON.stringify({ sub: subtitle, track: trackNumber })}\n\n`);
    });
  } catch (err) {
    console.error(`[subtitles] Error: ${err.message}`);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }

  req.on('close', () => {
    console.log(`[subtitles] SSE connection closed for ${hash}/${fileId}`);
  });
});

app.get('/tracks/:hash/:fileId', async (req, res) => {
  const { hash, fileId } = req.params;
  try {
    const meta = getOrCreateMetadata(hash, fileId);
    const tracks = await meta.getTracks();
    res.json(tracks);
  } catch (err) {
    console.error(`[tracks] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/attachments/:hash/:fileId', async (req, res) => {
  const { hash, fileId } = req.params;
  const lan = "localhost";
  
  try {
    const meta = getOrCreateMetadata(hash, fileId);
    const attachments = await meta.getAttachments();
    
    const formatted = attachments.map(({ filename, mimetype }, number) => {
      const suffix = `:${PORT}/${hash}${fileId}/${number}`;
      return { filename, mimetype, id: parseInt(fileId), url: `http://localhost${suffix}`, lan: `http://${lan}${suffix}` };
    });
    
    res.json(formatted);
  } catch (err) {
    console.error(`[attachments] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ────────────────────────────────────────────────────────────
const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Backend CORS proxy + Streaming service Proxy running on port ${PORT}`);
});
process.setMaxListeners(0);