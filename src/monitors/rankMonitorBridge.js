"use strict";

function createRankMonitorBridge(options) {
  const rankModule = options.rankModule;
  const monitorConfig = options.monitorConfig || {};
  const logger = options.logger;
  let timer = null;
  let running = false;

  async function tick() {
    if (running) {
      logger.warn("Rank monitor tick skipped because previous tick is still running");
      return;
    }

    running = true;
    try {
      await rankModule.runOnce();
    } finally {
      running = false;
    }
  }

  function start() {
    if (!monitorConfig.enabled) {
      return false;
    }

    const intervalMs = Math.max(1, Number(monitorConfig.intervalMinutes || 60)) * 60 * 1000;
    timer = setInterval(() => {
      tick().catch((error) => logger.error("Rank monitor tick failed", { message: error.message }));
    }, intervalMs);
    logger.info("Rank monitor bridge started", { intervalMinutes: monitorConfig.intervalMinutes || 60 });
    return true;
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStatus() {
    return {
      enabled: Boolean(monitorConfig.enabled),
      running: Boolean(timer),
      intervalMinutes: Number(monitorConfig.intervalMinutes || 60)
    };
  }

  return {
    start,
    stop,
    tick,
    getStatus
  };
}

module.exports = {
  createRankMonitorBridge
};
