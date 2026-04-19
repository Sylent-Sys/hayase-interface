import express from 'express';
import cors from 'cors';
import os from 'node:os';

import { createProxyMiddleware } from 'http-proxy-middleware';
import TorrentClient from 'torrent-client';
import { statSync } from 'node:fs';
import { join } from 'node:path';

// ─── Critical Error Handling ────────────────────────────────────────────────
// Catch errors that would normally crash the process to keep the server alive
// and provide detailed logs for debugging.
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
const app = express();


let TMP;
try {
  TMP = join(statSync('/tmp') && '/tmp', 'webtorrent');
} catch (err) {
  TMP = join(os.tmpdir(), 'webtorrent');
}

// Single shared TorrentClient instance for server lifetime
const tclient = new TorrentClient({
  torrentPort: 6881,
  dhtPort: 6882,
}, TMP);

const wtClient = tclient.client;

// Prevent backend crash on WebTorrent errors
wtClient.on('error', (err) => {
  console.error('[webtorrent] Global error:', err.message);
});

wtClient.setMaxListeners(100); // Prevent MaxListenersExceededWarning

// Local map to track ongoing metadata fetches to prevent "Cannot add duplicate torrent" crashes
const ongoingMetadatas = new Map();

// Local map to track torrent metadata like added time
const torrentMetadata = new Map();


// High-performance public anime and general trackers for rapid peer discovery
const ANIME_TRACKERS = [
  // Anime specific
  'udp://nyaa.tracker.wf:7777/announce',
  'udp://anidex.moe:6969/announce',
  'udp://tracker.animereactor.com:80/announce',
  
  // High performance general trackers
  'udp://open.tracker.cl:1337/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://ipv4.tracker.harry.lu:80/announce',
  'udp://valakas.cyberia.is:6969/announce',
  'udp://9.rarbg.me:2970/announce',
  'udp://9.rarbg.to:2900/announce',
  
  // WebTorrent specific (Websocket)
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce',
  'wss://tracker.webtorrent.dev',
];

app.use(cors());

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
    dht: !!wtClient.dht,
    lsd: false,
    pex: true,
    nat: true,
    forwarding: false,
    persisting: true,
    streaming: true
  });
});

app.get('/protocol/status', (req, res) => {
  res.json({
    dht: !!wtClient.dht,
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

// ─── WebTorrent: Load torrent & list files ──────────────────────────────────
// GET /torrent/:hash
// Adds a magnet link (with anime trackers) and waits for metadata, then returns
// a TorrentFile[] array compatible with the native.ts TorrentFile type.
app.get('/torrent/:hash/status', async (req, res) => {
  const { hash } = req.params;
  const infoHash = hash.toLowerCase();
  
  const torrent = await wtClient.get(infoHash);
  if (!torrent) {
    return res.status(404).json({ error: 'Torrent not found' });
  }

  res.json({
    name: torrent.name,
    progress: torrent.progress,
    size: {
      total: torrent.length,
      downloaded: torrent.downloaded,
      uploaded: torrent.uploaded
    },
    speed: {
      down: torrent.downloadSpeed,
      up: torrent.uploadSpeed
    },
    time: {
      remaining: torrent.timeRemaining,
      elapsed: torrentMetadata.has(infoHash) ? Date.now() - torrentMetadata.get(infoHash).added : 0
    },

    peers: {
      seeders: torrent.numPeers, // Use connected peers count for seeder display
      leechers: 0,
      wires: torrent.numPeers
    },
    pieces: {
      total: torrent.pieces ? torrent.pieces.length : 0,
      size: torrent.pieceLength
    },
    hash: torrent.infoHash,
    ready: torrent.ready,
    paused: torrent.paused,
    done: torrent.done
  });
});

app.get('/torrent/:hash', (req, res) => {
  const { hash } = req.params;
  const infoHash = hash.toLowerCase();
  const magnetQuery = req.query.magnet;

  // 1. Double check ready status
  // 1. Double check ready status
  const existing = wtClient.get(infoHash);
  if (existing && existing.ready && existing.files && existing.files.length > 0) {
    console.log(`[torrent] Returning cached metadata for ${infoHash}`);
    return res.json(buildFileList(existing));
  }

  // If already fetching, join the existing promise
  const ongoing = ongoingMetadatas.get(infoHash);
  if (ongoing) {
    console.log(`[torrent] Joining ongoing fetch for ${infoHash}`);
    return ongoing
      .then(files => res.json(files))
      .catch(err => {
        if (!res.headersSent) res.status(504).json({ error: err.message });
      });
  }

  // 2. Atomic Queue Check - prevents double add() calls
  if (ongoingMetadatas.has(infoHash)) {
    console.log(`[torrent] Request joined existing metadata fetch for ${infoHash}`);
    ongoingMetadatas.get(infoHash)
      .then(files => res.json(files))
      .catch(err => {
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });
    return;
  }

  console.log(`[torrent] Starting metadata fetch for ${infoHash}`);

  // 3. Build magnet URI
  let magnet = magnetQuery || `magnet:?xt=urn:btih:${infoHash}`;
  ANIME_TRACKERS.forEach(t => {
    if (!magnet.includes(encodeURIComponent(t))) magnet += `&tr=${encodeURIComponent(t)}`;
  });

  // 4. Create and store Promise
  const metadataPromise = new Promise((resolve, reject) => {
    let timeoutId;
    
    const cleanup = () => {
      clearTimeout(timeoutId);
      ongoingMetadatas.delete(infoHash);
    };

    // Hard timeout for this specific fetch
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Metadata fetch timed out. No peers found or trackers unreachable.'));
    }, 60_000);

    try {
      wtClient.add(magnet, { announce: ANIME_TRACKERS }, (torrent) => {
        console.log(`[torrent] Metadata found for ${torrent.name}! Peers: ${torrent.numPeers}. Files found: ${torrent.files ? torrent.files.length : 0}`);
        
        // Final safety check: ensure files array is actually populated
        if (!torrent.files || torrent.files.length === 0) {
          console.error(`[torrent] ERROR: Callback fired but files array is empty for ${infoHash}`);
        }

        cleanup();
        torrentMetadata.set(infoHash, { added: Date.now() });
        resolve(buildFileList(torrent));
      });

    } catch (err) {
      cleanup();
      reject(err);
    }
  });

  ongoingMetadatas.set(infoHash, metadataPromise);

  metadataPromise
    .then(files => res.json(files))
    .catch(err => {
      console.error(`[torrent] Hub error for ${infoHash}: ${err.message}`);
      if (!res.headersSent) res.status(504).json({ error: err.message });
    });
});

// ─── WebTorrent: Range-based video streaming ────────────────────────────────
// GET /stream/:hash/:fileId
// Streams the selected file bytes as an HTTP Partial Content response so the
// browser <video> player can seek forward/backward without re-downloading.
app.get('/stream/:hash/:fileId', async (req, res) => {
  const { hash, fileId } = req.params;
  const infoHash = hash.toLowerCase();
  const fileIndex = parseInt(fileId, 10);

  // In WebTorrent v2, .get() returns a Promise
  const torrent = await wtClient.get(infoHash);
  
  if (!torrent) {
    return res.status(404).json({ error: 'Torrent not found. Load it via /torrent/:hash first.' });
  }

  // Define the streaming logic as a helper to call once ready
  const startStream = (t) => {
    const file = t.files[fileIndex];
    if (!file) {
      return res.status(404).json({ error: `File index ${fileIndex} not found in torrent.` });
    }

    const fileSize = file.length;
    const rangeHeader = req.headers.range;

    // Detect MIME type from extension
    const ext = file.name.split('.').pop()?.toLowerCase();
    const mimeTypes = {
      mkv: 'video/x-matroska',
      mp4: 'video/mp4',
      webm: 'video/webm',
      avi: 'video/x-msvideo',
      mov: 'video/quicktime',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });

      const stream = file.createReadStream({ start, end });
      stream.pipe(res);
      stream.on('error', (err) => {
        console.error('[stream] Stream error:', err.message);
        if (!res.headersSent) res.status(500).end();
      });
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      });
      const stream = file.createReadStream();
      stream.pipe(res);
      stream.on('error', (err) => {
        console.error('[stream] Stream error:', err.message);
        if (!res.headersSent) res.status(500).end();
      });
    }
  };

  // If already ready, start immediately
  if (torrent.ready && torrent.files && torrent.files.length > 0) {
    return startStream(torrent);
  }

  // Otherwise, wait for metadata (with a timeout)
  console.log(`[stream] ${infoHash} metadata not ready yet. Waiting...`);
  
  let isDone = false;
  const timeoutId = setTimeout(() => {
    if (isDone) return;
    isDone = true;
    console.error(`[stream] Timeout waiting for metadata: ${infoHash}`);
    if (!res.headersSent) res.status(504).json({ error: 'Timeout waiting for torrent metadata.' });
  }, 30000); // 30s timeout

  torrent.once('ready', () => {
    if (isDone) return;
    isDone = true;
    clearTimeout(timeoutId);
    console.log(`[stream] Metadata finally ready for ${infoHash}! Starting stream.`);
    startStream(torrent);
  });
});

// ─── Native Bridges: Subtitles, Tracks & Attachments ─────────────────────────

// GET /tracks/:hash/:fileId
app.get('/tracks/:hash/:fileId', async (req, res) => {
  const { hash, fileId } = req.params;
  try {
    const tracks = await tclient.tracks(hash, parseInt(fileId, 10));
    res.json(tracks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /subtitles/:hash/:fileId
app.get('/subtitles/:hash/:fileId', async (req, res) => {
  const { hash, fileId } = req.params;
  try {
    const subtitles = [];
    await tclient.subtitles(hash, parseInt(fileId, 10), (sub, track) => {
      subtitles.push({ sub, track });
    });
    res.json(subtitles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /attachments/:hash/:fileId
app.get('/attachments/:hash/:fileId', async (req, res) => {
  const { hash, fileId } = req.params;
  try {
    const attachments = await tclient.attachments(hash, parseInt(fileId, 10));
    res.json(attachments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
/**
 * Converts a WebTorrent torrent object into an array of TorrentFile objects
 * whose shape matches the native.ts `TorrentFile` interface expected by the
 * Svelte UI (name, hash, type, size, path, url, lan, id).
 */
function buildFileList(torrent) {
  if (!torrent || !torrent.files) return [];
  return torrent.files.map((file, index) => {
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
    const type = mimeTypes[ext] || 'application/octet-stream';
    const streamUrl = `/api/stream/${torrent.infoHash}/${index}`;

    return {
      name: file.name,
      hash: torrent.infoHash,
      type,
      size: file.length,
      path: file.path,
      url: streamUrl,
      lan: streamUrl,
      id: index,
    };
  });
}

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Backend CORS Proxy + WebTorrent Streaming running on port ${PORT}`);
});
process.setMaxListeners(0);