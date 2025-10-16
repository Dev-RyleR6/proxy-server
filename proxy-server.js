const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Allowed origins (browser requests)
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000'];

console.log('✅ Allowed Origins:', allowedOrigins);

// Dynamic CORS setup
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // non-browser requests
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'OK' }));

// Stream + Subtitles Proxy
app.get('/stream', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer;

  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

  let urlObj;
  try { urlObj = new URL(targetUrl); } 
  catch (e) { return res.status(400).json({ error: 'Invalid URL', message: e.message }); }

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0',
      'Accept': '*/*'
    };
    if (referer) headers['Referer'] = referer;

    const upstream = await fetch(urlObj.toString(), { headers });
    if (!upstream.ok) return res.status(upstream.status).send(await upstream.text());

    const contentType = upstream.headers.get('content-type') || '';

    // HLS Playlist
    if (contentType.includes('application/vnd.apple.mpegurl') || urlObj.pathname.endsWith('.m3u8')) {
      const text = await upstream.text();
      const origin = `https://${req.get('host')}`;
      const rewritten = text.split('\n').map(line => {
        const l = line.trim();
        if (!l || l.startsWith('#')) return line;
        try {
          const segmentUrl = new URL(l, urlObj).toString();
          const sp = new URLSearchParams({ url: segmentUrl });
          if (referer) sp.set('referer', referer);
          return `${origin}/stream?${sp.toString()}`;
        } catch { return line; }
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(rewritten);
    }

    // Subtitles (.vtt)
    if (urlObj.pathname.endsWith('.vtt')) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', 'text/vtt');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(buf);
    }

    // Other content (images, etc.)
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(buf);

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Proxy error', message: err.message });
  }
});

// ✅ HTTPS local server
const sslOptions = {
  key: fs.readFileSync('./certs/key.pem'),   // generate with openssl
  cert: fs.readFileSync('./certs/cert.pem'),
};

https.createServer(sslOptions, app).listen(PORT, () => {
  console.log(`🚀 HTTPS Proxy server running at https://localhost:${PORT}`);
  console.log(`📺 Stream proxy: https://localhost:${PORT}/stream?url=<URL>&referer=<REFERER>`);
  console.log(`🔧 Health check: https://localhost:${PORT}/health`);
});
