// proxy-server.js
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

dotenv.config();

const DEBUG = process.env.DEBUG === "true";
const PORT = process.env.PORT || 3000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS || "300", 10) * 1000;
const MEMORY_CACHE_MAX = parseInt(process.env.MEMORY_CACHE_MAX_ITEMS || "1000", 10);
const DISK_CACHE_ENABLED = (process.env.DISK_CACHE_ENABLED || "true") === "true";
const DISK_CACHE_DIR = process.env.DISK_CACHE_DIR || "/tmp/proxy-cache";
const PREFETCH_COUNT = parseInt(process.env.PREFETCH_COUNT || "3", 10);
const CACHE_SIZE_LIMIT_BYTES = 8 * 1024 * 1024; // 8 MB in-memory threshold

// Allowed origins
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : [];

// Ensure disk cache dir
if (DISK_CACHE_ENABLED) {
  try { fs.mkdirSync(DISK_CACHE_DIR, { recursive: true }); } 
  catch (e) { console.warn("Could not create disk cache dir:", e); }
}

// Keep-alive agents
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const getAgent = (url) => url.startsWith("https:") ? httpsAgent : httpAgent;

// Hash helpers
const hashKey = (key) => crypto.createHash("sha256").update(key).digest("hex");
const diskPathForKey = (key) => path.join(DISK_CACHE_DIR, hashKey(key));

// In-memory cache
const memoryCache = new LRUCache({ max: MEMORY_CACHE_MAX, ttl: CACHE_TTL });

// Disk cache helpers
async function readFromDisk(key) {
  if (!DISK_CACHE_ENABLED) return null;
  const file = diskPathForKey(key);
  const metaPath = `${file}.meta.json`;
  try {
    const [stat, metaStr] = await Promise.all([
      fsp.stat(file),
      fsp.readFile(metaPath, "utf8").catch(() => null)
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
  } catch { return null; }
}

async function writeToDisk(key, buffer, meta = {}) {
  if (!DISK_CACHE_ENABLED) return;
  const file = diskPathForKey(key);
  const metaPath = `${file}.meta.json`;
  try {
    await fsp.writeFile(file, buffer);
    await fsp.writeFile(metaPath, JSON.stringify({ ...meta, timestamp: Date.now() }));
  } catch (e) { if (DEBUG) console.warn("Disk cache write failed:", e.message); }
}

async function getCached(key) {
  const mem = memoryCache.get(key);
  if (mem) { if (DEBUG) console.debug("CACHE HIT memory:", key); return mem; }
  const disk = await readFromDisk(key);
  if (disk) {
    if (DEBUG) console.debug("CACHE HIT disk:", key);
    memoryCache.set(key, disk.buffer);
    return disk.buffer;
  }
  return null;
}

async function setCached(key, buffer, options = {}) {
  memoryCache.set(key, buffer);
  if (DISK_CACHE_ENABLED) writeToDisk(key, buffer, options.meta || {});
}

// Content helpers
const isHlsPlaylist = (ct, urlPath) => {
  const type = (ct || "").toLowerCase();
  return type.includes("application/vnd.apple.mpegurl") ||
         type.includes("application/x-mpegurl") ||
         urlPath.toLowerCase().endsWith(".m3u8");
};

const isBinaryType = (ct, urlPath) => {
  const type = (ct || "").toLowerCase();
  const ext = path.extname(urlPath).toLowerCase();
  return type.includes("video") || type.includes("audio") || type.includes("application/octet-stream") ||
         [".ts", ".mp4", ".m4s", ".webm", ".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext);
};

// Express setup
const app = express();

app.use(cors({
  origin(origin, cb) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return cb(null, true);
    
    // If no origins specified, allow all
    if (allowedOrigins.length === 0) return cb(null, true);
    
    // Check if origin is allowed
    if (allowedOrigins.includes(origin)) return cb(null, true);
    
    if (DEBUG) console.warn("CORS blocked:", origin);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

app.use(compression({ filter: (req, res) => /json|text|javascript|css|html/.test(res.getHeader("Content-Type") || "") }));
app.use(DEBUG ? morgan("dev") : morgan("tiny"));

app.get("/health", (_, res) => res.json({ status: "OK", message: "Proxy running" }));

// OPTIONS handler for CORS preflight
app.options("/stream", (_, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.sendStatus(204);
});

const getRewriteOrigin = (req) => `https://${req.get("host")}`;

// Prefetch next N segments
async function prefetchUrls(urls, referer) {
  const concurrency = 6;
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency).map(async (url) => {
      try {
        if (await getCached(url)) return;
        const upstream = await fetch(url, { agent: getAgent(url), headers: referer ? { Referer: referer } : {} });
        if (!upstream.ok) return;
        const ct = upstream.headers.get("content-type") || "";
        const buf = isHlsPlaylist(ct, url)
          ? Buffer.from(await upstream.text())
          : Buffer.from(await upstream.arrayBuffer());
        await setCached(url, buf, { meta: { contentType: ct } });
      } catch (e) { if (DEBUG) console.debug("prefetch error:", e.message); }
    });
    await Promise.allSettled(batch);
  }
}

// Main streaming endpoint
app.get("/stream", async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: "Missing url parameter" });
    const referer = req.query.referer;
    const key = String(rawUrl);

    const cached = await getCached(key);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Content-Encoding", "identity");
      res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL/1000)}, immutable`);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");
      return res.send(cached);
    }

    const upstream = await fetch(key, { agent: getAgent(key), headers: referer ? { Referer: referer } : {} });
    res.status(upstream.status);
    const contentType = upstream.headers.get("content-type") || "";
    for (const [k,v] of upstream.headers.entries()) {
      if (!["content-encoding","transfer-encoding","connection"].includes(k.toLowerCase())) res.setHeader(k,v);
    }

    // Ensure CORS headers are set
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    const urlPath = new URL(key).pathname;
    const rewriteOrigin = getRewriteOrigin(req);

    if (isHlsPlaylist(contentType, urlPath)) {
      const text = await upstream.text();
      const base = new URL(key);
      const lines = text.split("\n");
      const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        try {
          const resolved = new URL(trimmed, base).toString();
          if (DEBUG) console.debug("Rewriting URL:", resolved);
          const sp = new URLSearchParams({ url: resolved });
          if (referer) sp.set("referer", referer);
          return `${rewriteOrigin}/stream?${sp.toString()}`;
        } catch { return line; }
      }).join("\n");

      await setCached(key, Buffer.from(rewritten), { meta: { contentType: "application/vnd.apple.mpegurl" } });
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Content-Encoding", "identity");
      res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL/1000)}`);
      res.setHeader("X-Cache", "MISS");
      res.send(rewritten);

      // Prefetch segments in background
      const segmentUrls = Array.from(new Set(lines.filter(l => !l.startsWith("#")).map(l => {
        try {
          return new URL(l.trim(), base).toString();
        } catch {
          return null;
        }
      }).filter(Boolean)));
      if (PREFETCH_COUNT > 0) prefetchUrls(segmentUrls.slice(0,PREFETCH_COUNT), referer).catch(()=>{});
      return;
    }

    // Binary/video streaming (including images)
    if (isBinaryType(contentType, urlPath)) {
      if (DEBUG) console.debug("Serving binary content:", urlPath, "Type:", contentType);
      res.setHeader("Content-Encoding", "identity");
      res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL/1000)}, immutable`);
      res.setHeader("X-Cache", "MISS");

      const body = upstream.body;
      if (!body || typeof body.pipe !== "function") {
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.send(buf);
        if (buf.length <= CACHE_SIZE_LIMIT_BYTES) await setCached(key, buf, { meta: { contentType } });
        return;
      }

      let buffers = [], total = 0;
      body.on("data", chunk => {
        try { res.write(chunk); } catch {}
        if (total <= CACHE_SIZE_LIMIT_BYTES) { buffers.push(chunk); total += chunk.length; } else { buffers = null; }
      });
      body.on("end", async () => {
        try { res.end(); } catch {}
        if (buffers && total > 0) await setCached(key, Buffer.concat(buffers,total), { meta: { contentType } });
      });
      body.on("error", err => { if (DEBUG) console.debug("Upstream error:", err.message); try { res.end(); } catch {} });
      return;
    }

    // Fallback
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Encoding", "identity");
    res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL/1000)}`);
    res.setHeader("X-Cache", "MISS");
    res.send(buf);
    if (buf.length <= CACHE_SIZE_LIMIT_BYTES) await setCached(key, buf, { meta: { contentType } });

  } catch (err) {
    if (DEBUG) console.error("Proxy error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Proxy error", message: String(err?.message || err) });
  }
});

// Disk cleanup
if (DISK_CACHE_ENABLED) {
  setInterval(async () => {
    try {
      const files = await fsp.readdir(DISK_CACHE_DIR);
      const now = Date.now();
      for (const f of files) {
        if (f.endsWith(".meta.json")) {
          const metaPath = path.join(DISK_CACHE_DIR,f);
          try {
            const meta = JSON.parse(await fsp.readFile(metaPath,"utf8"));
            if (now - (meta.timestamp||0) > CACHE_TTL) {
              const base = metaPath.replace(/\.meta\.json$/,"");
              await fsp.rm(metaPath).catch(()=>{});
              await fsp.rm(base).catch(()=>{});
            }
          } catch {}
        }
      }
    } catch(e){ if(DEBUG) console.debug("Disk cleanup error:",e.message); }
  }, Math.max(60_000,CACHE_TTL));
}

app.listen(PORT, () => console.log(`🚀 Proxy listening on port ${PORT} (DEBUG=${DEBUG})`));