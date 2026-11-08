"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const StratumServer = require("../lib/stratumServer");

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const DEFAULT_SOLS_PER_DIFF = 262144; // 2^256 / 0x00003fff...ff

function client() {
  return { metrics: { accepted: 0, rejected: 0, invalid: 0, lowDiff: 0, stale: 0, recentAccepted: [], bestShareDifficulty: 0 } };
}

test("one unit of difficulty is 2^256 / shareTarget solutions", () => {
  assert.equal(Math.round(new StratumServer({}, quiet).solutionsPerDifficulty), DEFAULT_SOLS_PER_DIFF);
  const easy = new StratumServer({ shareTarget: "0007" + "f".repeat(60) }, quiet);
  assert.equal(Math.round(easy.solutionsPerDifficulty), 8192);
});

test("window hashrate converts assigned difficulty to solutions per second", () => {
  const s = new StratumServer({}, quiet);
  const c = client();
  c.metrics.recentAccepted.push({ ts: Date.now() - 1000, difficulty: 100 });
  // 100 difficulty in a 100 s window = 1 difficulty/s = 262,144 Sol/s
  assert.equal(Math.round(s.estimateHashrate(c, 100)), DEFAULT_SOLS_PER_DIFF);
});

test("a configured solutionRateScale no longer changes the estimate", () => {
  const s = new StratumServer({ solutionRateScale: 1000 }, quiet);
  const c = client();
  c.metrics.recentAccepted.push({ ts: Date.now() - 1000, difficulty: 100 });
  assert.equal(Math.round(s.estimateHashrate(c, 100)), DEFAULT_SOLS_PER_DIFF);
});

test("EWMA hashrate uses the same solutions-per-difficulty conversion", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const s = new StratumServer({}, quiet);
  const c = client();
  s.recordShareOutcome(c, { accepted: true, assignedDifficulty: 10 });
  const seed = (10 * DEFAULT_SOLS_PER_DIFF) / s.vardiff.targetTime;
  t.mock.timers.tick(10_000);
  s.recordShareOutcome(c, { accepted: true, assignedDifficulty: 10 });
  const alpha = 1 - Math.exp(-10 / s.hashrateWindowSeconds);
  const expected = alpha * ((10 * DEFAULT_SOLS_PER_DIFF) / 10) + (1 - alpha) * seed;
  assert.ok(Math.abs(c.metrics.ewmaHashrate - expected) < 1e-6 * expected, `${c.metrics.ewmaHashrate} vs ${expected}`);
});
