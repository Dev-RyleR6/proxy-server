const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3001;

// Cache directory
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Allowed origins
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000'];

console.log('✅ Allowed Origins:', allowedOrigins);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // Non-browser requests
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.get('/health', (req, res) => res.json({ status: 'OK' }));

// Helper to get cache file path
const getCachePath = (url) => path.join(CACHE_DIR, encodeURIComponent(url));

// Stream / Subtitles / Images Proxy with segment caching
app.get('/stream', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer;

  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

  let urlObj;
  try { urlObj = new URL(String(targetUrl)); } 
  catch (e) { return res.status(400).json({ error: 'Invalid URL', message: e.message }); }

  if (urlObj.protocol === 'http:') urlObj.protocol = 'https:';

  try {
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
    if (referer) headers['Referer'] = referer;

    const cacheFile = getCachePath(urlObj.toString());

    // Serve from cache if exists
    if (fs.existsSync(cacheFile)) {
      const cached = fs.readFileSync(cacheFile);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=60'); // cached
      const contentType = path.extname(urlObj.pathname).includes('.m3u8')
        ? 'application/vnd.apple.mpegurl'
        : urlObj.pathname.endsWith('.vtt')
          ? 'text/vtt'
          : 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      return res.send(cached);
    }

    const upstream = await fetch(urlObj.toString(), { headers });
    if (!upstream.ok) return res.status(upstream.status).send(await upstream.text());

    const contentType = upstream.headers.get('content-type') || '';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=60');

    // HLS Playlist
    if (contentType.includes('application/vnd.apple.mpegurl') || urlObj.pathname.endsWith('.m3u8')) {
      const text = await upstream.text();
      const origin = `${req.protocol}://${req.get('host')}`;

      const rewritten = text.split('\n').map(line => {
        const l = line.trim();
        if (!l || l.startsWith('#')) return line;

        try {
          const segmentUrl = new URL(l, urlObj);
          if (segmentUrl.protocol === 'http:') segmentUrl.protocol = 'https:';
          const sp = new URLSearchParams({ url: segmentUrl.toString() });
          if (referer) sp.set('referer', referer);
          return `${origin}/stream?${sp.toString()}`;
        } catch { return line; }
      }).join('\n');

      // Cache playlist
      fs.writeFileSync(cacheFile, rewritten, 'utf8');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    // Subtitles / Images / Other content
    const buf = Buffer.from(await upstream.arrayBuffer());
    fs.writeFileSync(cacheFile, buf);
    if (urlObj.pathname.endsWith('.vtt')) res.setHeader('Content-Type', 'text/vtt');
    else if (/\.(jpg|jpeg|png|webp|gif)$/i.test(urlObj.pathname)) res.setHeader('Content-Type', contentType || 'image/*');
    else res.setHeader('Content-Type', contentType || 'application/octet-stream');

    return res.send(buf);

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Proxy error', message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
  console.log(`📺 Stream proxy at: http://localhost:${PORT}/stream?url=<URL>&referer=<REFERER>`);
});
