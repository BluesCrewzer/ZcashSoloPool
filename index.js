const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const ZcashRPC = require("./lib/zcashRpc");
const StratumServer = require("./lib/stratumServer");
const WorkManager = require("./lib/workManager");
const ApiServer = require("./lib/apiServer");
const WebGuiServer = require("./lib/webguiServer");
const { Logger } = require("./lib/logger");

class ZCashSoloPool {
  constructor(configPath) {
    this.config = this.loadConfig(configPath);
    this.startedAt = Date.now();

    this.logger = new Logger(this.config.logging || {});
    this.rpc = new ZcashRPC(this.config.zcash, this.logger);
    this.wm = new WorkManager(this.rpc, this.config.zcash.walletAddress, this.logger, this.config.pool || {});
    this.stratum = new StratumServer(this.config.pool || {}, this.logger);

    this.stats = {
      shares: 0,
      rejectedShares: 0,
      blocks: 0,
      blockCandidates: 0,
      blockSubmitsRejected: 0,
      miners: 0,
      lastShareAt: null,
      lastBlockAt: null,
      lastBlockHash: null,
      lastBlockDifficulty: null,
      lastBlockSubmitResult: null,
      lastBlockWorker: null,
      lastBlockReward: null,
      lastBlockHeight: null,
    };

    this.cachedNetwork = null;

    this.recentBlockSubmissions = new Map();
    const dedupWindow = Number(this.config.pool && this.config.pool.blockSubmitDedupWindowMs);
    this.blockSubmitDedupWindowMs = Number.isFinite(dedupWindow) && dedupWindow >= 0 ? dedupWindow : 120000;
    this.jobUpdateInFlight = null;
    this.jobUpdateQueued = false;
    this.jobUpdateQueuedClean = false;
    this.minerPing = this.buildMinerPingConfig(this.config.pool || {});
    this.pingSweepInFlight = false;
    this.pingCommandUnavailable = false;

    // Tracks when effort clock last reset (pool start, miner dropout, or block found in session)
    this.effortResetAt = this.startedAt;

    this.allTimeBestShare = { difficulty: 0, hash: null, worker: null, at: null };
    this.blockHistory = [];
    this.maxBlockHistory = 200;

    this.statePath = path.resolve(path.dirname(
      path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath)
    ), "pool-state.json");
    this.loadPersistedState();

    this.api = new ApiServer(
      this.config.api || {},
      {
        getHealth: () => this.getApiHealth(),
        getStats: () => this.getApiStats(),
        getMiners: () => this.getApiMiners(),
        getNetwork: () => this.getApiNetwork(),
        getJob: () => this.getApiJob(),
      },
      this.logger
    );

    this.webgui = new WebGuiServer(
      this.config.webgui || {},
      this.config.api || {},
      this.logger,
      this.config.pool || {}
    );
  }

  loadConfig(configPath) {
    const resolvedPath = path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
    const raw = fs.readFileSync(resolvedPath, "utf8");
    return JSON.parse(raw);
  }

  loadPersistedState() {
    try {
      if (!fs.existsSync(this.statePath)) return;
      const raw = fs.readFileSync(this.statePath, "utf8");
      const saved = JSON.parse(raw);
      if (saved.lastBlock) {
        this.stats.lastBlockAt = saved.lastBlock.at || null;
        this.stats.lastBlockHash = saved.lastBlock.hash || null;
        this.stats.lastBlockDifficulty = saved.lastBlock.difficulty || null;
        this.stats.lastBlockSubmitResult = saved.lastBlock.submitResult || null;
        this.stats.lastBlockWorker = saved.lastBlock.worker || null;
        this.stats.lastBlockReward = saved.lastBlock.reward || null;
        this.stats.lastBlockHeight = saved.lastBlock.height || null;
      }
      if (saved.totals) {
        this.stats.blocks = saved.totals.blocks || 0;
        this.stats.blockCandidates = saved.totals.blockCandidates || 0;
        this.stats.blockSubmitsRejected = saved.totals.blockSubmitsRejected || 0;
      }
      if (saved.allTimeBestShare && saved.allTimeBestShare.difficulty > 0) {
        this.allTimeBestShare = saved.allTimeBestShare;
      }
      if (Array.isArray(saved.blockHistory)) {
        this.blockHistory = saved.blockHistory;
      }
      this.logger.info(`[State] Loaded persisted state from ${this.statePath} (${this.blockHistory.length} blocks in history)`);
    } catch (e) {
      this.logger.warn(`[State] Could not load persisted state: ${e.message}`);
    }
  }

  savePersistedState() {
    const data = {
      savedAt: new Date().toISOString(),
      lastBlock: {
        at: this.stats.lastBlockAt,
        hash: this.stats.lastBlockHash,
        difficulty: this.stats.lastBlockDifficulty,
        submitResult: this.stats.lastBlockSubmitResult,
        worker: this.stats.lastBlockWorker,
        reward: this.stats.lastBlockReward,
        height: this.stats.lastBlockHeight,
      },
      totals: {
        blocks: this.stats.blocks,
        blockCandidates: this.stats.blockCandidates,
        blockSubmitsRejected: this.stats.blockSubmitsRejected,
        shares: this.stats.shares,
        rejectedShares: this.stats.rejectedShares,
      },
      allTimeBestShare: this.allTimeBestShare,
      blockHistory: this.blockHistory,
    };
    try {
      const tmp = this.statePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, this.statePath);
    } catch (e) {
      this.logger.warn(`[State] Failed to save state: ${e.message}`);
    }
  }

  normalizeBlockKey(hash) {
    return String(hash || "").toLowerCase().replace(/^0x/, "");
  }

  parsePositiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  parseNonNegativeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  getNetworkSolutionRate(info = this.cachedNetwork) {
    if (!info || typeof info !== "object") return null;
    return (
      this.parsePositiveNumber(info.networksolps) ||
      this.parsePositiveNumber(info.networkSolps) ||
      this.parsePositiveNumber(info.networkhashps) ||
      this.parsePositiveNumber(info.networkHashrate) ||
      null
    );
  }

  getBlockReward() {
    const height = this.cachedNetwork ? this.cachedNetwork.blocks : null;
    if (!height) return "1.25 ZEC";
    // Zcash halving every 1,050,000 blocks (post-Blossom), first halving at block 1,046,400
    // Initial subsidy 12.5 ZEC (pre-Blossom equivalent), halved to 6.25, then 3.125, then 1.5625...
    // After NU5 the miner share is 80% of the block subsidy
    // Current era (halving 2): base subsidy = 3.125 ZEC, miner gets 80% = 2.5 ZEC
    // But with the second halving the subsidy is 1.5625, miner gets 80% = 1.25 ZEC
    // For simplicity, use the configured or default value
    return (this.config.pool && this.config.pool.blockReward) || "1.25 ZEC";
  }

  getNetworkRateSource() {
    if (this.rpc && typeof this.rpc.getNetworkRateSource === "function") {
      return this.rpc.getNetworkRateSource();
    }
    return { method: null, params: [], unsupported: false };
  }

  buildMinerPingConfig(poolConfig = {}) {
    const cfg = poolConfig.minerPing || {};
    const intervalMinutes = Number(cfg.intervalMinutes);
    const timeoutMs = Number(cfg.timeoutMs);
    return {
      enabled: cfg.enabled === true,
      intervalMinutes: Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 5,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 200 ? timeoutMs : 1500,
      logResults: cfg.logResults !== false,
    };
  }

  pingHost(host, timeoutMs) {
    return new Promise((resolve) => {
      const platform = process.platform;
      const safeTimeoutMs = Math.max(200, Number(timeoutMs) || 1500);
      let args;
      if (platform === "win32") {
        args = ["-n", "1", "-w", String(safeTimeoutMs), host];
      } else if (platform === "darwin") {
        args = ["-n", "-c", "1", "-W", String(safeTimeoutMs), host];
      } else {
        const waitSeconds = Math.max(1, Math.ceil(safeTimeoutMs / 1000));
        args = ["-n", "-c", "1", "-W", String(waitSeconds), host];
      }

      execFile("ping", args, { timeout: safeTimeoutMs + 1000 }, (error, stdout = "", stderr = "") => {
        const output = `${stdout}\n${stderr}`;
        const rttMatch = /time[=<]\s*([0-9.]+)\s*ms/i.exec(output);
        if (!error && rttMatch) {
          return resolve({ ok: true, latencyMs: Number(rttMatch[1]) });
        }
        if (!error) return resolve({ ok: true, latencyMs: null });
        if (error.code === "ENOENT") return resolve({ ok: false, unavailable: true, error: "ping command not found" });
        return resolve({
          ok: false,
          error: String((stderr || stdout || error.message || "ping failed")).trim().split("\n")[0].slice(0, 200),
        });
      });
    });
  }

  normalizePingAddress(address) {
    const raw = String(address || "").trim();
    if (!raw) return null;
    if (raw.startsWith("::ffff:")) return raw.slice(7);
    return raw;
  }

  async runMinerPingSweep() {
    if (!this.minerPing.enabled || this.pingSweepInFlight || this.pingCommandUnavailable) return;
    this.pingSweepInFlight = true;
    try {
      // Group authorized clients by normalized host to avoid pinging the same IP
      // multiple times (e.g. miners behind the same NAT/forwarder).
      const hostMap = new Map();
      this.stratum.clients.forEach((client) => {
        if (!client || !client.authorized) return;
        const host = this.normalizePingAddress(client.socket && client.socket.remoteAddress);
        if (!host) return;
        if (!hostMap.has(host)) hostMap.set(host, []);
        hostMap.get(host).push(client);
      });
      if (!hostMap.size) return;

      // Ping all unique hosts in parallel.
      const hosts = [...hostMap.keys()];
      const results = await Promise.all(
        hosts.map((host) => this.pingHost(host, this.minerPing.timeoutMs))
      );

      for (let i = 0; i < hosts.length; i++) {
        const host = hosts[i];
        const result = results[i];
        if (result.unavailable) {
          this.pingCommandUnavailable = true;
          this.logger.warn("[Ping] ping command not found; disabling miner ping sweep");
          break;
        }
        for (const client of hostMap.get(host)) {
          const m = client.metrics || {};
          m.lastPingAt = new Date().toISOString();
          if (result.ok) {
            m.lastPingMs = Number.isFinite(result.latencyMs) ? Number(result.latencyMs.toFixed(2)) : null;
            m.lastPingStatus = "ok";
            m.lastPingError = null;
            m.pingSuccesses = (m.pingSuccesses || 0) + 1;
            if (this.minerPing.logResults) {
              this.logger.info(
                `[Ping] worker=${client.workerName || `miner-${client.id}`} ip=${host} status=ok latency=${m.lastPingMs != null ? `${m.lastPingMs}ms` : "n/a"}`
              );
            }
          } else {
            m.lastPingMs = null;
            m.lastPingStatus = "fail";
            m.lastPingError = result.error || "ping failed";
            m.pingFailures = (m.pingFailures || 0) + 1;
            if (this.minerPing.logResults) {
              this.logger.warn(
                `[Ping] worker=${client.workerName || `miner-${client.id}`} ip=${host} status=fail error=${m.lastPingError}`
              );
            }
          }
        }
      }
    } finally {
      this.pingSweepInFlight = false;
    }
  }

  computeShareDifficulty(client, shareQuality) {
    const base = this.parsePositiveNumber(client && client.currentDifficulty) || 0;
    const quality = this.parsePositiveNumber(shareQuality) || 1;
    return base * quality;
  }

  formatScaledNumber(value, decimals = 3) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "n/a";
    const sign = n < 0 ? "-" : "";
    let v = Math.abs(n);
    const units = ["", "K", "M", "G", "T", "P", "E"];
    let i = 0;
    while (v >= 1000 && i < units.length - 1) {
      v /= 1000;
      i += 1;
    }
    const precision = v >= 100 ? 1 : v >= 10 ? 2 : decimals;
    return `${sign}${v.toFixed(precision)}${units[i]}`;
  }

  formatDifficulty(value) {
    // Delegate to stratumServer so there is a single implementation (with the full unit set)
    return this.stratum.formatDifficulty(value);
  }

  formatSolutionsRate(hashrate) {
    const rate = this.parsePositiveNumber(hashrate) || 0;
    if (rate <= 0) return "0 Sol/s";
    const units = ["Sol/s", "KSol/s", "MSol/s", "GSol/s", "TSol/s"];
    let value = rate;
    let i = 0;
    while (value >= 1000 && i < units.length - 1) {
      value /= 1000;
      i += 1;
    }
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
  }

  computeConnectedSeconds(client) {
    if (!client || !Number.isFinite(Number(client.connectedAt))) return null;
    const seconds = Math.floor((Date.now() - Number(client.connectedAt)) / 1000);
    return Math.max(0, seconds);
  }

  formatDuration(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n < 0) return "n/a";
    const total = Math.floor(n);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  }

  countAuthorizedMiners() {
    let authorized = 0;
    this.stratum.clients.forEach((client) => { if (client.authorized) authorized++; });
    return authorized;
  }

  getPoolSolutionRate() {
    let total = 0;
    this.stratum.clients.forEach((client) => {
      if (!client || !client.authorized) return;
      total += this.stratum.estimateHashrate(client);
    });
    return total;
  }

  computeAverageLuck() {
    const withEffort = this.blockHistory.filter((b) => Number.isFinite(b.effortPercent) && b.effortPercent > 0).slice(-10);
    if (!withEffort.length) return null;
    const sum = withEffort.reduce((acc, b) => acc + b.effortPercent, 0);
    return Number((sum / withEffort.length).toFixed(2));
  }

  getNodeStatus(info = this.cachedNetwork) {
    if (!info || typeof info !== "object") return null;

    const peerSummary = info.peerSummary && typeof info.peerSummary === "object" ? info.peerSummary : {};
    const totalPeers = this.parseNonNegativeNumber(peerSummary.total ?? info.connections);
    const inboundPeers = this.parseNonNegativeNumber(peerSummary.inbound ?? info.incomingPeers);
    const outboundPeers = this.parseNonNegativeNumber(peerSummary.outbound ?? info.outgoingPeers);

    return {
      software: info.subversion || "zebrad",
      version: info.version ?? null,
      protocolVersion: info.protocolversion ?? null,
      connections: totalPeers,
      incomingPeers: inboundPeers,
      outgoingPeers: outboundPeers,
    };
  }

  buildApiMiner(client, options = {}) {
    const includeAddress = options.includeAddress === true;
    const m = client.metrics || {};
    const connectedSeconds = this.computeConnectedSeconds(client);
    const hashrate = this.stratum.estimateHashrate(client);

    const miner = {
      id: client.id,
      worker: client.workerName || `miner-${client.id}`,
      difficulty: Number(client.currentDifficulty.toFixed(6)),
      difficultyText: this.formatDifficulty(client.currentDifficulty),
      hashrate,
      hashrateText: this.formatSolutionsRate(hashrate),
      hashrateEwma: Math.round(m.ewmaHashrate || 0),
      hashrateEwmaText: this.formatSolutionsRate(m.ewmaHashrate || 0),
      solutionRate: hashrate,
      solutionRateText: this.formatSolutionsRate(hashrate),
      connectedAt: client.connectedAt ? new Date(client.connectedAt).toISOString() : null,
      connectedSeconds,
      connectedText: this.formatDuration(connectedSeconds),
      acceptedShares: m.accepted || 0,
      rejectedShares: m.rejected || 0,
      blocksFound: m.blocksFound || 0,
      invalidShares: m.invalid || 0,
      lowDiffShares: m.lowDiff || 0,
      staleShares: m.stale || 0,
      bestShareDifficulty: Number((m.bestShareDifficulty || 0).toFixed(6)),
      lastBlockDifficulty: Number((m.lastBlockDifficulty || 0).toFixed(6)),
      bestDiffText: this.formatDifficulty(m.bestShareDifficulty || 0),
      lastBlockDiffText: this.formatDifficulty(m.lastBlockDifficulty || 0),
      bestShareDifficultyText: this.formatDifficulty(m.bestShareDifficulty || 0),
      bestShareHash: m.bestShareHash || null,
      lastShareAt: m.lastShareAt || null,
      pingMs: Number.isFinite(Number(m.lastPingMs)) ? Number(m.lastPingMs) : null,
      pingStatus: m.lastPingStatus || null,
      pingAt: m.lastPingAt || null,
      pingFailures: m.pingFailures || 0,
      pingSuccesses: m.pingSuccesses || 0,
      pingError: m.lastPingError || null,
    };

    if (includeAddress) {
      miner.address = client.socket && client.socket.remoteAddress;
      miner.port = client.socket && client.socket.remotePort;
      miner.shareTarget = client.shareTarget;
    }

    return miner;
  }

  async updateJob(clean) {
    const requestedClean = clean === true;

    if (this.jobUpdateInFlight) {
      this.jobUpdateQueued = true;
      if (requestedClean) this.jobUpdateQueuedClean = true;
      return this.jobUpdateInFlight;
    }

    this.jobUpdateInFlight = (async () => {
      let runAnother = true;
      let forceClean = requestedClean;

      while (runAnother) {
        try {
          const job = await this.wm.generateJob(forceClean);
          this.stratum.broadcastJob(job);
          this.logger.info(`>>> Job Broadcast: Height ${job.height} | txs ${(job.template.transactions || []).length}`);
        } catch (err) {
          this.logger.error(`[UpdateJob] generateJob failed: ${err.message}`);
          break;
        }

        runAnother = this.jobUpdateQueued;
        forceClean = this.jobUpdateQueuedClean;
        this.jobUpdateQueued = false;
        this.jobUpdateQueuedClean = false;
      }
    })();

    const inflight = this.jobUpdateInFlight;
    try {
      await inflight;
    } finally {
      // Identity check prevents a concurrent caller from nulling out a
      // newer in-flight promise if two callers race through here.
      if (this.jobUpdateInFlight === inflight) this.jobUpdateInFlight = null;
    }
  }

  async submitBlockCandidate(res) {
    try {
      // Pre-flight nBits check: header bits (bytes 104-107) must match the template.
      // A mismatch means a non-canonical endianness variant slipped through validation
      // and the node will reject the block with "bad-diffbits".
      if (res.jobNbits && res.blockHex && res.blockHex.length >= 216) {
        const headerBitsLE = res.blockHex.slice(208, 216);
        const canonicalBitsLE = this.wm.normalizeCompactBitsLE(res.jobNbits);
        if (headerBitsLE !== canonicalBitsLE) {
          this.logger.warn(
            `[BLOCK] nBits mismatch: header=${headerBitsLE} template=${res.jobNbits} (expected LE: ${canonicalBitsLE}) — node will likely reject`
          );
        }
      }
      const rpcResult = await this.rpc.submitBlock(res.blockHex);
      const netDiff = this.parsePositiveNumber(this.cachedNetwork && this.cachedNetwork.difficulty);
      const foundDiff = netDiff && this.parsePositiveNumber(res.networkQuality)
        ? netDiff * Number(res.networkQuality)
        : null;
      const minerLabel = res.worker || (Number.isFinite(Number(res.minerId)) ? `miner-${res.minerId}` : "unknown");
      const netDiffText = this.formatDifficulty(netDiff);
      const foundDiffText = this.formatDifficulty(foundDiff);

      if (rpcResult == null) {
        // Capture effort start BEFORE updating lastBlockAt (previous block time or pool start)
        const effortStart = this.stats.lastBlockAt ? Date.parse(this.stats.lastBlockAt) : this.startedAt;
        const now = Date.now();
        const actualSeconds = Math.max(1, (now - effortStart) / 1000);

        this.stats.blocks++;
        this.stats.lastBlockAt = new Date(now).toISOString();
        this.effortResetAt = now; // reset effort clock for next block
        this.stats.lastBlockHash = res.hash;
        this.stats.lastBlockDifficulty = foundDiff ? Number(foundDiff.toFixed(6)) : null;
        this.stats.lastBlockSubmitResult = "accepted";
        this.stats.lastBlockWorker = minerLabel;
        this.stats.lastBlockHeight = res.height || (this.wm.getCurrentJob() ? this.wm.getCurrentJob().height : null);
        this.stats.lastBlockReward = this.getBlockReward();
        // Calculate per-block luck at find time
        const poolRate = this.getPoolSolutionRate();
        const netRate = this.getNetworkSolutionRate();
        const blockInterval = (this.config.pool && this.config.pool.blockIntervalSeconds) || 75;
        let effortPercent = null;
        if (poolRate > 0 && netRate > 0) {
          const expectedSeconds = (netRate / poolRate) * blockInterval;
          effortPercent = Number(((actualSeconds / expectedSeconds) * 100).toFixed(2));
        }

        const blockDifficulty = foundDiff ? Number(foundDiff.toFixed(6)) : null;
        this.blockHistory.push({
          height: res.height || (this.wm.getCurrentJob() ? this.wm.getCurrentJob().height : null),
          hash: res.hash,
          difficulty: blockDifficulty,
          difficultyText: this.formatDifficulty(blockDifficulty),
          reward: this.getBlockReward(),
          worker: minerLabel,
          at: new Date().toISOString(),
          submitResult: "accepted",
          effortPercent,
        });
        if (this.blockHistory.length > this.maxBlockHistory) {
          this.blockHistory = this.blockHistory.slice(-this.maxBlockHistory);
        }
        this.logger.warn(
          `[BLOCK] submitblock accepted by node: ${res.hash.substring(0, 16)} worker=${minerLabel} netDiff=${netDiffText} foundDiff=${foundDiffText}`
        );
        this.savePersistedState();
        return;
      }

      this.stats.blockSubmitsRejected++;
      this.stats.lastBlockSubmitResult = String(rpcResult);
      this.logger.warn(`[BLOCK] submitblock returned rejection: ${String(rpcResult)} worker=${minerLabel}`);

      try {
        const proposalResult = await this.rpc.proposeBlock(res.blockHex);
        const proposalText = proposalResult === null ? "accepted" : String(proposalResult);
        this.logger.warn(`[BLOCK] proposal validation result: ${proposalText}`);
        this.stats.lastBlockSubmitResult = `submit=${String(rpcResult)}; proposal=${proposalText}`;
      } catch (proposalError) {
        this.logger.warn(`[BLOCK] proposal validation failed: ${proposalError.message}`);
        this.stats.lastBlockSubmitResult = `submit=${String(rpcResult)}; proposalError=${proposalError.message}`;
      }
      this.savePersistedState();
    } catch (e) {
      this.stats.blockSubmitsRejected++;
      this.stats.lastBlockSubmitResult = `rpc-error: ${e.message}`;
      this.logger.error(`[BLOCK] submitblock failed: ${e.message}`);
      this.savePersistedState();
    }
  }

  isNodeWarmupError(error) {
    const code = error && error.rpc ? error.rpc.code : null;
    const msg = String(
      (error && error.rpc && error.rpc.message) ||
      (error && error.message) ||
      ""
    ).toLowerCase();

    return (
      code === -28 ||
      msg.includes("warming up") ||
      msg.includes("warmup") ||
      msg.includes("loading") ||
      msg.includes("verifying blocks") ||
      msg.includes("rescanning") ||
      msg.includes("reindex") ||
      msg.includes("downloading")
    );
  }

  async waitForNodeReady() {
    const zcashCfg = this.config.zcash || {};
    const intervalMs = Number.isFinite(Number(zcashCfg.startupRetryMs)) && Number(zcashCfg.startupRetryMs) >= 1000
      ? Number(zcashCfg.startupRetryMs)
      : 3000;
    const timeoutMs = Number.isFinite(Number(zcashCfg.startupTimeoutMs)) && Number(zcashCfg.startupTimeoutMs) >= intervalMs
      ? Number(zcashCfg.startupTimeoutMs)
      : 300000;

    const startedAt = Date.now();
    let attempt = 0;
    let lastError = null;

    while (Date.now() - startedAt <= timeoutMs) {
      attempt += 1;
      try {
        const info = await this.rpc.getInfo();
        await this.rpc.getBlockTemplate();
        return info;
      } catch (error) {
        lastError = error;
        if (!this.isNodeWarmupError(error)) throw error;

        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        const timeoutSec = Math.floor(timeoutMs / 1000);
        this.logger.warn(
          `[RPC] Node not ready yet (attempt ${attempt}, ${elapsedSec}s/${timeoutSec}s): ${error.message}`
        );
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    if (lastError) throw lastError;
    throw new Error("Timed out waiting for Zcash RPC to become ready");
  }

  async start() {
    this.logger.info("Starting ZCashSoloPool...");
    const info = await this.waitForNodeReady();
    this.cachedNetwork = info;
    this.logger.info(`Connected to node: height ${info.blocks}`);

    this.stratum.on("authorize", async () => {
      this.stats.miners = this.countAuthorizedMiners();
      if (this.minerPing.enabled) {
        this.runMinerPingSweep().catch((e) => this.logger.warn(`[Ping] sweep failed: ${e.message}`));
      }
      // The stratum server already sends lastJob + a delayed resend on authorize.
      // Do NOT call updateJob(true) here - it broadcasts a clean job to ALL miners,
      // which disrupts other miners every time one miner reconnects.
    });

    this.stratum.on("clientDisconnected", () => {
      this.stats.miners = this.countAuthorizedMiners();
      // Reset effort clock when all miners drop so stale wall-clock doesn't inflate effort on reconnect
      if (this.stats.miners === 0) this.effortResetAt = Date.now();
    });

    this.stratum.on("submit", async (submission) => {
      try {
        const res = await this.wm.validateShare(submission);

        if (res.valid) {
          const netDiff = this.parsePositiveNumber(this.cachedNetwork && this.cachedNetwork.difficulty);
          const foundDiff = res.isBlock && netDiff && this.parsePositiveNumber(res.networkQuality)
            ? netDiff * Number(res.networkQuality)
            : null;

          this.stats.shares++;
          this.stats.lastShareAt = new Date().toISOString();
          this.stratum.respondSubmit(submission.client, submission.requestId, true, null);
          const shareDifficulty = this.computeShareDifficulty(submission.client, res.shareQuality);
          this.stratum.recordShareOutcome(submission.client, {
            accepted: true,
            hash: res.hash,
            shareDifficulty,
            foundDifficulty: foundDiff,
            assignedDifficulty: submission.client.currentDifficulty,
          });

          const retarget = this.stratum.noteAcceptedShare(submission.client);
          if (retarget.changed) {
            this.logger.info(
              `[VarDiff] Miner #${submission.client.id} diff ${this.formatDifficulty(retarget.oldDifficulty)} -> ${this.formatDifficulty(retarget.newDifficulty)} (avg ${retarget.avgInterval.toFixed(2)}s/share)`
            );
          }

          const effectiveShareDiff = foundDiff || shareDifficulty;
          if (Number.isFinite(effectiveShareDiff) && effectiveShareDiff > this.allTimeBestShare.difficulty) {
            const workerName = submission.client.workerName || submission.worker || `miner-${submission.client.id}`;
            this.allTimeBestShare = {
              difficulty: effectiveShareDiff,
              hash: res.hash || null,
              worker: workerName,
              at: new Date().toISOString(),
            };
            this.logger.info(
              `[AllTimeBest] New all-time best share! diff=${this.formatDifficulty(effectiveShareDiff)} worker=${workerName} hash=${(res.hash || "").substring(0, 16)}`
            );
            this.savePersistedState();
          }

          this.logger.info(
            `Share Accepted: ${res.hash.substring(0, 16)} worker=${submission.client.workerName || submission.worker || `miner-${submission.client.id}`} diff=${this.formatDifficulty(shareDifficulty)}`
          );

          if (res.isBlock) {
            this.stats.blockCandidates++;
            const netDiffText = this.formatDifficulty(netDiff);
            const foundDiffText = this.formatDifficulty(foundDiff);
            const worker = submission.client.workerName || submission.worker || `miner-${submission.client.id}`;
            if (submission.client.metrics) {
              submission.client.metrics.blocksFound = (submission.client.metrics.blocksFound || 0) + 1;
            }
            this.logger.warn(
              `!!! BLOCK FOUND !!! hash=${res.hash.substring(0, 16)} worker=${worker} minerId=${submission.client.id} height=${this.wm.getCurrentJob() ? this.wm.getCurrentJob().height : "n/a"} netDiff=${netDiffText} foundDiff=${foundDiffText}`
            );

            const now = Date.now();
            const key = this.normalizeBlockKey(res.hash);
            const prev = this.recentBlockSubmissions.get(key);

            if (prev && now - prev < this.blockSubmitDedupWindowMs) {
              this.logger.warn(`[BLOCK] Duplicate block candidate suppressed: ${res.hash.substring(0, 16)}`);
            } else {
              this.recentBlockSubmissions.set(key, now);
                await this.submitBlockCandidate({
                ...res,
                worker,
                minerId: submission.client.id,
              });
            }

            await this.updateJob(true);
          }
        } else {
          this.stats.rejectedShares++;
          this.stratum.respondSubmit(submission.client, submission.requestId, null, [23, res.error || "Rejected", null]);
          this.stratum.recordShareOutcome(submission.client, {
            accepted: false,
            reason: res.error || "Rejected",
          });
          this.logger.debug(`Share Rejected: ${res.error || "Unknown"}`);
        }
      } catch (e) {
        this.stratum.recordShareOutcome(submission.client, {
          accepted: false,
          reason: "Internal server error",
        });
        this.logger.error(`[Submit] Handler failure: ${e.message}`);
        try { this.stratum.respondSubmit(submission.client, submission.requestId, null, [20, "Internal server error", null]); } catch (_) {}
      }
    });

    this.stratum.start();
    this.api.start();
    this.webgui.start();
    await this.updateJob(true);

    setInterval(async () => {
      try {
        // Use lightweight getblockcount (returns a single integer) instead of the full
        // getblocktemplate payload just to detect height changes. updateJob fetches the
        // full template only when the height actually advances.
        const height = await this.rpc.getBlockCount();
        const curr = this.wm.getCurrentJob();
        if (!curr || height !== curr.height) {
          this.logger.info(`[Network] New Height: ${height}`);
          await this.updateJob(true);
        }
      } catch (err) {
        this.logger.warn(`[Network] Height poll failed: ${err.message}`);
      }
    }, 2000);

    setInterval(async () => {
      try { this.cachedNetwork = await this.rpc.getInfo(); }
      catch (err) { this.logger.warn(`[API] Failed to refresh network cache: ${err.message}`); }
    }, 10000);

    // Job refresh: periodic re-broadcast to keep ASIC sessions stable during long block gaps
    const jrCfg = (this.config.pool && this.config.pool.jobRefresh) || {};
    const jrEnabled = jrCfg.enabled === true;
    const jrIntervalSec = Number.isFinite(Number(jrCfg.intervalSeconds)) && Number(jrCfg.intervalSeconds) >= 5
      ? Number(jrCfg.intervalSeconds) : 30;
    const jrClean = jrCfg.cleanJobs === true;
    if (jrEnabled) {
      this.logger.info(`[Jobs] periodic refresh enabled | interval=${jrIntervalSec}s cleanJobs=${jrClean}`);
      setInterval(async () => {
        try { await this.updateJob(jrClean); }
        catch (err) { this.logger.warn(`[Jobs] refresh failed: ${err.message}`); }
      }, jrIntervalSec * 1000);
    }

    if (this.minerPing.enabled) {
      const intervalMs = Math.max(10000, Math.round(this.minerPing.intervalMinutes * 60 * 1000));
      this.logger.info(
        `[Ping] Miner ping enabled | interval=${this.minerPing.intervalMinutes}m timeout=${this.minerPing.timeoutMs}ms`
      );
      setInterval(() => { this.runMinerPingSweep().catch((e) => this.logger.warn(`[Ping] sweep failed: ${e.message}`)); }, intervalMs);
      setTimeout(() => { this.runMinerPingSweep().catch((e) => this.logger.warn(`[Ping] sweep failed: ${e.message}`)); }, 5000);
    }

    // Periodic state save every 5 minutes
    setInterval(() => { this.savePersistedState(); }, 300000);

    // Periodic block dedup map cleanup (avoids O(n) scan on every block submission)
    setInterval(() => {
      const cutoff = Date.now() - this.blockSubmitDedupWindowMs;
      for (const [h, ts] of this.recentBlockSubmissions) if (ts < cutoff) this.recentBlockSubmissions.delete(h);
    }, this.blockSubmitDedupWindowMs);
  }

  async getApiStats() {
    const minerStats = [];
    let poolHashrate = 0;
    let authorizedCount = 0;
    this.stratum.clients.forEach((client) => {
      if (!client.authorized) return;
      authorizedCount++;
      const miner = this.buildApiMiner(client);
      minerStats.push(miner);
      poolHashrate += miner.hashrate;
    });
    this.stats.miners = authorizedCount;
    // Effort clock resets on: pool start, all miners dropping, or a block found this session.
    // Persisted lastBlockAt from a previous run must not carry over after restart.
    const lastBlockMs = this.stats.lastBlockAt ? Date.parse(this.stats.lastBlockAt) : 0;
    const sessionLastBlock = lastBlockMs > this.startedAt ? lastBlockMs : 0;
    const effortStart = Math.max(this.effortResetAt, sessionLastBlock);
    return {
      pool: (this.config.pool && this.config.pool.name) || "ZCashSoloPool",
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      secondsSinceLastBlock: Math.floor((Date.now() - effortStart) / 1000),
      miners: this.stats.miners,
      poolHashrate,
      poolHashrateText: this.formatSolutionsRate(poolHashrate),
      solutionRate: poolHashrate,
      solutionRateText: this.formatSolutionsRate(poolHashrate),
      shares: this.stats.shares,
      rejectedShares: this.stats.rejectedShares,
      blocks: this.stats.blocks,
      blockCandidates: this.stats.blockCandidates,
      blockSubmitsRejected: this.stats.blockSubmitsRejected,
      lastShareAt: this.stats.lastShareAt,
      lastBlockAt: this.stats.lastBlockAt,
      lastBlockHash: this.stats.lastBlockHash,
      lastBlockDifficulty: this.stats.lastBlockDifficulty,
      lastBlockDifficultyText: this.formatDifficulty(this.stats.lastBlockDifficulty),
      lastBlockSubmitResult: this.stats.lastBlockSubmitResult,
      lastBlockWorker: this.stats.lastBlockWorker,
      lastBlockReward: this.stats.lastBlockReward,
      lastBlockHeight: this.stats.lastBlockHeight,
      allTimeBestShare: {
        difficulty: this.allTimeBestShare.difficulty,
        difficultyText: this.formatDifficulty(this.allTimeBestShare.difficulty),
        hash: this.allTimeBestShare.hash,
        worker: this.allTimeBestShare.worker,
        at: this.allTimeBestShare.at,
      },
      blockHistory: this.blockHistory.map((b) => ({
        height: b.height,
        hash: b.hash,
        difficulty: b.difficulty,
        difficultyText: b.difficultyText || this.formatDifficulty(b.difficulty),
        reward: b.reward,
        worker: b.worker,
        at: b.at,
        submitResult: b.submitResult,
        effortPercent: b.effortPercent ?? null,
      })),
      averageLuck: this.computeAverageLuck(),
      networkDifficulty: this.cachedNetwork ? this.cachedNetwork.difficulty : null,
      networkDifficultyText: this.formatDifficulty(this.cachedNetwork && this.cachedNetwork.difficulty),
      networkHashrate: this.getNetworkSolutionRate(this.cachedNetwork),
      networkHashrateText: this.formatSolutionsRate(this.getNetworkSolutionRate(this.cachedNetwork)),
      networkHashrateSource: this.getNetworkRateSource(),
      node: this.getNodeStatus(),
      minerStats,
    };
  }

  async getApiMiners() {
    const miners = [];
    this.stratum.clients.forEach((client) => {
      if (!client.authorized) return;
      miners.push(this.buildApiMiner(client, { includeAddress: true }));
    });
    return { count: miners.length, miners };
  }

  async getApiNetwork() {
    const info = this.cachedNetwork || (await this.rpc.getInfo());
    this.cachedNetwork = info;
    const netRate = this.getNetworkSolutionRate(info);
    const source = this.getNetworkRateSource();
    return {
      chain: info.chain,
      blocks: info.blocks,
      headers: info.headers,
      difficulty: info.difficulty,
      difficultyText: this.formatDifficulty(info.difficulty),
      hashrate: netRate,
      hashrateText: this.formatSolutionsRate(netRate),
      networkHashrate: netRate,
      networkHashrateText: this.formatSolutionsRate(netRate),
      networkHashrateSource: source,
      node: this.getNodeStatus(info),
      verificationProgress: info.verificationprogress,
      bestBlockHash: info.bestblockhash,
    };
  }

  async getApiHealth() {
    const info = this.cachedNetwork || (await this.rpc.getInfo().catch(() => null));
    if (info) this.cachedNetwork = info;
    const netRate = this.getNetworkSolutionRate(info);
    return {
      ok: true,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      chain: info ? info.chain : null,
      nodeHeight: info ? info.blocks : null,
      miners: this.countAuthorizedMiners(),
      networkHashrate: netRate,
      networkHashrateText: this.formatSolutionsRate(netRate),
      networkHashrateSource: this.getNetworkRateSource(),
    };
  }

  async getApiJob() {
    const job = (typeof this.wm.getCurrentJob === 'function') ? this.wm.getCurrentJob() : this.wm.currentJob;
    if (!job) return { active: false };
    return {
      active: true,
      jobId: job.jobId,
      height: job.height,
      nbits: job.nbits,
      ntime: job.ntime,
      cleanJobs: job.cleanJobs,
      target: job.target,
      txCount: (job.template.transactions || []).length,
    };
  }

  logStats() {
    const netDiff = this.parsePositiveNumber(this.cachedNetwork && this.cachedNetwork.difficulty);
    const minerInline = [];
    const minerLines = [];
    this.stratum.clients.forEach((client) => {
      if (!client.authorized) return;
      const m = client.metrics || {};
      const hashrate = this.stratum.estimateHashrate(client);
      const connectedSeconds = this.computeConnectedSeconds(client);
      const pingText = m.lastPingStatus === "ok"
        ? `${Number.isFinite(Number(m.lastPingMs)) ? Number(m.lastPingMs).toFixed(1) : "n/a"}ms`
        : (m.lastPingStatus === "fail" ? "fail" : "n/a");
      minerInline.push(`${client.workerName || `miner-${client.id}`}:b${m.blocksFound || 0}/a${m.accepted || 0}/r${m.rejected || 0}/p${pingText}`);
      minerLines.push(
        `[Miner #${client.id}] worker=${client.workerName || `miner-${client.id}`} up=${this.formatDuration(connectedSeconds)} diff=${this.formatDifficulty(client.currentDifficulty)} rate=${this.formatSolutionsRate(hashrate)} acc=${m.accepted || 0} rej=${m.rejected || 0} blocks=${m.blocksFound || 0} bestDiff=${this.formatDifficulty(m.bestShareDifficulty || 0)} lastBlockDiff=${this.formatDifficulty(m.lastBlockDifficulty || 0)} ping=${pingText}`
      );
    });
    this.logger.info(
      `[Stats] Miners: ${this.stats.miners} | Shares: ${this.stats.shares} | Rejected: ${this.stats.rejectedShares} | BlockCandidates: ${this.stats.blockCandidates} | BlocksAccepted: ${this.stats.blocks} | BlockSubmitsRejected: ${this.stats.blockSubmitsRejected} | NetDiff: ${this.formatDifficulty(netDiff)} | MinerStats: ${minerInline.join(", ") || "none"}`
    );
    for (const line of minerLines) this.logger.info(line);
  }
}

const pool = new ZCashSoloPool(process.argv[2] || "./config.json");
pool.start().catch((error) => {
  pool.logger.error(`[Startup] Fatal error: ${error.message}`);
  process.exit(1);
});

setInterval(() => {
  pool.logStats();
}, 30000);

// Graceful shutdown: save state and flush logs before exit
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  pool.logger.info(`[Shutdown] Received ${signal}, saving state...`);
  try { pool.savePersistedState(); } catch (_) {}
  try { pool.api.stop(); } catch (_) {}
  try { pool.webgui.stop(); } catch (_) {}
  try { pool.logger.shutdown(); } catch (_) {}
  process.exit(0);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
