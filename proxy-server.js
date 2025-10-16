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

// ✅ Print allowed origins on startup
console.log('✅ Allowed Origins:', allowedOrigins);

// ✅ Dynamic CORS setup with clear logging
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      console.log('🌐 Non-browser request allowed');
      return callback(null, true);
    }
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
>>>>>>> parent of fda5475 (fix: Server only handles playlists + subtitles → minimal load.)
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
      const text = await upstream.text().catch(() => '');
      console.error(`❌ Upstream fetch failed [${upstream.status}] for ${targetUrl}`);
      return res.status(upstream.status).send(text || 'Upstream error');
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


<<<<<<< HEAD
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
  console.log(`📺 Stream proxy: http://localhost:${PORT}/stream?url=<URL>&referer=<REFERER>`);
  console.log(`🔧 Health check: http://localhost:${PORT}/health`);
=======
// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on http://localhost:${PORT}`);
  console.log(`📺 Stream proxy available at: http://localhost:${PORT}/stream?url=<STREAM_URL>&referer=<REFERER_URL>`);
  console.log(`🔧 Health check: http://localhost:${PORT}/health`);
});
