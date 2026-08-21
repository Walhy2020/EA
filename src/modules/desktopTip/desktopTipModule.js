"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { resolveProjectPath } = require("../../utils/paths");
const { createProductionMaintenanceManager } = require("./productionMaintenance");

const DEFAULT_VERSION = "0.4.2";
const TERMINAL_ACTIONS = new Set(["dismissed", "opened", "done"]);
const MANUAL_MESSAGE_SOURCE_KEY = "admin_manual_message";
const CLIENT_MANUAL_MESSAGE_SOURCE_KEY = "client_manual_message";
const WECOM_GROUP_REGISTRY_SOURCE_KEY = "desktop_tip_wecom_group_registry";
const MANUAL_MESSAGE_TITLE_MAX = 80;
const MANUAL_MESSAGE_BODY_MAX = 1000;
const MANUAL_MESSAGE_FORBIDDEN_TARGET_FIELDS = [
  "recipientUsers",
  "recipientGroups",
  "recipients",
  "recipientIds",
  "recipientGroupId",
  "recipientScope",
  "targetUserId",
  "targetClientId",
  "clientIds",
  "clientId",
  "userId"
];

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readClientRegistryFile(filePath, fallback, logger, configStorePath) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || !Array.isArray(value.clients)) {
      throw new Error("clients must be an array");
    }
    return value;
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn("Desktop tip client registry is invalid; fallback to empty registry", {
        storePath: configStorePath,
        message: error && error.message ? error.message : String(error || "")
      });
    }
    return fallback;
  }
}

function trimText(value) {
  return String(value || "").trim();
}

function lowerText(value) {
  return trimText(value).toLowerCase();
}

function maskLogId(value) {
  const text = trimText(value);
  if (!text) {
    return "";
  }
  if (text.length <= 4) {
    return "***";
  }
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function eventId() {
  return `dt_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function futureIso(minutes) {
  return new Date(Date.now() + Math.max(1, Number(minutes) || 1) * 60 * 1000).toISOString();
}

function safeLimit(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(number), max);
}

function normalizeClientRegistryConfig(value = {}) {
  const config = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    storePath: trimText(config.storePath) || "data/desktop-tip/clients.json",
    persistIntervalSeconds: safeLimit(config.persistIntervalSeconds, 60, 3600),
    maxRegisteredClients: safeLimit(config.maxRegisteredClients, 5000, 100000)
  };
}

function normalizeClientUpdateConfig(value = {}) {
  const config = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    enabled: config.enabled !== undefined ? Boolean(config.enabled) : true,
    manifestPath: trimText(config.manifestPath) || "tools/desktop-tip/releases/latest.json",
    packageDir: trimText(config.packageDir) || "tools/desktop-tip/releases",
    packageUrl: trimText(config.packageUrl) || "/api/desktop-tip/client-update/package"
  };
}

function normalizeWecomGroupRegistryConfig(value = {}) {
  const config = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    enabled: config.enabled !== undefined ? Boolean(config.enabled) : true,
    storePath: trimText(config.storePath) || "data/desktop-tip/wecom-groups.json",
    maxGroups: safeLimit(config.maxGroups, 50, 500)
  };
}

function normalizeConfig(moduleConfig = {}) {
  return {
    enabled: moduleConfig.enabled !== undefined ? Boolean(moduleConfig.enabled) : true,
    name: trimText(moduleConfig.name) || "EA右下角提醒小工具",
    source: trimText(moduleConfig.source) || "desktop-tip",
    version: trimText(moduleConfig.version) || DEFAULT_VERSION,
    storePath: trimText(moduleConfig.storePath) || "data/desktop-tip/events.json",
    ttlMinutes: safeLimit(moduleConfig.ttlMinutes, 3 * 24 * 60, 30 * 24 * 60),
    maxStoredEvents: safeLimit(moduleConfig.maxStoredEvents, 500, 5000),
    pollLimit: safeLimit(moduleConfig.pollLimit, 20, 100),
    tokenEnv: trimText(moduleConfig.tokenEnv) || "EA_DESKTOP_TIP_TOKEN",
    requireToken: Boolean(moduleConfig.requireToken),
    clientPollSeconds: safeLimit(moduleConfig.clientPollSeconds, 8, 300),
    openUrl: trimText(moduleConfig.openUrl) || "https://work.weixin.qq.com",
    clientRegistry: normalizeClientRegistryConfig(moduleConfig.clientRegistry),
    clientUpdate: normalizeClientUpdateConfig(moduleConfig.clientUpdate),
    wecomGroupRegistry: normalizeWecomGroupRegistryConfig(moduleConfig.wecomGroupRegistry),
    productionMaintenance: moduleConfig.productionMaintenance && typeof moduleConfig.productionMaintenance === "object"
      ? moduleConfig.productionMaintenance
      : {}
  };
}

function createUnauthorizedError(message) {
  const error = new Error(message);
  error.statusCode = 401;
  return error;
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function groupRegistryId(chatId) {
  return `wg_${crypto.createHash("sha256").update(trimText(chatId)).digest("hex").slice(0, 16)}`;
}

function normalizeGroupDisplayName(value) {
  return trimText(value).replace(/\s+/g, " ").slice(0, 40);
}

function readWecomGroupRegistryFile(filePath, fallback, logger, configStorePath) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || !Array.isArray(value.groups)) {
      throw new Error("groups must be an array");
    }
    return value;
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn("Desktop tip WeCom group registry is invalid; fallback to empty registry", {
        sourceKey: WECOM_GROUP_REGISTRY_SOURCE_KEY,
        storePath: configStorePath,
        message: error && error.message ? error.message : String(error || "")
      });
    }
    return fallback;
  }
}

function compactCommandText(value) {
  return trimText(value).replace(/\s+/g, "");
}

function parseWecomGroupBindingCommand(text) {
  const raw = trimText(text);
  const compact = compactCommandText(raw);
  const bindIndex = compact.search(/(?:绑定|设置)M04通知群/i);
  const unbindIndex = compact.search(/(?:取消绑定|解绑)M04通知群/i);
  if (bindIndex < 0 && unbindIndex < 0) {
    return { handled: false };
  }
  const action = unbindIndex >= 0 && (bindIndex < 0 || unbindIndex <= bindIndex) ? "unbind" : "bind";
  const pattern = action === "bind"
    ? /(?:绑定|设置)\s*M04\s*通知群/i
    : /(?:取消绑定|解绑)\s*M04\s*通知群/i;
  const match = raw.match(pattern);
  const displayName = match ? normalizeGroupDisplayName(raw.slice(match.index + match[0].length)) : "";
  return {
    handled: true,
    action,
    displayName
  };
}

function createDesktopTipModule(options = {}) {
  const logger = options.logger;
  const config = normalizeConfig(options.moduleConfig || {});
  const storeFile = resolveProjectPath(config.storePath);
  const clientRegistryFile = resolveProjectPath(config.clientRegistry.storePath);
  const wecomGroupRegistryFile = resolveProjectPath(config.wecomGroupRegistry.storePath);
  const updateManifestFile = resolveProjectPath(config.clientUpdate.manifestPath);
  const updatePackageDir = resolveProjectPath(config.clientUpdate.packageDir);
  let state = readJsonFile(storeFile, { events: [] });
  let clientRegistryState = readClientRegistryFile(clientRegistryFile, { clients: [] }, logger, config.clientRegistry.storePath);
  let wecomGroupRegistryState = readWecomGroupRegistryFile(wecomGroupRegistryFile, { groups: [] }, logger, config.wecomGroupRegistry.storePath);
  let warnedAnonymousAccess = false;
  let warnedClientRegistryLimit = false;
  let lastRegistryPersistAt = "";
  let lastRegistryPersistMs = 0;

  if (!Array.isArray(state.events)) {
    state.events = [];
  }

  const productionMaintenance = createProductionMaintenanceManager({
    logger,
    config: {
      ...config.productionMaintenance,
      openUrl: config.productionMaintenance && config.productionMaintenance.openUrl
        ? config.productionMaintenance.openUrl
        : config.openUrl
    },
    createTip,
    getRegisteredClients,
    getClientRegistryStatus
  });

  function save() {
    writeJsonAtomic(storeFile, state);
  }

  function saveClientRegistry() {
    writeJsonAtomic(clientRegistryFile, {
      version: config.version,
      updatedAt: new Date().toISOString(),
      clients: clientRegistryState.clients
    });
    lastRegistryPersistAt = new Date().toISOString();
    lastRegistryPersistMs = Date.now();
  }

  function saveWecomGroupRegistry() {
    writeJsonAtomic(wecomGroupRegistryFile, {
      version: config.version,
      sourceKey: WECOM_GROUP_REGISTRY_SOURCE_KEY,
      updatedAt: new Date().toISOString(),
      groups: wecomGroupRegistryState.groups
    });
  }

  function maybeWarnClientRegistryLimit() {
    if (
      clientRegistryState.clients.length > config.clientRegistry.maxRegisteredClients
      && !warnedClientRegistryLimit
      && logger
      && typeof logger.warn === "function"
    ) {
      warnedClientRegistryLimit = true;
      logger.warn("Desktop tip client registry exceeds configured max; no registered client is deleted automatically", {
        registeredClientCount: clientRegistryState.clients.length,
        maxRegisteredClients: config.clientRegistry.maxRegisteredClients
      });
    }
  }

  function persistClientRegistryIfNeeded(force) {
    if (force || Date.now() - lastRegistryPersistMs >= config.clientRegistry.persistIntervalSeconds * 1000) {
      saveClientRegistry();
      return true;
    }
    return false;
  }

  function registerClient(input = {}) {
    const targetUserId = trimText(input.targetUserId || input.userId);
    const clientId = trimText(input.clientId);
    if (!clientId) {
      return { ok: false, skipped: true, reason: "missing_client" };
    }

    try {
      const nowIso = new Date().toISOString();
      const normalizedClient = lowerText(clientId);
      let client = clientRegistryState.clients.find((item) => (
        lowerText(item.clientId || item.installId) === normalizedClient
      ));
      const isNew = !client;
      if (!client) {
        client = {
          clientId,
          installId: clientId,
          targetUserId,
          clientVersion: trimText(input.clientVersion) || "unknown",
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          active: true
        };
        clientRegistryState.clients.push(client);
      } else {
        if (targetUserId) {
          client.targetUserId = targetUserId;
        }
        client.clientId = clientId;
        client.installId = trimText(client.installId) || clientId;
        client.clientVersion = trimText(input.clientVersion) || client.clientVersion || "unknown";
        client.lastSeenAt = nowIso;
        client.active = true;
      }
      maybeWarnClientRegistryLimit();
      const persisted = persistClientRegistryIfNeeded(isNew);
      if (logger && typeof logger.info === "function" && isNew) {
        logger.info("Desktop tip client registered", {
          targetUserId: maskLogId(targetUserId),
          clientId: maskLogId(clientId),
          clientVersion: client.clientVersion,
          registeredClientCount: getRegisteredClients().length,
          persisted
        });
      }
      return { ok: true, isNew, persisted };
    } catch (error) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Desktop tip client registry update failed; polling continues", {
          targetUserId: maskLogId(targetUserId),
          clientId: maskLogId(clientId),
          message: error && error.message ? error.message : String(error || "")
        });
      }
      return { ok: false, skipped: true, reason: "registry_update_failed" };
    }
  }

  function getRegisteredUserIds() {
    const byUser = new Map();
    for (const client of clientRegistryState.clients) {
      const userId = trimText(client && (client.targetUserId || client.userId));
      if (!userId) {
        continue;
      }
      const key = lowerText(userId);
      if (!byUser.has(key)) {
        byUser.set(key, userId);
      }
    }
    return [...byUser.values()];
  }

  function getRegisteredClients() {
    const byClient = new Map();
    for (const client of clientRegistryState.clients) {
      const clientId = trimText(client && (client.clientId || client.installId));
      if (!clientId || client.active === false) {
        continue;
      }
      const key = lowerText(clientId);
      if (!byClient.has(key)) {
        byClient.set(key, {
          clientId,
          installId: trimText(client.installId) || clientId,
          targetUserId: trimText(client.targetUserId || client.userId),
          clientVersion: trimText(client.clientVersion) || "unknown",
          firstSeenAt: trimText(client.firstSeenAt),
          lastSeenAt: trimText(client.lastSeenAt),
          active: client.active !== false
        });
      }
    }
    return [...byClient.values()];
  }

  function getRegisteredClient(clientId) {
    const normalizedClient = lowerText(clientId);
    if (!normalizedClient) {
      return null;
    }
    return getRegisteredClients().find((client) => lowerText(client.clientId) === normalizedClient) || null;
  }

  function getClientRegistryStatus() {
    return {
      storePath: config.clientRegistry.storePath,
      persistIntervalSeconds: config.clientRegistry.persistIntervalSeconds,
      maxRegisteredClients: config.clientRegistry.maxRegisteredClients,
      registeredUserCount: getRegisteredUserIds().length,
      registeredClientCount: getRegisteredClients().length,
      lastRegistryPersistAt
    };
  }

  function activeWecomGroups() {
    return wecomGroupRegistryState.groups
      .filter((group) => group && group.active !== false && trimText(group.chatId))
      .map((group) => ({
        groupId: trimText(group.groupId) || groupRegistryId(group.chatId),
        displayName: normalizeGroupDisplayName(group.displayName) || `M04通知群-${shortHash(group.chatId)}`,
        source: "wecom_smart_bot_group_callback",
        boundAt: trimText(group.boundAt),
        boundByName: trimText(group.boundByName),
        hasChatId: Boolean(trimText(group.chatId)),
        updatedAt: trimText(group.updatedAt)
      }));
  }

  function getWecomGroupRegistryStatus() {
    return {
      enabled: config.wecomGroupRegistry.enabled,
      storePath: config.wecomGroupRegistry.storePath,
      maxGroups: config.wecomGroupRegistry.maxGroups,
      groupCount: activeWecomGroups().length,
      groups: activeWecomGroups()
    };
  }

  function bindWecomGroupFromCallback(input = {}) {
    if (!config.wecomGroupRegistry.enabled) {
      return { ok: false, handled: true, message: "EA 桌面提醒群通知绑定功能未启用" };
    }
    const sender = input.sender || {};
    const chatType = lowerText(sender.chatType);
    const chatId = trimText(sender.chatId);
    if (!chatType.includes("group")) {
      return { ok: false, handled: true, statusCode: 400, message: "请在要接收通知的企业微信群里发送：@1号机器人 绑定M04通知群" };
    }
    if (!chatId) {
      return { ok: false, handled: true, statusCode: 400, message: "企业微信回调缺少群 chatid，无法绑定 M04 通知群" };
    }
    const nowIso = new Date().toISOString();
    const groupId = groupRegistryId(chatId);
    const requestedName = normalizeGroupDisplayName(input.displayName);
    const callbackName = normalizeGroupDisplayName(sender.chatName || sender.groupName || sender.name);
    const displayName = requestedName || callbackName || `M04通知群-${shortHash(chatId)}`;
    let group = wecomGroupRegistryState.groups.find((item) => trimText(item.groupId) === groupId || lowerText(item.chatId) === lowerText(chatId));
    const isNew = !group;
    if (!group) {
      if (activeWecomGroups().length >= config.wecomGroupRegistry.maxGroups) {
        throw createHttpError(409, `M04 通知群数量已达到上限 ${config.wecomGroupRegistry.maxGroups}`);
      }
      group = {
        groupId,
        chatId,
        displayName,
        active: true,
        boundAt: nowIso,
        boundByUserId: trimText(sender.userId),
        boundByName: trimText(sender.name),
        source: "wecom_smart_bot_group_callback"
      };
      wecomGroupRegistryState.groups.push(group);
    } else {
      group.groupId = groupId;
      group.chatId = chatId;
      group.displayName = displayName || normalizeGroupDisplayName(group.displayName) || `M04通知群-${shortHash(chatId)}`;
      group.active = true;
      group.updatedAt = nowIso;
      group.updatedByUserId = trimText(sender.userId);
      group.updatedByName = trimText(sender.name);
      if (!group.boundAt) group.boundAt = nowIso;
      if (!group.boundByUserId) group.boundByUserId = trimText(sender.userId);
      if (!group.boundByName) group.boundByName = trimText(sender.name);
    }
    saveWecomGroupRegistry();
    if (logger && typeof logger.info === "function") {
      logger.info("Desktop tip WeCom group bound", {
        sourceKey: WECOM_GROUP_REGISTRY_SOURCE_KEY,
        groupId,
        displayNameLength: group.displayName.length,
        isNew,
        operatorUserId: maskLogId(sender.userId),
        chatId: maskLogId(chatId),
        groupCount: activeWecomGroups().length
      });
    }
    return {
      ok: true,
      handled: true,
      action: "bind",
      idempotent: !isNew,
      group: activeWecomGroups().find((item) => item.groupId === groupId),
      message: isNew
        ? `已绑定 M04 通知群：${group.displayName}`
        : `M04 通知群已绑定，无需重复操作：${group.displayName}`
    };
  }

  function unbindWecomGroupFromCallback(input = {}) {
    const sender = input.sender || {};
    const chatType = lowerText(sender.chatType);
    const chatId = trimText(sender.chatId);
    if (!chatType.includes("group")) {
      return { ok: false, handled: true, statusCode: 400, message: "请在已绑定的企业微信群里发送：@1号机器人 解绑M04通知群" };
    }
    if (!chatId) {
      return { ok: false, handled: true, statusCode: 400, message: "企业微信回调缺少群 chatid，无法解绑 M04 通知群" };
    }
    const group = wecomGroupRegistryState.groups.find((item) => lowerText(item.chatId) === lowerText(chatId));
    if (!group || group.active === false) {
      return { ok: true, handled: true, action: "unbind", idempotent: true, message: "当前群未绑定 M04 通知群，无需解绑" };
    }
    group.active = false;
    group.unboundAt = new Date().toISOString();
    group.unboundByUserId = trimText(sender.userId);
    group.unboundByName = trimText(sender.name);
    saveWecomGroupRegistry();
    if (logger && typeof logger.info === "function") {
      logger.info("Desktop tip WeCom group unbound", {
        sourceKey: WECOM_GROUP_REGISTRY_SOURCE_KEY,
        groupId: trimText(group.groupId),
        operatorUserId: maskLogId(sender.userId),
        chatId: maskLogId(chatId),
        groupCount: activeWecomGroups().length
      });
    }
    return {
      ok: true,
      handled: true,
      action: "unbind",
      group: {
        groupId: trimText(group.groupId),
        displayName: normalizeGroupDisplayName(group.displayName)
      },
      message: `已解绑 M04 通知群：${normalizeGroupDisplayName(group.displayName) || "当前群"}`
    };
  }

  function captureWecomGroupBindingMessage(message = {}) {
    const command = parseWecomGroupBindingCommand(message.text);
    if (!command.handled) {
      return { handled: false };
    }
    if (command.action === "unbind") {
      return unbindWecomGroupFromCallback({ sender: message.sender || {} });
    }
    return bindWecomGroupFromCallback({
      sender: message.sender || {},
      displayName: command.displayName
    });
  }

  function resolveWecomGroupTargets(targets = []) {
    const requested = Array.isArray(targets) ? targets : [];
    const activeById = new Map();
    for (const group of wecomGroupRegistryState.groups) {
      if (group && group.active !== false && trimText(group.chatId)) {
        const groupId = trimText(group.groupId) || groupRegistryId(group.chatId);
        activeById.set(groupId, group);
      }
    }
    return requested.map((target) => {
      const groupId = trimText(target && target.groupId);
      const mentionMode = trimText(target && target.mentionMode) === "all" ? "all" : "none";
      const group = activeById.get(groupId);
      if (!group) {
        throw createHttpError(400, "选择的企业微信群未绑定或已失效，请刷新群列表");
      }
      return {
        groupId,
        chatId: trimText(group.chatId),
        displayName: normalizeGroupDisplayName(group.displayName) || `M04通知群-${shortHash(group.chatId)}`,
        mentionMode
      };
    });
  }

  function expectedToken() {
    return trimText(process.env[config.tokenEnv]);
  }

  function assertInside(baseDir, filePath) {
    const base = path.resolve(baseDir);
    const target = path.resolve(filePath);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
      throw createHttpError(403, "桌面提醒客户端更新包路径不合法");
    }
    return target;
  }

  function readClientUpdateManifest() {
    if (!config.clientUpdate.enabled) {
      throw createHttpError(404, "桌面提醒客户端在线更新未启用");
    }
    if (!fs.existsSync(updateManifestFile)) {
      throw createHttpError(404, "桌面提醒客户端更新 manifest 不存在");
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(updateManifestFile, "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
      throw createHttpError(503, `桌面提醒客户端更新 manifest 无效：${error.message}`);
    }
    const version = trimText(manifest.version);
    const sha256 = lowerText(manifest.sha256);
    const size = Number(manifest.size);
    const packageFile = trimText(manifest.packageFile || path.basename(trimText(manifest.packageUrl || "")));
    if (!version || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isInteger(size) || size <= 0 || !packageFile) {
      throw createHttpError(503, "桌面提醒客户端更新 manifest 字段不完整");
    }
    if (packageFile !== path.basename(packageFile)) {
      throw createHttpError(503, "桌面提醒客户端更新包文件名不合法");
    }
    const packagePath = assertInside(updatePackageDir, path.join(updatePackageDir, packageFile));
    if (!fs.existsSync(packagePath)) {
      throw createHttpError(404, "桌面提醒客户端更新包不存在");
    }
    const stat = fs.statSync(packagePath);
    if (!stat.isFile()) {
      throw createHttpError(503, "桌面提醒客户端更新包不是文件");
    }
    if (stat.size !== size) {
      throw createHttpError(503, "桌面提醒客户端更新包大小与 manifest 不匹配");
    }
    const actualSha256 = crypto.createHash("sha256").update(fs.readFileSync(packagePath)).digest("hex");
    if (actualSha256 !== sha256) {
      throw createHttpError(503, "桌面提醒客户端更新包 SHA256 与 manifest 不匹配");
    }
    return {
      manifest: {
        version,
        publishedAt: trimText(manifest.publishedAt),
        packageUrl: trimText(manifest.packageUrl) || config.clientUpdate.packageUrl,
        sha256,
        size,
        releaseNotes: Array.isArray(manifest.releaseNotes)
          ? manifest.releaseNotes.map(trimText).filter(Boolean).slice(0, 20)
          : uniqueLines(manifest.releaseNotes).slice(0, 20),
        minimumSupportedVersion: trimText(manifest.minimumSupportedVersion)
      },
      packageFile,
      packagePath,
      stat
    };
  }

  function uniqueLines(value) {
    return String(value || "")
      .split(/[\r\n]+/)
      .map(trimText)
      .filter(Boolean);
  }

  function getClientUpdateStatus() {
    if (!config.clientUpdate.enabled) {
      return {
        enabled: false,
        version: "",
        packageReady: false,
        size: 0,
        sha256Prefix: "",
        publishedAt: ""
      };
    }
    try {
      const info = readClientUpdateManifest();
      return {
        enabled: true,
        version: info.manifest.version,
        packageReady: true,
        size: info.manifest.size,
        sha256Prefix: info.manifest.sha256.slice(0, 12),
        publishedAt: info.manifest.publishedAt
      };
    } catch (error) {
      return {
        enabled: true,
        version: "",
        packageReady: false,
        size: 0,
        sha256Prefix: "",
        publishedAt: "",
        error: error && error.message ? error.message : String(error || "")
      };
    }
  }

  function getClientUpdateManifest() {
    const info = readClientUpdateManifest();
    if (logger && typeof logger.info === "function") {
      logger.info("Desktop tip client update manifest requested", {
        version: info.manifest.version,
        size: info.manifest.size,
        packageReady: true
      });
    }
    return {
      ok: true,
      manifest: info.manifest
    };
  }

  function getClientUpdatePackage() {
    const info = readClientUpdateManifest();
    if (logger && typeof logger.info === "function") {
      logger.info("Desktop tip client update package requested", {
        version: info.manifest.version,
        size: info.manifest.size,
        sha256Prefix: info.manifest.sha256.slice(0, 12)
      });
    }
    return {
      ok: true,
      version: info.manifest.version,
      fileName: info.packageFile,
      filePath: info.packagePath,
      size: info.manifest.size,
      sha256: info.manifest.sha256,
      stream: fs.createReadStream(info.packagePath)
    };
  }

  function assertAuthorized(token) {
    const expected = expectedToken();
    const provided = trimText(token);
    if (expected) {
      if (provided !== expected) {
        throw createUnauthorizedError("桌面提醒访问令牌不正确");
      }
      return "token";
    }

    if (config.requireToken) {
      throw createUnauthorizedError(`桌面提醒已要求访问令牌，但环境变量 ${config.tokenEnv} 还没有配置`);
    }

    if (!warnedAnonymousAccess && logger && typeof logger.warn === "function") {
      warnedAnonymousAccess = true;
      logger.warn("Desktop tip token is not configured; polling is allowed without token", {
        tokenEnv: config.tokenEnv,
        requireToken: config.requireToken
      });
    }
    return "anonymous";
  }

  function isExpired(event, now = Date.now()) {
    return Boolean(event.expiresAt && new Date(event.expiresAt).getTime() <= now);
  }

  function pruneExpired() {
    const now = Date.now();
    const before = state.events.length;
    state.events = state.events.filter((event) => {
      if (!event || typeof event !== "object") {
        return false;
      }
      if (isExpired(event, now)) {
        return false;
      }
      return true;
    });

    if (state.events.length > config.maxStoredEvents) {
      state.events = state.events
        .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())
        .slice(0, config.maxStoredEvents);
    }
    return before !== state.events.length;
  }

  function publicEvent(event) {
    return {
      id: event.id,
      type: event.type || "info",
      source: event.source || config.source,
      sourceId: event.sourceId || "",
      recipientType: event.recipientType || (event.targetClientId ? "client" : "user"),
      targetClientId: event.targetClientId || "",
      targetUserId: event.targetUserId || "",
      targetName: event.targetName || "",
      title: event.title || "EA提醒",
      body: event.body || "",
      detailLines: Array.isArray(event.detailLines) ? event.detailLines : [],
      priority: event.priority || "normal",
      openUrl: event.openUrl || config.openUrl,
      createdAt: event.createdAt || "",
      expiresAt: event.expiresAt || "",
      meta: event.meta || {}
    };
  }

  function createTip(input = {}) {
    if (!config.enabled) {
      return {
        ok: false,
        skipped: true,
        reason: "desktop tip module is disabled"
      };
    }

    const targetClientId = trimText(input.targetClientId || (input.recipientType === "client" ? input.clientId : ""));
    const targetUserId = trimText(input.targetUserId);
    const recipientType = targetClientId ? "client" : "user";
    if (!targetClientId && !targetUserId) {
      throw new Error("桌面提醒目标不能为空");
    }

    const changed = pruneExpired();
    const createdAt = new Date().toISOString();
    const event = {
      id: eventId(),
      type: trimText(input.type) || "info",
      source: trimText(input.source) || config.source,
      sourceId: trimText(input.sourceId),
      recipientType,
      targetClientId,
      targetUserId,
      targetName: trimText(input.targetName),
      title: trimText(input.title) || "EA提醒",
      body: trimText(input.body),
      detailLines: Array.isArray(input.detailLines)
        ? input.detailLines.map(trimText).filter(Boolean).slice(0, 8)
        : [],
      priority: trimText(input.priority) || "normal",
      openUrl: trimText(input.openUrl) || config.openUrl,
      createdAt,
      expiresAt: input.expiresAt ? trimText(input.expiresAt) : futureIso(input.ttlMinutes || config.ttlMinutes),
      status: "active",
      deliveries: [],
      acknowledgements: [],
      meta: input.meta && typeof input.meta === "object" && !Array.isArray(input.meta) ? input.meta : {}
    };

    state.events.push(event);
    if (changed || state.events.length > config.maxStoredEvents) {
      pruneExpired();
    }
    save();

    if (logger && typeof logger.info === "function") {
      logger.info("Desktop tip event queued", {
        eventId: event.id,
        source: event.source,
        sourceId: event.sourceId,
        type: event.type,
        recipientType: event.recipientType,
        targetClientId: maskLogId(event.targetClientId),
        targetUserId: maskLogId(event.targetUserId),
        titleLength: event.title.length,
        bodyLength: event.body.length,
        expiresAt: event.expiresAt
      });
    }

    return {
      ok: true,
      event: publicEvent(event)
    };
  }

  function hasTerminalAck(event, userId, clientId) {
    const normalizedUserId = lowerText(userId);
    const normalizedClientId = lowerText(clientId);
    return Array.isArray(event.acknowledgements) && event.acknowledgements.some((ack) => {
      if (trimText(event.targetClientId)) {
        return normalizedClientId
          && lowerText(ack.clientId) === normalizedClientId
          && TERMINAL_ACTIONS.has(trimText(ack.action));
      }
      const sameUser = normalizedUserId && lowerText(ack.userId) === normalizedUserId;
      const sameClient = normalizedClientId && lowerText(ack.clientId) === normalizedClientId;
      return (sameUser || sameClient) && TERMINAL_ACTIONS.has(trimText(ack.action));
    });
  }

  function listTips(input = {}) {
    const accessMode = assertAuthorized(input.token);
    if (!config.enabled) {
      return {
        ok: false,
        skipped: true,
        reason: "desktop tip module is disabled",
        events: []
      };
    }

    const targetUserId = trimText(input.targetUserId || input.userId);
    const clientId = trimText(input.clientId);
    if (!targetUserId && !clientId) {
      throw createUnauthorizedError("桌面提醒客户端标识不能为空");
    }
    registerClient({
      targetUserId,
      clientId,
      clientVersion: input.clientVersion
    });
    const changed = pruneExpired();
    const normalizedTarget = lowerText(targetUserId);
    const normalizedClientId = lowerText(clientId);
    const limit = safeLimit(input.limit, config.pollLimit, 100);
    const events = state.events
      .filter((event) => event.status === "active")
      .filter((event) => {
        const eventClientId = trimText(event.targetClientId);
        if (eventClientId) {
          return normalizedClientId && lowerText(eventClientId) === normalizedClientId;
        }
        return normalizedTarget && lowerText(event.targetUserId) === normalizedTarget;
      })
      .filter((event) => productionMaintenance.shouldShowEvent(event))
      .filter((event) => !hasTerminalAck(event, targetUserId, clientId))
      .sort((left, right) => new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime())
      .slice(0, limit);

    let deliveryChanged = changed;
    for (const event of events) {
      event.deliveries = Array.isArray(event.deliveries) ? event.deliveries : [];
      const hasDelivery = clientId && event.deliveries.some((delivery) => lowerText(delivery.clientId) === lowerText(clientId));
      if (clientId && !hasDelivery) {
        event.deliveries.push({
          clientId,
          userId: targetUserId,
          deliveredAt: new Date().toISOString()
        });
        deliveryChanged = true;
      }
    }
    if (deliveryChanged) {
      save();
    }

    if (logger && typeof logger.info === "function") {
      logger.info("Desktop tip events polled", {
        targetUserId: maskLogId(targetUserId),
        clientId: maskLogId(clientId),
        eventCount: events.length,
        accessMode
      });
    }

    return {
      ok: true,
      version: config.version,
      serverTime: new Date().toISOString(),
      pollSeconds: config.clientPollSeconds,
      events: events.map(publicEvent)
    };
  }

  function ackTip(input = {}) {
    const accessMode = assertAuthorized(input.token);
    const event = state.events.find((item) => item.id === trimText(input.eventId));
    if (!event) {
      return {
        ok: false,
        message: "桌面提醒事件不存在，可能已经过期"
      };
    }

    const userId = trimText(input.userId || input.targetUserId);
    const clientId = trimText(input.clientId);
    const action = trimText(input.action) || "shown";
    if (trimText(event.targetClientId)) {
      if (!clientId || lowerText(event.targetClientId) !== lowerText(clientId)) {
        throw createUnauthorizedError("不能确认其他客户端的桌面提醒事件");
      }
    } else if (!userId || lowerText(event.targetUserId) !== lowerText(userId)) {
      throw createUnauthorizedError("不能确认其他人的桌面提醒事件");
    }

    event.acknowledgements = Array.isArray(event.acknowledgements) ? event.acknowledgements : [];
    event.acknowledgements.push({
      action,
      userId,
      clientId,
      receivedAt: new Date().toISOString()
    });
    if (TERMINAL_ACTIONS.has(action)) {
      event.status = "acknowledged";
      event.acknowledgedAt = new Date().toISOString();
    }
    save();

    if (logger && typeof logger.info === "function") {
      logger.info("Desktop tip event acknowledged", {
        eventId: event.id,
        action,
        targetUserId: maskLogId(event.targetUserId),
        targetClientId: maskLogId(event.targetClientId),
        clientId: maskLogId(clientId),
        accessMode
      });
    }

    return {
      ok: true,
      event: publicEvent(event)
    };
  }

  function createManualMessage(input = {}) {
    const rawInput = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const forbiddenFields = MANUAL_MESSAGE_FORBIDDEN_TARGET_FIELDS.filter((field) => hasOwn(rawInput, field));
    if (forbiddenFields.length > 0) {
      throw createHttpError(400, "普通桌面消息不允许指定接收人、客户端或任意目标参数");
    }

    const operatorUserId = trimText(rawInput.operatorUserId);
    if (!operatorUserId) {
      throw createHttpError(401, "普通桌面消息发送人必须来自已签名登录会话");
    }
    const sourceKey = rawInput.sourceKey === CLIENT_MANUAL_MESSAGE_SOURCE_KEY
      ? CLIENT_MANUAL_MESSAGE_SOURCE_KEY
      : MANUAL_MESSAGE_SOURCE_KEY;
    const sourceLabel = sourceKey === CLIENT_MANUAL_MESSAGE_SOURCE_KEY
      ? "来源：EA 桌面提醒客户端发送"
      : "来源：EA 管理后台普通消息测试";

    const title = trimText(rawInput.title);
    const body = trimText(rawInput.body || rawInput.content);
    if (!title) {
      throw createHttpError(400, "普通桌面消息标题不能为空");
    }
    if (!body) {
      throw createHttpError(400, "普通桌面消息内容不能为空");
    }
    if (title.length > MANUAL_MESSAGE_TITLE_MAX) {
      throw createHttpError(400, `普通桌面消息标题不能超过 ${MANUAL_MESSAGE_TITLE_MAX} 个字符`);
    }
    if (body.length > MANUAL_MESSAGE_BODY_MAX) {
      throw createHttpError(400, `普通桌面消息内容不能超过 ${MANUAL_MESSAGE_BODY_MAX} 个字符`);
    }

    const clients = getRegisteredClients();
    if (clients.length <= 0) {
      throw createHttpError(409, "当前没有已登记桌面客户端，请先启动 EA 桌面提醒并成功连接一次，无需登录");
    }

    const batchId = `manual_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const createdAt = new Date().toISOString();
    const queuedEvents = [];
    const failed = [];

    clients.forEach((client, index) => {
      try {
        const result = createTip({
          type: "manual_message",
          source: MANUAL_MESSAGE_SOURCE_KEY,
          sourceId: `${batchId}_${index + 1}`,
          recipientType: "client",
          targetClientId: client.clientId,
          title,
          body,
          detailLines: [
            sourceLabel,
            `批次：${batchId}`
          ],
          priority: "normal",
          ttlMinutes: config.ttlMinutes,
          meta: {
            sourceKey,
            batchId,
            createdAt
          }
        });
        queuedEvents.push(result.event);
      } catch (error) {
        failed.push({
          clientId: maskLogId(client.clientId),
          message: error && error.message ? error.message : String(error || "")
        });
      }
    });

    if (logger && typeof logger.info === "function") {
      logger.info("Desktop tip manual message batch queued", {
        sourceKey,
        batchId,
        operatorConfigured: Boolean(operatorUserId),
        operatorUserId: maskLogId(operatorUserId),
        recipientCount: clients.length,
        titleLength: title.length,
        bodyLength: body.length,
        queued: queuedEvents.length,
        failed: failed.length
      });
    }

    return {
      ok: failed.length === 0,
      sourceKey,
      batchId,
      recipientType: "client",
      recipientScope: "all_registered_clients",
      recipientCount: clients.length,
      queuedCount: queuedEvents.length,
      failedCount: failed.length,
      failed,
      events: queuedEvents.map((event) => ({
        id: event.id,
        recipientType: event.recipientType
      })),
      operator: {
        userId: operatorUserId,
        name: trimText(rawInput.operatorName)
      }
    };
  }

  function createTestTip(input = {}) {
    return createTip({
      type: "test",
      source: "admin-console",
      sourceId: `desktop_tip_test_${Date.now()}`,
      targetUserId: input.targetUserId || input.userId,
      targetName: input.targetName,
      title: input.title || "EA桌面提醒测试",
      body: input.body || "这是一条桌面浮窗测试提醒。",
      detailLines: input.detailLines || [
        "来源：EA后台",
        "用途：验证右下角浮窗小工具"
      ],
      priority: "normal",
      ttlMinutes: input.ttlMinutes || 60
    });
  }

  function getStatus() {
    pruneExpired();
    return {
      enabled: Boolean(config.enabled),
      name: config.name,
      version: config.version,
      storePath: config.storePath,
      activeCount: state.events.filter((event) => event.status === "active").length,
      totalCount: state.events.length,
      tokenEnv: config.tokenEnv,
      tokenConfigured: Boolean(expectedToken()),
      requireToken: config.requireToken,
      clientPollSeconds: config.clientPollSeconds,
      clientRegistry: getClientRegistryStatus(),
      wecomGroupRegistry: getWecomGroupRegistryStatus(),
      clientUpdate: getClientUpdateStatus(),
      productionMaintenance: productionMaintenance.getStatus()
    };
  }

  if (!options.disableMaintenanceScheduler) {
    productionMaintenance.start();
  }

  return {
    name: "desktopTip",
    createTip,
    listTips,
    ackTip,
    createManualMessage,
    createTestTip,
    getStatus,
    getRegisteredUserIds,
    getRegisteredClients,
    getRegisteredClient,
    getClientRegistryStatus,
    getWecomGroupRegistryStatus,
    resolveWecomGroupTargets,
    captureWecomGroupBindingMessage,
    getClientUpdateManifest,
    getClientUpdatePackage,
    getClientUpdateStatus,
    maintenance: productionMaintenance,
    flushClientRegistry() {
      saveClientRegistry();
      return getClientRegistryStatus();
    },
    stop() {
      productionMaintenance.stop();
    }
  };
}

module.exports = {
  createDesktopTipModule
};
