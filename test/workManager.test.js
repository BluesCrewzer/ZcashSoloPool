"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const WorkManager = require("../lib/workManager");
const fx = require("./helpers/fixtures");

const quiet = { info() {}, warn() {}, debug() {}, error() {} };

function makeWM(tpl, verifier = { enabled: true, verify: () => false }) {
  const rpc = { getBlockTemplate: async () => tpl };
  return new WorkManager(rpc, fx.POOL_ADDRESS, quiet, { verifier });
}

test("job records the miner reward a v6 (NU7) coinbase pays the pool address", async () => {
  const job = await makeWM(fx.template()).generateJob(true);
  assert.equal(job.minerRewardZat, 41670668);
});

test("job records the miner reward a v5 coinbase pays the pool address", async () => {
  const tpl = fx.template({ coinbase: fx.coinbaseTx({ version: 5, outputs: fx.NU7_OUTPUTS }) });
  const job = await makeWM(tpl).generateJob(true);
  assert.equal(job.minerRewardZat, 41670668);
});

test("miner reward sums only the outputs that pay the pool address", async () => {
  const outputs = [
    { value: 30000000, script: fx.p2pkh(fx.POOL_HASH160) },
    { value: 4166666, script: fx.p2sh(fx.OTHER_HASH160) },
    { value: 11670668, script: fx.p2pkh(fx.POOL_HASH160) },
  ];
  const job = await makeWM(fx.template({ coinbase: fx.coinbaseTx({ outputs }) })).generateJob(true);
  assert.equal(job.minerRewardZat, 41670668);
});

test("miner reward is null for a coinbase version it cannot parse", async () => {
  const tpl = fx.template({ coinbase: fx.coinbaseTx({ version: 4, outputs: fx.NU7_OUTPUTS }) });
  const job = await makeWM(tpl).generateJob(true);
  assert.equal(job.minerRewardZat, null);
});

test("generateJob builds from a supplied template without fetching one", async () => {
  const rpc = { getBlockTemplate: async () => { throw new Error("must not fetch"); } };
  const wm = new WorkManager(rpc, fx.POOL_ADDRESS, quiet, { verifier: { enabled: true, verify: () => false } });
  const tpl = fx.template();
  const job = await wm.generateJob(true, tpl);
  assert.equal(job.height, tpl.height);
  assert.equal(job.prevhash, tpl.previousblockhash);
});

test("an accepted share carries its job's miner reward", async () => {
  const wm = makeWM(fx.template(), { enabled: true, verify: () => true });
  const job = await wm.generateJob(true);
  const res = await wm.validateShare({
    jobId: job.jobId,
    nTime: job.ntime,
    nonce: "00".repeat(32),
    solution: "fd4005" + "00".repeat(1344),
    client: {},
  });
  assert.equal(res.valid, true);
  assert.equal(res.minerRewardZat, 41670668);
});
