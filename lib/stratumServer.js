const net = require("net");
const EventEmitter = require("events");

class StratumServer extends EventEmitter {
  constructor(config = {}, logger = console) {
    super();
    this.port = config.port || 3333;
    this.host = config.host || "0.0.0.0";
    this.clients = new Map();
    this.clientCounter = 0;
    this.logger = logger;

    this.logSubmissions = config.logSubmissions === true;
    this.submitAudit = config.submitAudit === true;

    this.useSetTarget = config.useSetTarget !== false;
    this.logOutbound = config.logOutbound === true;

    // Notify format preset: 'zcash' (default) or 'inno'
    this.notifyFormat = String(config.notifyFormat || 'inno').toLowerCase();

    // 'headerle' sends header-byte (LE) values in notify; 'display' sends RPC/display (BE-ish) values.
    this.notifyPreset = String(config.notifyPreset || 'headerle').toLowerCase();

    // Equihash miners generate their own nonce; extranonce2_size is typically 0.
    const en2 = Number(config.extranonce2Size);
    this.extranonce2Size = Number.isFinite(en2) && en2 >= 0 ? en2 : 0;

    // reserved field in mining.notify: 'empty' (default), 'zero32', or 'sapling'
    this.notifyReservedMode = String(config.notifyReservedMode || 'empty').toLowerCase();

    // Some ASIC firmwares expect version in BE (00000004) not LE (04000000)
    this.notifyVersionEndian = String(config.notifyVersionEndian || 'be').toLowerCase();

    // Protocol mode: 'zip301' (Zcash Stratum spec) or 'legacy' (bitcoin-style subscribe + custom notify)
    const pm = (config.protocolMode ?? config.protocol_mode ?? config.stratumMode ?? config.stratum_mode ?? 'zip301');
    this.protocolMode = String(pm).toLowerCase();


    this.maxTarget = (1n << 256n) - 1n;
    this.baseTarget =
      this.normalizeTarget(config.shareTarget) ||
      "00003fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    this.baseTargetBI = BigInt(`0x${this.baseTarget}`);
    this.solutionRateScale =
      Number.isFinite(Number(config.solutionRateScale)) && Number(config.solutionRateScale) > 0
        ? Number(config.solutionRateScale)
        : 1000;
    this.hashrateWindowSeconds =
      Number.isFinite(Number(config.hashrateWindowSeconds)) && Number(config.hashrateWindowSeconds) >= 10
        ? Number(config.hashrateWindowSeconds)
        : 300;

    this.vardiff = this.buildVardiffConfig(config);
    this.jobResendDelayMs =
      Number.isFinite(Number(config.jobResendDelayMs)) && Number(config.jobResendDelayMs) >= 0
        ? Number(config.jobResendDelayMs)
        : 1200;

    this.connectionAcl = this.buildConnectionAclConfig(config);
    this.addressBanUntil = new Map();
    this.lastJob = null;

    // Hardening limits
    this.maxBufferBytes = 16 * 1024;          // 16 KB per-client buffer cap
    const maxConn = Number(config.maxConnectionsPerIp);
    this.maxConnectionsPerIp = Number.isFinite(maxConn) && maxConn > 0 ? Math.floor(maxConn) : 8;
    this.preAuthTimeoutMs = 30000;            // 30s to authenticate or get kicked
    this.maxPreAuthMessages = 10;             // max messages before auth
    this.maxWorkerNameLength = 128;           // worker name length cap
    this.banCleanupIntervalMs = 60000;        // cleanup bans every 60s
    this._banCleanupTimer = null;
    // O(1) per-IP connection count: ip -> count
    this._ipCount = new Map();
    // Kick miners that haven't sent any data in this long (covers silent TCP drops
    // where socket.setTimeout never fires because we keep writing job notifications)
    const inactiveMs = Number(config.inactiveTimeoutMs);
    this.inactiveTimeoutMs = Number.isFinite(inactiveMs) && inactiveMs >= 30000
      ? inactiveMs
      : 10 * 60 * 1000; // 10 minutes default
  }

  parseBoolean(value, defaultValue = false) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
      if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
    }
    return defaultValue;
  }

  buildConnectionAclConfig(config = {}) {
    const acl = config.connectionAcl || {};
    const maxBadJsonBeforeClose = Number(acl.maxBadJsonBeforeClose);
    const badJsonBanSeconds = Number(acl.badJsonBanSeconds);
    const allowEntries = this.compileAclEntries(Array.isArray(acl.allowCidrs) ? acl.allowCidrs : []);
    const denyEntries = this.compileAclEntries(Array.isArray(acl.denyCidrs) ? acl.denyCidrs : []);
    return {
      enabled: this.parseBoolean(acl.enabled, false),
      allowEntries,
      denyEntries,
      logDenied: this.parseBoolean(acl.logDenied, true),
      banOnBadJson: this.parseBoolean(acl.banOnBadJson, true),
      maxBadJsonBeforeClose: Number.isFinite(maxBadJsonBeforeClose) && maxBadJsonBeforeClose >= 1
        ? Math.floor(maxBadJsonBeforeClose)
        : 3,
      badJsonBanSeconds: Number.isFinite(badJsonBanSeconds) && badJsonBanSeconds > 0
        ? Math.floor(badJsonBanSeconds)
        : 900,
    };
  }

  normalizeRemoteAddress(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "";
    if (raw.startsWith("::ffff:")) return raw.slice(7);
    return raw;
  }

  ipV4ToInt(ip) {
    if (net.isIP(ip) !== 4) return null;
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let acc = 0;
    for (const part of parts) {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      acc = (acc << 8) + n;
    }
    return acc >>> 0;
  }

  compileAclEntries(entries) {
    const compiled = [];
    const list = Array.isArray(entries) ? entries : [];
    list.forEach((entryRaw) => {
      const entry = String(entryRaw || "").trim().toLowerCase();
      if (!entry) return;

      if (entry.includes("/")) {
        const [ipRaw, prefixRaw] = entry.split("/");
        const ip = this.normalizeRemoteAddress(ipRaw);
        const prefix = Number(prefixRaw);
        if (net.isIP(ip) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
          this.logger.warn(`[Stratum] Ignoring invalid connectionAcl CIDR entry: ${entryRaw}`);
          return;
        }
        const ipInt = this.ipV4ToInt(ip);
        const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
        compiled.push({
          type: "ipv4-cidr",
          base: ipInt & mask,
          mask,
          text: `${ip}/${prefix}`,
        });
        return;
      }

      const ip = this.normalizeRemoteAddress(entry);
      if (net.isIP(ip) === 0) {
        this.logger.warn(`[Stratum] Ignoring invalid connectionAcl IP entry: ${entryRaw}`);
        return;
      }
      compiled.push({
        type: "ip",
        ip,
        text: ip,
      });
    });
    return compiled;
  }

  isAddressInAclEntries(addressRaw, entries) {
    const address = this.normalizeRemoteAddress(addressRaw);
    if (!address || !Array.isArray(entries) || !entries.length) return false;
    const ipV4 = this.ipV4ToInt(address);

    for (const entry of entries) {
      if (!entry) continue;
      if (entry.type === "ip" && entry.ip === address) return true;
      if (entry.type === "ipv4-cidr" && ipV4 != null && (ipV4 & entry.mask) === entry.base) return true;
    }
    return false;
  }

  isAddressAllowed(addressRaw) {
    if (!this.connectionAcl.enabled) return true;
    if (this.isAddressInAclEntries(addressRaw, this.connectionAcl.denyEntries)) return false;
    if (!this.connectionAcl.allowEntries.length) return true;
    return this.isAddressInAclEntries(addressRaw, this.connectionAcl.allowEntries);
  }

  cleanupAddressBans() {
    const now = Date.now();
    for (const [ip, until] of this.addressBanUntil) {
      if (!Number.isFinite(until) || until <= now) this.addressBanUntil.delete(ip);
    }
  }

  isAddressBanned(addressRaw) {
    const address = this.normalizeRemoteAddress(addressRaw);
    if (!address) return false;
    const until = this.addressBanUntil.get(address);
    if (!Number.isFinite(until)) return false;
    if (until <= Date.now()) {
      this.addressBanUntil.delete(address);
      return false;
    }
    return true;
  }

  banAddress(addressRaw, seconds, reason = "") {
    const address = this.normalizeRemoteAddress(addressRaw);
    if (!address) return;
    const ttlSeconds = Math.max(1, Number(seconds) || 0);
    const until = Date.now() + (ttlSeconds * 1000);
    this.addressBanUntil.set(address, until);
    if (this.connectionAcl.logDenied) {
      const reasonSuffix = reason ? ` reason=${reason}` : "";
      this.logger.warn(`[Stratum] Temporary ban ${address} for ${ttlSeconds}s${reasonSuffix}`);
    }
  }

  formatDifficulty(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "n/a";
    if (n === 0) return "0K";
    const sign = n < 0 ? "-" : "";
    let v = Math.abs(n) / 1000;
    const units = ["K", "M", "G", "T", "P", "E", "Z"];
    let i = 0;
    while (v >= 1000 && i < units.length - 1) {
      v /= 1000;
      i += 1;
    }
    const precision = v >= 100 ? 1 : v >= 10 ? 2 : 3;
    return `${sign}${v.toFixed(precision)}${units[i]}`;
  }

  buildVardiffConfig(config = {}) {
    const vd = config.vardiff || {};
    const initialDifficulty =
      Number.isFinite(Number(config.difficulty)) && Number(config.difficulty) > 0
        ? Number(config.difficulty)
        : 1;
    const minDifficulty =
      Number.isFinite(Number(vd.minDifficulty)) && Number(vd.minDifficulty) > 0
        ? Number(vd.minDifficulty)
        : Math.min(initialDifficulty, 1);

    return {
      enabled: vd.enabled !== false,
      initialDifficulty,
      minDifficulty,
      maxDifficulty:
        Number.isFinite(Number(vd.maxDifficulty)) && Number(vd.maxDifficulty) > 0
          ? Number(vd.maxDifficulty)
          : 4096,
      targetTime:
        Number.isFinite(Number(vd.targetTime)) && Number(vd.targetTime) > 0
          ? Number(vd.targetTime)
          : 15,
      retargetTime:
        Number.isFinite(Number(vd.retargetTime)) && Number(vd.retargetTime) > 0
          ? Number(vd.retargetTime)
          : 90,
      variancePercent:
        Number.isFinite(Number(vd.variancePercent)) && Number(vd.variancePercent) >= 0
          ? Number(vd.variancePercent)
          : 30,
      minSamples:
        Number.isFinite(Number(vd.minSamples)) && Number(vd.minSamples) >= 2
          ? Number(vd.minSamples)
          : 6,
    };
  }

  reverseHexBytes(hex) {
    if (typeof hex !== "string" || hex.length % 2 !== 0) return hex;
    return Buffer.from(hex, "hex").reverse().toString("hex");
  }

  countConnectionsFromIp(ip) {
    return this._ipCount.get(ip) || 0;
  }

  start() {
    // Periodic ban cleanup instead of per-connection
    this._banCleanupTimer = setInterval(() => this.cleanupAddressBans(), this.banCleanupIntervalMs);
    if (this._banCleanupTimer.unref) this._banCleanupTimer.unref();

    // Periodic inactive-client sweep: kicks miners that haven't sent any data recently.
    // socket.setTimeout() alone is not sufficient because outgoing job broadcasts reset
    // the idle timer — a silently-dead TCP connection can stay open indefinitely.
    const inactiveSweepMs = Math.max(30000, Math.floor(this.inactiveTimeoutMs / 3));
    this._inactiveSweepTimer = setInterval(() => this.kickInactiveClients(), inactiveSweepMs);
    if (this._inactiveSweepTimer.unref) this._inactiveSweepTimer.unref();

    // Periodic idle-miner VarDiff check — halves difficulty for miners that
    // haven't submitted a share in 3x targetTime, preventing stuck-high diff.
    if (this.vardiff.enabled) {
      this._vardiffIdleTimer = setInterval(() => this.checkIdleMinersVardiff(), this.vardiff.retargetTime * 1000);
      if (this._vardiffIdleTimer.unref) this._vardiffIdleTimer.unref();
    }

    this.server = net.createServer((socket) => {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 15000);
      // Fallback timeout for fully-idle sockets (no data in either direction).
      // Silent disconnects are caught sooner by kickInactiveClients() which tracks
      // lastReceivedAt independently of outgoing job writes.
      socket.setTimeout(this.inactiveTimeoutMs);

      const remoteAddress = this.normalizeRemoteAddress(socket.remoteAddress);

      // Per-IP connection limit
      if (this.countConnectionsFromIp(remoteAddress) >= this.maxConnectionsPerIp) {
        this.logger.warn(`[Stratum] Rejected ${remoteAddress}: per-IP connection limit (${this.maxConnectionsPerIp})`);
        socket.destroy();
        return;
      }

      if (this.isAddressBanned(remoteAddress)) {
        if (this.connectionAcl.logDenied) {
          this.logger.warn(`[Stratum] Rejected banned address ${remoteAddress || "unknown"}`);
        }
        socket.destroy();
        return;
      }

      if (!this.isAddressAllowed(remoteAddress)) {
        if (this.connectionAcl.logDenied) {
          this.logger.warn(`[Stratum] Rejected address ${remoteAddress || "unknown"} by connectionAcl`);
        }
        socket.destroy();
        return;
      }

      const clientId = ++this.clientCounter;
      const client = {
        id: clientId,
        socket,
        remoteAddress,
        authorized: false,
        workerName: null,
        buffer: "",
        badJsonCount: 0,
        preAuthMessages: 0,
        extranonce1: clientId.toString(16).padStart(8, "0"),
        lastReceivedAt: Date.now(),
        currentDifficulty: this.clampDifficulty(this.vardiff.initialDifficulty),
        shareTarget: null,
        previousShareTarget: null,
        previousTargetExpiresAt: 0,
        shareTimes: [],
        lastRetargetAt: 0,
        connectedAt: Date.now(),
        metrics: {
          submits: 0,
          accepted: 0,
          rejected: 0,
          blocksFound: 0,
          invalid: 0,
          lowDiff: 0,
          stale: 0,
          bestShareDifficulty: 0,
          bestShareHash: null,
          lastBlockDifficulty: 0,
          lastShareAt: null,
          lastAcceptedMs: null,   // numeric ms timestamp of last accepted share
          ewmaHashrate: 0,        // exponential weighted moving average Sol/s
          recentAccepted: [],
          lastPingAt: null,
          lastPingMs: null,
          lastPingStatus: null,
          lastPingError: null,
          pingSuccesses: 0,
          pingFailures: 0,
        },
      };

      this.applyDifficulty(client, client.currentDifficulty, false);
      this.clients.set(clientId, client);
      this._ipCount.set(remoteAddress, (this._ipCount.get(remoteAddress) || 0) + 1);
      this.emit("clientConnected", client);

      this.logger.info(
        `[Stratum] Client connected #${clientId} from ${socket.remoteAddress}:${socket.remotePort}`
      );

      // Pre-auth timeout: kick clients that don't authenticate quickly
      const preAuthTimer = setTimeout(() => {
        if (!client.authorized) {
          this.logger.warn(`[Stratum] Pre-auth timeout for #${clientId} (${this.preAuthTimeoutMs}ms), closing`);
          socket.destroy();
        }
      }, this.preAuthTimeoutMs);
      if (preAuthTimer.unref) preAuthTimer.unref();

      socket.on("data", (data) => {
        client.lastReceivedAt = Date.now();
        client.buffer += data.toString("utf8");

        // Buffer size cap: prevent memory exhaustion from clients sending data without newlines
        if (client.buffer.length > this.maxBufferBytes) {
          this.logger.warn(`[Stratum] Buffer overflow from #${client.id} (${client.buffer.length} bytes), closing`);
          if (this.connectionAcl.banOnBadJson) {
            this.banAddress(client.remoteAddress, this.connectionAcl.badJsonBanSeconds, "buffer-overflow");
          }
          socket.destroy();
          return;
        }

        const lines = client.buffer.split("\n");
        client.buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Pre-auth message rate limit
          if (!client.authorized) {
            client.preAuthMessages++;
            if (client.preAuthMessages > this.maxPreAuthMessages) {
              this.logger.warn(`[Stratum] Pre-auth message flood from #${client.id} (${client.preAuthMessages} msgs), closing`);
              if (this.connectionAcl.banOnBadJson) {
                this.banAddress(client.remoteAddress, this.connectionAcl.badJsonBanSeconds, "preauth-flood");
              }
              socket.destroy();
              return;
            }
          }

          try {
            this.handleRequest(client, JSON.parse(trimmed));
          } catch (e) {
            this.logger.warn(`[Stratum] Bad JSON from #${client.id}: ${e.message}`);
            client.badJsonCount = (client.badJsonCount || 0) + 1;
            if (client.badJsonCount >= this.connectionAcl.maxBadJsonBeforeClose) {
              if (this.connectionAcl.banOnBadJson && !client.authorized) {
                this.banAddress(client.remoteAddress, this.connectionAcl.badJsonBanSeconds, "malformed-json");
              }
              this.logger.warn(
                `[Stratum] Closing client #${client.id} after ${client.badJsonCount} malformed messages (auth=${client.authorized})`
              );
              socket.destroy();
              return;
            }
          }
        }
      });

      let cleanedUp = false;
      const cleanup = (why, errMsg) => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearTimeout(preAuthTimer);
        this.clients.delete(clientId);
        const ipCount = (this._ipCount.get(client.remoteAddress) || 1) - 1;
        if (ipCount <= 0) this._ipCount.delete(client.remoteAddress);
        else this._ipCount.set(client.remoteAddress, ipCount);
        this.emit("clientDisconnected", client);
        const worker = client.workerName || "unauthorized";
        const upSeconds = Math.max(0, Math.floor((Date.now() - (client.connectedAt || Date.now())) / 1000));
        const endpoint = `${client.remoteAddress || socket.remoteAddress || "unknown"}:${socket.remotePort || "?"}`;
        if (errMsg || why === "close_with_error") {
          this.logger.warn(
            `[Stratum] Client disconnected #${clientId} reason=${why} worker=${worker} up=${upSeconds}s from=${endpoint}${errMsg ? ` error=${errMsg}` : ""}`
          );
        } else {
          this.logger.info(
            `[Stratum] Client disconnected #${clientId} reason=${why} worker=${worker} up=${upSeconds}s from=${endpoint}`
          );
        }
      };

      socket.on("end", () => cleanup("end"));
      socket.on("close", (hadError) => cleanup(hadError ? "close_with_error" : "close"));
      socket.on("error", (err) => cleanup("error", err.message));
      socket.on("timeout", () => {
        this.logger.warn(`[Stratum] Socket timeout for #${clientId} (no data for 10m), closing`);
        socket.destroy();
      });
    });

    this.server.listen(this.port, this.host, () => {
      this.logger.info(`Stratum listening on ${this.host}:${this.port}`);
      this.logger.info(`[Stratum] protocolMode=${this.protocolMode} notifyFormat=${this.notifyFormat} notifyPreset=${this.notifyPreset}`);
      this.logger.info(
        `[Stratum] VarDiff ${this.vardiff.enabled ? "enabled" : "disabled"} | initial=${this.formatDifficulty(this.vardiff.initialDifficulty)} min=${this.formatDifficulty(this.vardiff.minDifficulty)} max=${this.formatDifficulty(this.vardiff.maxDifficulty)}`
      );
      this.logger.info(`[Stratum] Hashrate window: ${this.hashrateWindowSeconds}s`);
    });
  }

  handleRequest(client, req) {
    const { method, params, id } = req || {};

    if (method === "mining.configure") {
      // Many miners send this before authorize. Reply success with no special features.
      this.send(client, { id, result: [[], {}], error: null });
      return;
    }

    if (method === "mining.subscribe") {
      if (this.protocolMode === "zip301") {
        const sessionId = null;
        this.logger.info(`[Stratum] ZIP301 subscribe -> #${client.id} extranonce1=${client.extranonce1} extranonce2_size=${this.extranonce2Size}`);
        this.send(client, { id, result: [sessionId, client.extranonce1, this.extranonce2Size], error: null });
        return;
      }

      // Legacy/ASIC-friendly subscribe response
      this.send(client, {
        id,
        result: [
          [["mining.notify", "1"], ["mining.set_difficulty", "1"], ["mining.set_target", "1"]],
          client.extranonce1,
          this.extranonce2Size,
        ],
        error: null,
      });
      this.send(client, { method: "mining.set_difficulty", params: [client.currentDifficulty], id: null });
      return;
    }

    if (method === "mining.extranonce.subscribe") {
      this.send(client, { id, result: true, error: null });
      return;
    }

    if (method === "mining.suggest_difficulty") {
      const suggested = Number(params && params[0]);
      if (Number.isFinite(suggested) && suggested > 0) {
        const before = client.currentDifficulty;
        this.applyDifficulty(client, suggested, true);
        this.logger.info(`[Stratum] Client #${client.id} suggested diff ${this.formatDifficulty(suggested)} -> ${this.formatDifficulty(client.currentDifficulty)} (was ${this.formatDifficulty(before)})`);
      }
      this.send(client, { id, result: true, error: null });
      return;
    }

    if (method === "mining.authorize") {
      client.authorized = true;
      const rawName = String((params && params[0]) || client.workerName || `miner-${client.id}`);
      // Sanitize worker name: strip control chars, limit length
      client.workerName = rawName.replace(/[\x00-\x1f\x7f]/g, "").slice(0, this.maxWorkerNameLength);
      this.logger.info(`[Stratum] Authorize request #${client.id} user=${(params && params[0]) || "unknown"}`);
      this.send(client, { id, result: true, error: null });
      this.send(client, { method: "mining.set_difficulty", params: [client.currentDifficulty], id: null });
      if (this.useSetTarget) {
        this.send(client, { method: "mining.set_target", params: [client.shareTarget], id: null });
      }
      this.emit("authorize", client, params);

      // Some firmware expects a notify immediately after authorize.
      if (this.lastJob) {
        this.sendJob(client, this.lastJob);
        if (this.jobResendDelayMs > 0) {
          const socketRef = client.socket;
          setTimeout(() => {
            // Re-send the latest job after a short delay to help devices that
            // reconnect but miss/ignore the first notify during restart churn.
            if (!client.authorized) return;
            if (!client.socket || client.socket.destroyed) return;
            if (client.socket !== socketRef) {
              this.logger.debug(`[Stratum] Skipping delayed job resend for #${client.id}: socket replaced`);
              return;
            }
            if (this.lastJob) this.sendJob(client, this.lastJob);
          }, this.jobResendDelayMs);
        }
      }
      return;
    }

    if (method === "mining.submit") {
      if (!client.authorized) {
        this.send(client, { id, result: null, error: [24, "Unauthorized", null] });
        return;
      }

      const parsed = this.parseSubmit(params || []);
      client.metrics.submits += 1;
      if (parsed.worker) {
        client.workerName = String(parsed.worker).replace(/[\x00-\x1f\x7f]/g, "").slice(0, this.maxWorkerNameLength);
      }

      this.logger.debug(
        `[Stratum] Share submit from client #${client.id} job ${parsed.jobId || "unknown"} nTime=${parsed.nTime || "n/a"} nonceLen=${(parsed.nonce || "").length}`
      );

      if (this.logSubmissions) {
        this.logger.debug(
          `[Stratum] Submit detail #${client.id} worker=${parsed.worker || "n/a"} nonce=${this.previewHex(parsed.nonce)} solution=${this.previewHex(parsed.solution)} raw=${JSON.stringify(params || [])}`
        );
      }

      if (this.submitAudit) {
        const nTimeHexLen = typeof parsed.nTime === "string" ? parsed.nTime.replace(/^0x/i, "").length : 0;
        const nonceHexLen = typeof parsed.nonce === "string" ? parsed.nonce.replace(/^0x/i, "").length : 0;
        const solutionHexLen = typeof parsed.solution === "string" ? parsed.solution.replace(/^0x/i, "").length : 0;
        this.logger.info(
          `[Stratum][Audit] client=#${client.id} worker=${parsed.worker || "n/a"} job=${parsed.jobId || "n/a"} params=${(params || []).length} nTimeHexLen=${nTimeHexLen} nonceHexLen=${nonceHexLen} solutionHexLen=${solutionHexLen}`
        );
      }

      this.emit("submit", {
        client,
        requestId: id,
        worker: parsed.worker,
        jobId: parsed.jobId,
        nTime: parsed.nTime,
        nonce: parsed.nonce,
        solution: parsed.solution,
        rawParams: params || [],
      });
      return;
    }

    const safeMethod = String(method || "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 64);
    this.send(client, { id, result: null, error: [20, `Unsupported method ${safeMethod}`, null] });
  }

  parseSubmit(params) {
    const asHex = (v) => (typeof v === "string" ? v.toLowerCase().replace(/^0x/, "").trim() : "");
    const isNTimeHex = (v) => /^[0-9a-f]{8}$/.test(asHex(v));
    const isHexLike = (v) => /^[0-9a-f]+$/i.test(asHex(v));

    if (!Array.isArray(params)) return { worker: null, jobId: null, nTime: null, nonce: null, solution: null };

    if (params.length >= 5) {
      const worker = params[0];
      const jobId = String(params[1] ?? "");
      const tail = params.slice(2);

      const solution = tail[tail.length - 1];
      const middle = tail.slice(0, -1);

      let nTime = middle.find((v) => isNTimeHex(v)) || null;

      const nonceCandidates = middle.filter((v) => v !== nTime && isHexLike(v));
      let nonce = null;
      if (nonceCandidates.length) nonce = nonceCandidates.sort((a, b) => asHex(b).length - asHex(a).length)[0];

      if (!nTime || !nonce) {
        const p2 = params[2];
        const p3 = params[3];
        if (isNTimeHex(p2) && !isNTimeHex(p3)) { nTime = p2; nonce = p3; }
        else if (!isNTimeHex(p2) && isNTimeHex(p3)) { nTime = p3; nonce = p2; }
        else { nTime = p2 || null; nonce = p3 || null; }
      }

      return { worker, jobId, nTime: asHex(nTime), nonce: asHex(nonce), solution: asHex(solution) };
    }

    if (params.length === 4) {
      const jobId = String(params[0] ?? "");
      const p1 = params[1];
      const p2 = params[2];
      const solution = params[3];

      let nTime = p1;
      let nonce = p2;
      if (!isNTimeHex(p1) && isNTimeHex(p2)) { nTime = p2; nonce = p1; }

      return { worker: null, jobId, nTime: asHex(nTime), nonce: asHex(nonce), solution: asHex(solution) };
    }

    return { worker: null, jobId: null, nTime: null, nonce: null, solution: null };
  }

  previewHex(value) {
    if (typeof value !== "string") return "n/a";
    const normalized = value.trim().toLowerCase().replace(/^0x/, "");
    if (!normalized) return "empty";
    if (normalized.length <= 24) return normalized;
    return `${normalized.slice(0, 12)}...${normalized.slice(-12)}`;
  }

  respondSubmit(client, id, result, error = null) {
    this.send(client, { id, result, error });
  }

  recordShareOutcome(client, outcome = {}) {
    if (!client || !client.metrics) return;
    const now = Date.now();
    const metrics = client.metrics;
    const accepted = outcome.accepted === true;
    const shareDiff = Number(outcome.shareDifficulty);
    const foundDiff = Number(outcome.foundDifficulty);

    metrics.lastShareAt = new Date(now).toISOString();

    if (accepted) {
      metrics.accepted += 1;
      const assignedDiff = Number(outcome.assignedDifficulty);
      const diffContribution =
        Number.isFinite(assignedDiff) && assignedDiff > 0
          ? assignedDiff
          : Math.max(Number(client.currentDifficulty) || 0, 0);
      metrics.recentAccepted.push({ ts: now, difficulty: diffContribution });

      // Update EWMA using inter-share timing.
      // alpha = 1 - e^(-dt/halfLife) gives a time-continuous EMA where the
      // half-life equals hashrateWindowSeconds.  Long gaps pull the estimate
      // down; bursts pull it up; stable mining converges to the true rate.
      const prevMs = metrics.lastAcceptedMs;
      metrics.lastAcceptedMs = now;
      if (prevMs && now > prevMs) {
        const dt = (now - prevMs) / 1000;
        const instantaneous = (diffContribution * this.solutionRateScale) / dt;
        const halfLife = this.hashrateWindowSeconds;
        const alpha = 1 - Math.exp(-dt / halfLife);
        metrics.ewmaHashrate = alpha * instantaneous + (1 - alpha) * (metrics.ewmaHashrate || 0);
      } else if (!prevMs) {
        // First share of this session: seed with a rough estimate assuming vardiff targetTime
        const seedDt = Math.max(1, this.vardiff.targetTime || 30);
        metrics.ewmaHashrate = (diffContribution * this.solutionRateScale) / seedDt;
      }

      const effectiveDiff = Number.isFinite(foundDiff) && foundDiff > 0
        ? foundDiff
        : shareDiff;
      if (Number.isFinite(effectiveDiff) && effectiveDiff > metrics.bestShareDifficulty) {
        metrics.bestShareDifficulty = effectiveDiff;
        metrics.bestShareHash = outcome.hash || metrics.bestShareHash;
      }
      if (Number.isFinite(foundDiff) && foundDiff > 0) {
        metrics.lastBlockDifficulty = foundDiff;
      }
    } else {
      metrics.rejected += 1;
      const reason = String(outcome.reason || "").toLowerCase();
      if (reason.includes("invalid")) metrics.invalid += 1;
      else if (reason.includes("low diff")) metrics.lowDiff += 1;
      else if (reason.includes("expired") || reason.includes("stale")) metrics.stale += 1;
    }

    const retentionMs = this.hashrateWindowSeconds * 1000;
    metrics.recentAccepted = metrics.recentAccepted.filter((s) => now - s.ts <= retentionMs);
  }

  estimateHashrate(client, windowSeconds = null) {
    if (!client || !client.metrics) return 0;
    const now = Date.now();
    const effectiveWindow = Number.isFinite(Number(windowSeconds)) && Number(windowSeconds) > 0
      ? Number(windowSeconds)
      : this.hashrateWindowSeconds;
    const safeWindowSeconds = Math.max(10, effectiveWindow);
    const windowMs = safeWindowSeconds * 1000;
    const shares = client.metrics.recentAccepted.filter((s) => now - s.ts <= windowMs);

    // If no shares in the window the miner is idle/offline — return 0 so the
    // pool hashrate and effort calculations correctly reflect no active work.
    if (!shares.length) return 0;

    const totalDifficulty = shares.reduce((sum, s) => sum + Math.max(0, Number(s.difficulty) || 0), 0);
    if (totalDifficulty <= 0) return 0;

    // Window estimate: total difficulty normalised over the full window.
    // This is the correct unbiased estimator but has high variance when
    // the window contains only ~10-20 shares (typical for Equihash ASICs).
    const windowEstimate = (totalDifficulty * this.solutionRateScale) / safeWindowSeconds;

    // EWMA estimate: updated on every accepted share using inter-share timing.
    // Much lower variance than the window estimate for sparse share streams.
    // Only blend it in when the miner is actively submitting (shares exist in
    // the window) so that idle/offline miners still correctly report 0.
    const ewma = client.metrics.ewmaHashrate || 0;
    if (ewma > 0) {
      // 30% window (keeps reaction to genuine hashrate changes) +
      // 70% EWMA (smooths out Poisson variance between share bursts).
      return 0.3 * windowEstimate + 0.7 * ewma;
    }

    return windowEstimate;
  }

  sendJob(client, job) {
    if (!client.socket || client.socket.destroyed) return;

    if (this.protocolMode === "zip301" || this.protocolMode === "zip301_notify") {
      // ZIP 301 mining.notify:
      // ["JOB_ID","VERSION","PREVHASH","MERKLEROOT","RESERVED","TIME","BITS",CLEAN_JOBS]
      // All fields encoded as in the Zcash block header (little-endian for int32/uint32 and 32-byte hashes).
      const versionLE = job._versionLE || job.version || "04000000";
      const prevhashLE = job._prevhashLE || job.prevhash;
      const merkleRootLE = job._merkleRootLE || job.merkleRoot;
      const reservedLE = job._reservedLE || "0".repeat(64);
      const timeLE = job._ntimeLE || job.ntime;
      const bitsLE = job.nbitsLE || this.reverseHexBytes(job.nbits);

      const params = [job.jobId, versionLE, prevhashLE, merkleRootLE, reservedLE, timeLE, bitsLE, job.cleanJobs];
      this.send(client, { method: "mining.notify", params, id: null });
      return;
    }

    // Legacy/custom notify presets (kept for experimentation)
    const preset = this.notifyPreset;

    let version = preset === "display" ? (job._versionBE || job.version) : (job._versionLE_forNotify || job.version);
    if (this.notifyVersionEndian === "be") {
      version = (job._versionBE || version);
    } else if (this.notifyVersionEndian === "le") {
      version = (job._versionLE_forNotify || version);
    }

    const prevhash = preset === "display" ? (job._prevhashBE || job.prevhash) : (job._prevhashLE_forNotify || job.prevhash);
    const merkleRoot = preset === "display" ? (job._merkleRootBE || job.merkleRoot) : (job._merkleRootLE_forNotify || job.merkleRoot);

    let reserved;
    const mode = this.notifyReservedMode;
    if (mode === "empty") {
      reserved = "";
    } else if (mode === "zero32") {
      reserved = "0".repeat(64);
    } else {
      reserved = preset === "display" ? (job._reservedBE || job.reserved) : (job._reservedLE || job.reserved);
    }

    const ntime = job.ntime;
    const nbits = job.nbits;

    const params =
      this.notifyFormat === "zcash"
        ? [job.jobId, version, prevhash, merkleRoot, reserved, ntime, nbits, job.cleanJobs]
        : [job.jobId, prevhash, merkleRoot, reserved, version, nbits, ntime, job.cleanJobs];

    this.send(client, { method: "mining.notify", params, id: null });
  }

  noteAcceptedShare(client) {
    if (!client || !this.vardiff.enabled) return { changed: false };

    const now = Date.now();
    client.shareTimes.push(now);

    // Keep a longer window so we have enough data to judge real throughput.
    // Use 4x retargetTime to survive bursty Equihash variance.
    const retentionMs = this.vardiff.retargetTime * 1000 * 4;
    client.shareTimes = client.shareTimes.filter((ts) => now - ts <= retentionMs);
    // Hard cap to prevent unbounded growth at very high share rates.
    if (client.shareTimes.length > 120) client.shareTimes.splice(0, client.shareTimes.length - 120);

    if (client.shareTimes.length < this.vardiff.minSamples) return { changed: false };
    if (now - client.lastRetargetAt < this.vardiff.retargetTime * 1000) return { changed: false };

    // Average interval = total wall-clock time / number of share intervals.
    // This naturally includes long idle gaps between bursts.
    const totalElapsed = (client.shareTimes[client.shareTimes.length - 1] - client.shareTimes[0]) / 1000;
    const intervals = client.shareTimes.length - 1;
    const avg = intervals > 0 ? totalElapsed / intervals : this.vardiff.targetTime;

    const variance = this.vardiff.variancePercent / 100;
    const minOk = this.vardiff.targetTime * (1 - variance);
    const maxOk = this.vardiff.targetTime * (1 + variance);

    client.lastRetargetAt = now;
    if (avg >= minOk && avg <= maxOk) return { changed: false };

    // Asymmetric dampening: increase slowly (max 1.5x), decrease aggressively (min 0.33x).
    // Equihash share finding is inherently bursty — the cost of overshooting difficulty
    // (minutes of silence) is far worse than undershooting (a few extra cheap shares).
    const ratio = this.vardiff.targetTime / Math.max(avg, 0.001);
    const dampened = ratio > 1 ? Math.min(ratio, 1.5) : Math.max(ratio, 0.33);
    const proposed = this.clampDifficulty(client.currentDifficulty * dampened);
    const changeRatio = Math.abs(proposed - client.currentDifficulty) / Math.max(client.currentDifficulty, 1e-8);
    if (changeRatio < 0.05) return { changed: false };

    const old = client.currentDifficulty;
    this.applyDifficulty(client, proposed, true);
    return { changed: true, oldDifficulty: old, newDifficulty: client.currentDifficulty, avgInterval: avg };
  }

  // Kick clients that haven't sent any data (shares, subscribe, authorize, etc.)
  // within inactiveTimeoutMs. This handles the case where socket.setTimeout does
  // not fire because the pool keeps writing outbound job notifications to the socket.
  kickInactiveClients() {
    const now = Date.now();
    for (const [, client] of this.clients) {
      const idle = now - (client.lastReceivedAt || client.connectedAt || now);
      if (idle < this.inactiveTimeoutMs) continue;
      const worker = client.workerName || `miner-${client.id}`;
      this.logger.warn(
        `[Stratum] Kicking inactive client #${client.id} worker=${worker} (no data for ${Math.floor(idle / 1000)}s)`
      );
      client.socket.destroy();
    }
  }

  // Called periodically to reduce difficulty for miners that haven't submitted
  // shares in a long time. Without this, a miner stuck at high difficulty
  // can't trigger noteAcceptedShare often enough to ever get reduced.
  checkIdleMinersVardiff() {
    if (!this.vardiff.enabled) return;
    const now = Date.now();
    const idleThresholdMs = this.vardiff.targetTime * 3 * 1000; // 3x target = too slow

    for (const client of this.clients.values()) {
      if (!client.authorized) continue;

      const lastShareAt = client.shareTimes.length > 0
        ? client.shareTimes[client.shareTimes.length - 1]
        : client.connectedAt;
      const idleMs = now - lastShareAt;

      if (idleMs < idleThresholdMs) continue;
      if (client.currentDifficulty <= this.vardiff.minDifficulty) continue;
      // Don't reduce more than once per retarget interval
      if (now - client.lastRetargetAt < this.vardiff.retargetTime * 1000) continue;

      // Halve difficulty for idle miners
      const old = client.currentDifficulty;
      const proposed = this.clampDifficulty(old * 0.5);
      if (proposed >= old) continue;

      client.lastRetargetAt = now;
      this.applyDifficulty(client, proposed, true);
      this.logger.info(
        `[VarDiff] Idle retarget Miner #${client.id} diff ${this.formatDifficulty(old)} -> ${this.formatDifficulty(proposed)} (idle ${(idleMs / 1000).toFixed(0)}s)`
      );
    }
  }

  applyDifficulty(client, difficulty, sendUpdate = true) {
    // Preserve previous target for a grace window so in-flight shares aren't rejected.
    // Only keep previous target when difficulty is INCREASING (the case that causes Low Diff rejects).
    const oldTarget = client.shareTarget;
    const newDifficulty = this.clampDifficulty(difficulty);
    if (oldTarget && newDifficulty > client.currentDifficulty) {
      // Grace window: 30 seconds for in-flight shares computed at the old (easier) difficulty
      client.previousShareTarget = oldTarget;
      client.previousTargetExpiresAt = Date.now() + 30_000;
    } else {
      // Difficulty staying the same or decreasing: clear any stale grace period.
      // The new target is easier, so old shares would pass it anyway.
      client.previousShareTarget = null;
      client.previousTargetExpiresAt = 0;
    }

    client.currentDifficulty = newDifficulty;
    client.shareTarget = this.targetForDifficulty(client.currentDifficulty);

    if (sendUpdate && client.authorized) {
      this.send(client, { method: "mining.set_difficulty", params: [client.currentDifficulty], id: null });
      if (this.useSetTarget) {
        this.send(client, { method: "mining.set_target", params: [client.shareTarget], id: null });
      }
    }
  }

  clampDifficulty(value) {
    const min = Math.min(this.vardiff.minDifficulty, this.vardiff.maxDifficulty);
    const max = Math.max(this.vardiff.minDifficulty, this.vardiff.maxDifficulty);
    return Math.max(min, Math.min(max, Number(value) || this.vardiff.initialDifficulty));
  }

  targetForDifficulty(difficulty) {
    const precision = 1000000n;
    const denom = BigInt(Math.max(1, Math.round(difficulty * Number(precision))));
    const scaled = this.baseTargetBI * precision;
    const targetBI = scaled / denom;
    const bounded = targetBI > this.maxTarget ? this.maxTarget : targetBI;
    const clamped = bounded <= 0n ? 1n : bounded;
    return clamped.toString(16).padStart(64, "0");
  }

  normalizeTarget(target) {
    if (typeof target !== "string") return null;
    const normalized = target.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{1,64}$/.test(normalized)) return null;
    return normalized.padStart(64, "0");
  }

  broadcastJob(job) {
    this.lastJob = job;

    // Pre-serialize the notify payload once and reuse for every connected client.
    // JSON.stringify is non-trivial; calling it N times per broadcast is wasteful.
    // All clients share the same protocol mode so the payload is identical for all.
    const payload = this._buildNotifyPayload(job);

    this.clients.forEach((c) => {
      if (!c.authorized || !c.socket || c.socket.destroyed) return;
      if (c.socket.writableLength > this.maxBufferBytes) {
        this.logger.warn(`[Stratum] Outbound backlog exceeded for #${c.id} (${c.socket.writableLength} bytes), closing`);
        c.socket.destroy();
        return;
      }
      try { c.socket.write(payload); } catch (err) {
        this.logger.warn(`[Stratum] Write failed to #${c.id}: ${err.message}`);
      }
    });
  }

  _buildNotifyPayload(job) {
    let params;
    if (this.protocolMode === "zip301" || this.protocolMode === "zip301_notify") {
      const versionLE = job._versionLE || job.version || "04000000";
      const prevhashLE = job._prevhashLE || job.prevhash;
      const merkleRootLE = job._merkleRootLE || job.merkleRoot;
      const reservedLE = job._reservedLE || "0".repeat(64);
      const timeLE = job._ntimeLE || job.ntime;
      const bitsLE = job.nbitsLE || this.reverseHexBytes(job.nbits);
      params = [job.jobId, versionLE, prevhashLE, merkleRootLE, reservedLE, timeLE, bitsLE, job.cleanJobs];
    } else {
      // Legacy/custom notify path — mirror the logic from sendJob
      const preset = this.notifyPreset;
      let version = preset === "display" ? (job._versionBE || job.version) : (job._versionLE_forNotify || job.version);
      if (this.notifyVersionEndian === "be") version = (job._versionBE || version);
      else if (this.notifyVersionEndian === "le") version = (job._versionLE_forNotify || version);
      const prevhash = preset === "display" ? (job._prevhashBE || job.prevhash) : (job._prevhashLE_forNotify || job.prevhash);
      const merkleRoot = preset === "display" ? (job._merkleRootBE || job.merkleRoot) : (job._merkleRootLE_forNotify || job.merkleRoot);
      const mode = this.notifyReservedMode;
      const reserved = mode === "empty" ? "" : mode === "zero32" ? "0".repeat(64)
        : (preset === "display" ? (job._reservedBE || job.reserved) : (job._reservedLE || job.reserved));
      params = this.notifyFormat === "zcash"
        ? [job.jobId, version, prevhash, merkleRoot, reserved, job.ntime, job.nbits, job.cleanJobs]
        : [job.jobId, prevhash, merkleRoot, reserved, version, job.nbits, job.ntime, job.cleanJobs];
    }
    return JSON.stringify({ method: "mining.notify", params, id: null }) + "\n";
  }

  send(client, data) {
    if (client && client.socket && !client.socket.destroyed) {
      if (this.logOutbound) {
        try {
          this.logger.debug(`[Stratum][TX] -> #${client.id} ${JSON.stringify(data)}`);
        } catch (_) {}
      }
      try {
        const payload = JSON.stringify(data) + "\n";
        // Guard against unbounded outbound buffer growth: if the write backlog
        // exceeds the same 16 KB cap used for inbound, the client is too slow
        // to consume data (network stall or malicious hold-open). Disconnect it.
        if (client.socket.writableLength > this.maxBufferBytes) {
          this.logger.warn(
            `[Stratum] Outbound backlog exceeded for #${client.id} (${client.socket.writableLength} bytes), closing`
          );
          client.socket.destroy();
          return;
        }
        client.socket.write(payload);
      } catch (err) {
        this.logger.warn(`[Stratum] Write failed to #${client.id}: ${err.message}`);
      }
    }
  }
}

module.exports = StratumServer;
