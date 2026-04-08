"use strict";

/**
 * Equihash verifier wrapper for Zcash (Equihash 200,9).
 * Uses the native equihashverify addon.
 */

let native = null;
try {
  // Prefer in-repo native addon first (built in ./native/equihashverify)
  native = require("../native/equihashverify");
} catch (e1) {
  try {
    // Fallback to dependency-installed addon
    native = require("equihashverify");
  } catch (e2) {
    native = null;
  }
}

class EquihashVerifier {
  constructor(logger) {
    this.logger = logger;

    // Native addon API compatibility:
    // - historical: { verifyEH(headerBuf140, solutionBuf1344) }
    // - current (this repo): { verify(headerBuf140, solutionBuf1344), path }
    // - defensive: allow a direct function export
    const maybeObj = native;
    this._verifyFn =
      (maybeObj && typeof maybeObj.verifyEH === "function" && maybeObj.verifyEH.bind(maybeObj)) ||
      (maybeObj && typeof maybeObj.verify === "function" && maybeObj.verify.bind(maybeObj)) ||
      (typeof maybeObj === "function" ? maybeObj : null);

    this.enabled = typeof this._verifyFn === "function";
  }

  verify(headerBuf, solutionBuf) {
    try {
      if (!Buffer.isBuffer(headerBuf) || headerBuf.length !== 140) return false;
      if (!Buffer.isBuffer(solutionBuf) || solutionBuf.length !== 1344) return false;

      if (this._verifyFn) return !!this._verifyFn(headerBuf, solutionBuf);

      return false;
    } catch (e) {
      if (this.logger && this.logger.warn) this.logger.warn(`[Equihash] verify error: ${e.message}`);
      return false;
    }
  }
}

module.exports = EquihashVerifier;
