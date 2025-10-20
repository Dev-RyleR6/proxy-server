// proxy-server-optimized.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import compression from "compression";
import morgan from "morgan";
import dotenv from "dotenv";
import LRU from "lru-cache";
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
const MAX_MEMORY_CACHE_SIZE_BYTES = parseInt(process.env.MAX_MEMORY_CACHE_SIZE_BYTES || "8") * 1024 * 1024;

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : [];

if (DISK_CACHE_ENABLED) fs.mkdirSync(DISK_CACHE_DIR, { recursive: true });

// Keep-alive agents
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const getAgent = url => url.startsWith("https:") ? httpsAgent : httpAgent;

const hashKey = key => crypto.createHash("sha256").update(key).digest("hex");
const diskPathForKey = key => path.join(DISK_CACHE_DIR, hashKey(key));

// LRU memory cache
const memoryCache = new LRU({ max: MEMORY_CACHE_MAX, ttl: CACHE_TTL });

// Disk cache helpers
async function readFromDisk(key) {
  if (!DISK_CACHE_ENABLED) return null;
  const file = diskPathForKey(key);
  const metaPath = `${file}.meta.json`;
  try {
    const [stat, metaStr] = await Promise.all([
      fsp.stat(file).catch(() => null),
      fsp.readFile(metaPath, "utf8").catch(() => null)
    ]);
    if (!stat || stat.size === 0) return null;
    if (!metaStr) { await fsp.rm(file).catch(() => {}); return null; }
    const meta = JSON.parse(metaStr);
    if (Date.now() - meta.timestamp > CACHE_TTL) {
      await fsp.rm(file).catch(() => {});
      await fsp.rm(metaPath).catch(() => {});
      return null;
    }
    const buffer = await fsp.readFile(file);
    return { buffer, meta };
  } catch { return null; }
}

async function writeToDisk(key, buffer, meta = {}) {
  if (!DISK_CACHE_ENABLED) return;
  const file = diskPathForKey(key), metaPath = `${file}.meta.json`;
  fsp.writeFile(file, buffer).catch(() => {});
  fsp.writeFile(metaPath, JSON.stringify({ ...meta, timestamp: Date.now() })).catch(() => {});
}

async function getCached(key) {
  const mem = memoryCache.get(key);
  if (mem) return mem;
  const disk = await readFromDisk(key);
  if (disk) { memoryCache.set(key, disk.buffer); return disk.buffer; }
  return null;
}

async function setCached(key, buffer, options = {}) {
  if (buffer.length <= MAX_MEMORY_CACHE_SIZE_BYTES) memoryCache.set(key, buffer);
  if (DISK_CACHE_ENABLED) writeToDisk(key, buffer, options.meta || {});
}

// Type check helpers
const isHlsPlaylist = (ct, urlPath) =>
  (ct || "").toLowerCase().includes("mpegurl") || urlPath.toLowerCase().endsWith(".m3u8");

const isBinaryType = (ct, urlPath) => {
  if (!ct) return false;
  const ext = path.extname(urlPath).toLowerCase();
  return ct.includes("video") || ct.includes("audio") || ct.includes("application/octet-stream") ||
    [".ts", ".mp4", ".m4s", ".webm", ".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext);
};

const app = express();

// CORS
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true
}));

// Compression
app.use(compression({ filter: (req, res) => /json|text|javascript|css|html/.test(res.getHeader("Content-Type") || "") }));

// Logging
app.use(morgan(DEBUG ? "dev" : "tiny"));

app.get("/health", (_, res) => res.json({ status: "OK", message: "Proxy running" }));

// Helper
const getRewriteOrigin = req => `https://${req.get("host")}`;

// Prefetch
async function prefetchUrls(urls, referer) {
  const concurrency = 6;
  const tasks = urls.map(url => async () => {
    try {
      if (await getCached(url)) return;
      const upstream = await fetch(url, { agent: getAgent(url), headers: referer ? { Referer: referer } : {} });
      if (!upstream.ok) return;
      const ct = upstream.headers.get("content-type") || "";
      const data = isHlsPlaylist(ct, url) ? Buffer.from(await upstream.text()) : Buffer.from(await upstream.arrayBuffer());
      await setCached(url, data, { meta: { contentType: ct } });
    } catch {}
  });

  for (let i = 0; i < tasks.length; i += concurrency) {
    await Promise.allSettled(tasks.slice(i, i + concurrency).map(t => t()));
  }
}

// Stream endpoint
app.get("/stream", async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: "Missing url parameter" });
    const referer = req.query.referer;
    const key = String(rawUrl);

    const cached = await getCached(key);
    if (cached) return res.send(cached);

    const upstream = await fetch(key, { agent: getAgent(key), headers: referer ? { Referer: referer } : {} });
    res.status(upstream.status);

    const contentType = upstream.headers.get("content-type") || "";
    for (const [k, v] of upstream.headers.entries()) {
      if (!["content-encoding", "transfer-encoding", "connection"].includes(k.toLowerCase())) res.setHeader(k, v);
    }

    const urlPath = new URL(key).pathname;
    if (isHlsPlaylist(contentType, urlPath)) {
      const text = await upstream.text();
      const base = new URL(key);
      const lines = text.split("\n");
      const rewrittenLines = [];
      const segments = [];

      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith("#")) { rewrittenLines.push(line); continue; }
        try {
          const resolved = new URL(t, base).toString();
          const sp = new URLSearchParams({ url: resolved });
          if (referer) sp.set("referer", referer);
          rewrittenLines.push(`${getRewriteOrigin(req)}/stream?${sp.toString()}`);
          segments.push(resolved);
        } catch { rewrittenLines.push(line); }
      }

      const rewritten = rewrittenLines.join("\n");
      setCached(key, Buffer.from(rewritten), { meta: { contentType } });
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Content-Encoding", "identity");
      res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL/1000)}`);
      res.send(rewritten);

      if (segments.length) prefetchUrls(segments.slice(0, PREFETCH_COUNT), referer).catch(() => {});
      return;
    }

    if (isBinaryType(contentType, urlPath)) {
      res.setHeader("Content-Encoding", "identity");
      res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL/1000)}, immutable`);

      const tempPath = DISK_CACHE_ENABLED ? diskPathForKey(key) : null;
      const upstreamStream = upstream.body;

      if (upstreamStream && typeof upstreamStream.pipe === "function") {
        const fileStream = tempPath ? fs.createWriteStream(tempPath) : null;
        upstreamStream.on("data", chunk => {
          res.write(chunk);
          if (fileStream) fileStream.write(chunk);
        });
        upstreamStream.on("end", async () => {
          res.end();
          if (fileStream) {
            fileStream.end();
            await writeToDisk(key, await fsp.readFile(tempPath), { meta: { contentType } });
          }
        });
        upstreamStream.on("error", () => { try { res.end() } catch {} });
        return;
      } else {
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.send(buf);
        setCached(key, buf, { meta: { contentType } });
        return;
      }
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
    setCached(key, buf, { meta: { contentType } });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Proxy error", message: String(err?.message || err) });
  }
});

if (DISK_CACHE_ENABLED) {
  setInterval(async () => {
    try {
      const files = await fsp.readdir(DISK_CACHE_DIR);
      const now = Date.now();
      for (const f of files) if (f.endsWith(".meta.json")) {
        const metaPath = path.join(DISK_CACHE_DIR, f);
        try {
          const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
          if (now - (meta.timestamp || 0) > CACHE_TTL) {
            await fsp.rm(metaPath).catch(() => {});
            await fsp.rm(metaPath.replace(/\.meta\.json$/, "")).catch(() => {});
          }
        } catch {}
      }
    } catch {}
  }, Math.max(60_000, CACHE_TTL));
}

app.listen(PORT, () => console.log(`🚀 Proxy listening on port ${PORT} (DEBUG=${DEBUG})`));
