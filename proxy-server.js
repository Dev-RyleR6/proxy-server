const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ✅ Load allowed origins from .env
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'https://localhost:5173'];

// ✅ Log allowed origins
console.log('✅ Allowed Origins:', allowedOrigins);

// ✅ Dynamic CORS setup
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // Allow curl/postman
    if (allowedOrigins.includes(origin)) {
      console.log(`✅ CORS allowed: ${origin}`);
      return callback(null, true);
    } else {
      console.warn(`🚫 CORS blocked: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use(express.json());

// ✅ Force HTTPS redirect when deployed on Railway
app.enable('trust proxy');
app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] !== 'https' && process.env.NODE_ENV === 'production') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});

// ✅ Health check route
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Proxy server is running' });
});

// ✅ Optional passthrough proxy
app.use('/proxy', createProxyMiddleware({
  target: 'https://example.com',
  changeOrigin: true,
}));

// ✅ Main HLS / stream proxy
app.get('/stream', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer;

  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

  let urlObj;
  try {
    urlObj = new URL(String(targetUrl));
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL', message: String(e?.message || e) });
  }

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive',
    };
    if (referer) headers['Referer'] = String(referer);

    const upstream = await fetch(urlObj.toString(), { headers });

    if (!upstream.ok) {
      return res.status(upstream.status).send(await upstream.text());
    }

    // ✅ Always respond with secure headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Referer, User-Agent');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

    const contentType = upstream.headers.get('content-type') || '';
    const isPlaylist = contentType.includes('application/vnd.apple.mpegurl')
      || contentType.includes('application/x-mpegURL')
      || urlObj.pathname.endsWith('.m3u8');

    // ✅ Handle M3U8 rewriting securely
    if (isPlaylist) {
      let text = await upstream.text();

      // Convert all HTTP → HTTPS (very important)
      text = text.replace(/http:\/\//g, 'https://');

      // Rewrite relative URLs into absolute proxied HTTPS URLs
      const origin = `https://${req.get('host')}`;
      const base = urlObj;
      const rewritten = text.split('\n').map(line => {
        const l = line.trim();
        if (!l || l.startsWith('#')) return line;
        try {
          const resolved = new URL(l, base).toString();
          const sp = new URLSearchParams({ url: resolved });
          if (referer) sp.set('referer', String(referer));
          return `${origin}/stream?${sp.toString()}`;
        } catch {
          return line;
        }
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    // ✅ For segments / binary data
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);

  } catch (err) {
    console.error('❌ Stream proxy error:', err);
    return res.status(500).json({ error: 'Stream proxy error', message: String(err?.message || err) });
  }
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
  console.log(`📺 Stream proxy: https://your-railway-app.up.railway.app/stream?url=<URL>&referer=<REFERER>`);
  console.log(`🔧 Health check: https://your-railway-app.up.railway.app/health`);
});
