// Simple built-in logger with optional file rotation.
// Supports size-based rotation (rotateBy: "size") and daily rotation (rotateBy: "date").
// Optimized: buffered writes, debounced rotation checks.
//
// Compatibility note:
// - Some versions of the pool used: const { createLogger } = require('./lib/logger')
// - Others used: const { Logger } = require('./lib/logger')
//
// We export BOTH to make this a drop-in replacement.

const fs = require('fs');
const path = require('path');

const LEVEL_ORDER = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return '[unserializable]';
  }
}

class Logger {
  constructor(config = {}) {
    this.level = String(config.level || 'info').toLowerCase();
    this.maxFileSizeMb = Number(config.maxFileSizeMb || 50);
    this.maxFiles = Number(config.maxFiles || 7);
    this.rotateBy = String(config.rotateBy || 'size').toLowerCase();

    // Write buffer: flush every 500ms or when buffer exceeds 8KB
    this._buffer = [];
    this._bufferBytes = 0;
    this._flushTimer = null;
    this._flushMaxBytes = 8 * 1024;
    this._flushIntervalMs = 500;

    // Debounce rotation: check at most once per 30 seconds
    this._lastRotateCheckAt = 0;
    this._rotateCheckIntervalMs = 30000;

    this.file = null;
    if (config.file) {
      const resolved = path.resolve(String(config.file));
      const dir = path.dirname(resolved);
      const ext = path.extname(resolved);
      this._logDir = dir;
      this._logBase = path.basename(resolved, ext);
      this._logExt = ext || '.log';

      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (this.rotateBy === 'date') {
        this._currentDate = this._todayUTC();
        this.file = this._datedFilePath(this._currentDate);
      } else {
        this.file = resolved;
      }

      this._startFlushTimer();
    }
  }

  _todayUTC() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  _datedFilePath(dateStr) {
    return path.join(this._logDir, `${this._logBase}-${dateStr}${this._logExt}`);
  }

  _pruneOldLogs() {
    try {
      const escapedExt = this._logExt.replace('.', '\\.');
      const pattern = new RegExp(`^${this._logBase}-\\d{4}-\\d{2}-\\d{2}${escapedExt}$`);
      const files = fs.readdirSync(this._logDir)
        .filter((f) => pattern.test(f))
        .sort()    // YYYY-MM-DD lexicographic order == chronological
        .reverse(); // newest first
      for (const f of files.slice(this.maxFiles)) {
        try { fs.unlinkSync(path.join(this._logDir, f)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  shouldLog(level) {
    const want = LEVEL_ORDER[String(level).toLowerCase()] ?? 2;
    const cur = LEVEL_ORDER[this.level] ?? 2;
    return want <= cur;
  }

  rotateIfNeeded() {
    if (!this.file) return;
    const now = Date.now();
    if (now - this._lastRotateCheckAt < this._rotateCheckIntervalMs) return;
    this._lastRotateCheckAt = now;

    if (this.rotateBy === 'date') {
      const today = this._todayUTC();
      if (today !== this._currentDate) {
        // Flush remaining buffer into the outgoing day's file before switching.
        if (this._buffer.length) {
          const chunk = this._buffer.join('');
          this._buffer.length = 0;
          this._bufferBytes = 0;
          try { fs.appendFileSync(this.file, chunk); } catch { /* ignore */ }
        }
        this._currentDate = today;
        this.file = this._datedFilePath(today);
        this._pruneOldLogs();
      }
      return;
    }

    // Size-based rotation
    try {
      if (!fs.existsSync(this.file)) return;
      const st = fs.statSync(this.file);
      const maxBytes = this.maxFileSizeMb * 1024 * 1024;
      if (st.size < maxBytes) return;

      // Rotate: file -> file.1 -> file.2 ...
      for (let i = this.maxFiles; i >= 1; i--) {
        const src = i === 1 ? this.file : `${this.file}.${i - 1}`;
        const dst = `${this.file}.${i}`;
        if (fs.existsSync(src)) {
          if (i === this.maxFiles && fs.existsSync(dst)) fs.unlinkSync(dst);
          fs.renameSync(src, dst);
        }
      }
    } catch {
      // ignore
    }
  }

  _startFlushTimer() {
    if (this._flushTimer) return;
    this._flushTimer = setInterval(() => this.flush(), this._flushIntervalMs);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  flush() {
    if (!this.file || !this._buffer.length) return;
    const chunk = this._buffer.join('');
    this._buffer.length = 0;
    this._bufferBytes = 0;
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, chunk);
    } catch {
      // ignore
    }
  }

  write(line) {
    if (!this.file) return;
    const entry = line + '\n';
    this._buffer.push(entry);
    this._bufferBytes += entry.length;
    if (this._bufferBytes >= this._flushMaxBytes) {
      this.flush();
    }
  }

  fmt(level, args) {
    const ts = new Date().toISOString();
    const msg = args
      .map((a) => (typeof a === 'string' ? a : safeJson(a)))
      .join(' ');
    return `${ts} [${String(level).toUpperCase()}] ${msg}`;
  }

  log(level, ...args) {
    const lvl = String(level).toLowerCase();
    if (!this.shouldLog(lvl)) return;
    const line = this.fmt(lvl, args);
    // eslint-disable-next-line no-console
    (console[lvl] || console.log).call(console, line);
    this.write(line);
  }

  error(...args) { this.log('error', ...args); }
  warn(...args) { this.log('warn', ...args); }
  info(...args) { this.log('info', ...args); }
  debug(...args) { this.log('debug', ...args); }
  trace(...args) { this.log('trace', ...args); }

  child(prefix) {
    const p = String(prefix || '').trim();
    if (!p) return this;
    const parent = this;
    return {
      error: (...a) => parent.error(p, ...a),
      warn: (...a) => parent.warn(p, ...a),
      info: (...a) => parent.info(p, ...a),
      debug: (...a) => parent.debug(p, ...a),
      trace: (...a) => parent.trace(p, ...a),
      child: (p2) => parent.child(`${p} ${p2}`),
    };
  }

  shutdown() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this.flush();
  }
}

function createLogger(config = {}) {
  return new Logger(config);
}

module.exports = {
  Logger,
  createLogger,
};
