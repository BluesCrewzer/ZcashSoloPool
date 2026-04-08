const DASHBOARD_CONFIG_READY = (
  typeof window !== "undefined" &&
  window.DASHBOARD_CONFIG_READY &&
  typeof window.DASHBOARD_CONFIG_READY.then === "function"
)
  ? window.DASHBOARD_CONFIG_READY
  : Promise.resolve(
      (typeof window !== "undefined" && window.DASHBOARD_CONFIG && typeof window.DASHBOARD_CONFIG === "object")
        ? window.DASHBOARD_CONFIG
        : {}
    );

const API_PATHS = ["/api/dashboard", "/api/stats", "/stats", "/api/pool/stats", "/api/pool_stats"];
const FAILED_PROBE_RETRY_MS = 5 * 60_000;

const fallbackData = {
  pool: {
    hashrate: "2.44 GS/s",
    connectedMiners: 5,
    sharesAccepted: 19244,
    sharesRejected: 231,
    topAcceptedShares: [
      { miner: "rig-echo", difficulty: "151.14 M" },
      { miner: "rig-delta", difficulty: "120.87 M" },
      { miner: "rig-alpha", difficulty: "104.27 M" },
      { miner: "rig-charlie", difficulty: "84.2 M" },
      { miner: "rig-bravo", difficulty: "72.61 M" },
    ],
  },
  miners: [
    { name: "rig-alpha", hashrate: "510.6 MS/s", accepted: 4210, rejected: 42, stale: 11, highestDifficulty: "104.27 M", connected: "2h 14m", lastShare: "7s ago" },
    { name: "rig-bravo", hashrate: "498.1 MS/s", accepted: 4020, rejected: 59, stale: 16, highestDifficulty: "72.61 M", connected: "1h 48m", lastShare: "11s ago" },
    { name: "rig-charlie", hashrate: "462.9 MS/s", accepted: 3688, rejected: 48, stale: 9, highestDifficulty: "84.2 M", connected: "2h 51m", lastShare: "9s ago" },
    { name: "rig-delta", hashrate: "541.2 MS/s", accepted: 4461, rejected: 39, stale: 5, highestDifficulty: "120.87 M", connected: "3h 04m", lastShare: "5s ago" },
    { name: "rig-echo", hashrate: "423.4 MS/s", accepted: 2865, rejected: 43, stale: 8, highestDifficulty: "151.14 M", connected: "1h 32m", lastShare: "13s ago" },
  ],
  network: { hashrate: "9.88 GS/s", difficulty: "98.14 M" },
  blocks: [{ height: 2738142, hash: "00000000007f...f91b", reward: "2.5 ZEC", confirmedAt: "2026-02-10 16:08 UTC", minedBy: "rig-alpha" }],
  ops: {
    pingStatusText: "Unknown",
    pingBreakdownText: "--",
    pingTone: "neutral",
    pingReason: "no_data",
    backoffBans: 0,
    backoffBlocked: 0,
    historyEvents: 0,
    historySnapshotText: "--",
    historyLastEventText: "--",
  },
};

const $ = (s) => document.querySelector(s);
const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== "");
const pickObj = (...vals) => vals.find((v) => v && typeof v === "object" && !Array.isArray(v));
const state = {
  minersSortKey: "hashrate",
  minersSortDir: "desc",
  lastData: null,
  refreshTimerId: null,
};

function getDashboardConfig() {
  return (typeof window !== "undefined" && window.DASHBOARD_CONFIG && typeof window.DASHBOARD_CONFIG === "object")
    ? window.DASHBOARD_CONFIG
    : {};
}

function getDefaultApiBase() {
  return String(getDashboardConfig().apiBase || "").trim().replace(/\/$/, "");
}

function getDefaultApiKey() {
  return String(getDashboardConfig().apiKey || "").trim();
}

function getRefreshMs() {
  const value = Number(getDashboardConfig().refreshMs);
  return Number.isFinite(value) && value >= 5000 ? value : 30_000;
}

function looksLikeIp(value) {
  return typeof value === "string" && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.trim());
}

function safeMinerName(primary, fallback, index = 0) {
  const chosen = pick(primary, fallback, `miner-${index + 1}`);
  if (!looksLikeIp(chosen)) return chosen;
  const parts = chosen.split(".");
  return `miner-${parts[parts.length - 1] || index + 1}`;
}

function nestedPick(obj, paths = []) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const path of paths) {
    let cur = obj;
    let valid = true;
    for (const key of path) {
      if (!cur || typeof cur !== "object" || !(key in cur)) {
        valid = false;
        break;
      }
      cur = cur[key];
    }
    if (valid && cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return undefined;
}

function parseScaledNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  if (Number.isFinite(Number(value))) return Number(value);
  const s = String(value).trim();
  const match = s.match(/^(-?\d+(?:\.\d+)?)\s*([kKmMgGtTpPeE])(?:[a-zA-Z/]+)?$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const pow = { k: 1, m: 2, g: 3, t: 4, p: 5, e: 6 }[match[2].toLowerCase()] || 0;
  return n * (1000 ** pow);
}

function parseTimestampMs(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n > 10_000_000_000 ? n : n * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDurationSeconds(value) {
  if (value === undefined || value === null || value === "") return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;

  let total = 0;
  let found = false;
  const unitScale = { d: 86400, h: 3600, m: 60, s: 1 };
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) {
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || !unitScale[unit]) continue;
    total += amount * unitScale[unit];
    found = true;
  }
  return found ? total : null;
}

function parseRelativeAgoToTimestampMs(value) {
  if (value === undefined || value === null || value === "") return null;
  const timestamp = parseTimestampMs(value);
  if (timestamp !== null) return timestamp;
  const text = String(value).trim().toLowerCase();
  if (!text.includes("ago")) return null;
  const seconds = parseDurationSeconds(text.replace(/\bago\b/, "").trim());
  if (!Number.isFinite(seconds)) return null;
  return Date.now() - (seconds * 1000);
}

const formatHashes = (value) => {
  if (typeof value === "string") {
    if (/[a-z]/i.test(value)) return value;
    value = Number(value);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "--";
  const units = ["Sol/s", "KSol/s", "MSol/s", "GSol/s", "TSol/s", "PSol/s"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
};

const formatCount = (value) => (Number.isFinite(Number(value)) ? Number(value).toLocaleString() : "--");

const formatHashesMaybe = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const formatted = formatHashes(value);
  return formatted === "--" ? undefined : formatted;
};

// Zcash block interval is 75 seconds.
// Estimated time to find a block = (networkHashrate / poolHashrate) * blockInterval
// Returns seconds, or null if inputs are missing.
function estimateTimeToBlock(poolSolPerSec, networkSolPerSec) {
  if (!Number.isFinite(poolSolPerSec) || poolSolPerSec <= 0) return null;
  if (!Number.isFinite(networkSolPerSec) || networkSolPerSec <= 0) return null;
  const blockIntervalSeconds = Number(getDashboardConfig().blockIntervalSeconds) || 75;
  return (networkSolPerSec / poolSolPerSec) * blockIntervalSeconds;
}

function formatLongDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days >= 365) {
    const years = (days / 365.25);
    return years >= 10 ? `~${Math.round(years)}y` : `~${years.toFixed(1)}y`;
  }
  if (days > 0) return `~${days}d ${hours}h`;
  if (hours > 0) return `~${hours}h ${minutes}m`;
  return `~${minutes}m`;
}

const formatDifficulty = (value) => {
  if (value === undefined || value === null || value === "") return "--";
  if (typeof value === "string" && /[a-z]/i.test(value)) return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
};

const formatRelativeTime = (timestamp) => {
  const raw = Number(timestamp);
  let ms;
  if (Number.isFinite(raw)) {
    ms = raw > 10_000_000_000 ? raw : raw * 1000;
  } else {
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) return timestamp || "--";
    ms = parsed;
  }
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
};

const formatDuration = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const total = Math.floor(n);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
};

const formatConnectedFromTimestamp = (timestamp) => {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return undefined;
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  return formatDuration(seconds);
};

function isAllowedApiOrigin(url) {
  if (!url) return true; // relative URLs are always allowed
  try {
    const parsed = new URL(url, window.location.origin);
    // Allow same-origin always
    if (parsed.origin === window.location.origin) return true;
    // Allow private/LAN IPs (RFC 1918, loopback, link-local)
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (/^10\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    // Allow if it matches the configured apiBase origin
    const configBase = getDefaultApiBase();
    if (configBase) {
      try {
        const configOrigin = new URL(configBase, window.location.origin).origin;
        if (parsed.origin === configOrigin) return true;
      } catch { /* ignore */ }
    }
    return false;
  } catch {
    return false;
  }
}

function explicitApiBaseFromUI() {
  const fromQuery = new URL(location.href).searchParams.get("api");
  if (fromQuery && !isAllowedApiOrigin(fromQuery)) {
    console.warn("[Dashboard] Blocked ?api= override to non-local origin:", fromQuery);
    return getDefaultApiBase() || "";
  }
  const value = fromQuery || getDefaultApiBase() || "";
  return String(value).trim().replace(/\/$/, "");
}

function apiBaseCandidates() {
  const candidates = [];
  const add = (value) => {
    const normalized = String(value || "").trim().replace(/\/$/, "");
    if (candidates.includes(normalized)) return;
    candidates.push(normalized);
  };

  const explicitBase = explicitApiBaseFromUI();
  if (explicitBase) add(explicitBase);

  // Relative same-origin API routes work best when the GUI is reverse-proxied with the pool API.
  add("");

  if (typeof window !== "undefined" && window.location) {
    add(window.location.origin);

    // When the GUI is served from the same host on a different port, also try the pool API default port.
    if (window.location.hostname && window.location.protocol === "http:") {
      add(`http://${window.location.hostname}:8085`);
    }
  }

  return candidates;
}

function apiKeyFromUI() {
  return getDefaultApiKey();
}

function endpointCandidates() {
  const candidates = [];
  apiBaseCandidates().forEach((base) => {
    API_PATHS.forEach((path) => {
      candidates.push({
        base,
        path,
        url: `${base}${path}`,
      });
    });
  });
  return candidates;
}

function buildApiUrl(path, base = "") {
  return `${String(base || "").trim().replace(/\/$/, "")}${path}`;
}

function shouldSendApiKey(endpoint) {
  const key = apiKeyFromUI();
  if (!key) return "";
  // Only send the API key to the explicitly configured or overridden API base.
  // Auto-discovered origins (same-origin, :8085 fallback) should not receive the key
  // unless they match the configured apiBase or the ?api= parameter.
  const explicitBase = explicitApiBaseFromUI();
  if (!explicitBase) return key; // no explicit base = relative URLs = same-origin, safe
  try {
    const endpointOrigin = new URL(endpoint, window.location.origin).origin;
    const baseOrigin = new URL(explicitBase, window.location.origin).origin;
    if (endpointOrigin === baseOrigin) return key;
  } catch { /* fall through */ }
  return "";
}

function fetchJson(endpoint) {
  const key = shouldSendApiKey(endpoint);
  const headers = key ? { "x-api-key": key } : undefined;
  return fetch(endpoint, headers ? { headers } : undefined);
}

const probeState = {
  lastGoodEndpoint: null,
  lastProbeFailureAt: 0,
  lastProbeErrors: [],
};

function orderedEndpointCandidates() {
  const candidates = endpointCandidates();
  if (!probeState.lastGoodEndpoint) return candidates;
  return [
    probeState.lastGoodEndpoint,
    ...candidates.filter((candidate) => candidate.url !== probeState.lastGoodEndpoint.url),
  ];
}

function normalizeMinerRow(m, nameFallback, i) {
  const rawRate = pick(
    m.solutionRate,
    m.hashrate,
    m.hashRate,
    m.solps,
    m.hashesPerSecond,
    nestedPick(m, [["stats", "hashrate"], ["shares", "hashrate"]])
  );
  const name = safeMinerName(
    pick(m.name, m.worker, m.workerName, m.username, m.login, m.address),
    nameFallback,
    i
  );
  const hashrate = pick(
    m.solutionRateText,
    m.hashrateText,
    m.hashrateString,
    formatHashesMaybe(m.solutionRate),
    formatHashesMaybe(m.hashrate),
    formatHashesMaybe(m.hashRate),
    formatHashesMaybe(m.solps),
    formatHashesMaybe(m.hashesPerSecond),
    formatHashesMaybe(nestedPick(m, [["stats", "hashrate"], ["shares", "hashrate"]]))
  );
  const accepted = pick(
    m.accepted,
    m.acceptedShares,
    m.sharesAccepted,
    m.validShares,
    m.shares,
    nestedPick(m, [["stats", "accepted"], ["shares", "accepted"], ["totals", "accepted"]])
  );
  const rejected = pick(
    m.rejected,
    m.rejectedShares,
    m.sharesRejected,
    m.invalidShares,
    m.invalidshares,
    nestedPick(m, [["stats", "rejected"], ["shares", "rejected"], ["totals", "rejected"]])
  );
  const stale = pick(
    m.stale,
    m.staleShares,
    m.staleshares,
    nestedPick(m, [["stats", "stale"], ["shares", "stale"], ["totals", "stale"]])
  );
  const highestDifficulty = pick(
    m.bestDiffText,
    m.bestShareDifficultyText,
    m.highestDifficultyText,
    m.highestDifficulty,
    m.bestDifficulty,
    m.bestShareDifficulty,
    m.maxShareDiff,
    m.bestDiff,
    nestedPick(m, [["stats", "bestDiff"], ["stats", "highestDifficulty"], ["shares", "bestDifficulty"], ["bestShare", "difficulty"]])
  );

  const connectedSeconds = pick(
    parseDurationSeconds(m.connectedSeconds),
    parseDurationSeconds(m.connectionSeconds),
    parseDurationSeconds(m.connectedForSeconds),
    parseDurationSeconds(nestedPick(m, [["stats", "connectedSeconds"], ["connection", "seconds"]])),
    parseDurationSeconds(formatConnectedFromTimestamp(m.connectedAt))
  );
  const connected = pick(
    m.connectedText,
    m.connectedFor,
    m.connectedDurationText,
    formatDuration(connectedSeconds),
    formatConnectedFromTimestamp(m.connectedAt)
  );

  const lastShareTimestampMs = pick(
    parseTimestampMs(m.lastShareAt),
    parseTimestampMs(m.lastShareTimestamp),
    parseTimestampMs(m.lastSubmit),
    parseTimestampMs(m.last_share),
    parseRelativeAgoToTimestampMs(m.lastShare),
    parseRelativeAgoToTimestampMs(m.lastShareText)
  );
  const lastShare = pick(
    (typeof m.lastShare === "string" ? m.lastShare : undefined),
    formatRelativeTime(m.lastShareAt),
    formatRelativeTime(m.lastShareTimestamp),
    formatRelativeTime(m.lastSubmit),
    formatRelativeTime(m.last_share),
    Number.isFinite(Number(m.lastShare)) ? formatRelativeTime(m.lastShare) : undefined
  );

  const pingMsRaw = pick(
    m.pingMs,
    m.ping,
    m.latencyMs,
    m.lastPingMs,
    nestedPick(m, [["stats", "pingMs"], ["metrics", "pingMs"], ["ping", "ms"]])
  );
  const pingStatusRaw = pick(
    m.pingStatus,
    m.lastPingStatus,
    nestedPick(m, [["stats", "pingStatus"], ["metrics", "pingStatus"], ["ping", "status"]])
  );
  const pingMsNum = Number.isFinite(Number(pingMsRaw)) ? Number(pingMsRaw) : null;
  const pingStatus = typeof pingStatusRaw === "string" ? pingStatusRaw.toLowerCase() : null;
  const pingDisplay = pingMsNum !== null
    ? `${pingMsNum.toFixed(1)} ms`
    : (pingStatus === "fail" ? "fail" : (pingStatus === "ok" ? "ok" : "--"));

  const sortHashrate = pick(
    Number.isFinite(Number(rawRate)) ? Number(rawRate) : undefined,
    parseScaledNumber(hashrate)
  );

  const blocksFoundRaw = pick(
    m.blocksFound,
    m.blocks_found,
    m.sessionBlocksFound,
    nestedPick(m, [["stats", "blocksFound"], ["metrics", "blocksFound"]])
  );
  const blocksFound = Number.isFinite(Number(blocksFoundRaw)) ? Number(blocksFoundRaw) : 0;

  return {
    rawRate,
    name,
    hashrate,
    accepted,
    rejected,
    stale,
    blocksFound,
    highestDifficulty,
    connected,
    ping: pingDisplay,
    lastShare,
    sortName: String(name || "").toLowerCase(),
    sortHashrate,
    sortAccepted: Number.isFinite(Number(accepted)) ? Number(accepted) : parseScaledNumber(accepted),
    sortRejected: Number.isFinite(Number(rejected)) ? Number(rejected) : parseScaledNumber(rejected),
    sortStale: Number.isFinite(Number(stale)) ? Number(stale) : parseScaledNumber(stale),
    sortBlocksFound: blocksFound,
    sortHighestDifficulty: parseScaledNumber(highestDifficulty),
    sortConnectedSeconds: pick(connectedSeconds, parseDurationSeconds(connected)),
    sortPingMs: pingMsNum,
    sortLastShareMs: lastShareTimestampMs,
  };
}

function normalizeMiners(input) {
  if (Array.isArray(input)) {
    return input.map((m, i) => normalizeMinerRow(m, m.ip, i));
  }
  if (input && typeof input === "object") {
    return Object.entries(input).map(([name, m], i) => normalizeMinerRow(m, looksLikeIp(name) ? m.ip : name, i));
  }
  return [];
}

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.map((b) => {
    if (typeof b === "string") {
      const p = b.split(":");
      return { height: p[0], hash: p[1] || b, reward: "--", confirmedAt: "--", minedBy: "--" };
    }
    return {
      height: pick(b.height, b.blockHeight),
      hash: pick(b.hash, b.blockHash),
      difficulty: pick(b.difficulty, b.diff),
      difficultyText: pick(b.difficultyText, b.diffText),
      effortPercent: pick(b.effortPercent, b.effort),
      reward: pick(b.reward, b.value),
      confirmedAt: pick(b.confirmedAt, b.time ? new Date(Number(b.time) * 1000).toLocaleString() : undefined),
      minedBy: pick(b.minedBy, b.worker, b.miner),
    };
  });
}

function buildSummaryBlocks(root, blocksA) {
  if (Array.isArray(blocksA)) return normalizeBlocks(blocksA);

  // Use blockHistory array from API if available
  const history = root.blockHistory ?? root.blockhistory;
  if (Array.isArray(history) && history.length > 0) {
    return history
      .slice()
      .sort((a, b) => {
        const ta = Date.parse(a.at) || 0;
        const tb = Date.parse(b.at) || 0;
        return tb - ta;
      })
      .map((b) => ({
        height: b.height ?? "--",
        hash: b.hash ?? "--",
        difficulty: b.difficulty ?? null,
        difficultyText: b.difficultyText ?? null,
        effortPercent: b.effortPercent ?? null,
        reward: b.reward ?? "--",
        confirmedAt: b.at ? new Date(b.at).toLocaleString() : "--",
        minedBy: b.worker ?? "--",
      }));
  }

  // Fallback: build single-entry from lastBlock fields
  const totalBlocks = Number(root.blocks);
  const hasTotalBlocks = Number.isFinite(totalBlocks) && totalBlocks >= 0;
  const hash = root.lastBlockHash ?? root.lastblockhash;
  const confirmedAtRaw = root.lastBlockAt ?? root.lastblockat;

  if (!hasTotalBlocks && !hash && !confirmedAtRaw) return [];

  const confirmedAt = confirmedAtRaw ? new Date(confirmedAtRaw).toLocaleString() : "--";
  const height = hasTotalBlocks ? `Total: ${totalBlocks}` : "--";

  const reward = root.lastBlockReward ?? root.lastblockreward ?? "--";
  const minedBy = root.lastBlockWorker ?? root.lastblockworker ?? "--";
  const blockHeight = root.lastBlockHeight ?? root.lastblockheight;

  return [{
    height: blockHeight ?? height,
    hash: hash ?? "--",
    difficulty: root.lastBlockDifficulty ?? root.lastblockdifficulty ?? null,
    difficultyText: root.lastBlockDifficultyText ?? root.lastblockdifficultytext ?? null,
    reward,
    confirmedAt,
    minedBy,
  }];
}

function normalizeOperationalData(root = {}, pingStatusRoot = null) {
  const pingHealth = pickObj(
    root.pingHealth,
    root.pinghealth,
    root.pool?.pingHealth,
    root.stats?.pingHealth,
    pingStatusRoot?.health,
    pingStatusRoot?.pingHealth
  );
  const pingTotals = pickObj(
    pingStatusRoot?.totals,
    pingHealth?.totals
  );

  let failPercent = pick(
    pingHealth?.failPercent,
    pingHealth?.fail_pct,
    pingTotals?.failPercent
  );
  let unknownPercent = pick(
    pingHealth?.unknownPercent,
    pingHealth?.unknown_pct,
    pingTotals?.unknownPercent
  );

  const totalMiners = Number(pick(pingTotals?.miners, pingTotals?.total, pingHealth?.total));
  const failCount = Number(pick(pingTotals?.fail, pingHealth?.fail));
  const unknownCount = Number(pick(pingTotals?.unknown, pingHealth?.unknown));
  if ((failPercent === undefined || failPercent === null) && Number.isFinite(totalMiners) && totalMiners > 0 && Number.isFinite(failCount)) {
    failPercent = (failCount / totalMiners) * 100;
  }
  if ((unknownPercent === undefined || unknownPercent === null) && Number.isFinite(totalMiners) && totalMiners > 0 && Number.isFinite(unknownCount)) {
    unknownPercent = (unknownCount / totalMiners) * 100;
  }

  const healthy = typeof pingHealth?.healthy === "boolean" ? pingHealth.healthy : null;
  const pingStatusText = healthy === true ? "Healthy" : healthy === false ? "Degraded" : "Unknown";
  const pingTone = healthy === true ? "good" : healthy === false ? "bad" : "neutral";
  const failText = Number.isFinite(Number(failPercent)) ? `${Number(failPercent).toFixed(1)}%` : "--";
  const unknownText = Number.isFinite(Number(unknownPercent)) ? `${Number(unknownPercent).toFixed(1)}%` : "--";
  const pingBreakdownText = `Fail ${failText} | Unknown ${unknownText}`;

  const backoff = pickObj(
    root.workerBackoff,
    root.workerbackoff,
    root.pool?.workerBackoff,
    root.stats?.workerBackoff
  );
  const history = pickObj(
    root.history,
    root.pool?.history,
    root.stats?.history
  );

  const historySnapshotAt = pick(history?.lastSnapshotAt, history?.lastSnapshot, history?.lastSnapshotTs);
  const historyLastEventAt = pick(history?.lastEventAt, history?.lastEvent, history?.lastEventTs);

  return {
    pingStatusText,
    pingBreakdownText,
    pingTone,
    pingReason: pick(pingHealth?.reason, pingHealth?.statusReason, null),
    backoffBans: pick(backoff?.totalBans, backoff?.bans, 0),
    backoffBlocked: pick(backoff?.totalBlockedSubmissions, backoff?.blockedSubmissions, 0),
    historyEvents: pick(history?.totalEvents, history?.events, 0),
    historySnapshotText: historySnapshotAt ? formatRelativeTime(historySnapshotAt) : "--",
    historyLastEventText: historyLastEventAt ? formatRelativeTime(historyLastEventAt) : "--",
  };
}

function formatNodeVersion(value) {
  if (value === undefined || value === null || value === "") return "--";
  if (typeof value === "string" && /\D/.test(value)) return value;
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return String(value);
  const major = Math.floor(raw / 1000000);
  const minor = Math.floor((raw % 1000000) / 10000);
  const patch = Math.floor((raw % 10000) / 100);
  const build = raw % 100;
  const parts = [major, minor, patch, build];
  while (parts.length > 3 && parts[parts.length - 1] === 0) parts.pop();
  return parts.join(".");
}

function normalizeNodeData(...sources) {
  const node = pickObj(
    ...sources.flatMap((source) => {
      if (!source || typeof source !== "object") return [];
      return [
        source.node,
        source.nodeInfo,
        source.zebrad,
        source.node_info,
      ];
    })
  );

  if (!node || typeof node !== "object") return null;

  return {
    connections: pick(node.connections, node.totalConnections, node.peers),
    incomingPeers: pick(node.incomingPeers, node.inboundPeers, node.inbound),
    outgoingPeers: pick(node.outgoingPeers, node.outboundPeers, node.outbound),
    version: formatNodeVersion(pick(node.version, node.nodeVersion)),
    software: pick(node.software, node.subversion, node.name, node.client),
  };
}

function normalizePayload(payload) {
  const root = payload?.result ?? payload?.data ?? payload;
  if (!root || typeof root !== "object") return null;

  // shape A: explicit dashboard keys
  const poolA = root.pool ?? root.poolStats ?? root.pool_stats ?? root.stats;
  // Prefer miner collections over numeric summary counters (e.g. root.miners = 2 + root.minerStats = [...]).
  const minersA = (
    (root.miners && typeof root.miners === "object" ? root.miners : undefined) ??
    (root.minerStats && typeof root.minerStats === "object" ? root.minerStats : undefined) ??
    (root.miner_stats && typeof root.miner_stats === "object" ? root.miner_stats : undefined) ??
    (root.workers && typeof root.workers === "object" ? root.workers : undefined)
  );
  const networkA = root.network ?? root.networkStats ?? root.network_stats;
  const blocksA = root.blocks ?? root.recentBlocks ?? root.confirmedBlocks ?? root.confirmed_blocks;

  // shape A1: flat summary stats (ex: { miners: 2, shares: 22, rejectedShares: 6, ... })
  const hasFlatSummaryStats =
    typeof root.miners === "number" ||
    typeof root.shares === "number" ||
    typeof root.rejectedShares === "number" ||
    typeof root.uptimeSeconds === "number";

  if (poolA || minersA || networkA || blocksA || hasFlatSummaryStats) {
    return {
      pool: {
        hashrate: pick(
          poolA?.solutionRateText,
          poolA?.hashrateText,
          poolA?.hashrate,
          poolA?.hashrateString,
          formatHashesMaybe(poolA?.solutionRate),
          formatHashesMaybe(poolA?.hashRate),
          formatHashesMaybe(poolA?.poolHashrate),
          formatHashesMaybe(poolA?.hashesPerSecond),
          formatHashesMaybe(root.poolHashrate),
          formatHashesMaybe(root.hashrate)
        ),
        connectedMiners: pick(
          poolA?.connectedMiners,
          poolA?.miners,
          poolA?.workerCount,
          typeof minersA === "number" ? minersA : undefined,
          Array.isArray(minersA) ? minersA.length : undefined,
          root.miners
        ),
        sharesAccepted: pick(poolA?.sharesAccepted, poolA?.acceptedShares, poolA?.accepted, poolA?.validShares, poolA?.shares, root.shares),
        sharesRejected: pick(poolA?.sharesRejected, poolA?.rejectedShares, poolA?.rejected, poolA?.invalidShares, root.rejectedShares),
        topAcceptedShares: normalizeTopAcceptedShares(
          pick(
            poolA?.topAcceptedShares,
            poolA?.topShares,
            poolA?.bestShares,
            root.topAcceptedShares,
            root.topShares,
            root.bestShares,
            root.highestAcceptedShares,
            nestedPick(root, [["shares", "topAccepted"], ["shares", "top"], ["stats", "topShares"]])
          )
        ),
      },
      miners: normalizeMiners(minersA),
      network: {
        hashrate: pick(
          networkA?.solutionRateText,
          networkA?.hashrateText,
          networkA?.hashrate,
          formatHashesMaybe(networkA?.hashRate),
          formatHashesMaybe(networkA?.solps),
          formatHashesMaybe(networkA?.networkHashrate),
          formatHashesMaybe(networkA?.hashesPerSecond),
          formatHashesMaybe(nestedPick(networkA, [["stats", "networkHashrate"], ["network", "hashrate"]])),
          formatHashesMaybe(root.networkHashrate),
          formatHashesMaybe(root.networkHashRate)
        ),
        difficulty: pick(
          networkA?.difficultyText,
          networkA?.networkDifficultyText,
          networkA?.difficulty,
          networkA?.networkDifficulty,
          nestedPick(networkA, [["stats", "networkDifficulty"], ["network", "difficulty"]]),
          root.networkDifficultyText,
          root.networkDifficulty,
          root.networkDiff
        ),
      },
      uptimeSeconds: pick(
        poolA?.uptimeSeconds,
        root.uptimeSeconds,
        poolA?.uptime,
        root.uptime
      ),
      secondsSinceLastBlock: pick(
        root.secondsSinceLastBlock,
        poolA?.secondsSinceLastBlock
      ),
      blocks: buildSummaryBlocks(root, blocksA),
      ops: normalizeOperationalData(root),
      node: normalizeNodeData(root, networkA),
      allTimeBestShare: root.allTimeBestShare || null,
      averageLuck: root.averageLuck ?? null,
    };
  }

  // shape B: NOMP style
  if (root.pools && typeof root.pools === "object") {
    const key = Object.keys(root.pools)[0];
    const p = root.pools[key] || {};
    return {
      pool: {
        hashrate: pick(p.hashrateString, formatHashesMaybe(p.hashrate), formatHashesMaybe(p.poolHashrate)),
        connectedMiners: pick(p.workerCount, p.miners),
        sharesAccepted: pick(p.shares, p.validShares),
        sharesRejected: pick(p.invalidShares, p.rejectedShares),
        topAcceptedShares: normalizeTopAcceptedShares(
          pick(
            p.topAcceptedShares,
            p.topShares,
            p.bestShares,
            root.topAcceptedShares,
            root.topShares,
            root.bestShares
          )
        ),
      },
      miners: normalizeMiners(p.workers),
      network: {
        hashrate: pick(formatHashesMaybe(root.networkSols), formatHashesMaybe(root.networkHashrate), formatHashesMaybe(root.networkHashRate)),
        difficulty: pick(root.networkDiff, root.networkDifficulty),
      },
      uptimeSeconds: pick(p.uptimeSeconds, root.uptimeSeconds, p.uptime, root.uptime),
      blocks: normalizeBlocks(root.blocks || p.blocks),
      ops: normalizeOperationalData(root),
      node: normalizeNodeData(root, p, root.network),
    };
  }

  return null;
}

async function fetchOptionalJson(endpoint) {
  try {
    const res = await fetchJson(endpoint);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function enrichWithSupplementalEndpoints(data, primaryEndpoint) {
  if (!primaryEndpoint || !primaryEndpoint.path) return data;
  if (primaryEndpoint.path !== "/api/stats" && primaryEndpoint.path !== "/stats") return data;

  const enriched = {
    pool: { ...(data.pool || {}) },
    miners: Array.isArray(data.miners) ? [...data.miners] : [],
    network: { ...(data.network || {}) },
    uptimeSeconds: data.uptimeSeconds,
    secondsSinceLastBlock: data.secondsSinceLastBlock,
    blocks: Array.isArray(data.blocks) ? [...data.blocks] : [],
    ops: { ...(data.ops || {}) },
    node: data.node ? { ...data.node } : null,
    allTimeBestShare: data.allTimeBestShare || null,
    averageLuck: data.averageLuck ?? null,
  };

  if (!enriched.miners.length) {
    const minersPayload =
      await fetchOptionalJson(buildApiUrl("/api/miners", primaryEndpoint.base)) ||
      await fetchOptionalJson(buildApiUrl("/miners", primaryEndpoint.base));
    const minersCandidate = minersPayload?.miners ?? minersPayload?.workers ?? minersPayload;
    const miners = normalizeMiners(minersCandidate);
    if (miners.length) enriched.miners = miners;
  }

  if (!enriched.network?.hashrate || !enriched.network?.difficulty) {
    const networkPayload =
      await fetchOptionalJson(buildApiUrl("/api/network", primaryEndpoint.base)) ||
      await fetchOptionalJson(buildApiUrl("/network", primaryEndpoint.base));
    const networkRoot = networkPayload?.network ?? networkPayload?.result ?? networkPayload?.data ?? networkPayload;
    if (networkRoot && typeof networkRoot === "object") {
      enriched.network.hashrate = enriched.network.hashrate || pick(
        networkRoot.solutionRateText,
        networkRoot.hashrateText,
        networkRoot.hashrate,
        formatHashesMaybe(networkRoot.solutionRate),
        formatHashesMaybe(networkRoot.hashRate),
        formatHashesMaybe(networkRoot.solps),
        formatHashesMaybe(networkRoot.networkHashrate),
        formatHashesMaybe(networkRoot.networkHashRate),
        formatHashesMaybe(networkRoot.networkSols),
        formatHashesMaybe(nestedPick(networkRoot, [["network", "hashrate"], ["stats", "networkHashrate"]]))
      );
      enriched.network.difficulty = enriched.network.difficulty || pick(
        networkRoot.difficultyText,
        networkRoot.networkDifficultyText,
        networkRoot.difficulty,
        networkRoot.networkDifficulty,
        networkRoot.networkDiff,
        nestedPick(networkRoot, [["network", "difficulty"], ["stats", "networkDifficulty"]])
      );
      enriched.node = enriched.node || normalizeNodeData(networkRoot);
    }
  }

  // Fetch job, health, and ping-status in parallel since they are independent
  const parallelFetches = [];

  const needsJob = !enriched.pool?.hashrate;
  parallelFetches.push(
    needsJob
      ? fetchOptionalJson(buildApiUrl("/api/job", primaryEndpoint.base))
          .then((r) => r || fetchOptionalJson(buildApiUrl("/job", primaryEndpoint.base)))
      : Promise.resolve(null)
  );
  parallelFetches.push(
    fetchOptionalJson(buildApiUrl("/api/health", primaryEndpoint.base))
      .then((r) => r || fetchOptionalJson(buildApiUrl("/health", primaryEndpoint.base)))
  );
  parallelFetches.push(
    fetchOptionalJson(buildApiUrl("/api/ping-status", primaryEndpoint.base))
      .then((r) => r || fetchOptionalJson(buildApiUrl("/ping-status", primaryEndpoint.base)))
  );

  const [jobPayload, healthPayload, pingPayload] = await Promise.all(parallelFetches);

  if (needsJob && jobPayload) {
    const jobRoot = jobPayload?.job ?? jobPayload?.result ?? jobPayload?.data ?? jobPayload;
    if (jobRoot && typeof jobRoot === "object") {
      enriched.pool.hashrate = pick(
        enriched.pool.hashrate,
        jobRoot.poolHashrate,
        formatHashesMaybe(jobRoot.hashrate),
        formatHashesMaybe(jobRoot.hashRate)
      );
    }
  }

  const healthRoot = healthPayload?.health ?? healthPayload?.result ?? healthPayload?.data ?? healthPayload;
  const pingRoot = pingPayload?.ping ?? pingPayload?.result ?? pingPayload?.data ?? pingPayload;
  if ((healthRoot && typeof healthRoot === "object") || (pingRoot && typeof pingRoot === "object")) {
    enriched.ops = normalizeOperationalData(healthRoot || {}, pingRoot || {});
    enriched.node = enriched.node || normalizeNodeData(healthRoot);
  }

  return enriched;
}

async function fetchDashboardData() {
  const now = Date.now();
  const hasApiBaseOverride = Boolean(explicitApiBaseFromUI());

  if (!hasApiBaseOverride && probeState.lastProbeFailureAt && (now - probeState.lastProbeFailureAt) < FAILED_PROBE_RETRY_MS) {
    return {
      ...fallbackData,
      source: "fallback",
      warning: `No compatible mining API response found on this static server. Skipping re-probe for ${Math.ceil((FAILED_PROBE_RETRY_MS - (now - probeState.lastProbeFailureAt)) / 1000)}s to avoid log spam. Set API Base URL to your pool API port. Last check: ${probeState.lastProbeErrors.join(" | ")}`,
    };
  }

  const errors = [];
  for (const endpoint of orderedEndpointCandidates()) {
    try {
      const res = await fetchJson(buildApiUrl(endpoint.path, endpoint.base));
      if (!res.ok) {
        errors.push(`${endpoint.url} -> ${res.status}`);
        continue;
      }
      const data = normalizePayload(await res.json());
      if (data) {
        probeState.lastGoodEndpoint = endpoint;
        probeState.lastProbeFailureAt = 0;
        probeState.lastProbeErrors = [];

        const enrichedData = await enrichWithSupplementalEndpoints(data, endpoint);

        const hasMinerRows = Array.isArray(enrichedData.miners) && enrichedData.miners.length > 0;
        const hasNetworkStats = Boolean(enrichedData.network?.hashrate || enrichedData.network?.difficulty);
        let warning = "";
        if (!hasMinerRows || !hasNetworkStats) {
          warning = "API is connected but only returning summary stats. For per-miner rows, pool hashrate, and network stats, expose detailed stats fields in your pool API.";
        }

        return { ...enrichedData, source: endpoint.url, warning };
      }
      errors.push(`${endpoint.url} -> unsupported payload`);
    } catch (e) {
      errors.push(`${endpoint.url} -> ${e.message}`);
    }
  }

  probeState.lastProbeFailureAt = now;
  probeState.lastProbeErrors = errors;

  return {
    ...fallbackData,
    source: "fallback",
    warning: `No compatible mining API response found. Checked: ${errors.join(" | ")}`,
  };
}

function clearChildren(target) {
  if (target) target.replaceChildren();
}

function buildEmptyRow(colSpan) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = colSpan;
  td.className = "empty-row";
  td.textContent = "No data available.";
  tr.appendChild(td);
  return tr;
}

function buildRows(target, rows, toRow, emptyColSpan = 1) {
  clearChildren(target);
  if (!rows?.length) {
    target.appendChild(buildEmptyRow(emptyColSpan));
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.forEach((row) => fragment.appendChild(toRow(row)));
  target.appendChild(fragment);
}

function createTextCell(value) {
  const td = document.createElement("td");
  td.textContent = value ?? "--";
  return td;
}

function createTopShareListItem(entry, index) {
  const li = document.createElement("li");

  const rank = document.createElement("span");
  rank.className = "top-share-rank";
  rank.textContent = `${index + 1}.`;

  const miner = document.createElement("span");
  miner.className = "top-share-miner";
  miner.textContent = entry.miner || "--";

  const diff = document.createElement("span");
  diff.className = "top-share-diff";
  diff.textContent = formatDifficulty(entry.difficulty);

  li.append(rank, miner, diff);
  return li;
}

function createMinerRow(m) {
  const tr = document.createElement("tr");
  tr.append(
    createTextCell(m.name ?? "--"),
    createTextCell(m.hashrate ?? "--"),
    createTextCell(formatCount(m.accepted)),
    createTextCell(formatCount(m.rejected)),
    createTextCell(formatCount(m.stale)),
    createTextCell(m.blocksFound > 0 ? String(m.blocksFound) : "--"),
    createTextCell(formatDifficulty(m.highestDifficulty)),
    createTextCell(m.connected ?? "--"),
    createTextCell(m.ping ?? "--"),
    createTextCell(m.lastShare ?? "--")
  );
  return tr;
}

function formatLuckCell(effortPercent) {
  if (!Number.isFinite(effortPercent) || effortPercent <= 0) return "--";
  return `${effortPercent.toFixed(1)}%`;
}

function createBlockRow(b) {
  const tr = document.createElement("tr");
  tr.append(
    createTextCell(b.height ?? "--"),
    createTextCell(b.hash ?? "--"),
    createTextCell(b.difficultyText || formatDifficulty(b.difficulty)),
    createTextCell(formatLuckCell(b.effortPercent)),
    createTextCell(b.reward ?? "--"),
    createTextCell(b.confirmedAt ?? "--"),
    createTextCell(b.minedBy ?? "--")
  );
  return tr;
}

function normalizeTopShareEntry(entry, i = 0) {
  if (!entry || typeof entry !== "object") return null;
  const difficulty = pick(
    entry.difficultyText,
    entry.difficulty,
    entry.diffText,
    entry.diff,
    entry.bestDiffText,
    entry.bestDiff,
    entry.bestDifficultyText,
    entry.bestDifficulty,
    entry.shareDifficultyText,
    entry.shareDifficulty,
    nestedPick(entry, [["share", "difficulty"], ["stats", "difficulty"]])
  );
  const sortDifficulty = Number.isFinite(Number(difficulty)) ? Number(difficulty) : parseScaledNumber(difficulty);
  if (!Number.isFinite(sortDifficulty) || sortDifficulty <= 0) return null;

  return {
    miner: safeMinerName(
      pick(entry.miner, entry.worker, entry.workerName, entry.name, entry.submittedBy, entry.address),
      `miner-${i + 1}`,
      i
    ),
    difficulty,
    sortDifficulty,
  };
}

function normalizeTopAcceptedShares(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry, i) => normalizeTopShareEntry(entry, i))
    .filter(Boolean);
}

function extractTopAcceptedShares(data, miners) {
  const fromApi = normalizeTopAcceptedShares(
    pick(
      data?.pool?.topAcceptedShares,
      data?.pool?.topShares,
      data?.pool?.bestShares,
      data?.topAcceptedShares,
      data?.topShares,
      data?.bestShares
    )
  );

  if (fromApi.length) {
    return [...fromApi]
      .sort((a, b) => b.sortDifficulty - a.sortDifficulty)
      .slice(0, 5);
  }

  return (Array.isArray(miners) ? miners : [])
    .map((m, i) => {
      if (!Number.isFinite(m.sortHighestDifficulty) || m.sortHighestDifficulty <= 0) return null;
      return {
        miner: safeMinerName(m.name, `miner-${i + 1}`, i),
        difficulty: m.highestDifficulty,
        sortDifficulty: m.sortHighestDifficulty,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.sortDifficulty - a.sortDifficulty)
    .slice(0, 5);
}

function getMinerSortValue(miner, key) {
  switch (key) {
    case "name":
      return miner.sortName ?? String(miner.name || "").toLowerCase();
    case "hashrate":
      return miner.sortHashrate;
    case "accepted":
      return miner.sortAccepted;
    case "rejected":
      return miner.sortRejected;
    case "stale":
      return miner.sortStale;
    case "blocksFound":
      return miner.sortBlocksFound;
    case "highestDifficulty":
      return miner.sortHighestDifficulty;
    case "connected":
      return miner.sortConnectedSeconds;
    case "ping":
      return miner.sortPingMs;
    case "lastShare":
      return miner.sortLastShareMs;
    default:
      return null;
  }
}

function compareSortValues(a, b) {
  if (a === null || a === undefined || a === "") return (b === null || b === undefined || b === "") ? 0 : 1;
  if (b === null || b === undefined || b === "") return -1;

  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }

  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function sortMiners(miners) {
  const dir = state.minersSortDir === "asc" ? 1 : -1;
  const key = state.minersSortKey;
  return [...miners].sort((a, b) => {
    const primary = compareSortValues(getMinerSortValue(a, key), getMinerSortValue(b, key));
    if (primary !== 0) return primary * dir;
    return compareSortValues(getMinerSortValue(a, "name"), getMinerSortValue(b, "name"));
  });
}

function updateMinerSortHeaderUi() {
  const headers = document.querySelectorAll("#miners-table th.sortable");
  headers.forEach((th) => {
    const key = th.dataset.sortKey;
    th.classList.remove("sort-asc", "sort-desc");
    if (key === state.minersSortKey) {
      th.classList.add(state.minersSortDir === "asc" ? "sort-asc" : "sort-desc");
    }
  });
}

function defaultSortDirForKey(key) {
  if (key === "name" || key === "ping") return "asc";
  return "desc";
}

function initMinerSorting() {
  const headers = document.querySelectorAll("#miners-table th.sortable");
  if (!headers.length) return;
  headers.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      if (!key) return;
      if (state.minersSortKey === key) {
        state.minersSortDir = state.minersSortDir === "asc" ? "desc" : "asc";
      } else {
        state.minersSortKey = key;
        state.minersSortDir = defaultSortDirForKey(key);
      }
      updateMinerSortHeaderUi();
      if (state.lastData) render(state.lastData);
    });
  });
  updateMinerSortHeaderUi();
}

function render(data) {
  state.lastData = data;
  const miners = sortMiners(Array.isArray(data.miners) ? data.miners : []);
  const aggregateRate = miners
    .reduce((sum, m) => sum + (Number.isFinite(Number(m.rawRate)) ? Number(m.rawRate) : 0), 0);
  const poolRate = data.pool?.hashrate || (aggregateRate > 0 ? formatHashes(aggregateRate) : "--");
  const ops = data.ops || {};

  $("#pool-hashrate").textContent = poolRate;
  $("#connected-miners").textContent = formatCount(data.pool?.connectedMiners ?? miners.length);
  const uptimeSec = Number(data.uptimeSeconds);
  $("#pool-uptime").textContent = Number.isFinite(uptimeSec) && uptimeSec >= 0 ? formatDuration(uptimeSec) : "--";
  $("#total-accepted").textContent = formatCount(data.pool?.sharesAccepted);
  const rejectedEl = $("#total-rejected");
  if (rejectedEl) rejectedEl.textContent = `rejected: ${formatCount(data.pool?.sharesRejected)}`;
  const blocksFoundEl = $("#blocks-found");
  if (blocksFoundEl) blocksFoundEl.textContent = formatCount((data.blocks || []).length);

  // Pool Luck
  const poolLuckEl = $("#pool-luck");
  const poolLuckDetailEl = $("#pool-luck-detail");
  if (poolLuckEl) {
    const avgLuck = Number(data.averageLuck);
    if (Number.isFinite(avgLuck) && avgLuck > 0) {
      poolLuckEl.textContent = `${avgLuck.toFixed(1)}%`;
      const blocksWithLuck = (data.blocks || []).filter((b) => Number.isFinite(b.effortPercent) && b.effortPercent > 0).length;
      if (poolLuckDetailEl) poolLuckDetailEl.textContent = `avg over ${blocksWithLuck} block${blocksWithLuck !== 1 ? "s" : ""}`;
    } else {
      poolLuckEl.textContent = "--";
      if (poolLuckDetailEl) poolLuckDetailEl.textContent = "no blocks found yet";
    }
  }

  const atBest = data.allTimeBestShare;
  const atBestEl = $("#alltime-best-difficulty");
  if (atBestEl) {
    atBestEl.textContent = atBest && atBest.difficulty > 0
      ? (atBest.difficultyText || formatDifficulty(atBest.difficulty))
      : "--";
  }
  const atBestMinerEl = $("#alltime-best-miner");
  if (atBestMinerEl) atBestMinerEl.textContent = `miner: ${atBest?.worker || "--"}`;
  const atBestTimeEl = $("#alltime-best-time");
  if (atBestTimeEl) atBestTimeEl.textContent = atBest?.at ? formatRelativeTime(atBest.at) : "";

  const topAcceptedShares = extractTopAcceptedShares(data, miners);
  const bestShare = topAcceptedShares[0] || null;
  $("#highest-share-difficulty").textContent = bestShare ? formatDifficulty(bestShare.difficulty) : "--";
  $("#highest-share-miner").textContent = `miner: ${bestShare?.miner || "--"}`;

  const topSharesList = $("#top-share-list");
  if (topSharesList) {
    clearChildren(topSharesList);
    if (!topAcceptedShares.length) {
      const li = document.createElement("li");
      li.textContent = "--";
      topSharesList.appendChild(li);
    } else {
      const fragment = document.createDocumentFragment();
      topAcceptedShares.forEach((entry, i) => fragment.appendChild(createTopShareListItem(entry, i)));
      topSharesList.appendChild(fragment);
    }
  }

  // Block effort: cumulative pool work as a percentage of expected work per block.
  // Effort = (poolHashrate * uptimeSeconds) / (networkHashrate * blockInterval) * 100
  const effortPoolRate = aggregateRate > 0 ? aggregateRate : parseScaledNumber(poolRate);
  const effortNetRate = parseScaledNumber(data.network?.hashrate);
  const effortUptime = Number(data.secondsSinceLastBlock ?? data.uptimeSeconds);
  const effortEl = $("#block-effort");
  const effortBarEl = $("#block-effort-bar");
  const effortDetailEl = $("#block-effort-detail");
  if (Number.isFinite(effortPoolRate) && effortPoolRate > 0 &&
      Number.isFinite(effortNetRate) && effortNetRate > 0 &&
      Number.isFinite(effortUptime) && effortUptime > 0) {
    const cumulativeWork = effortPoolRate * effortUptime;
    const expectedWork = effortNetRate * (getDashboardConfig().blockIntervalSeconds || 75);
    const effortPct = (cumulativeWork / expectedWork) * 100;
    effortEl.textContent = effortPct >= 10 ? `${effortPct.toFixed(1)}%` : `${effortPct.toFixed(3)}%`;
    if (effortBarEl) {
      effortBarEl.style.width = `${Math.min(effortPct, 100)}%`;
      effortBarEl.classList.toggle("overdue", effortPct > 100);
    }
    if (effortDetailEl) {
      if (effortPct >= 100) {
        effortDetailEl.textContent = `${effortPct.toFixed(1)}% — overdue by ${formatLongDuration((effortPct - 100) / 100 * (expectedWork / effortPoolRate))}`;
      } else {
        const workLeft = expectedWork - cumulativeWork;
        const secsLeft = workLeft / effortPoolRate;
        effortDetailEl.textContent = `~${formatLongDuration(secsLeft)} remaining at current rate`;
      }
    }
  } else {
    effortEl.textContent = "--";
    if (effortBarEl) effortBarEl.style.width = "0%";
    if (effortDetailEl) effortDetailEl.textContent = "needs pool + network hashrate + uptime";
  }

  // Estimated time to find a block
  const poolSolPerSec = aggregateRate > 0 ? aggregateRate : parseScaledNumber(poolRate);
  const netSolPerSec = parseScaledNumber(data.network?.hashrate);
  const estSeconds = estimateTimeToBlock(poolSolPerSec, netSolPerSec);
  $("#est-time-to-block").textContent = estSeconds !== null ? formatLongDuration(estSeconds) : "--";
  const detailEl = $("#est-time-to-block-detail");
  if (detailEl) {
    if (estSeconds !== null && Number.isFinite(poolSolPerSec) && Number.isFinite(netSolPerSec)) {
      const pct = ((poolSolPerSec / netSolPerSec) * 100);
      detailEl.textContent = `${pct < 0.01 ? pct.toExponential(1) : pct.toFixed(pct < 1 ? 3 : 2)}% of network`;
    } else {
      detailEl.textContent = "needs pool + network hashrate";
    }
  }

  $("#network-hashrate").textContent = data.network?.hashrate || "--";
  $("#network-difficulty").textContent = formatDifficulty(data.network?.difficulty);
  $("#node-connections").textContent = formatCount(data.node?.connections);
  $("#node-peers").textContent = `inbound: ${formatCount(data.node?.incomingPeers)} | outbound: ${formatCount(data.node?.outgoingPeers)}`;
  $("#node-version").textContent = data.node?.version || "--";
  $("#node-software").textContent = data.node?.software || "--";
  updateMinerSortHeaderUi();

  buildRows($("#miner-rows"), miners, createMinerRow, 10);
  buildRows($("#block-rows"), (data.blocks || []).slice(0, 10), createBlockRow, 7);

  const now = new Date().toLocaleString();
  const updatedEl = $("#last-updated");
  if (data.source === "fallback") {
    updatedEl.textContent = `⚠ Sample data — API unreachable — ${now}`;
    updatedEl.classList.add("warning-text");
  } else {
    updatedEl.textContent = `Last updated ${now}`;
    updatedEl.classList.remove("warning-text");
  }
}

async function refresh() {
  render(await fetchDashboardData());
}

function startRefreshTimer() {
  stopRefreshTimer();
  state.refreshTimerId = window.setInterval(refresh, getRefreshMs());
}

function stopRefreshTimer() {
  if (state.refreshTimerId !== null) {
    window.clearInterval(state.refreshTimerId);
    state.refreshTimerId = null;
  }
}

async function startDashboard() {
  await DASHBOARD_CONFIG_READY;
  initMinerSorting();
  await refresh();
  startRefreshTimer();

  // Pause refresh when tab is hidden, resume immediately when visible
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopRefreshTimer();
    } else {
      refresh();
      startRefreshTimer();
    }
  });
}

startDashboard();
