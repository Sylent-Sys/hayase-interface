import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();

app.use(cors());

app.get('/health', (req, res) => res.send('OK'));

app.use('/proxy', (req, res, next) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).send('No URL specified in the ?url= query parameter');
  }

  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: () => '', // removes the current proxy path before forwarding
    router: () => target, // target the exact URL
    on: {
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

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Backend CORS Proxy running on port ${PORT}`);
});
