"use strict";

// Serializes job updates. Requests that arrive while one is running are merged
// into a single follow-up run. A "newTipOnly" request is dropped when the
// template still builds on the current job's parent, so tip pollers and the
// long poll can fire freely without sending miners duplicate clean jobs.
class JobUpdater {
  constructor({ fetchTemplate, buildJob, currentJob, broadcast, logger = console }) {
    this.fetchTemplate = fetchTemplate;
    this.buildJob = buildJob;
    this.currentJob = currentJob;
    this.broadcast = broadcast;
    this.logger = logger;
    this.inFlight = null;
    this.queued = null;
  }

  update({ clean = false, newTipOnly = false, template = null } = {}) {
    const request = { clean: clean === true, newTipOnly: newTipOnly === true, template };
    if (this.inFlight) {
      // Queued runs always fetch a fresh template.
      this.queued = this.queued
        ? { clean: this.queued.clean || request.clean, newTipOnly: this.queued.newTipOnly && request.newTipOnly, template: null }
        : { ...request, template: null };
      return this.inFlight;
    }

    const run = (async () => {
      let next = request;
      while (next) {
        try {
          await this.runOnce(next);
        } catch (err) {
          this.logger.error(`[UpdateJob] job update failed: ${err.message}`);
        }
        next = this.queued;
        this.queued = null;
      }
      // Cleared in the same tick the queue is found empty, so no request can
      // be queued onto a run that has already finished.
      this.inFlight = null;
    })();
    this.inFlight = run;
    return run;
  }

  async runOnce({ clean, newTipOnly, template }) {
    const tpl = template || (await this.fetchTemplate());
    const current = this.currentJob();
    if (newTipOnly && current && current.prevhash === tpl.previousblockhash) return null;
    const job = await this.buildJob(clean, tpl);
    this.broadcast(job);
    return job;
  }
}

module.exports = JobUpdater;
