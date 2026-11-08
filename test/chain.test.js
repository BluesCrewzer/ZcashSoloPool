"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const chain = require("../lib/chain");

const zebraInfo = {
  blocks: 3552314,
  upgrades: {
    c8e71055: { name: "NU6", activationheight: 2726400, status: "active" },
    "77190ad9": { name: "NU7", activationheight: 3543405, status: "active" },
  },
};

test("NU7 activation height is read from getblockchaininfo upgrades", () => {
  assert.equal(chain.nu7ActivationHeight(zebraInfo), 3543405);
});

test("NU7 activation height is null when the node does not report NU7", () => {
  assert.equal(chain.nu7ActivationHeight({ upgrades: { c8e71055: zebraInfo.upgrades.c8e71055 } }), null);
  assert.equal(chain.nu7ActivationHeight(null), null);
});

test("block spacing is 25 s from the NU7 activation height on", () => {
  assert.equal(chain.targetBlockSeconds(3543405, 3543405), 25);
  assert.equal(chain.targetBlockSeconds(3552315, 3543405), 25);
});

test("block spacing is 75 s before NU7 or when NU7 is unknown", () => {
  assert.equal(chain.targetBlockSeconds(3543404, 3543405), 75);
  assert.equal(chain.targetBlockSeconds(3552315, null), 75);
});

test("zatoshi amounts format as ZEC without trailing zeros", () => {
  assert.equal(chain.formatZec(41670668), "0.41670668 ZEC");
  assert.equal(chain.formatZec(125000000), "1.25 ZEC");
  assert.equal(chain.formatZec(null), null);
});

test("tip is unchanged while the best block hash is the job's parent", () => {
  const job = { prevhash: "aa".repeat(32) };
  assert.equal(chain.tipChanged("aa".repeat(32), job), false);
  assert.equal(chain.tipChanged("AA".repeat(32), job), false);
});

test("tip changed when the best block hash differs or there is no job", () => {
  assert.equal(chain.tipChanged("bb".repeat(32), { prevhash: "aa".repeat(32) }), true);
  assert.equal(chain.tipChanged("bb".repeat(32), null), true);
});
