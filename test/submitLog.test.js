"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const StratumServer = require("../lib/stratumServer");

function capture() {
  const lines = [];
  const log = (msg) => lines.push(String(msg));
  return { lines, logger: { info: log, warn: log, debug: log, error: log } };
}

function submitClient() {
  return {
    id: 7,
    authorized: true,
    workerName: null,
    metrics: { submits: 0 },
    socket: { destroyed: false, writableLength: 0, write() {} },
  };
}

const submit = (worker, jobId) => ({
  id: 3,
  method: "mining.submit",
  params: [worker, jobId, "00000000", "00".repeat(28), "fd4005" + "00".repeat(1344)],
});

test("submit log lines strip control characters from the worker and job id", () => {
  const { lines, logger } = capture();
  const s = new StratumServer({ submitAudit: true, logSubmissions: true }, logger);
  s.handleRequest(submitClient(), submit("rig\nFAKE WORKER", "nojob\r\nFAKE LINE"));
  const audit = lines.find((l) => l.startsWith("[Stratum][Audit]"));
  assert.ok(audit, "audit line logged");
  assert.match(audit, /worker=rigFAKE WORKER job=nojobFAKE LINE /);
  for (const l of lines) assert.doesNotMatch(l, /[\x00-\x1f\x7f]/, l);
});

test("the audit line caps the job id at 64 characters", () => {
  const { lines, logger } = capture();
  const s = new StratumServer({ submitAudit: true }, logger);
  s.handleRequest(submitClient(), submit("rig", "j".repeat(500)));
  const audit = lines.find((l) => l.startsWith("[Stratum][Audit]"));
  assert.match(audit, new RegExp(`job=${"j".repeat(64)} `));
});

test("the audit line shows n/a when the submit names no worker", () => {
  const { lines, logger } = capture();
  const s = new StratumServer({ submitAudit: true }, logger);
  const client = submitClient();
  client.workerName = "authorized-name";
  s.handleRequest(client, submit("", "5"));
  const audit = lines.find((l) => l.startsWith("[Stratum][Audit]"));
  assert.match(audit, /worker=n\/a job=5 /);
});
