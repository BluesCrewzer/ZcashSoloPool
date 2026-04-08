const crypto = require("crypto");
const bs58checkRaw = require("bs58check");
const bs58check = bs58checkRaw.default || bs58checkRaw;
const EquihashVerifier = require("./equihashVerifier");

class WorkManager {
  constructor(rpcClient, walletAddress, logger = console, options = {}) {
    this.rpcClient = rpcClient;
    this.walletAddress = String(walletAddress || "").trim();
    this.logger = logger;

    this.currentJob = null;
    this.jobs = new Map();
    this.jobCounter = 0;

    this.shareValidationMode = String(options.shareValidationMode || 'local').toLowerCase();
    this.poolTarget = this.normalizeTarget(options.shareTarget) || "f".repeat(64);
    this.protocolMode = String(options.protocolMode || 'zip301').toLowerCase();
    this.notifyPreset = String(options.notifyPreset || 'headerle').toLowerCase();

    // Require the native verifier to be present and use it for every share.
    this.verifier = new EquihashVerifier(this.logger);
    if (!this.verifier.enabled) {
      throw new Error(
        "The native 'equihashverify' module is required. Install build deps then run: npm install"
      );
    }
  }

  async generateJob(cleanJobs = false) {
    const template = await this.rpcClient.getBlockTemplate();
    const jobId = (++this.jobCounter).toString(16);

    const coinbaseTx = this.getCoinbaseFromTemplate(template);
    const coinbaseTxid = template.coinbasetxn && template.coinbasetxn.hash;
    const merkleRootBE = this.calculateFullMerkleRoot(coinbaseTx, template.transactions || [], coinbaseTxid);

    const versionLE = this.uint32ToHex(template.version);
    const versionBE = this.reverseHex(versionLE);

    const prevhashBE = template.previousblockhash;              // notify-friendly
    const prevhashLE = this.reverseHex(prevhashBE);             // header bytes

    const ntimeBE = Number(template.curtime >>> 0).toString(16).padStart(8, "0");
    const ntimeLE = this.reverseHex(ntimeBE);

    this.currentJob = {
      jobId,

      // Notify fields (miner-facing)
      version: versionLE,
      prevhash: prevhashBE,
      merkleRoot: merkleRootBE, // BE
      reserved:
        template.blockcommitmentshash ||
        template.lightclientroothash ||
        template.finalsaplingroothash ||
        "0000000000000000000000000000000000000000000000000000000000000000",
      ntime: ntimeBE,
      nbits: template.bits,
      cleanJobs,
      height: template.height,
      target: template.target,

      // Internals for hashing/assembly
      _versionLE: versionLE,
      _prevhashLE: prevhashLE,
      _merkleRootLE: this.reverseHex(merkleRootBE),
      _ntimeLE: ntimeLE,

      _versionBE: versionBE,
      _prevhashBE: prevhashBE,
      _merkleRootBE: merkleRootBE,
      _reservedBE: (template.blockcommitmentshash ||
        template.lightclientroothash ||
        template.finalsaplingroothash ||
        "0000000000000000000000000000000000000000000000000000000000000000"),

      // LE header-byte versions (some miners expect these in notify)
      _reservedLE: this.reverseHex(template.blockcommitmentshash ||
        template.lightclientroothash ||
        template.finalsaplingroothash ||
        "0000000000000000000000000000000000000000000000000000000000000000"),
      _merkleRootLE_forNotify: this.reverseHex(merkleRootBE),
      _prevhashLE_forNotify: prevhashLE,
      _versionLE_forNotify: versionLE,

      coinbaseTx,
      template,
    };

    if (cleanJobs) this.jobs.clear();
    this.jobs.set(jobId, this.currentJob);

    // Strictly retain only jobs for the latest height to prevent stale submissions
    for (const [id, j] of this.jobs) {
      if (id === jobId) continue;
      if (j.height !== this.currentJob.height) this.jobs.delete(id);
    }

    if (this.jobs.size > 64) this.jobs.delete(this.jobs.keys().next().value);

    return this.currentJob;
  }

  getCoinbaseFromTemplate(template) {
    if (!this.walletAddress) {
      throw new Error("walletAddress is required for coinbase validation");
    }

    if (!template || !template.coinbasetxn || typeof template.coinbasetxn.data !== "string") {
      throw new Error("getblocktemplate did not provide coinbasetxn.data (zebrad required)");
    }

    const provided = this.normalizeHexField(template.coinbasetxn.data, { maxLength: 2000000 });
    if (!provided) throw new Error("coinbasetxn.data is not valid hex");

    const expectedScript = this.buildP2PKHScript(this.walletAddress);
    if (expectedScript && !provided.toLowerCase().includes(expectedScript.toLowerCase())) {
      throw new Error("coinbasetxn does not pay configured walletAddress; aborting to prevent misdirected rewards");
    }

    return provided;
  }

  // Merkle hashing uses internal LE byte order of txids.
  calculateFullMerkleRoot(coinbaseTxHex, txs, coinbaseTxid = null) {
    const leaves = [];
    let cbHash;
    if (coinbaseTxid && /^[0-9a-fA-F]{64}$/.test(coinbaseTxid)) {
      // Zebrad provides the correct txid (display/BE order). Reverse to internal LE.
      // For NU5 v5 transactions, txid != SHA256d(raw_bytes), so we must use this.
      cbHash = Buffer.from(coinbaseTxid, "hex").reverse();
    } else {
      // Fallback for v1-v4 transactions where txid == SHA256d(raw_bytes).
      cbHash = this.doubleHash(Buffer.from(coinbaseTxHex, "hex"));
    }
    leaves.push(cbHash);

    for (const t of txs || []) {
      const h = String(t.hash || t.txid || "");
      if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("Template tx missing valid hash/txid");
      leaves.push(Buffer.from(h, "hex").reverse());
    }

    let layer = leaves;
    while (layer.length > 1) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        const left = layer[i];
        const right = layer[i + 1] || layer[i];
        next.push(this.doubleHash(Buffer.concat([left, right])));
      }
      layer = next;
    }

    return layer[0].reverse().toString("hex"); // BE display
  }

  async validateShare(submission) {
    const job = this.jobs.get(submission.jobId);
    if (!job) return { valid: false, error: "Job Expired" };

    // Reject stale jobs that are not the current height
    if (this.currentJob && job.height !== this.currentJob.height) {
      return { valid: false, error: "Stale Job" };
    }

    const nTimeBE = this.normalizeHexField(submission.nTime, { maxLength: 8 });
    if (!nTimeBE || nTimeBE.length !== 8) return { valid: false, error: "Invalid nTime size" };

    // Miner and firmware variants disagree on nTime endianness on submit; try safe variants.
    const nTimeHeaderCandidates = this.normalizeHeaderTimeCandidates(nTimeBE, job);

    const nonceHex = this.normalizeHexField(submission.nonce, { allowOddLength: true, maxLength: 128 });
    if (!nonceHex) return { valid: false, error: "Nonce is not valid hex" };

    const solutionHex = this.normalizeHexField(submission.solution, { maxLength: 60000 });
    if (!solutionHex) return { valid: false, error: "Solution is not valid hex" };

    const headerNonces = this.normalizeNonceCandidates(nonceHex, submission.client && submission.client.extranonce1);
    const bitsHeaderCandidates = this.normalizeCompactBitsCandidates(job.nbits);
    const solutionFields = this.normalizeSolutionFields(solutionHex);
    if (!headerNonces.length || !nTimeHeaderCandidates.length || !bitsHeaderCandidates.length || !solutionFields.length) {
      return { valid: false, error: "Invalid nonce/solution layout" };
    }

    const netTargetBI = BigInt("0x" + job.target);
    const clientTargetHex = this.normalizeTarget(submission.client && submission.client.shareTarget) || this.poolTarget;
    const poolTargetBI = BigInt("0x" + clientTargetHex);

    // Grace period: accept shares that meet the previous (lower) difficulty
    // for a short window after VarDiff increases. This prevents rejecting
    // in-flight shares the miner computed before receiving the new target.
    const client = submission.client;
    let graceTargetBI = null;
    if (client && client.previousShareTarget && Date.now() < client.previousTargetExpiresAt) {
      const prevHex = this.normalizeTarget(client.previousShareTarget);
      if (prevHex) {
        const prevBI = BigInt("0x" + prevHex);
        // Only use grace target if it's more lenient (higher value = easier)
        if (prevBI > poolTargetBI) graceTargetBI = prevBI;
      }
    }

    // Pre-parse solutions once — extractRawSolutionBytes does compact-size parsing
    // and would otherwise run inside the triple-nested loop for every candidate.
    const parsedSolutions = [];
    for (const solutionFieldHex of solutionFields) {
      const solRaw = this.extractRawSolutionBytes(solutionFieldHex);
      if (solRaw) parsedSolutions.push({ solutionFieldHex, solBuf: solRaw });
    }
    if (!parsedSolutions.length) return { valid: false, error: "Invalid solution" };

    // Pre-build a single 140-byte header Buffer with the static fields (bytes 0-99:
    // version + prevhash + merkleRoot + reserved). Only nTime (100-103), nBits (104-107),
    // and nonce (108-139) change per candidate — we overwrite those bytes in-place.
    const headerBuf = Buffer.alloc(140);
    Buffer.from(
      job._versionLE + job._prevhashLE + job._merkleRootLE + job._reservedLE,
      "hex"
    ).copy(headerBuf, 0);

    let bestTried = null;

    for (const headerNonce of headerNonces) {
      Buffer.from(headerNonce, "hex").copy(headerBuf, 108);

      for (const nTimeHeader of nTimeHeaderCandidates) {
        Buffer.from(nTimeHeader, "hex").copy(headerBuf, 100);

        for (const bitsHeader of bitsHeaderCandidates) {
          Buffer.from(bitsHeader, "hex").copy(headerBuf, 104);

          for (const { solutionFieldHex, solBuf } of parsedSolutions) {
            // Verify Equihash solution against the assembled header
            if (!this.verifier.verify(headerBuf, solBuf)) continue;

            const solutionBuf = Buffer.from(solutionFieldHex, "hex");
            const hashBE = this.doubleHash(Buffer.concat([headerBuf, solutionBuf]))
              .reverse()
              .toString("hex");
            const hashBI = BigInt("0x" + hashBE);

            if (!bestTried || hashBI < bestTried.hashBI) bestTried = { hash: hashBE, hashBI };

            const isBlock = hashBI <= netTargetBI;
            const isShare = hashBI <= poolTargetBI;
            const isGraceShare = !isShare && graceTargetBI && hashBI <= graceTargetBI;
            const effectiveTarget = (isShare || isBlock) ? poolTargetBI : (isGraceShare ? graceTargetBI : poolTargetBI);
            const shareQuality = this.ratioToDecimalString(effectiveTarget, hashBI, 6);
            const networkQuality = this.ratioToDecimalString(netTargetBI, hashBI, 6);

            if (isShare || isBlock || isGraceShare) {
              const powHeaderHex = headerBuf.toString("hex");
              return {
                valid: true,
                isBlock,
                hash: hashBE,
                shareQuality,
                networkQuality,
                hashValueHex: hashBI.toString(16),
                blockHex: isBlock ? this.assemble(job, powHeaderHex, solutionFieldHex) : null,
                height: job.height,
                jobNbits: job.nbits,
              };
            }
          }
        }
      }
    }

    const preview = bestTried ? bestTried.hash.substring(0, 16) : "n/a";
    this.logger.debug(`[Share] Rejected job=${submission.jobId} best=${preview}`);
    return { valid: false, error: bestTried ? "Low Diff" : "Invalid solution" };
  }

  assemble(job, powHeaderHex, solutionFieldHex) {
    const txCount = 1 + (job.template.transactions?.length || 0);
    const countHex = this.compactSizeHex(txCount);
    return (
      powHeaderHex +
      solutionFieldHex +
      countHex +
      job.coinbaseTx +
      (job.template.transactions || []).map((t) => t.data).join("")
    );
  }

  extractRawSolutionBytes(solutionFieldHex) {
    const parsed = this.parseCompactSize(solutionFieldHex);
    if (!parsed) return null;
    const body = solutionFieldHex.slice(parsed.sizeHexChars);
    if (body.length / 2 !== parsed.value) return null;
    return Buffer.from(body, "hex");
  }

  normalizeNonceCandidates(nonceHex, extranonce1 = null) {
    if (!nonceHex || nonceHex.length % 2 !== 0 || nonceHex.length > 64) return [];
    const candidates = [];
    const extra = this.normalizeHexField(extranonce1, { maxLength: 8 });
    const push = (value) => {
      if (!value || value.length !== 64) return;
      if (!/^[0-9a-f]{64}$/.test(value)) return;
      candidates.push(value);
    };

    if (nonceHex.length === 64) {
      push(nonceHex);
      return [...new Set(candidates)];
    }

    // 28-byte nonce + 4-byte extranonce1 is common for Equihash ASICs.
    // Different firmware inserts extranonce at different offsets.
    // Cap at 8 insertion positions to prevent DoS amplification via excessive
    // Equihash verifier calls per share (worst case: 29 positions × 6 nTime
    // candidates × 4 bits candidates = 696 verifications per submission).
    if (extra && extra.length === 8 && nonceHex.length + extra.length === 64) {
      const prevLen = candidates.length;
      for (let i = 0; i <= nonceHex.length; i += 2) {
        push(nonceHex.slice(0, i) + extra + nonceHex.slice(i));
        if (candidates.length - prevLen >= 8) break;
      }
    }

    if (nonceHex.length >= 8) {
      push(nonceHex.padStart(64, "0"));
      push(nonceHex.padEnd(64, "0"));
    }

    return [...new Set(candidates)];
  }

  normalizeHeaderTimeCandidates(submittedNTime, job) {
    const out = [];
    const seen = new Set();
    const push = (value) => {
      const normalized = this.normalizeHexField(value, { maxLength: 8 });
      if (!normalized || normalized.length !== 8 || seen.has(normalized)) return;
      seen.add(normalized);
      out.push(normalized);
    };

    push(submittedNTime);
    push(this.reverseHex(submittedNTime));
    push(job && job._ntimeLE);
    push(job && job.ntime);
    if (job && job.ntime) push(this.reverseHex(job.ntime));
    push(job && job._ntimeBE);
    return out;
  }

  normalizeCompactBitsCandidates(bitsHex) {
    const out = [];
    const seen = new Set();
    const push = (value) => {
      const normalized = this.normalizeHexField(value, { maxLength: 8 });
      if (!normalized || normalized.length !== 8 || seen.has(normalized)) return;
      seen.add(normalized);
      out.push(normalized);
    };

    const raw = this.normalizeHexField(bitsHex, { maxLength: 8 });
    if (!raw || raw.length !== 8) return out;

    push(raw);
    push(this.reverseHex(raw));

    const normalizedLE = this.normalizeCompactBitsLE(raw);
    if (normalizedLE && normalizedLE.length === 8) push(normalizedLE);
    if (normalizedLE && normalizedLE.length === 8) push(this.reverseHex(normalizedLE));

    return out;
  }

  normalizeSolutionFields(solutionHex) {
    const out = [];
    const seen = new Set();
    const push = (v) => { if (v && !seen.has(v)) { seen.add(v); out.push(v); } };

    const parsed = this.parseCompactSize(solutionHex);
    if (parsed) {
      const body = solutionHex.slice(parsed.sizeHexChars);
      if (body.length / 2 === parsed.value) {
        push(solutionHex);
        const canonical = this.compactSizeHex(body.length / 2);
        if (canonical) push(canonical + body);
        return out;
      }
    }

    const prefix = this.compactSizeHex(solutionHex.length / 2);
    if (prefix) push(prefix + solutionHex);
    return out;
  }

  normalizeHexField(input, options = {}) {
    if (input === null || input === undefined) return null;
    const { allowOddLength = false, maxLength = null } = options;

    let normalized;
    if (Buffer.isBuffer(input)) normalized = input.toString("hex");
    else if (typeof input === "string") normalized = input.trim().toLowerCase().replace(/^0x/, "");
    else if (typeof input === "number" || typeof input === "bigint") {
      if (input < 0) return null;
      normalized = input.toString(16);
    } else return null;

    if (!normalized || !/^[0-9a-f]+$/.test(normalized)) return null;
    if (allowOddLength && normalized.length % 2 !== 0) normalized = `0${normalized}`;
    if (normalized.length % 2 !== 0) return null;
    if (maxLength && normalized.length > maxLength) return null;
    return normalized;
  }

  normalizeTarget(target) {
    const normalized = this.normalizeHexField(target, { maxLength: 64 });
    if (!normalized) return null;
    return normalized.padStart(64, "0");
  }

  compactSizeHex(value) {
    if (!Number.isFinite(value) || value < 0) return null;
    if (value < 253) return value.toString(16).padStart(2, "0");

    if (value <= 0xffff) {
      const b = Buffer.alloc(2);
      b.writeUInt16LE(value);
      return `fd${b.toString("hex")}`;
    }

    if (value <= 0xffffffff) {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(value);
      return `fe${b.toString("hex")}`;
    }

    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(value));
    return `ff${b.toString("hex")}`;
  }

  parseCompactSize(hexValue) {
    if (typeof hexValue !== "string" || hexValue.length < 2 || hexValue.length % 2 !== 0) return null;

    const prefix = parseInt(hexValue.slice(0, 2), 16);
    if (prefix < 0xfd) return { value: prefix, sizeHexChars: 2 };

    if (prefix === 0xfd) {
      if (hexValue.length < 6) return null;
      const value = Buffer.from(hexValue.slice(2, 6), "hex").readUInt16LE(0);
      return { value, sizeHexChars: 6 };
    }

    if (prefix === 0xfe) {
      if (hexValue.length < 10) return null;
      const value = Buffer.from(hexValue.slice(2, 10), "hex").readUInt32LE(0);
      return { value, sizeHexChars: 10 };
    }

    if (hexValue.length < 18) return null;
    const value = Number(Buffer.from(hexValue.slice(2, 18), "hex").readBigUInt64LE(0));
    if (!Number.isSafeInteger(value)) return null;
    return { value, sizeHexChars: 18 };
  }

  uint32ToHex(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(Number(n) >>> 0);
    return b.toString("hex");
  }

  reverseHex(h) { return Buffer.from(h, "hex").reverse().toString("hex"); }

  normalizeCompactBitsLE(bitsHex) {
    const h = (bitsHex || "").toLowerCase();
    if (h.length !== 8 || !/^[0-9a-f]{8}$/.test(h)) return h;

    const beExp = parseInt(h.slice(0, 2), 16);
    const leExp = parseInt(h.slice(6, 8), 16);
    const expRange = (x) => x >= 3 && x <= 32;

    if (expRange(beExp) && !expRange(leExp)) return this.reverseHex(h);
    if (expRange(leExp) && !expRange(beExp)) return h;
    return h;
  }

  doubleHash(buf) {
    return crypto
      .createHash("sha256")
      .update(crypto.createHash("sha256").update(buf).digest())
      .digest();
  }

  buildP2PKHScript(address) {
    try {
      const raw = bs58check.decode(address);
      const decoded = Buffer.from(raw);
      if (decoded.length < 22) return null;

      const prefix = decoded.slice(0, 2).toString("hex");
      const hash160 = decoded.slice(2).toString("hex");

      // Allowed transparent prefixes (mainnet t1/t3, testnet tm/t2)
      const allowed = ["1cb8", "1cbd", "1d25", "1cba"]; // p2pkh / p2sh prefixes
      if (!allowed.includes(prefix)) {
        throw new Error("walletAddress must be a transparent t-address (p2pkh or p2sh)");
      }

      // Only allow p2pkh for payout enforcement (t1 / tm)
      if (prefix !== "1cb8" && prefix !== "1d25") {
        throw new Error("Only P2PKH transparent addresses (t1/tm) are supported for payouts");
      }

      // OP_DUP OP_HASH160 PUSH20 <hash160> OP_EQUALVERIFY OP_CHECKSIG
      return `76a914${hash160}88ac`;
    } catch (e) {
      if (this.logger && this.logger.warn) {
        this.logger.warn(`[Work] walletAddress validation failed: ${e.message}`);
      }
      throw e;
    }
  }

  ratioToDecimalString(numerator, denominator, decimals = 6) {
    if (typeof numerator !== "bigint" || typeof denominator !== "bigint") return "0";
    if (denominator <= 0n || numerator <= 0n) return "0";
    const scale = 10n ** BigInt(Math.max(0, decimals));
    const scaled = (numerator * scale) / denominator;
    const whole = scaled / scale;
    const frac = scaled % scale;
    if (frac === 0n) return whole.toString();
    return `${whole.toString()}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
  }

  getCurrentJob() {
    return this.currentJob;
  }

}

module.exports = WorkManager;
