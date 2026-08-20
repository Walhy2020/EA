"use strict";

const { createWxMiniRankAdapter } = require("./wxMiniRankAdapter");

function createRankModule(options) {
  const adapter = createWxMiniRankAdapter({
    moduleConfig: options.moduleConfig,
    logger: options.logger
  });

  async function handle(context) {
    const text = await adapter.buildReply(context.text);
    return {
      ok: true,
      module: "rank",
      intent: context.intent,
      text,
      data: {
        adapter: "wx-mini-rank-monitor"
      }
    };
  }

  async function runOnce() {
    return adapter.runOnce();
  }

  async function getStatus() {
    return adapter.getStatus();
  }

  return {
    name: "rank",
    handle,
    runOnce,
    getStatus
  };
}

module.exports = {
  createRankModule
};
