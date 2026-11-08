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

// Feeds a steady miner: one share of `diff` every `everySec` seconds for `forSec` seconds.
function feedSteady(t, s, c, { diff, everySec, forSec }) {
  for (let elapsed = everySec; elapsed <= forSec; elapsed += everySec) {
    t.mock.timers.tick(everySec * 1000);
    s.recordShareOutcome(c, { accepted: true, assignedDifficulty: diff });
  }
}

test("EWMA reads a steady miner's true rate one minute after it connects", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const s = new StratumServer({}, quiet);
  const c = client();
  c.connectedAt = Date.now();
  feedSteady(t, s, c, { diff: 10, everySec: 10, forSec: 60 });
  // 10 difficulty every 10 s = 1 difficulty/s = 262,144 Sol/s
  const ewma = s.ewmaHashrate(c);
  assert.ok(Math.abs(ewma / DEFAULT_SOLS_PER_DIFF - 1) < 0.03, `ewma ${ewma}`);
});

test("EWMA still reads the true rate for a long-connected miner", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const s = new StratumServer({}, quiet);
  const c = client();
  c.connectedAt = Date.now();
  feedSteady(t, s, c, { diff: 10, everySec: 10, forSec: 3600 });
  const ewma = s.ewmaHashrate(c);
  assert.ok(Math.abs(ewma / DEFAULT_SOLS_PER_DIFF - 1) < 0.03, `ewma ${ewma}`);
});

test("displayed hashrate is right one minute after connect", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const s = new StratumServer({}, quiet);
  const c = client();
  c.connectedAt = Date.now();
  feedSteady(t, s, c, { diff: 10, everySec: 10, forSec: 60 });
  const rate = s.estimateHashrate(c);
  assert.ok(Math.abs(rate / DEFAULT_SOLS_PER_DIFF - 1) < 0.03, `rate ${rate}`);
});

function connectedClient(secondsAgo) {
  const c = client();
  c.connectedAt = Date.now() - secondsAgo * 1000;
  return c;
}

test("a miner connected for less than the window is rated over its connected time", () => {
  const s = new StratumServer({}, quiet);
  const c = connectedClient(60);
  c.metrics.recentAccepted.push({ ts: Date.now() - 1000, difficulty: 60 });
  // 60 difficulty in the 60 s since connect = 1 difficulty/s, not 60/300
  assert.equal(Math.round(s.estimateHashrate(c)), DEFAULT_SOLS_PER_DIFF);
});

test("connected time below 30 s is rated over 30 s", () => {
  const s = new StratumServer({}, quiet);
  const c = connectedClient(5);
  c.metrics.recentAccepted.push({ ts: Date.now() - 1000, difficulty: 30 });
  assert.equal(Math.round(s.estimateHashrate(c)), DEFAULT_SOLS_PER_DIFF);
});

test("a miner connected longer than the window is rated over the full window", () => {
  const s = new StratumServer({}, quiet);
  const c = connectedClient(3600);
  c.metrics.recentAccepted.push({ ts: Date.now() - 1000, difficulty: 300 });
  assert.equal(Math.round(s.estimateHashrate(c)), DEFAULT_SOLS_PER_DIFF);
});
