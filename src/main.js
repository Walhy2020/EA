"use strict";

const { loadAppConfig, sanitizedConfigSummary } = require("./config/configLoader");
const { createLogger } = require("./utils/logger");
const { createDeepSeekClient } = require("./ai/deepseekClient");
const { createDeepSeekIntentDetector } = require("./router/deepseekIntentDetector");
const { createIntentRouter } = require("./router/intentRouter");
const { createAnswerComposer } = require("./ai/answerComposer");
const { createRankModule } = require("./modules/rank/rankModule");
const { createDemandModule } = require("./modules/demand/demandModule");
const { createDemandCollaborationModule } = require("./modules/demandCollaboration/demandCollaborationModule");
const { createDevProgressModule } = require("./modules/devProgress/devProgressModule");
const { createDemandMonitorFeedbackModule } = require("./modules/feedback/demandMonitorFeedbackModule");
const { createBugCollectionModule } = require("./modules/bugCollection/bugCollectionModule");
const { createDocCreatorModule } = require("./modules/docCreator/docCreatorModule");
const { createWatchdogModule } = require("./modules/watchdog/watchdogModule");
const { createDesktopTipModule } = require("./modules/desktopTip/desktopTipModule");
const { createActivityModule } = require("./modules/activity/activityModule");
const { createHistoryModule } = require("./modules/history/historyModule");
const { createNotificationCenter } = require("./notification/notificationCenter");
const { createWecomAppNotifier } = require("./notification/wecomAppNotifier");
const { createWecomAppCallback } = require("./notification/wecomAppCallback");
const { createMonitorManager } = require("./monitors/monitorManager");
const { createWecomBotServer } = require("./robot/wecomBotServer");
const { createRobotDiagnosticsStore } = require("./robot/robotDiagnosticsStore");
const { createAdminServer } = require("./admin/adminServer");
const { createConversationStore } = require("./conversation/conversationStore");
const { createConversationOrchestrator } = require("./conversation/conversationOrchestrator");

function resolveWatchdogAppFeedbackUrl(config) {
  const watchdog = config.modules && config.modules.modules && config.modules.modules.watchdog;
  const demandCollaboration = config.modules && config.modules.modules && config.modules.modules.demandCollaboration;
  const feedbackPath = watchdog && watchdog.appPush && watchdog.appPush.feedbackPath
    ? watchdog.appPush.feedbackPath
    : "/watchdog-feedback.html";
  const entryUrl = demandCollaboration && demandCollaboration.entryUrl;
  try {
    return new URL(feedbackPath, new URL(entryUrl).origin).toString();
  } catch (_) {
    return "";
  }
}

function resolveDevRequiredFeedbackUrl(config) {
  const demandCollaboration = config.modules && config.modules.modules && config.modules.modules.demandCollaboration;
  const entryUrl = demandCollaboration && demandCollaboration.entryUrl;
  try {
    return new URL("/dev-required-feedback.html", new URL(entryUrl).origin).toString();
  } catch (_) {
    return "";
  }
}

function buildRuntime(config, logger) {
  const desktopTip = createDesktopTipModule({
    moduleConfig: config.modules.modules.desktopTip,
    logger
  });
  const watchdogAppNotifier = createWecomAppNotifier({
    appMessage: config.modules.modules.watchdog && config.modules.modules.watchdog.appPush,
    logger
  });
  const watchdogAppFeedbackUrl = resolveWatchdogAppFeedbackUrl(config);
  const devRequiredFeedbackUrl = resolveDevRequiredFeedbackUrl(config);
  const modules = {
    rank: createRankModule({
      moduleConfig: config.modules.modules.rank,
      logger
    }),
    demand: createDemandModule(),
    demandCollaboration: createDemandCollaborationModule({
      moduleConfig: config.modules.modules.demandCollaboration,
      appConfig: config.app,
      workflowRules: config.demandWorkflowRules,
      logger
    }),
    devProgress: createDevProgressModule({ logger }),
    feedback: createDemandMonitorFeedbackModule({ logger }),
    bugCollection: createBugCollectionModule({ logger }),
    docCreator: createDocCreatorModule({
      moduleConfig: config.modules.modules.docCreator,
      logger
    }),
    watchdog: createWatchdogModule({
      moduleConfig: config.modules.modules.watchdog,
      desktopTip,
      appNotifier: watchdogAppNotifier,
      appFeedbackUrl: watchdogAppFeedbackUrl,
      logger
    }),
    desktopTip,
    activity: createActivityModule(),
    history: createHistoryModule()
  };
  const conversationModules = {
    ...modules,
    bugCollection: config.modules.modules.bugCollection
      && config.modules.modules.bugCollection.enabled
      ? modules.bugCollection
      : null
  };

  const deepseekClient = config.app.ai.enabled
    ? createDeepSeekClient(config.app.ai)
    : null;

  const aiIntentDetector = createDeepSeekIntentDetector({
    aiConfig: config.app.ai,
    deepseekClient
  });

  const answerComposer = createAnswerComposer({
    aiConfig: config.app.ai,
    deepseekClient,
    logger
  });

  const conversationStore = createConversationStore();
  const conversationOrchestrator = createConversationOrchestrator({
    aiConfig: config.app.ai,
    aiClient: deepseekClient,
    modules: conversationModules,
    answerComposer,
    store: conversationStore,
    logger
  });

  const router = createIntentRouter({
    routesConfig: config.routes,
    modules: conversationModules,
    aiIntentDetector,
    answerComposer,
    conversationOrchestrator,
    logger
  });

  const robotDiagnostics = createRobotDiagnosticsStore({ logger });

  const robotServer = createWecomBotServer({
    config: config.app.robot,
    router,
    sdkSearchDirs: [],
    logger,
    diagnostics: robotDiagnostics,
    watchdog: modules.watchdog,
    desktopTip: modules.desktopTip
  });
  modules.watchdog.setRobotServer(robotServer);

  const notificationCenter = createNotificationCenter({
    config: config.modules.notification,
    logger
  });

  const monitorManager = createMonitorManager({
    modules,
    config: config.modules.monitors,
    robotServer,
    appNotifier: watchdogAppNotifier,
    appFeedbackUrl: devRequiredFeedbackUrl,
    logger
  });
  if (typeof robotServer.setMonitorManager === "function") {
    robotServer.setMonitorManager(monitorManager);
  }

  const wecomAppCallback = createWecomAppCallback({
    appMessage: config.modules.modules.watchdog && config.modules.modules.watchdog.appPush,
    watchdog: modules.watchdog,
    appNotifier: watchdogAppNotifier,
    logger
  });

  const adminServer = createAdminServer({
    config,
    router,
    modules,
    robotServer,
    robotDiagnostics,
    monitorManager,
    notificationCenter,
    wecomAppCallback,
    logger
  });

  return {
    modules,
    router,
    notificationCenter,
    monitorManager,
    robotServer,
    robotDiagnostics,
    wecomAppCallback,
    adminServer
  };
}

async function main() {
  const config = loadAppConfig();
  const logger = createLogger({
    level: config.app.runtime.logLevel
  });

  if (process.argv.includes("--check-config")) {
    console.log(JSON.stringify(sanitizedConfigSummary(config), null, 2));
    return;
  }

  const testMessageIndex = process.argv.indexOf("--test-message");
  const runtime = buildRuntime(config, logger);
  if (testMessageIndex >= 0) {
    const text = process.argv.slice(testMessageIndex + 1).join(" ") || "top20";
    const result = await runtime.router.handleMessage({ text, sender: { source: "cli" } });
    console.log(result.text || JSON.stringify(result, null, 2));
    return;
  }

  await runtime.robotServer.start();
  runtime.monitorManager.start();
  runtime.adminServer.start();

  function shutdown() {
    logger.info("Service shutting down");
    runtime.monitorManager.stop();
    runtime.robotServer.stop();
    runtime.adminServer.stop();
  }

  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

module.exports = {
  buildRuntime,
  main
};
