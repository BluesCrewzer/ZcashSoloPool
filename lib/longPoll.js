"use strict";

// getblocktemplate long polling: zebrad holds the request open until the
// template changes (new tip, mempool, or time range), so a new block reaches
// miners as soon as the node has it instead of on the next poll.
class LongPollWatcher {
  constructor({ getTemplate, onTemplate, logger = console, retryMs = 2000, sleep = null }) {
    this.getTemplate = getTemplate;
    this.onTemplate = onTemplate;
    this.logger = logger;
    this.retryMs = retryMs;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.running = false;
    this.longpollid = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
  }

  async loop() {
    while (this.running) {
      try {
        const tpl = await this.getTemplate(this.longpollid);
        this.longpollid = tpl && typeof tpl.longpollid === "string" && tpl.longpollid ? tpl.longpollid : null;
        if (!this.running) break;
        await this.onTemplate(tpl);
      } catch (err) {
        // A timeout or node error: start again from the current template.
        this.longpollid = null;
        this.logger.warn(`[LongPoll] ${err.message}; retrying in ${this.retryMs} ms`);
        await this.sleep(this.retryMs);
      }
    }
  }
}

module.exports = LongPollWatcher;
