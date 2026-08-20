"use strict";

const { createRankMonitorBridge } = require("./rankMonitorBridge");
const { createDevProgressMonitorBridge } = require("./devProgressMonitorBridge");

function createMonitorManager(options) {
  const watchdogModule = options.modules.watchdog;
  const rankBridge = createRankMonitorBridge({
    rankModule: options.modules.rank,
    monitorConfig: options.config.rank,
    logger: options.logger
  });
  const devProgressBridge = createDevProgressMonitorBridge({
    devProgressModule: options.modules.devProgress,
    robotServer: options.robotServer,
    appNotifier: options.appNotifier,
    appFeedbackUrl: options.appFeedbackUrl,
    monitorConfig: options.config.devProgress,
    logger: options.logger
  });

  function start() {
    rankBridge.start();
    devProgressBridge.start();
    if (watchdogModule && typeof watchdogModule.start === "function") {
      watchdogModule.start();
    }
  }

  function stop() {
    rankBridge.stop();
    devProgressBridge.stop();
    if (watchdogModule && typeof watchdogModule.stop === "function") {
      watchdogModule.stop();
    }
  }

  function getStatus() {
    return {
      rank: rankBridge.getStatus(),
      devProgress: devProgressBridge.getStatus(),
      watchdog: watchdogModule && typeof watchdogModule.getStatus === "function"
        ? watchdogModule.getStatus()
        : { enabled: false }
    };
  }

  async function captureTextMessage(message) {
    if (devProgressBridge && typeof devProgressBridge.captureTextMessage === "function") {
      return devProgressBridge.captureTextMessage(message);
    }
    return { handled: false };
  }

  async function handleTemplateCardEvent(summary, sender) {
    if (devProgressBridge && typeof devProgressBridge.handleTemplateCardEvent === "function") {
      return devProgressBridge.handleTemplateCardEvent(summary, sender);
    }
    return { handled: false };
  }

  function getPilotAppFeedback(input) {
    return devProgressBridge.getPilotAppFeedback(input);
  }

  function getPilotGroupDetail() {
    return devProgressBridge.getPilotGroupDetail();
  }

  async function submitPilotAppFeedback(input) {
    return devProgressBridge.submitPilotAppFeedback(input);
  }

  return {
    start,
    stop,
    captureTextMessage,
    handleTemplateCardEvent,
    getPilotAppFeedback,
    getPilotGroupDetail,
    submitPilotAppFeedback,
    getStatus
  };
}

module.exports = {
  createMonitorManager
};
