"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const JobUpdater = require("../lib/jobUpdater");

const TIP_A = "aa".repeat(32);
const TIP_B = "bb".repeat(32);
const tpl = (prev) => ({ previousblockhash: prev, height: prev === TIP_A ? 100 : 101 });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// Fake pool around the real JobUpdater: records every broadcast.
function harness({ tip = TIP_B, fetch } = {}) {
  const state = { current: { prevhash: TIP_A, height: 100 }, broadcasts: [], fetches: 0 };
  const updater = new JobUpdater({
    fetchTemplate: fetch || (async () => { state.fetches++; return tpl(tip); }),
    buildJob: async (clean, template) => {
      state.current = { prevhash: template.previousblockhash, height: template.height, cleanJobs: clean };
      return state.current;
    },
    currentJob: () => state.current,
    broadcast: (job) => state.broadcasts.push(job),
    logger: { error() {}, info() {}, warn() {} },
  });
  return { state, updater };
}

test("a tip-only update at the same tip neither builds nor broadcasts", async () => {
  const { state, updater } = harness({ tip: TIP_A });
  await updater.update({ clean: true, newTipOnly: true });
  assert.equal(state.broadcasts.length, 0);
  assert.equal(state.current.prevhash, TIP_A);
});

test("a tip-only update on a new tip broadcasts one clean job", async () => {
  const { state, updater } = harness({ tip: TIP_B });
  await updater.update({ clean: true, newTipOnly: true });
  assert.equal(state.broadcasts.length, 1);
  assert.equal(state.broadcasts[0].prevhash, TIP_B);
  assert.equal(state.broadcasts[0].cleanJobs, true);
});

test("a forced update broadcasts even at the same tip", async () => {
  const { state, updater } = harness({ tip: TIP_A });
  await updater.update({ clean: false });
  assert.equal(state.broadcasts.length, 1);
  assert.equal(state.broadcasts[0].cleanJobs, false);
});

test("a supplied template is used without fetching", async () => {
  const { state, updater } = harness();
  await updater.update({ clean: true, newTipOnly: true, template: tpl(TIP_B) });
  assert.equal(state.fetches, 0);
  assert.equal(state.broadcasts.length, 1);
});

test("a tip request queued behind an in-flight update for that tip broadcasts once", async () => {
  const gate = deferred();
  let calls = 0;
  const { state, updater } = harness({
    fetch: async () => { calls++; if (calls === 1) await gate.promise; return tpl(TIP_B); },
  });
  const first = updater.update({ clean: true, newTipOnly: true });
  const second = updater.update({ clean: true, newTipOnly: true });
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(state.broadcasts.length, 1);
});

test("a forced request queued with a tip-only request stays forced", async () => {
  const gate = deferred();
  let calls = 0;
  const { state, updater } = harness({
    fetch: async () => { calls++; if (calls === 1) await gate.promise; return tpl(TIP_B); },
  });
  const first = updater.update({ clean: true, newTipOnly: true });
  const tipOnly = updater.update({ clean: true, newTipOnly: true });
  const forced = updater.update({ clean: false });
  gate.resolve();
  await Promise.all([first, tipOnly, forced]);
  assert.equal(state.broadcasts.length, 2);
  assert.equal(state.broadcasts[1].cleanJobs, true);
});

test("a failed update does not block the next one", async () => {
  let calls = 0;
  const { state, updater } = harness({
    fetch: async () => { calls++; if (calls === 1) throw new Error("rpc down"); return tpl(TIP_B); },
  });
  await updater.update({ clean: true });
  await updater.update({ clean: true });
  assert.equal(state.broadcasts.length, 1);
});
