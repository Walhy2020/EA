"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { resolveProjectPath } = require("../../utils/paths");

const SOURCE_KEY = "production_maintenance";
const DEFAULT_VERSION = "0.3.0";
const SEND_PERMISSION_MODES = new Set(["all_signed_in", "role_based"]);
const RECIPIENT_SCOPE_ALL_REGISTERED = "all_registered_clients";
const TERMINAL_STATUSES = new Set(["completed", "canceled"]);
const ACTIVE_STATUSES = new Set(["scheduled", "stopped", "extended"]);
const STATUS_LABELS = {
  scheduled: "正式服停服倒计时",
  stopped: "已停服",
  extended: "停服已延长",
  completed: "正式服更新完成",
  canceled: "已取消"
};
const MESSAGE_TYPES = {
  countdown: "maintenance_countdown",
  stopped: "maintenance_stopped",
  extended: "maintenance_extended",
  completed: "maintenance_completed"
};

function trimText(value) {
  return String(value || "").trim();
}

function lowerText(value) {
  return trimText(value).toLowerCase();
}

function uniqueList(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || "").split(/[\r\n,，、|;；]+/);
  return [...new Set(source.map(trimText).filter(Boolean))];
}

function uniquePositiveMinutes(value, fallback) {
  const source = Array.isArray(value) ? value : fallback;
  const values = [...new Set(source
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0 && item <= 24 * 60))]
    .sort((left, right) => right - left);
  return values.length > 0 ? values : fallback;
}

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

function safeIso(value, fieldName) {
  const text = trimText(value);
  const time = Date.parse(text);
  if (!text || Number.isNaN(time)) {
    const error = new Error(`${fieldName} 必须是有效时间`);
    error.statusCode = 400;
    throw error;
  }
  return new Date(time).toISOString();
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function maintenanceId() {
  return `pm_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeRecipientGroups(value) {
  const result = {};
  const groups = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  for (const [groupId, users] of Object.entries(groups)) {
    const key = trimText(groupId);
    const list = uniqueList(users);
    if (key && list.length > 0) {
      result[key] = list;
    }
  }
  return result;
}

function normalizeConfig(input = {}) {
  const config = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const recipientGroups = normalizeRecipientGroups(config.recipientGroups);
  const defaultGroup = trimText(config.defaultRecipientGroupId);
  const sendPermissionMode = trimText(config.sendPermissionMode || config.accessMode) || "all_signed_in";
  const defaultRecipientScope = trimText(config.defaultRecipientScope || config.recipientScope || config.defaultRecipientGroupId);
  return {
    enabled: config.enabled !== undefined ? Boolean(config.enabled) : true,
    sourceKey: SOURCE_KEY,
    name: trimText(config.name) || "正式服停服更新通知",
    version: trimText(config.version) || DEFAULT_VERSION,
    storePath: trimText(config.storePath) || "data/desktop-tip/production-maintenance.json",
    openUrl: trimText(config.openUrl) || "https://work.weixin.qq.com",
    messageAdmins: uniqueList(config.messageAdmins),
    authorizedSenders: uniqueList(config.authorizedSenders),
    sendPermissionMode: SEND_PERMISSION_MODES.has(sendPermissionMode) ? sendPermissionMode : "all_signed_in",
    recipientUsers: uniqueList(config.recipientUsers),
    recipientGroups,
    defaultRecipientGroupId: recipientGroups[defaultGroup] ? defaultGroup : "",
    defaultRecipientScope: defaultRecipientScope === RECIPIENT_SCOPE_ALL_REGISTERED ? RECIPIENT_SCOPE_ALL_REGISTERED : "",
    countdownMinutes: uniquePositiveMinutes(config.countdownMinutes, [30, 10, 5, 1]),
    maxExtensionMinutes: Math.max(1, Math.min(Number(config.maxExtensionMinutes) || 240, 24 * 60)),
    eventTtlMinutes: Math.max(60, Math.min(Number(config.eventTtlMinutes) || 3 * 24 * 60, 30 * 24 * 60)),
    schedulerIntervalSeconds: Math.max(5, Math.min(Number(config.schedulerIntervalSeconds) || 15, 300)),
    deliveryChannels: uniqueList(config.deliveryChannels).length > 0 ? uniqueList(config.deliveryChannels) : ["desktop_tip"],
    allowConfigBootstrap: Boolean(config.allowConfigBootstrap)
  };
}

function mergeRuntimeConfig(baseConfig, storedConfig) {
  return normalizeConfig({
    ...baseConfig,
    ...(storedConfig && typeof storedConfig === "object" && !Array.isArray(storedConfig) ? storedConfig : {})
  });
}

function publicConfig(config) {
  return {
    enabled: config.enabled,
    sourceKey: config.sourceKey,
    name: config.name,
    version: config.version,
    storePath: config.storePath,
    openUrl: config.openUrl,
    messageAdmins: config.messageAdmins,
    authorizedSenders: config.authorizedSenders,
    sendPermissionMode: config.sendPermissionMode,
    recipientUsers: config.recipientUsers,
    recipientGroups: config.recipientGroups,
    defaultRecipientGroupId: config.defaultRecipientGroupId,
    defaultRecipientScope: config.defaultRecipientScope,
    countdownMinutes: config.countdownMinutes,
    maxExtensionMinutes: config.maxExtensionMinutes,
    eventTtlMinutes: config.eventTtlMinutes,
    schedulerIntervalSeconds: config.schedulerIntervalSeconds,
    deliveryChannels: config.deliveryChannels,
    allowConfigBootstrap: config.allowConfigBootstrap
  };
}

function publicMaintenance(item) {
  return {
    maintenanceId: item.maintenanceId,
    title: item.title,
    serverName: item.serverName,
    status: item.status,
    statusLabel: STATUS_LABELS[item.status] || item.status,
    scheduledStopAt: item.scheduledStopAt,
    expectedResumeAt: item.expectedResumeAt,
    countdownMinutes: item.countdownMinutes,
    recipients: item.recipients,
    recipientGroupId: item.recipientGroupId,
    recipientScope: item.recipientScope || "",
    recipientType: item.recipientType || "user",
    deliveryChannels: item.deliveryChannels,
    currentRevision: item.currentRevision,
    extensionMinutes: item.extensionMinutes || 0,
    totalExtensionMinutes: item.totalExtensionMinutes || 0,
    reason: item.reason || "",
    createdBy: item.createdBy,
    createdAt: item.createdAt,
    updatedBy: item.updatedBy,
    updatedAt: item.updatedAt,
    completedBy: item.completedBy || "",
    completedAt: item.completedAt || "",
    canceledBy: item.canceledBy || "",
    canceledAt: item.canceledAt || "",
    statusHistory: Array.isArray(item.statusHistory) ? item.statusHistory : [],
    sendHistory: Array.isArray(item.sendHistory) ? item.sendHistory : []
  };
}

function chinaTimeText(iso) {
  if (!iso) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(iso));
}

function titleForMessage(item, messageType, minutes) {
  const prefix = item.serverName ? `${item.serverName} ` : "";
  if (messageType === MESSAGE_TYPES.countdown) {
    return `${prefix}停服倒计时 ${minutes} 分钟`;
  }
  if (messageType === MESSAGE_TYPES.stopped) {
    return `${prefix}已停服`;
  }
  if (messageType === MESSAGE_TYPES.extended) {
    return `${prefix}停服延长 ${item.extensionMinutes || 0} 分钟`;
  }
  if (messageType === MESSAGE_TYPES.completed) {
    return `${prefix}更新完成`;
  }
  return `${prefix}停服更新通知`;
}

function bodyForMessage(item, messageType, minutes) {
  if (messageType === MESSAGE_TYPES.countdown) {
    return `正式服将在 ${minutes} 分钟后停服，请关注更新安排。`;
  }
  if (messageType === MESSAGE_TYPES.stopped) {
    return "正式服已进入停服更新状态。";
  }
  if (messageType === MESSAGE_TYPES.extended) {
    return `本次停服延长 ${item.extensionMinutes || 0} 分钟，预计恢复时间已更新。`;
  }
  if (messageType === MESSAGE_TYPES.completed) {
    return "正式服更新已完成，本次停服事件已结束。";
  }
  return "正式服停服更新通知。";
}

function detailLinesForMessage(item, messageType, minutes) {
  const lines = [
    `事件：${item.title}`,
    `正式服：${item.serverName}`,
    `计划停服：${chinaTimeText(item.scheduledStopAt)}`,
    `预计恢复：${chinaTimeText(item.expectedResumeAt)}`,
    `状态：${STATUS_LABELS[item.status] || item.status}`
  ];
  if (messageType === MESSAGE_TYPES.countdown) {
    lines.splice(2, 0, `倒计时节点：停服前 ${minutes} 分钟`);
  }
  if (messageType === MESSAGE_TYPES.extended) {
    lines.push(`本次延长：${item.extensionMinutes || 0} 分钟`);
    lines.push(`累计延长：${item.totalExtensionMinutes || 0} 分钟`);
  }
  if (item.reason) {
    lines.push(`原因：${item.reason}`);
  }
  if (messageType === MESSAGE_TYPES.completed) {
    lines.push(`完成时间：${chinaTimeText(item.completedAt)}`);
  }
  return lines;
}

function createProductionMaintenanceManager(options = {}) {
  const logger = options.logger;
  const createTip = options.createTip;
  const getRegisteredClients = typeof options.getRegisteredClients === "function"
    ? options.getRegisteredClients
    : () => [];
  const getClientRegistryStatus = typeof options.getClientRegistryStatus === "function"
    ? options.getClientRegistryStatus
    : () => ({ registeredUserCount: 0, registeredClientCount: 0 });
  const baseConfig = normalizeConfig(options.config || {});
  const storeFile = resolveProjectPath(baseConfig.storePath);
  let state = readJsonFile(storeFile, { config: {}, events: [] });
  if (!Array.isArray(state.events)) {
    state.events = [];
  }
  let config = mergeRuntimeConfig(baseConfig, state.config);
  let timer = null;

  function save() {
    writeJsonAtomic(storeFile, {
      config: publicConfig(config),
      events: state.events
    });
  }

  function logInfo(message, meta) {
    if (logger && typeof logger.info === "function") {
      logger.info(message, meta);
    }
  }

  function logWarn(message, meta) {
    if (logger && typeof logger.warn === "function") {
      logger.warn(message, meta);
    }
  }

  function roleOf(operatorUserId) {
    const id = lowerText(operatorUserId);
    if (!id) {
      return "none";
    }
    const admin = config.messageAdmins.some((item) => lowerText(item) === id);
    const sender = config.authorizedSenders.some((item) => lowerText(item) === id);
    const receiver = config.recipientUsers.some((item) => lowerText(item) === id)
      || Object.values(config.recipientGroups).some((users) => users.some((item) => lowerText(item) === id));
    if (admin) return "message_admin";
    if (sender) return "sender";
    if (receiver) return "receiver";
    return "none";
  }

  function assertRole(operatorUserId, allowedRoles, action) {
    const role = roleOf(operatorUserId);
    if (
      config.sendPermissionMode === "all_signed_in"
      && trimText(operatorUserId)
      && allowedRoles.includes("sender")
      && ["create", "stop", "extend", "complete", "cancel", "list"].includes(action)
    ) {
      return role === "message_admin" ? role : "signed_in_sender";
    }
    if (!allowedRoles.includes(role)) {
      logWarn("Production maintenance permission rejected", {
        sourceKey: SOURCE_KEY,
        action,
        operatorConfigured: Boolean(trimText(operatorUserId)),
        role
      });
      throw createHttpError(403, "没有 EA 桌面提醒正式服停服更新权限");
    }
    return role;
  }

  function ensureEnabled() {
    if (!config.enabled) {
      throw createHttpError(400, "正式服停服更新通知未启用");
    }
  }

  function activeForServer(serverName) {
    const target = lowerText(serverName);
    return state.events.find((item) => lowerText(item.serverName) === target && ACTIVE_STATUSES.has(item.status));
  }

  function resolveRecipients(input = {}) {
    const requestedScope = trimText(input.recipientScope || input.recipientMode || input.recipientGroupId || config.defaultRecipientScope);
    if (requestedScope === RECIPIENT_SCOPE_ALL_REGISTERED) {
      const recipients = uniqueList(getRegisteredClients().map((client) => client.clientId || client.installId));
      if (recipients.length === 0) {
        throw createHttpError(400, "当前没有已登记桌面客户端，请先启动 EA 桌面提醒并成功连接一次，无需登录");
      }
      return {
        recipientScope: RECIPIENT_SCOPE_ALL_REGISTERED,
        recipientGroupId: "",
        recipientType: "client",
        recipients
      };
    }

    const requestedGroup = trimText(input.recipientGroupId) || config.defaultRecipientGroupId;
    if (requestedGroup) {
      const groupUsers = config.recipientGroups[requestedGroup];
      if (!groupUsers || groupUsers.length === 0) {
        throw createHttpError(400, "接收组不存在或为空");
      }
      return {
        recipientScope: "",
        recipientGroupId: requestedGroup,
        recipientType: "user",
        recipients: groupUsers
      };
    }

    const recipients = uniqueList(input.recipients || input.recipientUsers || input.targetUserIds);
    if (recipients.length > 0) {
      const allowed = new Set(config.recipientUsers.map(lowerText));
      for (const users of Object.values(config.recipientGroups)) {
        for (const user of users) {
          allowed.add(lowerText(user));
        }
      }
      if (allowed.size > 0) {
        const denied = recipients.filter((item) => !allowed.has(lowerText(item)));
        if (denied.length > 0) {
          throw createHttpError(403, "接收人不在 EA 桌面提醒授权接收范围内");
        }
      }
      return {
        recipientScope: "",
        recipientGroupId: "",
        recipientType: "user",
        recipients
      };
    }

    if (config.recipientUsers.length > 0) {
      return {
        recipientScope: "",
        recipientGroupId: "",
        recipientType: "user",
        recipients: config.recipientUsers
      };
    }

    throw createHttpError(400, "接收范围不能为空");
  }

  function nextRevision(item) {
    item.currentRevision = Number(item.currentRevision || 0) + 1;
    return item.currentRevision;
  }

  function appendStatusHistory(item, action, operatorUserId, extra = {}) {
    item.statusHistory = Array.isArray(item.statusHistory) ? item.statusHistory : [];
    item.statusHistory.push({
      sequence: item.currentRevision,
      action,
      status: item.status,
      operatorUserId: trimText(operatorUserId),
      createdAt: item.updatedAt,
      extensionMinutes: item.extensionMinutes || 0,
      totalExtensionMinutes: item.totalExtensionMinutes || 0,
      expectedResumeAt: item.expectedResumeAt,
      reason: item.reason || "",
      ...extra
    });
  }

  function hasActionKey(item, idempotencyKey) {
    if (!idempotencyKey) {
      return false;
    }
    item.actionKeys = Array.isArray(item.actionKeys) ? item.actionKeys : [];
    return item.actionKeys.includes(idempotencyKey);
  }

  function rememberActionKey(item, idempotencyKey) {
    if (!idempotencyKey) {
      return;
    }
    item.actionKeys = Array.isArray(item.actionKeys) ? item.actionKeys : [];
    if (!item.actionKeys.includes(idempotencyKey)) {
      item.actionKeys.push(idempotencyKey);
    }
  }

  function findMaintenance(id) {
    const item = state.events.find((entry) => entry.maintenanceId === trimText(id));
    if (!item) {
      throw createHttpError(404, "维护事件不存在");
    }
    return item;
  }

  function messageAlreadyQueued(item, messageKey, recipient) {
    const recipientType = trimText(item.recipientType) || "user";
    return Array.isArray(item.sendHistory) && item.sendHistory.some((entry) => (
      entry.messageKey === messageKey
      && (recipientType === "client"
        ? lowerText(entry.recipientClientId) === lowerText(recipient)
        : lowerText(entry.recipientUserId) === lowerText(recipient))
      && entry.channel === "desktop_tip"
      && entry.skipped !== true
    ));
  }

  function queueMessage(item, messageType, options = {}) {
    if (!config.deliveryChannels.includes("desktop_tip")) {
      logInfo("Production maintenance desktop-tip delivery skipped by channel config", {
        sourceKey: SOURCE_KEY,
        maintenanceId: item.maintenanceId,
        sequence: item.currentRevision,
        messageType
      });
      return { queuedCount: 0, skippedCount: item.recipients.length };
    }

    const minutes = Number(options.minutes || 0);
    const messageKey = `${item.maintenanceId}:${item.currentRevision}:${messageType}${minutes ? `:${minutes}` : ""}`;
    item.sendHistory = Array.isArray(item.sendHistory) ? item.sendHistory : [];
    let queuedCount = 0;
    let skippedCount = 0;
    for (const recipient of item.recipients) {
      const recipientType = trimText(item.recipientType) || "user";
      if (messageAlreadyQueued(item, messageKey, recipient)) {
        skippedCount += 1;
        continue;
      }

      const result = createTip({
        type: messageType,
        source: SOURCE_KEY,
        sourceId: messageKey,
        recipientType,
        targetUserId: recipientType === "client" ? "" : recipient,
        targetClientId: recipientType === "client" ? recipient : "",
        title: titleForMessage(item, messageType, minutes),
        body: bodyForMessage(item, messageType, minutes),
        detailLines: detailLinesForMessage(item, messageType, minutes),
        priority: messageType === MESSAGE_TYPES.completed ? "normal" : "high",
        openUrl: config.openUrl,
        ttlMinutes: config.eventTtlMinutes,
        meta: {
          sourceKey: SOURCE_KEY,
          deliveryChannels: config.deliveryChannels,
          maintenance: {
            maintenanceId: item.maintenanceId,
            title: item.title,
            serverName: item.serverName,
            status: item.status,
            statusLabel: STATUS_LABELS[item.status] || item.status,
            messageType,
            sequence: item.currentRevision,
            scheduledStopAt: item.scheduledStopAt,
            expectedResumeAt: item.expectedResumeAt,
            extensionMinutes: item.extensionMinutes || 0,
            totalExtensionMinutes: item.totalExtensionMinutes || 0,
            reason: item.reason || "",
            completedAt: item.completedAt || "",
            countdownMinutes: minutes || 0
          }
        }
      });

      item.sendHistory.push({
        messageKey,
        channel: "desktop_tip",
        messageType,
        sequence: item.currentRevision,
        recipientType,
        recipientUserId: recipientType === "client" ? "" : recipient,
        recipientClientId: recipientType === "client" ? recipient : "",
        desktopTipEventId: result && result.event ? result.event.id : "",
        queuedAt: new Date().toISOString(),
        skipped: false
      });
      queuedCount += 1;
    }

    logInfo("Production maintenance notification queued", {
      sourceKey: SOURCE_KEY,
      maintenanceId: item.maintenanceId,
      sequence: item.currentRevision,
      status: item.status,
      messageType,
      recipientCount: item.recipients.length,
      recipientType: item.recipientType || "user",
      queuedCount,
      skippedCount,
      countdownMinutes: minutes || 0
    });
    return { queuedCount, skippedCount };
  }

  function markSkippedCountdowns(item, dueMinutes, sentMinutes, nowIso) {
    item.countdownSendState = Array.isArray(item.countdownSendState) ? item.countdownSendState : [];
    for (const minutes of dueMinutes) {
      if (minutes === sentMinutes) {
        continue;
      }
      if (item.countdownSendState.some((entry) => Number(entry.minutes) === minutes)) {
        continue;
      }
      item.countdownSendState.push({
        minutes,
        skipped: true,
        reason: "superseded_by_later_countdown",
        sequence: item.currentRevision,
        createdAt: nowIso
      });
    }
  }

  function createMaintenance(input = {}) {
    ensureEnabled();
    assertRole(input.operatorUserId || input.createdBy, ["message_admin", "sender"], "create");
    const nowIso = new Date().toISOString();
    const title = trimText(input.title) || "正式服停服更新";
    const serverName = trimText(input.serverName) || "正式服";
    const scheduledStopAt = safeIso(input.scheduledStopAt, "计划停服时间");
    const expectedResumeAt = safeIso(input.expectedResumeAt, "预计恢复时间");
    if (Date.parse(expectedResumeAt) <= Date.parse(scheduledStopAt)) {
      throw createHttpError(400, "预计恢复时间必须晚于计划停服时间");
    }
    const existing = activeForServer(serverName);
    if (existing) {
      throw createHttpError(409, `正式服 ${serverName} 已有未完成停服事件`);
    }

    const recipientSnapshot = resolveRecipients(input);
    const countdownMinutes = uniquePositiveMinutes(input.countdownMinutes, config.countdownMinutes);
    const item = {
      maintenanceId: maintenanceId(),
      title,
      serverName,
      status: "scheduled",
      scheduledStopAt,
      expectedResumeAt,
      countdownMinutes,
      recipients: recipientSnapshot.recipients,
      recipientGroupId: recipientSnapshot.recipientGroupId,
      recipientScope: recipientSnapshot.recipientScope || "",
      recipientType: recipientSnapshot.recipientType || "user",
      deliveryChannels: config.deliveryChannels,
      currentRevision: 1,
      extensionMinutes: 0,
      totalExtensionMinutes: 0,
      reason: "",
      createdBy: trimText(input.operatorUserId || input.createdBy),
      createdAt: nowIso,
      updatedBy: trimText(input.operatorUserId || input.createdBy),
      updatedAt: nowIso,
      completedBy: "",
      completedAt: "",
      canceledBy: "",
      canceledAt: "",
      statusHistory: [],
      sendHistory: [],
      countdownSendState: [],
      actionKeys: []
    };
    appendStatusHistory(item, "create", item.createdBy);
    state.events.push(item);
    save();
    logInfo("Production maintenance event created", {
      sourceKey: SOURCE_KEY,
      maintenanceId: item.maintenanceId,
      status: item.status,
      serverName: item.serverName,
      operatorConfigured: Boolean(item.createdBy),
      recipientCount: item.recipients.length,
      scheduledStopAt: item.scheduledStopAt,
      expectedResumeAt: item.expectedResumeAt,
      countdownMinutes: item.countdownMinutes
    });
    runDue(new Date());
    return {
      ok: true,
      maintenance: publicMaintenance(item)
    };
  }

  function setStopped(input = {}) {
    ensureEnabled();
    const operatorUserId = trimText(input.operatorUserId || input.updatedBy);
    assertRole(operatorUserId, ["message_admin", "sender"], "stop");
    const item = findMaintenance(input.maintenanceId);
    const idempotencyKey = trimText(input.idempotencyKey);
    if (hasActionKey(item, idempotencyKey)) {
      return { ok: true, skipped: true, reason: "duplicate_action", maintenance: publicMaintenance(item) };
    }
    if (item.status === "stopped" || item.status === "extended") {
      rememberActionKey(item, idempotencyKey);
      save();
      return { ok: true, skipped: true, reason: "already_stopped", maintenance: publicMaintenance(item) };
    }
    if (item.status !== "scheduled") {
      throw createHttpError(409, "只有计划中的维护事件可以确认已停服");
    }
    const nowIso = new Date().toISOString();
    nextRevision(item);
    item.status = "stopped";
    item.updatedBy = operatorUserId;
    item.updatedAt = nowIso;
    appendStatusHistory(item, "manual_stop", operatorUserId);
    rememberActionKey(item, idempotencyKey);
    queueMessage(item, MESSAGE_TYPES.stopped);
    save();
    return { ok: true, maintenance: publicMaintenance(item) };
  }

  function extendMaintenance(input = {}) {
    ensureEnabled();
    const operatorUserId = trimText(input.operatorUserId || input.updatedBy);
    assertRole(operatorUserId, ["message_admin", "sender"], "extend");
    const item = findMaintenance(input.maintenanceId);
    const idempotencyKey = trimText(input.idempotencyKey);
    if (hasActionKey(item, idempotencyKey)) {
      return { ok: true, skipped: true, reason: "duplicate_action", maintenance: publicMaintenance(item) };
    }
    if (!["stopped", "extended"].includes(item.status)) {
      throw createHttpError(409, "只有已停服或已延长状态可以执行延长");
    }
    const minutes = Number(input.extensionMinutes || input.minutes);
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > config.maxExtensionMinutes) {
      throw createHttpError(400, `延长分钟必须是 1-${config.maxExtensionMinutes} 的正整数`);
    }
    const nowIso = new Date().toISOString();
    const baseTime = Math.max(Date.parse(item.expectedResumeAt), Date.now());
    nextRevision(item);
    item.status = "extended";
    item.extensionMinutes = minutes;
    item.totalExtensionMinutes = Number(item.totalExtensionMinutes || 0) + minutes;
    item.expectedResumeAt = new Date(baseTime + minutes * 60 * 1000).toISOString();
    item.reason = trimText(input.reason);
    item.updatedBy = operatorUserId;
    item.updatedAt = nowIso;
    appendStatusHistory(item, "extend", operatorUserId);
    rememberActionKey(item, idempotencyKey);
    queueMessage(item, MESSAGE_TYPES.extended);
    save();
    return { ok: true, maintenance: publicMaintenance(item) };
  }

  function completeMaintenance(input = {}) {
    ensureEnabled();
    const operatorUserId = trimText(input.operatorUserId || input.completedBy);
    assertRole(operatorUserId, ["message_admin", "sender"], "complete");
    const item = findMaintenance(input.maintenanceId);
    const idempotencyKey = trimText(input.idempotencyKey);
    if (hasActionKey(item, idempotencyKey) || item.status === "completed") {
      rememberActionKey(item, idempotencyKey);
      save();
      return { ok: true, skipped: true, reason: "already_completed", maintenance: publicMaintenance(item) };
    }
    if (!["stopped", "extended"].includes(item.status)) {
      throw createHttpError(409, "只有已停服或已延长状态可以完成更新");
    }
    const nowIso = new Date().toISOString();
    nextRevision(item);
    item.status = "completed";
    item.completedBy = operatorUserId;
    item.completedAt = nowIso;
    item.updatedBy = operatorUserId;
    item.updatedAt = nowIso;
    appendStatusHistory(item, "complete", operatorUserId);
    rememberActionKey(item, idempotencyKey);
    queueMessage(item, MESSAGE_TYPES.completed);
    save();
    return { ok: true, maintenance: publicMaintenance(item) };
  }

  function cancelMaintenance(input = {}) {
    ensureEnabled();
    const operatorUserId = trimText(input.operatorUserId || input.updatedBy);
    assertRole(operatorUserId, ["message_admin", "sender"], "cancel");
    const item = findMaintenance(input.maintenanceId);
    const idempotencyKey = trimText(input.idempotencyKey);
    if (hasActionKey(item, idempotencyKey) || item.status === "canceled") {
      rememberActionKey(item, idempotencyKey);
      save();
      return { ok: true, skipped: true, reason: "already_canceled", maintenance: publicMaintenance(item) };
    }
    if (item.status !== "scheduled" || Date.now() >= Date.parse(item.scheduledStopAt)) {
      throw createHttpError(409, "只能取消尚未开始的维护事件");
    }
    const nowIso = new Date().toISOString();
    nextRevision(item);
    item.status = "canceled";
    item.canceledBy = operatorUserId;
    item.canceledAt = nowIso;
    item.updatedBy = operatorUserId;
    item.updatedAt = nowIso;
    item.reason = trimText(input.reason) || item.reason || "";
    appendStatusHistory(item, "cancel", operatorUserId);
    rememberActionKey(item, idempotencyKey);
    save();
    return { ok: true, maintenance: publicMaintenance(item) };
  }

  function runDue(nowInput = new Date()) {
    if (!config.enabled) {
      return { ok: true, changed: false, processedCount: 0 };
    }
    const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
    const nowMs = now.getTime();
    if (Number.isNaN(nowMs)) {
      throw createHttpError(400, "调度时间无效");
    }
    const nowIso = now.toISOString();
    let changed = false;
    let processedCount = 0;
    for (const item of state.events) {
      if (!item || TERMINAL_STATUSES.has(item.status)) {
        continue;
      }
      const stopMs = Date.parse(item.scheduledStopAt);
      if (Number.isNaN(stopMs)) {
        continue;
      }
      if (item.status === "scheduled" && nowMs >= stopMs) {
        nextRevision(item);
        item.status = "stopped";
        item.updatedBy = "system";
        item.updatedAt = nowIso;
        appendStatusHistory(item, "auto_stop", "system", { schedulerReason: "scheduled_stop_reached" });
        queueMessage(item, MESSAGE_TYPES.stopped);
        changed = true;
        processedCount += 1;
        continue;
      }
      if (item.status === "scheduled") {
        item.countdownSendState = Array.isArray(item.countdownSendState) ? item.countdownSendState : [];
        const sentMinutes = new Set(item.countdownSendState.map((entry) => Number(entry.minutes)));
        const dueMinutes = item.countdownMinutes
          .filter((minutes) => !sentMinutes.has(minutes))
          .filter((minutes) => nowMs >= stopMs - minutes * 60 * 1000);
        if (dueMinutes.length > 0) {
          const selectedMinutes = Math.min(...dueMinutes);
          nextRevision(item);
          item.updatedBy = "system";
          item.updatedAt = nowIso;
          item.countdownSendState.push({
            minutes: selectedMinutes,
            skipped: false,
            sequence: item.currentRevision,
            createdAt: nowIso
          });
          markSkippedCountdowns(item, dueMinutes, selectedMinutes, nowIso);
          queueMessage(item, MESSAGE_TYPES.countdown, { minutes: selectedMinutes });
          changed = true;
          processedCount += 1;
        }
      }
    }
    if (changed) {
      save();
    }
    return { ok: true, changed, processedCount };
  }

  function listMaintenances(input = {}) {
    const operatorUserId = trimText(input.operatorUserId);
    assertRole(operatorUserId, ["message_admin", "sender"], "list");
    const limit = Math.max(1, Math.min(Number(input.limit) || 20, 100));
    const items = [...state.events]
      .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0).getTime() - new Date(left.updatedAt || left.createdAt || 0).getTime())
      .slice(0, limit)
      .map(publicMaintenance);
    return {
      ok: true,
      sourceKey: SOURCE_KEY,
      version: config.version,
      events: items,
      activeCount: state.events.filter((item) => ACTIVE_STATUSES.has(item.status)).length
    };
  }

  function getConfig(input = {}) {
    const operatorUserId = trimText(input.operatorUserId);
    const role = roleOf(operatorUserId);
    const canManage = role === "message_admin";
    const canSend = role === "message_admin"
      || role === "sender"
      || (config.sendPermissionMode === "all_signed_in" && Boolean(operatorUserId));
    const effectiveRole = canSend && role === "none" ? "signed_in_sender" : role;
    return {
      ok: true,
      sourceKey: SOURCE_KEY,
      version: config.version,
      role: effectiveRole,
      canManage,
      canSend,
      accessMode: config.sendPermissionMode,
      registeredReceivers: getClientRegistryStatus(),
      config: canManage || canSend ? publicConfig(config) : {
        enabled: config.enabled,
        sourceKey: SOURCE_KEY,
        name: config.name,
        version: config.version
      }
    };
  }

  function updateConfig(input = {}) {
    const operatorUserId = trimText(input.operatorUserId);
    const hasConfiguredAdmin = config.messageAdmins.length > 0;
    if (hasConfiguredAdmin || !config.allowConfigBootstrap) {
      assertRole(operatorUserId, ["message_admin"], "config");
    }
    const next = normalizeConfig({
      ...config,
      ...input.config,
      version: DEFAULT_VERSION,
      sourceKey: SOURCE_KEY
    });
    config = next;
    state.config = publicConfig(config);
    save();
    logInfo("Production maintenance config updated", {
      sourceKey: SOURCE_KEY,
      operatorConfigured: Boolean(operatorUserId),
      senderCount: config.authorizedSenders.length,
      adminCount: config.messageAdmins.length,
      recipientCount: config.recipientUsers.length,
      groupCount: Object.keys(config.recipientGroups).length,
      countdownMinutes: config.countdownMinutes
    });
    return getConfig({ operatorUserId });
  }

  function shouldShowEvent(event) {
    const meta = event && event.meta && typeof event.meta === "object" ? event.meta : {};
    const maintenance = meta.maintenance && typeof meta.maintenance === "object" ? meta.maintenance : null;
    if (!maintenance || meta.sourceKey !== SOURCE_KEY) {
      return true;
    }
    const item = state.events.find((entry) => entry.maintenanceId === maintenance.maintenanceId);
    if (!item) {
      return false;
    }
    const eventSequence = Number(maintenance.sequence || 0);
    if (eventSequence < Number(item.currentRevision || 0)) {
      return false;
    }
    if (item.status === "canceled") {
      return false;
    }
    if (item.status === "completed" && maintenance.messageType !== MESSAGE_TYPES.completed) {
      return false;
    }
    return true;
  }

  function getStatus() {
    return {
      enabled: config.enabled,
      sourceKey: SOURCE_KEY,
      name: config.name,
      version: config.version,
      storePath: config.storePath,
      activeCount: state.events.filter((item) => ACTIVE_STATUSES.has(item.status)).length,
      totalCount: state.events.length,
      senderCount: config.authorizedSenders.length,
      adminCount: config.messageAdmins.length,
      recipientCount: config.recipientUsers.length,
      recipientGroupCount: Object.keys(config.recipientGroups).length,
      accessMode: config.sendPermissionMode,
      registeredReceivers: getClientRegistryStatus(),
      countdownMinutes: config.countdownMinutes,
      schedulerIntervalSeconds: config.schedulerIntervalSeconds,
      deliveryChannels: config.deliveryChannels
    };
  }

  function start() {
    if (timer || !config.enabled) {
      return;
    }
    runDue(new Date());
    timer = setInterval(() => {
      try {
        runDue(new Date());
      } catch (error) {
        logWarn("Production maintenance scheduler failed", {
          sourceKey: SOURCE_KEY,
          message: error && error.message ? error.message : String(error || "")
        });
      }
    }, config.schedulerIntervalSeconds * 1000);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    logInfo("Production maintenance scheduler started", {
      sourceKey: SOURCE_KEY,
      intervalSeconds: config.schedulerIntervalSeconds,
      activeCount: state.events.filter((item) => ACTIVE_STATUSES.has(item.status)).length
    });
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    sourceKey: SOURCE_KEY,
    getStatus,
    getConfig,
    updateConfig,
    listMaintenances,
    createMaintenance,
    setStopped,
    extendMaintenance,
    completeMaintenance,
    cancelMaintenance,
    runDue,
    shouldShowEvent,
    start,
    stop
  };
}

module.exports = {
  SOURCE_KEY,
  MESSAGE_TYPES,
  createProductionMaintenanceManager
};
