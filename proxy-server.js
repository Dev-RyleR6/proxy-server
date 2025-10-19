import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import compression from "compression";
import morgan from "morgan";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Load allowed origins from .env
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [];

console.log("✅ Allowed Origins:", allowedOrigins);

// ✅ Dynamic CORS setup
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error("Not allowed by CORS"));
    },
  })
);

// ✅ Compression only for text responses
app.use(
  compression({
    filter: (req, res) => {
      const type = res.getHeader("Content-Type") || "";
      return /json|text|javascript|css|html/.test(type);
    },
  })
);

app.use(morgan("tiny"));

// 🧠 Helper for HTTPS rewrite
const forceHttpsOrigin = (req) => `https://${req.get("host")}`;

// 🛰️ Stream proxy
app.get("/stream", async (req, res) => {
  try {
    const { url, referer } = req.query;
    if (!url) return res.status(400).json({ error: "Missing URL parameter" });

    const targetUrl = new URL(url);
    console.log("🎯 Fetching:", targetUrl.href);

    const upstream = await fetch(targetUrl, {
      headers: referer ? { Referer: referer } : {},
    });

    // Copy headers (except problematic ones)
    res.status(upstream.status);
    for (const [key, value] of upstream.headers.entries()) {
      if (key.toLowerCase() === "content-encoding") continue; // 🚫 Prevent decoding errors
      res.setHeader(key, value);
    }

    const contentType = upstream.headers.get("content-type") || "";
    const rewriteOrigin = forceHttpsOrigin(req);

    // 🧩 Handle HLS playlist rewriting (.m3u8)
    const isHlsPlaylist =
      contentType.includes("application/vnd.apple.mpegurl") ||
      contentType.includes("application/x-mpegURL") ||
      targetUrl.pathname.endsWith(".m3u8");

    if (isHlsPlaylist) {
      const text = await upstream.text();
      const base = targetUrl;

      const rewritten = text
        .split("\n")
        .map((line) => {
          const l = line.trim();
          if (!l || l.startsWith("#")) return line;

          try {
            const resolved = new URL(l, base).toString();
            const sp = new URLSearchParams({ url: resolved });
            if (referer) sp.set("referer", String(referer));
            return `${rewriteOrigin}/stream?${sp.toString()}`;
          } catch {
            return line;
          }
        })
        .join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(rewritten);
    }

    // 🧱 For binary/video data (.ts, .mp4, etc.)
    const buffer = await upstream.arrayBuffer();
    res.setHeader("Content-Encoding", "identity"); // 🚫 Tell browser: no compression
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("❌ Proxy Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Health check route
app.get("/health", (_, res) => {
  res.json({ status: "OK", message: "Proxy server is running" });
});

// ✅ Root
app.get("/", (_, res) => {
  res.send("✅ Proxy server running with HTTPS rewrites and safe decoding!");
});

// 🚀 Start
app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
});
