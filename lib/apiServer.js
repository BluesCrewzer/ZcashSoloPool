const http = require("http");
const crypto = require("crypto");

// Simple per-IP rate limiter: max requestsPerWindow requests per windowMs.
// Entries are cleaned up lazily on each request from that IP.
class RateLimiter {
  constructor(requestsPerWindow = 60, windowMs = 60_000) {
    this.requestsPerWindow = requestsPerWindow;
    this.windowMs = windowMs;
    this._buckets = new Map(); // ip -> { count, windowStart }
  }

  isAllowed(ip) {
    const now = Date.now();
    let bucket = this._buckets.get(ip);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      bucket = { count: 0, windowStart: now };
      this._buckets.set(ip, bucket);
    }
    bucket.count++;
    return bucket.count <= this.requestsPerWindow;
  }
}

class ApiServer {
  constructor(config = {}, handlers = {}, logger = console) {
    this.enabled = config.enabled !== false;
    this.host = config.host || "127.0.0.1";
    this.port = config.port || 8080;
    // Only store a non-empty key; empty string means auth is disabled
    this.apiKey = config.apiKey ? String(config.apiKey) : "";
    this.corsOrigin = config.corsOrigin || "";
    this.handlers = handlers;
    this.logger = logger;
    this.server = null;
    // 60 requests/min per IP; increase if a legitimate dashboard polls faster
    this._rateLimiter = new RateLimiter(60, 60_000);
  }

  buildCorsHeaders(req) {
    if (!this.corsOrigin) return {};

    const requestedOrigin = req.headers.origin;
    let allowOrigin = this.corsOrigin;
    if (this.corsOrigin === "*") {
      allowOrigin = "*";
    } else if (requestedOrigin && requestedOrigin === this.corsOrigin) {
      allowOrigin = requestedOrigin;
    }

    const headers = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
      "Access-Control-Max-Age": "86400",
    };

    if (allowOrigin !== "*") {
      headers.Vary = "Origin";
    }
    return headers;
  }

  start() {
    if (!this.enabled) return;

    this.server = http.createServer(async (req, res) => {
      try {
        const corsHeaders = this.buildCorsHeaders(req);
        const parsed = new URL(req.url, "http://localhost");
        const route = parsed.pathname || "/";

        if (req.method === "OPTIONS") {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }

        const remoteIp = req.socket.remoteAddress || "";
        if (!this._rateLimiter.isAllowed(remoteIp)) {
          res.writeHead(429, { ...corsHeaders, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "rate_limited" }));
          return;
        }

        if (this.apiKey) {
          // Accept key via header only — query params appear in server logs
          const key = req.headers["x-api-key"] || "";
          // Timing-safe comparison prevents brute-force via timing side-channel
          const keyBuf = Buffer.from(String(key));
          const apiKeyBuf = Buffer.from(this.apiKey);
          const match =
            keyBuf.length === apiKeyBuf.length &&
            crypto.timingSafeEqual(keyBuf, apiKeyBuf);
          if (!match) {
            res.writeHead(401, { ...corsHeaders, "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "unauthorized" }));
            return;
          }
        }

        if (route === "/health") {
          let payload = { ok: true };
          if (typeof this.handlers.getHealth === "function") {
            const out = await this.handlers.getHealth();
            if (out && typeof out === "object") payload = { ...payload, ...out };
          }
          res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
          return;
        }

        const routes = {
          "/stats": "getStats",
          "/miners": "getMiners",
          "/network": "getNetwork",
          "/job": "getJob",
        };

        const fn = routes[route];
        if (fn && typeof this.handlers[fn] === "function") {
          const out = await this.handlers[fn]();
          res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
          res.end(JSON.stringify(out));
          return;
        }

        res.writeHead(404, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      } catch (e) {
        const corsHeaders = this.buildCorsHeaders(req);
        this.logger.error(`[API] Internal error: ${e.message}\n${e.stack || ""}`);
        res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    });

    this.server.listen(this.port, this.host, () => {
      this.logger.info(`[API] listening on http://${this.host}:${this.port}`);
    });
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = ApiServer;
