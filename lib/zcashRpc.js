const http = require("http");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");

const JSONRPC_VERSION = "1.0";

class ZcashRPC {
  constructor(config, logger = console) {
    this.config = config;
    this.rpcUrl = `http://${config.rpcHost}:${config.rpcPort}`;
    this.logger = logger;
    this.auth = this.setupAuth(config);
    this.requestId = 0;
    this.networkRateMethod = null;
    this.networkRateParams = null;
    this.networkRateUnsupported = false;
    // Reuse TCP connections across RPC calls — avoids per-call handshake overhead.
    this._httpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  }

  setupAuth(config) {
    if (!config.rpcCookiePath) {
      throw new Error("Missing rpcCookiePath. Zebrad cookie authentication only.");
    }

    let cookiePath = String(config.rpcCookiePath);
    if (cookiePath.startsWith("~")) cookiePath = path.join(os.homedir(), cookiePath.slice(1));
    // Resolve to canonical path to neutralize any ".." traversal sequences
    cookiePath = path.resolve(cookiePath);

    const stats = fs.statSync(cookiePath);
    if (stats.isDirectory()) throw new Error(`rpcCookiePath is a directory: ${cookiePath}`);

    const cookieContent = fs.readFileSync(cookiePath, "utf8").trim();
    const parts = cookieContent.split(":");
    if (parts.length !== 2) throw new Error("Invalid cookie format (expected user:pass).");

    this.logger.info(`[RPC] Auth loaded from zebrad cookie: ${cookiePath}`);
    return { username: parts[0], password: parts[1] };
  }

  async call(method, params = [], options = {}) {
    this.requestId += 1;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 5000;

    try {
      const response = await axios.post(
        this.rpcUrl,
        { jsonrpc: JSONRPC_VERSION, id: this.requestId, method, params },
        { auth: this.auth, timeout: timeoutMs, headers: { "Content-Type": "application/json" }, httpAgent: this._httpAgent }
      );

      if (response.data && response.data.error) {
        const rpcError = response.data.error;
        const e = new Error(rpcError.message || "RPC error");
        e.rpc = rpcError;
        e.method = method;
        e.params = params;
        throw e;
      }

      return response.data.result;
    } catch (error) {
      const rpcError = error && error.response && error.response.data && error.response.data.error;
      if (rpcError && typeof rpcError === "object") {
        const e = new Error(rpcError.message || error.message || "RPC error");
        e.rpc = rpcError;
        e.method = method;
        e.params = params;
        this.logger.warn(`[RPC] ${method} error code=${rpcError.code} msg=${e.message}`);
        throw e;
      }

      if (error && error.rpc) {
        this.logger.warn(`[RPC] ${method} error code=${error.rpc.code} msg=${error.message}`);
        throw error;
      }
      const status = error.response ? error.response.status : "Network Error";
      this.logger.warn(`[RPC] ${method} failed status=${status} msg=${error.message}`);
      const e = new Error(`RPC ${method} Failed: ${status} - ${error.message}`);
      e.method = method;
      e.params = params;
      throw e;
    }
  }

  async getBlockCount() {
    return await this.call("getblockcount", [], { timeoutMs: 3000 });
  }

  async getBlockTemplate() {
    return await this.call("getblocktemplate", [{
      mode: "template",
      capabilities: ["coinbasetxn", "coinbasevalue", "longpoll"]
    }], { timeoutMs: 10000 });
  }

  async proposeBlock(blockHex) {
    return await this.call("getblocktemplate", [{ mode: "proposal", data: blockHex }], { timeoutMs: 10000 });
  }

  async submitBlock(blockHex) {
    const primaryParams = [blockHex];
    const alternates = [
      [blockHex, ""],
      [[blockHex]],
      [{ block: blockHex }],
      [{ hex: blockHex }],
    ];

    try {
      return await this.call("submitblock", primaryParams, { timeoutMs: 15000 });
    } catch (e) {
      if (!this.shouldRetrySubmitBlock(e)) throw e;

      let last = e;
      for (let i = 0; i < alternates.length; i++) {
        try {
          this.logger.warn(`[RPC] retry submitblock alternate #${i + 2}`);
          return await this.call("submitblock", alternates[i], { timeoutMs: 15000 });
        } catch (e2) {
          last = e2;
          if (!this.shouldRetrySubmitBlock(e2)) throw e2;
        }
      }
      throw last;
    }
  }

  shouldRetrySubmitBlock(error) {
    const msg = String(error && error.message ? error.message : "").toLowerCase();
    const code = error && error.rpc ? error.rpc.code : null;

    const shape =
      msg.includes("invalid params") ||
      msg.includes("wrong number of arguments") ||
      msg.includes("invalid parameter") ||
      msg.includes("invalid parameter type") ||
      msg.includes("expected") ||
      msg.includes("cannot unmarshal") ||
      msg.includes("type mismatch");

    if (shape) return true;

    const reject =
      msg.includes("bad-") ||
      msg.includes("invalid block") ||
      msg.includes("high-hash") ||
      msg.includes("duplicate") ||
      msg.includes("already have") ||
      msg.includes("already known") ||
      msg.includes("rejected");

    if (reject) return false;

    if (code === -1 || msg.includes('"code":-1') || msg.includes("code -1")) return true;

    return false;
  }

  async getInfo() {
    const info = await this.call("getblockchaininfo", [], { timeoutMs: 5000 });
    const [netInfo, peerInfo] = await Promise.all([
      this.call("getnetworkinfo", [], { timeoutMs: 5000 }).catch(() => ({})),
      this.call("getpeerinfo", [], { timeoutMs: 5000 }).catch(() => null),
    ]);

    if (netInfo && typeof netInfo === "object") {
      info.version = netInfo.version || info.version || "zebrad";
      info.subversion = netInfo.subversion || info.subversion || null;
      info.protocolversion = netInfo.protocolversion || info.protocolversion || null;
      if (Number.isFinite(Number(netInfo.connections)) && Number(netInfo.connections) >= 0) {
        info.connections = Number(netInfo.connections);
      }
    }

    if (!info.version) {
      info.version = "zebrad";
    }

    const peerSummary = this.summarizePeers(peerInfo, netInfo);
    if (peerSummary) {
      info.peerSummary = peerSummary;
      info.incomingPeers = peerSummary.inbound;
      info.outgoingPeers = peerSummary.outbound;
    }

    if (
      !Number.isFinite(Number(info.networksolps)) &&
      !Number.isFinite(Number(info.networkhashps))
    ) {
      const solps = await this.getNetworkSolps().catch(() => null);
      if (Number.isFinite(Number(solps)) && Number(solps) >= 0) info.networksolps = Number(solps);
    }

    return info;
  }

  summarizePeers(peerInfo, netInfo = null) {
    const peers = Array.isArray(peerInfo) ? peerInfo : null;
    const totalFromNetInfo = Number(netInfo && netInfo.connections);
    if (!peers && !(Number.isFinite(totalFromNetInfo) && totalFromNetInfo >= 0)) return null;

    let inbound = 0;
    let outbound = 0;
    if (peers) {
      peers.forEach((peer) => {
        if (peer && peer.inbound === true) inbound += 1;
        else if (peer && peer.inbound === false) outbound += 1;
      });
    }

    const total = peers ? peers.length : totalFromNetInfo;
    return {
      total: Number.isFinite(Number(total)) && Number(total) >= 0 ? Number(total) : 0,
      inbound,
      outbound,
    };
  }

  async getNetworkSolps() {
    if (this.networkRateUnsupported) return null;

    const missingMethod = (error) => {
      const msg = String(error && error.message ? error.message : "").toLowerCase();
      const code = error && error.rpc ? error.rpc.code : null;
      return (
        code === -32601 ||
        msg.includes("method not found") ||
        msg.includes("not found") ||
        msg.includes("unsupported") ||
        msg.includes("not implemented")
      );
    };

    const invalidParams = (error) => {
      const msg = String(error && error.message ? error.message : "").toLowerCase();
      const code = error && error.rpc ? error.rpc.code : null;
      return (
        code === -32602 ||
        msg.includes("invalid params") ||
        msg.includes("wrong number of arguments") ||
        msg.includes("expected")
      );
    };

    const candidates = this.networkRateMethod
      ? [{ method: this.networkRateMethod, paramSets: [Array.isArray(this.networkRateParams) ? this.networkRateParams : []] }]
      : [
          { method: "getnetworksolps", paramSets: [[], [120], [-1], [120, -1]] },
          { method: "getnetworkhashps", paramSets: [[], [120], [-1], [120, -1]] },
          { method: "getmininginfo", paramSets: [[]] },
        ];

    for (const c of candidates) {
      for (const params of c.paramSets) {
        try {
          const result = await this.call(c.method, params, { timeoutMs: 5000 });
          let n = null;
          if (c.method === "getmininginfo" && result && typeof result === "object") {
            n = Number(result.networksolps ?? result.networkhashps ?? result.networkhashpspersec);
          } else {
            n = Number(result);
          }

          if (Number.isFinite(n) && n >= 0) {
            this.networkRateMethod = c.method;
            this.networkRateParams = params;
            return n;
          }
        } catch (error) {
          if (missingMethod(error)) break;
          if (invalidParams(error)) continue;
          if (this.networkRateMethod) return null;
          break;
        }
      }
    }

    if (!this.networkRateMethod) this.networkRateUnsupported = true;
    return null;
  }

  getNetworkRateSource() {
    return {
      method: this.networkRateMethod || null,
      params: Array.isArray(this.networkRateParams) ? this.networkRateParams : [],
      unsupported: this.networkRateUnsupported === true,
    };
  }
}

module.exports = ZcashRPC;
