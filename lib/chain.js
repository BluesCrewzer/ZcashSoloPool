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

// True when the node's best block is no longer the parent of the current job.
function tipChanged(bestBlockHash, job) {
  if (!job || !job.prevhash) return true;
  return String(bestBlockHash).toLowerCase() !== String(job.prevhash).toLowerCase();
}

module.exports = {
  PRE_NU7_BLOCK_SECONDS,
  NU7_BLOCK_SECONDS,
  nu7ActivationHeight,
  targetBlockSeconds,
  formatZec,
  tipChanged,
};
