"use strict";

const fs = require("fs");
const path = require("path");
const { projectRoot, resolveProjectPath } = require("../utils/paths");
const { maskSecrets } = require("../utils/secretMask");
const {
  normalizeDemandWorkflowRules,
  summarizeDemandWorkflowRules
} = require("../modules/demandWorkflow/rulesConfig");

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const index = trimmed.indexOf("=");
  if (index <= 0) {
    return null;
  }

  const key = trimmed.slice(0, index).trim();
  let value = trimmed.slice(index + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

function loadEnvFile(filePath = path.join(projectRoot, ".env")) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const lines = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const line of lines) {
    const entry = parseEnvLine(line);
    if (entry && process.env[entry.key] === undefined) {
      process.env[entry.key] = entry.value;
    }
  }
  return true;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function readConfigPair(baseName) {
  const realPath = path.join(projectRoot, "config", `${baseName}.json`);
  const examplePath = path.join(projectRoot, "config", `${baseName}.example.json`);
  const selectedPath = fs.existsSync(realPath) ? realPath : examplePath;
  return {
    path: selectedPath,
    isExample: selectedPath === examplePath,
    value: readJson(selectedPath)
  };
}

function readOptionalConfigPair(baseName) {
  const realPath = path.join(projectRoot, "config", `${baseName}.json`);
  const examplePath = path.join(projectRoot, "config", `${baseName}.example.json`);
  const selectedPath = fs.existsSync(realPath)
    ? realPath
    : (fs.existsSync(examplePath) ? examplePath : "");
  if (!selectedPath) {
    return null;
  }

  return {
    path: selectedPath,
    isExample: selectedPath === examplePath,
    value: readJson(selectedPath)
  };
}

function applyDevProgressConfig(modulesConfig, devProgressConfig) {
  const next = JSON.parse(JSON.stringify(modulesConfig || {}));
  next.modules = next.modules || {};
  next.monitors = next.monitors || {};

  if (!devProgressConfig || typeof devProgressConfig !== "object" || Array.isArray(devProgressConfig)) {
    return next;
  }

  const { monitor, ...moduleConfig } = devProgressConfig;
  next.modules.devProgress = {
    ...(next.modules.devProgress || {}),
    ...moduleConfig,
    configPath: (next.modules.devProgress && next.modules.devProgress.configPath) || "config/dev-progress.config.json"
  };
  if (monitor && typeof monitor === "object" && !Array.isArray(monitor)) {
    next.monitors.devProgress = monitor;
  }

  return next;
}

function envOrValue(envName, fallback) {
  if (envName && process.env[envName] !== undefined && process.env[envName] !== "") {
    return process.env[envName];
  }
  return fallback;
}

function normalizeConfig(config) {
  config.app.server.host = process.env.EAZYGAME_HOST || config.app.server.host || "127.0.0.1";
  config.app.server.port = Number(process.env.EAZYGAME_PORT || config.app.server.port || 39200);
  config.app.security = {
    maskSecretsInLogs: true,
    logRequestText: false,
    showSecretsInAdmin: true,
    ...(config.app.security || {})
  };
  normalizeAiConfig(config.app.ai);
  config.demandWorkflowRules = normalizeDemandWorkflowRules(config.demandWorkflowRules || {});

  const rank = config.modules.modules.rank;
  rank.resolvedPath = resolveProjectPath(envOrValue(rank.pathEnv, rank.path));
  rank.configPath = rank.configPath
    ? resolveProjectPath(rank.configPath)
    : path.resolve(rank.resolvedPath, rank.configFile || "config.json");
  rank.statePath = rank.statePath
    ? resolveProjectPath(rank.statePath)
    : path.resolve(path.dirname(rank.configPath), "data/state.json");
  rank.historyPath = rank.historyPath
    ? resolveProjectPath(rank.historyPath)
    : path.resolve(rank.resolvedPath, rank.historyCsv || "data/history/rank_history.csv");
  config.modules.modules.devProgress = config.modules.modules.devProgress || {
    enabled: false,
    name: "开发进度监控",
    source: "wecom-smartsheet"
  };
  config.modules.modules.demandCollaboration = config.modules.modules.demandCollaboration || {
    enabled: true,
    name: "需求协作",
    displayName: "需求协作",
    entryPath: "/demand-h5.html",
    version: "0.1.0"
  };
  config.modules.modules.demandCollaboration.draftStore = {
    path: "data/demand-collaboration/drafts.json",
    expireDays: 30,
    maxExpiredDrafts: 500,
    ...(config.modules.modules.demandCollaboration.draftStore || {})
  };
  config.modules.modules.bugCollection = config.modules.modules.bugCollection || {
    enabled: false,
    name: "需求和 Bug 收集",
    source: "wecom-smartsheet"
  };
  config.modules.modules.docCreator = config.modules.modules.docCreator || {
    enabled: true,
    name: "企业微信表格创建",
    source: "wecom-wedoc",
    auth: {
      corpIdEnv: "WECOM_DOC_CORP_ID",
      agentIdEnv: "WECOM_DOC_AGENT_ID",
      secretEnv: "WECOM_DOC_SECRET"
    },
    createDoc: {
      documentNamePrefix: "EA文档",
      smartDocumentNamePrefix: "EA智能文档",
      docNamePrefix: "EA智能表格",
      spreadsheetNamePrefix: "EA表格",
      docTypes: {
        document: 3,
        smartdoc: 3,
        spreadsheet: 4,
        smartsheet: 10
      },
      spaceId: "",
      fatherId: "",
      adminUsers: [],
      shareAfterCreate: true
    }
  };
  config.modules.modules.watchdog = config.modules.modules.watchdog || {
    enabled: true,
    name: "盯梢系统",
    source: "wecom-smart-bot",
    defaultIntervalMinutes: 180,
    personAliases: {},
    auth: {
      corpIdEnv: "WECOM_DOC_CORP_ID",
      secretEnv: "WECOM_DOC_SECRET"
    }
  };
  config.modules.modules.watchdog.appPush = {
    enabled: false,
    deliveryMode: "app_only",
    failureBackoffMs: 300000,
    feedbackPath: "/watchdog-feedback.html",
    corpIdEnv: "WECOM_DOC_CORP_ID",
    agentIdEnv: "WECOM_DOC_AGENT_ID",
    secretEnv: "WECOM_DOC_SECRET",
    testTargetUserId: "",
    ...(config.modules.modules.watchdog.appPush || {})
  };
  config.modules.modules.desktopTip = {
    enabled: true,
    name: "EA 桌面提醒",
    source: "desktop-tip",
    version: "0.3.2",
    storePath: "data/desktop-tip/events.json",
    ttlMinutes: 4320,
    maxStoredEvents: 500,
    pollLimit: 20,
    tokenEnv: "EA_DESKTOP_TIP_TOKEN",
    requireToken: false,
    clientPollSeconds: 8,
    openUrl: "https://work.weixin.qq.com",
    clientRegistry: {
      storePath: "data/desktop-tip/clients.json",
      persistIntervalSeconds: 60,
      maxRegisteredClients: 5000
    },
    clientUpdate: {
      enabled: true,
      manifestPath: "tools/desktop-tip/releases/latest.json",
      packageDir: "tools/desktop-tip/releases",
      packageUrl: "/api/desktop-tip/client-update/package"
    },
    wecomGroupRegistry: {
      enabled: true,
      storePath: "data/desktop-tip/wecom-groups.json",
      maxGroups: 50
    },
    productionMaintenance: {
      enabled: true,
      name: "正式服停服更新通知",
      version: "0.3.0",
      storePath: "data/desktop-tip/production-maintenance.json",
      openUrl: "https://work.weixin.qq.com",
      messageAdmins: [],
      authorizedSenders: [],
      sendPermissionMode: "all_signed_in",
      recipientUsers: [],
      recipientGroups: {},
      defaultRecipientGroupId: "",
      defaultRecipientScope: "all_registered_clients",
      countdownMinutes: [30, 10, 5, 1],
      maxExtensionMinutes: 240,
      eventTtlMinutes: 4320,
      schedulerIntervalSeconds: 15,
      deliveryChannels: ["desktop_tip"],
      allowConfigBootstrap: false
    },
    ...(config.modules.modules.desktopTip || {})
  };
  config.modules.monitors.devProgress = config.modules.monitors.devProgress || {
    enabled: false,
    mode: "poll-wecom-smartsheet",
    intervalMinutes: 1,
    notifyThroughCenter: true,
    changeDetection: {
      enabled: true,
      quietMinutes: 3,
      minScanIntervalMinutes: 5,
      scanOnFirstRun: false,
      scanOnSignalError: true
    },
    requiredFieldsPush: {
      enabled: true,
      cooldownMinutes: 1440,
      scanLimit: 2000,
      maxTargetsPerTick: 20,
      runOnStart: false
    }
  };
  config.modules.monitors.devProgress.changeDetection = {
    enabled: true,
    quietMinutes: 3,
    minScanIntervalMinutes: 5,
    scanOnFirstRun: false,
    scanOnSignalError: true,
    ...(config.modules.monitors.devProgress.changeDetection || {})
  };
  config.modules.monitors.devProgress.requiredFieldsPush = {
    enabled: true,
    cooldownMinutes: 1440,
    scanLimit: 2000,
    maxTargetsPerTick: 20,
    runOnStart: false,
    testMode: false,
    testTargetName: "",
    testVerifyDelaySeconds: 30,
    testNextTaskDelaySeconds: 600,
    ...(config.modules.monitors.devProgress.requiredFieldsPush || {})
  };
  config.modules.monitors.devProgress.requiredFieldsPush.groupCard = {
    enabled: true,
    maxCardsPerTick: 1,
    remindMinutes: 30,
    ...(config.modules.monitors.devProgress.requiredFieldsPush.groupCard || {})
  };
  config.modules.monitors.devProgress.requiredFieldsPush.pilot = {
    enabled: false,
    targetName: "",
    remindMinutes: 30,
    summaryMinutes: 60,
    maxActiveTasks: 1,
    focusDemandIds: [],
    ...(config.modules.monitors.devProgress.requiredFieldsPush.pilot || {})
  };

  return config;
}

function normalizeAiConfig(ai) {
  if (!ai) {
    return;
  }

  const providers = ai.providers || {};
  const provider = providers[ai.provider] ? ai.provider : (ai.provider || "deepseek");
  const selected = providers[provider];
  if (selected) {
    ai.provider = provider;
    ai.baseUrl = selected.baseUrl || ai.baseUrl || "https://api.deepseek.com";
    ai.model = selected.model || ai.model || "deepseek-v4-flash";
    ai.apiKeyEnv = selected.apiKeyEnv || ai.apiKeyEnv || "DEEPSEEK_API_KEY";
  } else {
    ai.provider = provider;
    ai.baseUrl = ai.baseUrl || "https://api.deepseek.com";
    ai.model = ai.model || "deepseek-v4-flash";
    ai.apiKeyEnv = ai.apiKeyEnv || "DEEPSEEK_API_KEY";
  }
}

function loadAppConfig() {
  loadEnvFile();

  const app = readConfigPair("app.config");
  const modules = readConfigPair("modules.config");
  const routes = readConfigPair("routes.config");
  const devProgress = readOptionalConfigPair("dev-progress.config");
  const demandWorkflowRules = readConfigPair("demand-workflow.rules");
  const modulesValue = applyDevProgressConfig(modules.value, devProgress ? devProgress.value : null);
  const config = normalizeConfig({
    app: app.value,
    modules: modulesValue,
    routes: routes.value,
    demandWorkflowRules: demandWorkflowRules.value,
    meta: {
      projectRoot,
      configFiles: {
        app: { path: app.path, isExample: app.isExample },
        modules: { path: modules.path, isExample: modules.isExample },
        routes: { path: routes.path, isExample: routes.isExample },
        ...(devProgress ? { devProgress: { path: devProgress.path, isExample: devProgress.isExample } } : {}),
        demandWorkflowRules: { path: demandWorkflowRules.path, isExample: demandWorkflowRules.isExample }
      }
    }
  });

  return config;
}

function sanitizedConfigSummary(config) {
  return maskSecrets({
    server: config.app.server,
    runtime: config.app.runtime,
    robot: config.app.robot,
    ai: config.app.ai,
    rankModule: {
      enabled: config.modules.modules.rank.enabled,
      path: config.modules.modules.rank.resolvedPath,
      configPath: config.modules.modules.rank.configPath,
      historyPath: config.modules.modules.rank.historyPath
    },
    devProgressModule: {
      enabled: Boolean(config.modules.modules.devProgress && config.modules.modules.devProgress.enabled),
      source: config.modules.modules.devProgress && config.modules.modules.devProgress.source ? config.modules.modules.devProgress.source : "wecom-smartsheet",
      docidConfigured: Boolean(config.modules.modules.devProgress && config.modules.modules.devProgress.docid),
      sheetIdConfigured: Boolean(config.modules.modules.devProgress && config.modules.modules.devProgress.sheetId),
      monitorEnabled: Boolean(config.modules.monitors.devProgress && config.modules.monitors.devProgress.enabled)
    },
    bugCollectionModule: {
      enabled: Boolean(config.modules.modules.bugCollection && config.modules.modules.bugCollection.enabled),
      source: config.modules.modules.bugCollection && config.modules.modules.bugCollection.source ? config.modules.modules.bugCollection.source : "wecom-smartsheet",
      docUrlConfigured: Boolean(config.modules.modules.bugCollection && config.modules.modules.bugCollection.docUrl),
      sheetIdConfigured: Boolean(config.modules.modules.bugCollection && config.modules.modules.bugCollection.sheetId)
    },
    demandCollaborationModule: {
      enabled: Boolean(config.modules.modules.demandCollaboration && config.modules.modules.demandCollaboration.enabled),
      entryPath: config.modules.modules.demandCollaboration && config.modules.modules.demandCollaboration.entryPath
        ? config.modules.modules.demandCollaboration.entryPath
        : "/demand-h5.html",
      draftStorePath: config.modules.modules.demandCollaboration
        && config.modules.modules.demandCollaboration.draftStore
        && config.modules.modules.demandCollaboration.draftStore.path
        ? config.modules.modules.demandCollaboration.draftStore.path
        : "data/demand-collaboration/drafts.json",
      draftExpireDays: Number(config.modules.modules.demandCollaboration
        && config.modules.modules.demandCollaboration.draftStore
        && config.modules.modules.demandCollaboration.draftStore.expireDays) || 30
    },
    docCreatorModule: {
      enabled: Boolean(config.modules.modules.docCreator && config.modules.modules.docCreator.enabled),
      source: config.modules.modules.docCreator && config.modules.modules.docCreator.source ? config.modules.modules.docCreator.source : "wecom-wedoc"
    },
    watchdogModule: {
      enabled: Boolean(config.modules.modules.watchdog && config.modules.modules.watchdog.enabled),
      defaultIntervalMinutes: Number(config.modules.modules.watchdog && config.modules.modules.watchdog.defaultIntervalMinutes) || 180
    },
    desktopTipModule: {
      enabled: Boolean(config.modules.modules.desktopTip && config.modules.modules.desktopTip.enabled),
      version: config.modules.modules.desktopTip && config.modules.modules.desktopTip.version
        ? config.modules.modules.desktopTip.version
        : "0.1.0",
      storePath: config.modules.modules.desktopTip && config.modules.modules.desktopTip.storePath
        ? config.modules.modules.desktopTip.storePath
        : "data/desktop-tip/events.json",
      tokenEnv: config.modules.modules.desktopTip && config.modules.modules.desktopTip.tokenEnv
        ? config.modules.modules.desktopTip.tokenEnv
        : "EA_DESKTOP_TIP_TOKEN",
      requireToken: Boolean(config.modules.modules.desktopTip && config.modules.modules.desktopTip.requireToken),
      clientPollSeconds: Number(config.modules.modules.desktopTip && config.modules.modules.desktopTip.clientPollSeconds) || 8,
      productionMaintenance: {
        enabled: Boolean(config.modules.modules.desktopTip
          && config.modules.modules.desktopTip.productionMaintenance
          && config.modules.modules.desktopTip.productionMaintenance.enabled !== false),
        version: config.modules.modules.desktopTip
          && config.modules.modules.desktopTip.productionMaintenance
          && config.modules.modules.desktopTip.productionMaintenance.version
          ? config.modules.modules.desktopTip.productionMaintenance.version
          : "0.3.0",
        storePath: config.modules.modules.desktopTip
          && config.modules.modules.desktopTip.productionMaintenance
          && config.modules.modules.desktopTip.productionMaintenance.storePath
          ? config.modules.modules.desktopTip.productionMaintenance.storePath
          : "data/desktop-tip/production-maintenance.json"
      }
    },
    demandWorkflowRules: summarizeDemandWorkflowRules(config.demandWorkflowRules),
    configFiles: config.meta.configFiles
  });
}

module.exports = {
  loadAppConfig,
  loadEnvFile,
  sanitizedConfigSummary
};
