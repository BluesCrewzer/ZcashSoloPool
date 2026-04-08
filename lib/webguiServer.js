const http = require("http");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

class WebGuiServer {
  constructor(config = {}, apiConfig = {}, logger = console, poolConfig = {}) {
    this.enabled = config.enabled !== false;
    this.host = config.host || "0.0.0.0";
    this.port = config.port || 8086;
    this.logger = logger;
    this.server = null;

    // Resolve the webgui directory relative to the project root
    this.webRoot = path.resolve(__dirname, "..", "webgui");

    // Build the runtime config.json that points the dashboard at the API
    this.apiHost = apiConfig.host || "127.0.0.1";
    this.apiPort = apiConfig.port || 8085;
    this.apiKey = apiConfig.apiKey || "";

    // Coin-specific block interval for effort calculation (Zcash=75s)
    const bi = Number(poolConfig.blockIntervalSeconds);
    this.blockIntervalSeconds = Number.isFinite(bi) && bi > 0 ? bi : 75;

    // Static file cache (loaded on first request, never changes at runtime)
    this._fileCache = new Map();
  }

  start() {
    if (!this.enabled) return;

    if (!fs.existsSync(this.webRoot)) {
      this.logger.warn(`[WebGui] webgui directory not found: ${this.webRoot}`);
      return;
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((e) => {
        this.logger.error(`[WebGui] Request error: ${e.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        }
      });
    });

    this.server.listen(this.port, this.host, () => {
      this.logger.info(`[WebGui] Dashboard listening on http://${this.host}:${this.port}`);
    });
  }

  async handleRequest(req, res) {
    // Only allow GET
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    // Parse the URL path, strip query string
    let urlPath = (req.url || "/").split("?")[0];

    // Serve a dynamic config.json that auto-points to the API
    if (urlPath === "/config.json") {
      const apiBase = this.buildApiBase(req);
      const config = {
        apiBase,
        apiKey: this.apiKey,
        refreshMs: 30000,
        blockIntervalSeconds: this.blockIntervalSeconds,
      };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(config));
      return;
    }

    // Default to index.html
    if (urlPath === "/") urlPath = "/index.html";

    // Prevent directory traversal
    const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = path.join(this.webRoot, safePath);

    // Ensure the resolved path is still within the webRoot
    if (!filePath.startsWith(this.webRoot)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    if (stat.isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    // Serve from cache; invalidate when file mtime changes
    const mtimeMs = stat.mtimeMs;
    const cached = this._fileCache.get(filePath);
    let content;
    if (cached && cached.mtimeMs === mtimeMs) {
      content = cached.data;
    } else {
      content = await fsp.readFile(filePath);
      this._fileCache.set(filePath, { data: content, mtimeMs });
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  }

  buildApiBase(req) {
    // Figure out the API URL from the perspective of the browser
    const host = req.headers.host;
    if (host) {
      const hostname = host.split(":")[0];
      return `http://${hostname}:${this.apiPort}`;
    }
    return `http://127.0.0.1:${this.apiPort}`;
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = WebGuiServer;
