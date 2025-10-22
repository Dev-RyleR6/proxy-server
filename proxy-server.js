// proxy-server.js (revised)
// Production-ready HLS proxy with improved CORS, SSRF protections, timeouts, and streaming error handling.

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import compression from "compression";
import morgan from "morgan";
import dotenv from "dotenv";
import { LRUCache } from "lru-cache";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import http from "http";
import https from "https";
import net from "net";

dotenv.config();

const DEBUG = process.env.DEBUG === "true";
const PORT = process.env.PORT || 3000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS || "300", 10) * 1000;
const MEMORY_CACHE_MAX = parseInt(process.env.MEMORY_CACHE_MAX_ITEMS || "1000", 10);
const DISK_CACHE_ENABLED = (process.env.DISK_CACHE_ENABLED || "true") === "true";
const DISK_CACHE_DIR = process.env.DISK_CACHE_DIR || "/tmp/proxy-cache";
const PREFETCH_COUNT = parseInt(process.env.PREFETCH_COUNT || "3", 10);
const CACHE_SIZE_LIMIT_BYTES = parseInt(process.env.CACHE_SIZE_LIMIT_BYTES || String(8 * 1024 * 1024), 10); // 8 MB default
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || "15000", 10); // 15s default

// Allowed origins (optional whitelist)
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : [];

// PUBLIC_HOST used for self checks / rewrite base
const PUBLIC_HOST = process.env.PUBLIC_HOST || "proxy-server-production-fb60.up.railway.app";

// Ensure disk cache dir
if (DISK_CACHE_ENABLED) {
  try {
    fs.mkdirSync(DISK_CACHE_DIR, { recursive: true });
  } catch (e) {
    console.warn("Could not create disk cache dir:", e);
  }
}

// Keep-alive agents
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const getAgent = (url) => (String(url || "").startsWith("https:") ? httpsAgent : httpAgent);

// Hash helpers
const hashKey = (key) => crypto.createHash("sha256").update(key).digest("hex");
const diskPathForKey = (key) => path.join(DISK_CACHE_DIR, hashKey(key));

// In-memory cache
const memoryCache = new LRUCache({ max: MEMORY_CACHE_MAX, ttl: CACHE_TTL });

// Disk cache helpers (unchanged)
async function readFromDisk(key) {
  if (!DISK_CACHE_ENABLED) return null;
  const file = diskPathForKey(key);
  const metaPath = `${file}.meta.json`;
  try {
    const [stat, metaStr] = await Promise.all([
      fsp.stat(file),
      fsp.readFile(metaPath, "utf8").catch(() => null),
    ]);
    if (!stat || stat.size === 0) return null;
    if (metaStr) {
      const meta = JSON.parse(metaStr);
      if (Date.now() - meta.timestamp > CACHE_TTL) {
        await fsp.rm(file).catch(() => {});
        await fsp.rm(metaPath).catch(() => {});
        return null;
      }
      return { buffer: await fsp.readFile(file), meta };
    } else {
      await fsp.rm(file).catch(() => {});
      return null;
    }
  } catch {
    return null;
  }
}

async function writeToDisk(key, buffer, meta = {}) {
  if (!DISK_CACHE_ENABLED) return;
  const file = diskPathForKey(key);
  const metaPath = `${file}.meta.json`;
  try {
    await fsp.writeFile(file, buffer);
    await fsp.writeFile(metaPath, JSON.stringify({ ...meta, timestamp: Date.now() }));
  } catch (e) {
    if (DEBUG) console.warn("Disk cache write failed:", e.message);
  }
}

async function getCached(key) {
  const mem = memoryCache.get(key);
  if (mem) {
    if (DEBUG) console.debug("CACHE HIT memory:", key);
    return mem;
  }
  const disk = await readFromDisk(key);
  if (disk) {
    if (DEBUG) console.debug("CACHE HIT disk:", key);
    memoryCache.set(key, disk.buffer);
    return disk.buffer;
  }
  return null;
}

async function setCached(key, buffer, options = {}) {
  try {
    memoryCache.set(key, buffer);
    if (DISK_CACHE_ENABLED) writeToDisk(key, buffer, options.meta || {});
  } catch (e) {
    if (DEBUG) console.debug("setCached error:", e?.message || e);
  }
}

// Content helpers (unchanged)
const isHlsPlaylist = (ct, urlPath) => {
  const type = (ct || "").toLowerCase();
  return (
    type.includes("application/vnd.apple.mpegurl") ||
    type.includes("application/x-mpegurl") ||
    urlPath.toLowerCase().endsWith(".m3u8")
  );
};

const isBinaryType = (ct, urlPath) => {
  const type = (ct || "").toLowerCase();
  const ext = path.extname(urlPath).toLowerCase();
  return (
    type.includes("video") ||
    type.includes("audio") ||
    type.includes("application/octet-stream") ||
    [".ts", ".mp4", ".m4s", ".webm", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".aac"].includes(ext)
  );
};

// Express setup
const app = express();

// Helper: check for IP literal and private/reserved ranges
function isPrivateIpLiteral(hostname) {
  // If hostname is an IP literal, check if it's private/reserved
  if (net.isIP(hostname) === 0) return false;
  // IPv4 checks
  if (hostname.includes(".")) {
    const parts = hostname.split(".").map(Number);
    if (parts[0] === 10) return true; // 10.0.0.0/8
    if (parts[0] === 127) return true; // loopback
    if (parts[0] === 169 && parts[1] === 254) return true; // link-local
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
    if (parts[0] >= 224) return true; // multicast & reserved
  }
  // IPv6 basic check for loopback / link-local (this is conservative)
  if (hostname.startsWith("::1") || hostname.startsWith("fe80") || hostname.startsWith("fc") || hostname.startsWith("fd")) {
    return true;
  }
  return false;
}

// CORS: echo origin when present (to allow credentials), otherwise allow curl/no-origin
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (!origin) {
    // no origin (curl / server-to-server) -> allow
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    // If whitelist present, enforce it
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
      if (DEBUG) console.warn("CORS blocked:", origin);
      res.setHeader("Access-Control-Allow-Origin", "null");
    } else {
      // echo the request origin so credentials can be used
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }
  next();
});

app.use(
  compression({
    filter: (req, res) => {
      // compress text-like responses (same intention as before)
      const ct = res.getHeader("Content-Type") || "";
      return /json|text|javascript|css|html/.test(String(ct));
    },
  })
);

app.use(DEBUG ? morgan("dev") : morgan("tiny"));

app.get("/health", (_, res) => res.json({ status: "OK", message: "Proxy running" }));

// OPTIONS handler for preflight: echo origin when present
app.options("/stream", (req, res) => {
  const origin = req.get("origin");
  if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  res.sendStatus(204);
});

const getRewriteOrigin = (req) => {
  const host = req.get("x-forwarded-host") || req.get("host") || PUBLIC_HOST;
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${host}`;
};

// Prefetch utility (unchanged but uses getAgent)
async function prefetchUrls(urls, referer) {
  const concurrency = 6;
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency).map(async (url) => {
      try {
        if (await getCached(url)) return;
        const upstream = await fetch(url, {
          agent: getAgent(url),
          headers: {
            Referer: referer || "https://megacloud.blog",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            Accept: "*/*",
          },
        });
        if (!upstream.ok) return;
        const ct = upstream.headers.get("content-type") || "";
        const buf = isHlsPlaylist(ct, url) ? Buffer.from(await upstream.text()) : Buffer.from(await upstream.arrayBuffer());
        await setCached(url, buf, { meta: { contentType: ct } });
      } catch (e) {
        if (DEBUG) console.debug("prefetch error:", e?.message || e);
      }
    });
    await Promise.allSettled(batch);
  }
}

// Build upstream headers based on incoming request; forward Range and User-Agent where present
function buildUpstreamHeaders(req, referer) {
  const headers = {
    Referer: referer || req.query.referer || req.get("referer") || "",
    "User-Agent": req.get("user-agent") || "Mozilla/5.0",
    Accept: "*/*",
    Origin: req.get("origin") || "",
  };
  const range = req.get("range");
  if (range) headers.Range = range;
  return headers;
}

/**
 * rewriteManifest (unchanged logic, minor robustness)
 */
function rewriteManifest(text, baseUrl, rewriteOrigin, referer) {
  const lines = text.split(/\r?\n/);
  const base = new URL(baseUrl);

  const rewrittenLines = lines.map((line) => {
    const trimmed = line.trim();

    // Keep comments / empty as-is
    if (!trimmed || trimmed.startsWith("#")) {
      // handle lines with URI="...": replace the inner URL if present
      if (trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (m, uri) => {
          try {
            const resolved = new URL(uri, base).toString();
            if (resolved.includes("/stream?url=") || resolved.includes(rewriteOrigin)) return `URI="${resolved}"`;
            const sp = new URLSearchParams({ url: resolved });
            if (referer) sp.set("referer", referer);
            return `URI="${rewriteOrigin}/stream?${sp.toString()}"`;
          } catch {
            return m;
          }
        });
      }
      return line;
    }

    // For non-comment lines (usually segment/playlist URIs), attempt to resolve & proxy
    try {
      const resolved = new URL(trimmed, base).toString();
      // If it's already proxied/pointing to our rewrite origin, keep as is
      if (resolved.includes("/stream?url=") || resolved.includes(rewriteOrigin)) return resolved;
      const sp = new URLSearchParams({ url: resolved });
      if (referer) sp.set("referer", referer);
      return `${rewriteOrigin}/stream?${sp.toString()}`;
    } catch {
      // fallback: try to rewrite any absolute URLs in the line (rare), using regex
      return line.replace(/(https?:\/\/[^\s"']+)/g, (match) => {
        try {
          if (match.includes("/stream?url=") || match.includes(rewriteOrigin)) return match;
          const sp = new URLSearchParams({ url: match });
          if (referer) sp.set("referer", referer);
          return `${rewriteOrigin}/stream?${sp.toString()}`;
        } catch {
          return match;
        }
      });
    }
  });

  return rewrittenLines.join("\n");
}

// MAIN /stream endpoint
app.get("/stream", async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: "Missing url parameter" });

    // Referer fallback
    const referer = req.query.referer || "https://megacloud.blog";

    // Decode once to avoid double-encoding problems
    const key = (() => {
      try {
        return decodeURIComponent(String(rawUrl));
      } catch {
        return String(rawUrl);
      }
    })();

    // Validate scheme
    let parsed;
    try {
      parsed = new URL(key);
    } catch {
      return res.status(400).json({ error: "Invalid url parameter" });
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "Only http/https URLs are allowed" });
    }

    // Prevent basic SSRF: block ip-literal private ranges and localhost
    const hostname = parsed.hostname;
    if (hostname === "localhost" || isPrivateIpLiteral(hostname)) {
      if (DEBUG) console.warn("Blocked private/loopback host:", hostname);
      return res.status(403).json({ error: "Blocked host" });
    }

    const rewriteOrigin = getRewriteOrigin(req);
    if (DEBUG) console.debug("Proxy request for:", key);

    // Try memory/disk cache
    const cached = await getCached(key);
    if (cached) {
      if (DEBUG) console.debug("Serving cached:", key);
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Content-Encoding", "identity");
      res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL / 1000)}, immutable`);
      res.setHeader("Access-Control-Allow-Origin", req.get("origin") || "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
      return res.send(cached);
    }

    // Fetch upstream while forwarding Range + UA + Referer
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    let upstream;
    try {
      upstream = await fetch(key, {
        agent: getAgent(key),
        headers: buildUpstreamHeaders(req, referer),
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === "AbortError") {
        return res.status(504).json({ error: "Upstream timeout" });
      }
      if (DEBUG) console.error("Fetch error:", err);
      return res.status(502).json({ error: "Upstream fetch failed", message: String(err?.message || err) });
    }
    clearTimeout(timeout);

    // Mirror upstream status for streaming clients
    res.status(upstream.status);

    const contentType = upstream.headers.get("content-type") || "";
    // Copy most headers (except hop-by-hop, we override CORS)
    for (const [k, v] of upstream.headers.entries()) {
      const lower = k.toLowerCase();
      if (["content-encoding", "transfer-encoding", "connection"].includes(lower)) continue;
      try {
        res.setHeader(k, v);
      } catch {}
    }

    // Ensure CORS + expose
    const origin = req.get("origin");
    if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");

    const urlPath = parsed.pathname;

    // 1) MANIFEST (.m3u8) -> rewrite every referenced URL to proxy through /stream
    if (isHlsPlaylist(contentType, urlPath)) {
      const text = await upstream.text();
      const rewritten = rewriteManifest(text, key, rewriteOrigin, referer);

      const buf = Buffer.from(rewritten);
      await setCached(key, buf, { meta: { contentType: "application/vnd.apple.mpegurl" } });

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Content-Encoding", "identity");
      res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL / 1000)}`);
      res.setHeader("X-Cache", "MISS");
      return res.send(buf);
    }

    // 2) BINARY segments (ts, m4s, jpg, etc.) -> stream directly, support Range requests
    if (isBinaryType(contentType, urlPath)) {
      if (DEBUG) console.debug("Streaming binary content:", urlPath, "Type:", contentType);

      res.setHeader("Content-Encoding", "identity");
      res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL / 1000)}, immutable`);
      res.setHeader("X-Cache", "MISS");

      // Forward range headers correctly for seeking
      const range = req.get("range");
      if (range) res.setHeader("Accept-Ranges", "bytes");

      // Stream directly to client
      if (upstream.body) {
        const chunks = [];
        let total = 0;
        let caching = true;

        upstream.body.on("data", (chunk) => {
          try {
            total += chunk.length;
            if (total <= CACHE_SIZE_LIMIT_BYTES) chunks.push(chunk);
            else caching = false;
          } catch {}
        });

        upstream.body.on("error", (err) => {
          if (DEBUG) console.error("Upstream stream error:", err);
          try { res.destroy(err); } catch {}
        });

        upstream.body.on("end", async () => {
          if (caching && chunks.length) {
            const buf = Buffer.concat(chunks);
            try {
              await setCached(key, buf, { meta: { contentType } });
            } catch (e) {
              if (DEBUG) console.debug("Cache store error:", e?.message || e);
            }
          }
        });

        // Pipe will handle backpressure; ensure errors are propagated
        upstream.body.pipe(res).on("error", (err) => {
          if (DEBUG) console.error("Pipe error:", err);
          try { res.destroy(err); } catch {}
        });
      } else {
        res.status(502).json({ error: "Upstream has no body to stream" });
      }
      return;
    }

    // 3) FALLBACK (JSON, HTML, etc.)
    const fallbackBuffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Encoding", "identity");
    res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL / 1000)}`);
    res.setHeader("X-Cache", "MISS");
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", contentType || "application/octet-stream");
    res.send(fallbackBuffer);
    if (fallbackBuffer.length <= CACHE_SIZE_LIMIT_BYTES) await setCached(key, fallbackBuffer, { meta: { contentType } });

  } catch (err) {
    if (DEBUG) console.error("Proxy error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Proxy error", message: String(err?.message || err) });
  }
});

// Disk cleanup (unchanged)
if (DISK_CACHE_ENABLED) {
  setInterval(async () => {
    try {
      const files = await fsp.readdir(DISK_CACHE_DIR);
      const now = Date.now();
      for (const f of files) {
        if (!f.endsWith(".meta.json")) continue;
        const metaPath = path.join(DISK_CACHE_DIR, f);
        try {
          const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
          if (now - (meta.timestamp || 0) > CACHE_TTL) {
            const base = metaPath.replace(/\.meta\.json$/, "");
            await fsp.rm(metaPath).catch(() => {});
            await fsp.rm(base).catch(() => {});
          }
        } catch {}
      }
    } catch (e) {
      if (DEBUG) console.debug("Disk cleanup error:", e?.message || e);
    }
  }, Math.max(60_000, CACHE_TTL));
}

app.listen(PORT, () => console.log(`🚀 Proxy listening on port ${PORT} (DEBUG=${DEBUG})`));
