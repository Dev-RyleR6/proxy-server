const express = require('express');
const cors = require('cors');
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

app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'OK' }));

// Stream + Subtitles Proxy
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

    // ✅ CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Referer, User-Agent');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

    const contentType = upstream.headers.get('content-type') || '';
    res.setHeader('Content-Type', contentType || 'application/octet-stream');

    // ✅ Handle HLS playlists
    if (
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegURL') ||
      urlObj.pathname.endsWith('.m3u8')
    ) {
      const text = await upstream.text();
      const origin = `${req.protocol}://${req.get('host')}`;
      const base = urlObj;

      const rewritten = text.split('\n').map((line) => {
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

    // ✅ Stream binary or image data safely
    if (upstream.body && typeof upstream.body.pipe === 'function') {
      console.log(`📡 Streaming ${urlObj.pathname} (${contentType})`);
      upstream.body.pipe(res);
      upstream.body.on('error', (err) => {
        console.error('❌ Stream error:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Stream pipe error', message: err.message });
        } else {
          res.destroy(err);
        }
      });
    } else {
      console.log(`📦 Buffering ${urlObj.pathname} (${contentType})`);
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    }
  } catch (err) {
    console.error('❌ Stream proxy error:', err);
    return res.status(500).json({ error: 'Stream proxy error', message: String(err?.message || err) });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
  console.log(`📺 Stream proxy: http://localhost:${PORT}/stream?url=<URL>&referer=<REFERER>`);
  console.log(`🔧 Health check: http://localhost:${PORT}/health`);
});
