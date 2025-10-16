const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ✅ Load allowed origins from .env (comma-separated)
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000'];

// ✅ Dynamic CORS setup
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // Allow non-browser requests
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      console.warn(`❌ CORS Blocked: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// ✅ Middleware
app.use(express.json());

// ✅ Health check route
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Proxy server is running' });
});

// ✅ Basic passthrough (optional)
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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': referer || 'https://megacloud.blog/',
      'Origin': 'https://megacloud.blog',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site'
    };

    if (referer) headers['Referer'] = String(referer);

    const upstream = await fetch(urlObj.toString(), { headers });
    if (!upstream.ok) {
      return res.status(upstream.status).send(await upstream.text());
    }

    // Set safe CORS headers for the response
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Referer, User-Agent');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

    const contentType = upstream.headers.get('content-type') || '';
    const isPlaylist = contentType.includes('application/vnd.apple.mpegurl')
      || contentType.includes('application/x-mpegURL')
      || urlObj.pathname.endsWith('.m3u8');

    if (isPlaylist) {
      const text = await upstream.text();
      const origin = `${req.protocol}://${req.get('host')}`;
      const base = urlObj;
      const rewritten = text.split('\n').map((line) => {
        const l = line.trim();
        if (!l || l.startsWith('#')) return line;
        let resolved;
        try { resolved = new URL(l, base).toString(); } catch { return line; }
        const sp = new URLSearchParams({ url: resolved });
        if (referer) sp.set('referer', String(referer));
        return `${origin}/stream?${sp.toString()}`;
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    console.error('Stream proxy error:', err);
    return res.status(500).json({ error: 'Stream proxy error', message: String(err?.message || err) });
  }
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on http://localhost:${PORT}`);
  console.log(`📺 Stream proxy available at: http://localhost:${PORT}/stream?url=<STREAM_URL>&referer=<REFERER_URL>`);
  console.log(`🔧 Health check: http://localhost:${PORT}/health`);
});
