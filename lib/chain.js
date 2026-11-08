"use strict";

// Zcash chain parameters the pool needs for display and job freshness.
// NU7 (ZIP 218) cut the target block spacing from 75 s to 25 s.
const PRE_NU7_BLOCK_SECONDS = 75;
const NU7_BLOCK_SECONDS = 25;

// NU7 activation height from a getblockchaininfo result, or null when the node does not report it.
function nu7ActivationHeight(info) {
  const upgrades = info && info.upgrades;
  if (!upgrades || typeof upgrades !== "object") return null;
  for (const upgrade of Object.values(upgrades)) {
    if (upgrade && upgrade.name === "NU7") {
      const h = Number(upgrade.activationheight);
      return Number.isSafeInteger(h) && h > 0 ? h : null;
    }
  }
  return null;
}

function targetBlockSeconds(height, nu7Height) {
  if (Number.isFinite(nu7Height) && Number.isFinite(height) && height >= nu7Height) return NU7_BLOCK_SECONDS;
  return PRE_NU7_BLOCK_SECONDS;
}

function formatZec(zat) {
  if (!Number.isSafeInteger(zat) || zat < 0) return null;
  const whole = Math.floor(zat / 1e8);
  const frac = String(zat % 1e8).padStart(8, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} ZEC`;
}

// Difficulty-1 targets: each chain's powLimit in compact form, which is what the node
// divides by for getdifficulty. Share difficulty in these units compares directly with
// network difficulty and with what miners display.
const DIFF1_TARGET = {
  main: BigInt("0x0007ffff" + "0".repeat(56)), // 0x1f07ffff
  test: BigInt("0x07ffff" + "0".repeat(58)), // 0x2007ffff
};

// Difficulty of a share hash (big-endian hex) in network-difficulty units, or null.
function shareDifficulty(hashHex, chainName) {
  if (typeof hashHex !== "string" || !/^[0-9a-fA-F]{1,64}$/.test(hashHex)) return null;
  const hash = BigInt("0x" + hashHex);
  if (hash === 0n) return null;
  const diff1 = DIFF1_TARGET[chainName] || DIFF1_TARGET.main;
  return Number((diff1 * 1_000_000n) / hash) / 1e6;
}

// True when the node's best block is no longer the parent of the current job.
function tipChanged(bestBlockHash, job) {
  if (!job || !job.prevhash) return true;
  return String(bestBlockHash).toLowerCase() !== String(job.prevhash).toLowerCase();
}

module.exports = {
  PRE_NU7_BLOCK_SECONDS,
  NU7_BLOCK_SECONDS,
  nu7ActivationHeight,
  shareDifficulty,
  targetBlockSeconds,
  formatZec,
  tipChanged,
};
