import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import WebTorrent from 'webtorrent';

const app = express();

// Single shared WebTorrent client instance for server lifetime
const wtClient = new WebTorrent();
wtClient.setMaxListeners(100); // Prevent MaxListenersExceededWarning

// Popular anime torrent trackers for fast peer discovery... (keep previous list)
const ANIME_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'udp://open.tracker.cl:1337',
  'udp://opentracker.i2p.rocks:6969',
  'udp://tracker.opentrackr.org:1337',
  'http://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969',
  'udp://nyaa.tracker.wf:7777',
  'http://nyaa.tracker.wf:7777/announce',
  'udp://tracker-udp.gbitt.info:80',
  'http://tracker.gbitt.info/announce',
];

app.use(cors());

app.get('/health', (req, res) => res.send('OK'));

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
app.get('/torrent/:hash', (req, res) => {
  const { hash } = req.params;
  const infoHash = hash.toLowerCase();
  const magnetQuery = req.query.magnet;

  // 1. Start with either the provided magnet or a fallback
  let magnet = magnetQuery || `magnet:?xt=urn:btih:${infoHash}`;

  // 2. Inject/Merge internal ANIME_TRACKERS specifically for fast peer discovery
  // We add them even if a magnet was provided to ensure we have the best anime-focused trackers
  ANIME_TRACKERS.forEach(tracker => {
    if (!magnet.includes(encodeURIComponent(tracker))) {
      magnet += `&tr=${encodeURIComponent(tracker)}`;
    }
  });

  console.log(`[torrent] Loading metadata for ${infoHash}${magnetQuery ? ' (from extension magnet)' : ''}`);

  // Respond once metadata+files are available
  const respond = (torrent) => {
    if (res.headersSent) return;
    clearTimeout(timer);
    console.log(`[torrent] Metadata ready: ${torrent.name} (${torrent.files?.length ?? 0} files)`);
    res.json(buildFileList(torrent));
  };

  // Hard timeout
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      console.error(`[torrent] Metadata timeout for ${infoHash}`);
      res.status(504).json({ error: 'Metadata fetch timed out. Torrent may be dead or have no seeders.' });
    }
  }, 60_000);

  const existing = wtClient.get(infoHash);
  if (existing && existing.files && existing.files.length > 0) {
    return respond(existing);
  }

  wtClient.add(magnet, { announce: ANIME_TRACKERS }, (torrent) => {
    respond(torrent);
  });
});

// ─── WebTorrent: Range-based video streaming ────────────────────────────────
// GET /stream/:hash/:fileId
// Streams the selected file bytes as an HTTP Partial Content response so the
// browser <video> player can seek forward/backward without re-downloading.
app.get('/stream/:hash/:fileId', (req, res) => {
  const { hash, fileId } = req.params;
  const infoHash = hash.toLowerCase();
  const fileIndex = parseInt(fileId, 10);

  const torrent = wtClient.get(infoHash);
  if (!torrent) {
    return res.status(404).json({ error: 'Torrent not loaded. Call /torrent/:hash first.' });
  }

  const file = torrent.files[fileIndex];
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
    // No range — full download
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
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
/**
 * Converts a WebTorrent torrent object into an array of TorrentFile objects
 * whose shape matches the native.ts `TorrentFile` interface expected by the
 * Svelte UI (name, hash, type, size, path, url, lan, id).
 */
function buildFileList(torrent) {
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
