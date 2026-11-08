"use strict";

// Synthetic Zebra getblocktemplate fixtures. The coinbase layout copies a live
// Zebra 7.0.0 post-NU7 coinbase (v6, 2026-11-08); the payout key is a dummy.
const bs58checkRaw = require("bs58check");
const bs58check = bs58checkRaw.default || bs58checkRaw;

const POOL_HASH160 = "11".repeat(20);
const POOL_ADDRESS = bs58check.encode(Buffer.from("1cb8" + POOL_HASH160, "hex"));
const OTHER_HASH160 = "22".repeat(20);

const p2pkh = (h160) => `76a914${h160}88ac`;
const p2sh = (h160) => `a914${h160}87`;

function compactSize(n) {
  if (n < 0xfd) return n.toString(16).padStart(2, "0");
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return `fd${b.toString("hex")}`;
}

function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b.toString("hex");
}

const HEADERS = {
  6: "06000080" + "98b684d8" + "d90a1977" + "00000000" + "43343600",
  5: "05000080" + "0a27a726" + "5510e7c8" + "00000000" + "43343600",
  4: "04000080" + "85202f89",
};

// outputs: [{ value, script }]
function coinbaseTx({ version = 6, outputs }) {
  const vin = "01" + "00".repeat(32) + "ffffffff" + "09" + "0343343604f09fa693" + "ffffffff";
  const vout = compactSize(outputs.length) +
    outputs.map((o) => u64le(o.value) + compactSize(o.script.length / 2) + o.script).join("");
  return HEADERS[version] + vin + vout + "00000000";
}

// Miner output 41,670,668 zat (NU7 subsidy share + fee share) plus the lockbox P2SH output.
const NU7_OUTPUTS = [
  { value: 41670668, script: p2pkh(POOL_HASH160) },
  { value: 4166666, script: p2sh(OTHER_HASH160) },
];

function template({ prev = "00000000006d0000000000000000000000000000000000000000000000000001", coinbase } = {}) {
  return {
    version: 4,
    previousblockhash: prev,
    blockcommitmentshash: "bc".repeat(32),
    bits: "1c013fbe",
    target: "000000000013fbe0000000000000000000000000000000000000000000000000",
    curtime: 1794159182,
    height: 3552315,
    longpollid: "lp-1",
    coinbasetxn: { data: coinbase || coinbaseTx({ outputs: NU7_OUTPUTS }), hash: "33".repeat(32) },
    transactions: [],
  };
}

module.exports = { POOL_ADDRESS, POOL_HASH160, OTHER_HASH160, p2pkh, p2sh, coinbaseTx, NU7_OUTPUTS, template };
