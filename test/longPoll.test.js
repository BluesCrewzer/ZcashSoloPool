"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const LongPollWatcher = require("../lib/longPoll");
const ZcashRPC = require("../lib/zcashRpc");

const quiet = { info() {}, warn() {}, debug() {}, error() {} };

// Runs the real watcher against a scripted node until `count` templates arrive.
async function run(responses, count, extra = {}) {
  const ids = [];
  const seen = [];
  const sleeps = [];
  let watcher;
  await new Promise((resolve) => {
    let i = 0;
    watcher = new LongPollWatcher({
      getTemplate: async (longpollid) => {
        ids.push(longpollid);
        const r = responses[Math.min(i++, responses.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      },
      onTemplate: async (tpl) => {
        seen.push(tpl);
        if (seen.length >= count) { watcher.stop(); resolve(); }
      },
      sleep: async (ms) => { sleeps.push(ms); },
      retryMs: 2000,
      logger: quiet,
      ...extra,
    });
    watcher.start();
  });
  return { ids, seen, sleeps };
}

test("each long poll sends the longpollid of the previous template", async () => {
  const { ids } = await run([{ longpollid: "id1" }, { longpollid: "id2" }, { longpollid: "id3" }], 3);
  assert.deepEqual(ids, [null, "id1", "id2"]);
});

test("an empty longpollid is not sent back to the node", async () => {
  const { ids } = await run([{ longpollid: "" }, { longpollid: "id2" }], 2);
  assert.deepEqual(ids, [null, null]);
});

test("a failed long poll waits retryMs and starts over without an id", async () => {
  const { ids, seen, sleeps } = await run([{ longpollid: "id1" }, new Error("timeout"), { longpollid: "id3" }], 2);
  assert.deepEqual(ids, [null, "id1", null]);
  assert.equal(seen.length, 2);
  assert.deepEqual(sleeps, [2000]);
});

test("template request omits longpollid unless it is a non-empty string", () => {
  assert.equal("longpollid" in ZcashRPC.templateRequest(null), false);
  assert.equal("longpollid" in ZcashRPC.templateRequest(""), false);
  assert.equal(ZcashRPC.templateRequest("abc").longpollid, "abc");
  assert.equal(ZcashRPC.templateRequest(null).mode, "template");
});
