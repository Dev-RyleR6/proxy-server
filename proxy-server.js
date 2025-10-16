const express = require('express');
const cors = require('cors');
require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3001;

// Allowed origins (browser requests)
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

// Stream / Subtitles / Images Proxy
app.get('/stream', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer;

  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

  let urlObj;
  try { urlObj = new URL(String(targetUrl)); } 
  catch (e) { return res.status(400).json({ error: 'Invalid URL', message: e.message }); }

  // Force HTTPS on the target URL
  if (urlObj.protocol === 'http:') urlObj.protocol = 'https:';

  try {
    const headers = { 
      'User-Agent': 'Mozilla/5.0',
      'Accept': '*/*'
    };
    if (referer) headers['Referer'] = referer;

    const upstream = await fetch(urlObj.toString(), { headers });
    if (!upstream.ok) return res.status(upstream.status).send(await upstream.text());

    const contentType = upstream.headers.get('content-type') || '';
    res.setHeader('Access-Control-Allow-Origin', '*'); // CORS
    res.setHeader('Cache-Control', 'public, max-age=30'); // Cache for 30s

    // HLS Playlist (.m3u8)
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

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    // Subtitles (.vtt)
    if (urlObj.pathname.endsWith('.vtt')) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', 'text/vtt');
      return res.send(buf);
    }

    // Images (.jpg, .png, .webp)
    if (/\.(jpg|jpeg|png|webp|gif)$/i.test(urlObj.pathname)) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', contentType || 'application/octet-stream');
      return res.send(buf);
    }

    // Other content: passthrough
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
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
