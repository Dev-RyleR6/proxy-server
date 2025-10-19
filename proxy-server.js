import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import compression from "compression";
import morgan from "morgan";

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Allow your frontend origins (edit if needed)
const allowedOrigins = [
  "https://myanime-w5in.vercel.app",
  "http://localhost:5173"
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);

app.use(compression());
app.use(morgan("dev"));

// 🧠 Helper: force HTTPS in rewrites
const forceHttpsOrigin = (req) => `https://${req.get("host")}`;

// 🛰️ Main Proxy Endpoint
app.get("/stream", async (req, res) => {
  try {
    const { url, referer } = req.query;
    if (!url) return res.status(400).json({ error: "Missing URL parameter" });

    console.log("🎯 Fetching:", url);

    const urlObj = new URL(url);
    const upstream = await fetch(urlObj, {
      headers: referer ? { referer } : {},
    });

    // Copy status & headers
    res.status(upstream.status);
    for (const [key, value] of upstream.headers.entries()) {
      res.setHeader(key, value);
    }

    const contentType = upstream.headers.get("content-type") || "";
    const rewriteOrigin = forceHttpsOrigin(req);
    console.log("🔁 Rewriting using HTTPS origin:", rewriteOrigin);

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
            console.log("🔗 Rewritten segment:", rewrittenUrl); // 👁 debug line
            return rewrittenUrl;
          } catch {
            return line;
          }
        })
        .join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(rewritten);
    }

    // 🧱 For non-HLS files (.ts, .mp4, etc.)
    const buffer = await upstream.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (err) {
    console.error("❌ Proxy Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Proxy server is running' });
});


app.get("/", (_, res) => {
  res.send("✅ Proxy server running with forced HTTPS rewrites!");
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
});
