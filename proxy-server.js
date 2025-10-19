const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Load allowed origins from .env (comma-separated)
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [
      'http://localhost:5173',
      'https://localhost:5173',
      'http://localhost:3000',
      'https://localhost:3000',
      process.env.PRODUCTION_URL,
      process.env.PRODUCTION_HTTPS_URL
    ].filter(Boolean); // filter out undefined values

// Print allowed origins on startup
console.log('✅ Allowed Origins:', allowedOrigins);

// Add security headers
app.use((req, res, next) => {
  // Enable HSTS with a 1 year max-age
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Prevent browsers from incorrectly detecting non-scripts as scripts
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Block site from being framed with X-Frame-Options
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Dynamic CORS setup with clear logging
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
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

// Force HTTPS in production
app.use((req, res, next) => {
  // Check if we're behind a proxy (like Railway)
  if (req.headers['x-forwarded-proto'] === 'http') {
    // Special handling for Railway's environment
    const httpsUrl = `https://${req.headers.host}${req.url}`;
    console.log(`🔒 Redirecting to HTTPS: ${httpsUrl}`);
    return res.redirect(301, httpsUrl);
  }
  next();
});

// Middleware
app.use(express.json());

// Health check route
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Proxy server is running' });
});

// Main HLS / stream proxy
app.get('/stream', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

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
    if (referer) {
      headers['Referer'] = String(referer);
    }

    const upstream = await fetch(urlObj.toString(), { headers });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      console.error(`❌ Upstream fetch failed [${upstream.status}] for ${targetUrl}`);
      return res.status(upstream.status).send(text || 'Upstream error');
    }

    // Set CORS headers on the response to the browser
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    const contentType = upstream.headers.get('content-type') || '';
    res.setHeader('Content-Type', contentType || 'application/octet-stream');

    // Handle HLS playlists
    const isHlsPlaylist = contentType.includes('application/vnd.apple.mpegurl') ||
                        contentType.includes('application/x-mpegURL') ||
                        urlObj.pathname.endsWith('.m3u8');
    if (isHlsPlaylist) {
      const text = await upstream.text();
      // Use the request's protocol and host to build the rewrite origin
      const rewriteOrigin = `${req.protocol}://${req.get('host')}`;
      const base = urlObj;

      const rewritten = text.split('\n').map((line) => {
        const l = line.trim();
        if (!l || l.startsWith('#')) return line;
        try {
          const resolved = new URL(l, base).toString();
          const sp = new URLSearchParams({ url: resolved });
          if (referer) sp.set('referer', String(referer));
          // Rewrite URL to point back to this proxy
          return `${rewriteOrigin}/stream?${sp.toString()}`;
        } catch {
          return line;
        }
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    // Stream binary or image data safely
    if (upstream.body && typeof upstream.body.pipe === 'function') {
      console.log(`📡 Streaming ${urlObj.pathname} (${contentType})`);
      upstream.body.pipe(res);
      upstream.body.on('error', (err) => {
        console.error('❌ Stream error:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Stream pipe error', message: err.message });
        } else {
          res.end();
        }
      });
    } else {
      console.log(`📦 Buffering ${urlObj.pathname} (${contentType})`);
      console.log('Production URL: ', process.env.PRODUCTION_URL);
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    }
  } catch (err) {
    console.error('❌ Stream proxy error:', err);
    return res.status(500).json({ error: 'Stream proxy error', message: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on http://localhost:${PORT}`);
  console.log(`📺 Stream proxy available at: http://localhost:${PORT}/stream?url=<STREAM_URL>&referer=<REFERER_URL>`);
  console.log(`🔧 Health check: http://localhost:${PORT}/health`);
});