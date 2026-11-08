"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const WorkManager = require("../lib/workManager");
const StratumServer = require("../lib/stratumServer");
const fx = require("./helpers/fixtures");

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const hex64 = (bi) => bi.toString(16).padStart(64, "0");

// One share whose hash is fixed (the verifier accepts any solution), plus
// targets one step harder and one step easier than that hash.
async function shareSetup() {
  const wm = new WorkManager({ getBlockTemplate: async () => fx.template() }, fx.POOL_ADDRESS, quiet, {
    verifier: { enabled: true, verify: () => true },
  });
  const job = await wm.generateJob(true);
  const submit = (client) =>
    wm.validateShare({ jobId: job.jobId, nTime: job.ntime, nonce: "00".repeat(32), solution: "fd4005" + "00".repeat(1344), client });
  const probe = await submit({});
  const hashBI = BigInt("0x" + probe.hash);
  return { job, submit, harder: hex64(hashBI - 1n), easier: hex64(hashBI + 1n) };
}

test("a share on a job sent before a difficulty raise is judged at that job's target", async () => {
  const { job, submit, harder, easier } = await shareSetup();
  const res = await submit({
    shareTarget: harder,
    currentDifficulty: 4,
    jobTargets: new Map([[job.jobId, { target: easier, difficulty: 2 }]]),
  });
  assert.equal(res.valid, true);
  assert.equal(res.assignedDifficulty, 2);
});

test("a share on a job sent at the current difficulty is judged at the current target", async () => {
  const { job, submit, harder } = await shareSetup();
  const res = await submit({
    shareTarget: harder,
    currentDifficulty: 4,
    jobTargets: new Map([[job.jobId, { target: harder, difficulty: 4 }]]),
  });
  assert.equal(res.valid, false);
  assert.equal(res.error, "Low Diff");
});

test("a difficulty drop applies to jobs sent before it", async () => {
  const { job, submit, harder, easier } = await shareSetup();
  const res = await submit({
    shareTarget: easier,
    currentDifficulty: 2,
    jobTargets: new Map([[job.jobId, { target: harder, difficulty: 4 }]]),
  });
  assert.equal(res.valid, true);
  assert.equal(res.assignedDifficulty, 2);
});

test("a share on a job with no recorded target is judged at the current target", async () => {
  const { submit, easier } = await shareSetup();
  const res = await submit({ shareTarget: easier, currentDifficulty: 3 });
  assert.equal(res.valid, true);
  assert.equal(res.assignedDifficulty, 3);
});

function fakeClient(s) {
  const client = {
    id: 1,
    authorized: true,
    currentDifficulty: 1,
    shareTarget: null,
    socket: { destroyed: false, writableLength: 0, write() {} },
  };
  s.clients.set(client.id, client);
  return client;
}

function job(jobId) {
  return {
    jobId,
    _versionLE: "06000080",
    _prevhashLE: "00".repeat(32),
    _merkleRootLE: "00".repeat(32),
    _reservedLE: "00".repeat(32),
    _ntimeLE: "00000000",
    nbitsLE: "be3f011c",
    nbits: "1c013fbe",
    ntime: "00000000",
    cleanJobs: false,
  };
}

test("each job a miner is sent records the target it was sent with", () => {
  const s = new StratumServer({}, quiet);
  const client = fakeClient(s);
  s.applyDifficulty(client, 2, false);
  s.sendJob(client, job("a"));
  s.applyDifficulty(client, 4, false);
  s.broadcastJob(job("b"));
  assert.deepEqual(client.jobTargets.get("a"), { target: s.targetForDifficulty(2), difficulty: 2 });
  assert.deepEqual(client.jobTargets.get("b"), { target: s.targetForDifficulty(4), difficulty: 4 });
});

test("re-sending a job keeps the target it was first sent with", () => {
  const s = new StratumServer({}, quiet);
  const client = fakeClient(s);
  s.applyDifficulty(client, 2, false);
  s.sendJob(client, job("a"));
  s.applyDifficulty(client, 4, false);
  s.sendJob(client, job("a"));
  assert.equal(client.jobTargets.get("a").difficulty, 2);
});

test("a miner's job target record is bounded", () => {
  const s = new StratumServer({}, quiet);
  const client = fakeClient(s);
  s.applyDifficulty(client, 2, false);
  for (let i = 0; i < 200; i++) s.broadcastJob(job(i.toString(16)));
  assert.ok(client.jobTargets.size <= 64, `size ${client.jobTargets.size}`);
  assert.ok(client.jobTargets.has((199).toString(16)));
});
