import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import compression from "compression";
import morgan from "morgan";
import dotenv from "dotenv";

dotenv.config(); // ✅ Load .env first

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Parse ALLOWED_ORIGINS from .env
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : ["http://localhost:5173"];

app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        origin.endsWith(".vercel.app") ||
        origin.endsWith(".railway.app")
      ) {
        callback(null, true);
      } else {
        console.warn("❌ Blocked by CORS:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);

app.use(compression());
app.use(morgan("dev"));

// 🧠 Helper: Always rewrite to HTTPS origin
const forceHttpsOrigin = (req) => `https://${req.get("host")}`;

// 🛰️ Main Proxy Endpoint
app.get("/stream", async (req, res) => {
  try {
    const { url, referer } = req.query;
    if (!url) return res.status(400).json({ error: "Missing URL parameter" });


    const urlObj = new URL(url);
    const upstream = await fetch(urlObj, {
      headers: referer ? { referer } : {},
    });

    // Copy status and headers
    res.status(upstream.status);
    for (const [key, value] of upstream.headers.entries()) {
      res.setHeader(key, value);
    }

    const contentType = upstream.headers.get("content-type") || "";
    const rewriteOrigin = forceHttpsOrigin(req);

    // 🧩 Handle HLS (.m3u8) playlist rewriting
    const isHlsPlaylist =
      contentType.includes("application/vnd.apple.mpegurl") ||
      contentType.includes("application/x-mpegURL") ||
      urlObj.pathname.endsWith(".m3u8");

    if (isHlsPlaylist) {
      const text = await upstream.text();
      const base = urlObj;

      const rewritten = text
        .split("\n")
        .map((line) => {
          const l = line.trim();
          if (!l || l.startsWith("#")) return line; // Keep comments

          try {
            const resolved = new URL(l, base).toString();
            const sp = new URLSearchParams({ url: resolved });
            if (referer) sp.set("referer", String(referer));

            const rewrittenUrl = `${rewriteOrigin}/stream?${sp.toString()}`;
            console.log("🔗 Rewritten segment:", rewrittenUrl);
            return rewrittenUrl;
          } catch {
            return line;
          }
        })
        .join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(rewritten);
    }

    // 🧱 Non-HLS (binary) response
    const buffer = await upstream.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (err) {
    console.error("❌ Proxy Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🩺 Health Check
app.get("/health", (req, res) => {
  res.json({ status: "OK", message: "Proxy server is running" });
});

// 🏠 Root
app.get("/", (_, res) => {
  res.send("✅ Proxy server running with .env + HTTPS rewrite!");
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
});
