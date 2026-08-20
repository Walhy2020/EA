"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { projectRoot } = require("../utils/paths");
const { errorInfo } = require("../utils/errorInfo");

const stateFile = path.join(projectRoot, "data", "monitors", "dev-progress-required-fields-state.json");
const DEFAULT_COOLDOWN_MINUTES = 24 * 60;
const DEFAULT_MAX_TARGETS_PER_TICK = 20;
const DEFAULT_CHANGE_QUIET_MINUTES = 3;
const DEFAULT_MIN_FULL_SCAN_INTERVAL_MINUTES = 5;
const DEFAULT_GROUP_CARD_LIMIT_PER_TICK = 1;
const DEFAULT_GROUP_REMIND_MINUTES = 24 * 60;
const DEFAULT_GROUP_RETRY_MS = 5 * 60 * 1000;
const GROUP_FREQUENCY_LIMIT_RETRY_MS = 30 * 60 * 1000;
const GROUP_REMINDER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PILOT_REMIND_MINUTES = 24 * 60;
const DEFAULT_PILOT_SUMMARY_MINUTES = 24 * 60;
const DEFAULT_PILOT_MENTION_DELAY_SECONDS = 70;
const DEFAULT_TEST_VERIFY_DELAY_SECONDS = 30;
const DEFAULT_TEST_NEXT_TASK_DELAY_SECONDS = 10 * 60;
const INLINE_TASK_LIMIT = 2;

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

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeDemandId(value) {
  const text = String(value || "").trim();
  return /^\d+$/.test(text) ? text.padStart(6, "0") : text;
}

function normalizeDemandIdList(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map(normalizeDemandId).filter(Boolean))];
}

function normalizePushConfig(monitorConfig = {}) {
  const push = monitorConfig.requiredFieldsPush || {};
  const groupCard = push.groupCard || {};
  const pilot = push.pilot || {};
  return {
    enabled: push.enabled !== undefined ? Boolean(push.enabled) : true,
    cooldownMinutes: positiveNumber(push.cooldownMinutes, DEFAULT_COOLDOWN_MINUTES),
    scanLimit: Number(push.scanLimit || 0),
    maxTargetsPerTick: positiveNumber(push.maxTargetsPerTick, DEFAULT_MAX_TARGETS_PER_TICK),
    runOnStart: Boolean(push.runOnStart),
    testMode: Boolean(push.testMode),
    testTargetName: typeof push.testTargetName === "string" ? push.testTargetName.trim() : "",
    testVerifyDelaySeconds: positiveNumber(push.testVerifyDelaySeconds, DEFAULT_TEST_VERIFY_DELAY_SECONDS),
    testNextTaskDelaySeconds: positiveNumber(push.testNextTaskDelaySeconds, DEFAULT_TEST_NEXT_TASK_DELAY_SECONDS),
    groupCard: {
      enabled: groupCard.enabled !== undefined ? Boolean(groupCard.enabled) : true,
      maxCardsPerTick: positiveNumber(groupCard.maxCardsPerTick, DEFAULT_GROUP_CARD_LIMIT_PER_TICK),
      remindMinutes: positiveNumber(groupCard.remindMinutes, DEFAULT_GROUP_REMIND_MINUTES)
    },
    pilot: {
      enabled: Boolean(pilot.enabled),
      targetName: typeof pilot.targetName === "string" ? pilot.targetName.trim() : "",
      remindMinutes: positiveNumber(pilot.remindMinutes, DEFAULT_PILOT_REMIND_MINUTES),
      summaryMinutes: positiveNumber(pilot.summaryMinutes, DEFAULT_PILOT_SUMMARY_MINUTES),
      mentionDelaySeconds: positiveNumber(pilot.mentionDelaySeconds, DEFAULT_PILOT_MENTION_DELAY_SECONDS),
      maxActiveTasks: positiveNumber(pilot.maxActiveTasks, 1),
      focusDemandIds: normalizeDemandIdList(pilot.focusDemandIds)
    }
  };
}

function normalizeChangeDetectionConfig(monitorConfig = {}) {
  const detection = monitorConfig.changeDetection || {};
  return {
    enabled: detection.enabled !== undefined ? Boolean(detection.enabled) : true,
    quietMinutes: positiveNumber(detection.quietMinutes, DEFAULT_CHANGE_QUIET_MINUTES),
    minScanIntervalMinutes: positiveNumber(detection.minScanIntervalMinutes, DEFAULT_MIN_FULL_SCAN_INTERVAL_MINUTES),
    scanOnFirstRun: Boolean(detection.scanOnFirstRun),
    scanOnSignalError: detection.scanOnSignalError !== undefined ? Boolean(detection.scanOnSignalError) : true
  };
}

function timeMs(value) {
  const ms = new Date(value || "").getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function compactChangeDecision(decision) {
  if (!decision) {
    return undefined;
  }
  return {
    enabled: decision.enabled,
    shouldScan: decision.shouldScan,
    reason: decision.reason,
    signal: decision.signal || "",
    modifyTime: decision.modifyTime || "",
    docName: decision.docName || "",
    pendingSince: decision.pendingSince || "",
    quietMinutes: decision.quietMinutes,
    minScanIntervalMinutes: decision.minScanIntervalMinutes
  };
}

function itemIdentity(ownerName, item = {}) {
  const task = item.task || {};
  const missingFields = Array.isArray(item.missingFields)
    ? item.missingFields.map((field) => String(field || "").trim()).filter(Boolean).sort()
    : [];
  return [
    ownerName,
    item.originalOwnerName || "",
    task.recordId || task.demandId || task.demand || "",
    item.demandType || task.demandType || "",
    item.status || task.status || "",
    missingFields.join("|")
  ].join("\u001f");
}

function itemKey(ownerName, item) {
  return crypto.createHash("sha1").update(itemIdentity(ownerName, item)).digest("hex");
}

function compactText(value, maxLength = 80) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLength - 3))}...`;
}

function groupReminderTaskId(key) {
  return `ea_dev_required_${String(key || "").slice(0, 20)}_${Date.now().toString(36)}`;
}

function pilotReminderId(key) {
  return `ea_dev_pilot_${String(key || "").slice(0, 20)}_${Date.now().toString(36)}`;
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function chinaDateTime(value) {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) {
    return "-";
  }
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function groupReminderCard(reminder) {
  const task = reminder.task || {};
  const demandLink = task.links && task.links.demandLink ? task.links.demandLink : "https://work.weixin.qq.com";
  const repeatText = Number(reminder.repeatCount || 0) > 0
    ? `第 ${Number(reminder.repeatCount || 0) + 1} 次提醒，请先点击“正在处理”`
    : "看到后请先点击“正在处理”";
  return {
    card_type: "button_interaction",
    source: {
      desc: "EA需求监控",
      desc_color: 0
    },
    main_title: {
      title: compactText(task.demand || "需求必填字段待补充", 30),
      desc: `${reminder.ownerName || "责任同事"}，${repeatText}`
    },
    quote_area: {
      type: 1,
      url: demandLink,
      title: `缺失字段：${compactText((reminder.missingFields || []).join("、") || "-", 60)}`,
      quote_text: `项目：${task.project || "-"}\n需求ID：${task.demandId || task.recordId || "-"}`
    },
    horizontal_content_list: [
      { keyname: "责任同事", value: reminder.ownerName || "-" },
      { keyname: "当前进度", value: reminder.statusLabel || task.status || "-" },
      { keyname: "提醒ID", value: reminder.id }
    ],
    button_list: [
      { text: "正在处理", key: "ea_dev_required_processing", style: 1 }
    ],
    card_action: {
      type: 1,
      url: demandLink
    },
    task_id: reminder.id
  };
}

function processingGroupReminderCard(reminder) {
  const task = reminder.task || {};
  const demandLink = task.links && task.links.demandLink ? task.links.demandLink : "https://work.weixin.qq.com";
  return {
    card_type: "button_interaction",
    source: {
      desc: "EA需求监控",
      desc_color: 0
    },
    main_title: {
      title: compactText(task.demand || "需求必填字段补充", 28),
      desc: `${reminder.processingByName || reminder.ownerName || "责任同事"} 已开始处理，补充完成后请点击“已完成”`
    },
    quote_area: {
      type: 1,
      url: demandLink,
      title: `缺失字段：${compactText((reminder.missingFields || []).join("、") || "-", 60)}`,
      quote_text: `项目：${task.project || "-"}\n需求ID：${task.demandId || task.recordId || "-"}`
    },
    horizontal_content_list: [
      { keyname: "责任同事", value: reminder.ownerName || "-" },
      { keyname: "开始处理", value: chinaDateTime(reminder.processingAt) },
      { keyname: "提醒ID", value: reminder.id }
    ],
    button_list: [
      { text: "已完成", key: "ea_dev_required_done", style: 1 }
    ],
    card_action: {
      type: 1,
      url: demandLink
    },
    task_id: reminder.id
  };
}

function completedGroupReminderCard(reminder) {
  const task = reminder.task || {};
  const demandLink = task.links && task.links.demandLink ? task.links.demandLink : "https://work.weixin.qq.com";
  return {
    card_type: "text_notice",
    source: {
      desc: "EA需求监控",
      desc_color: 1
    },
    main_title: {
      title: compactText(task.demand || "需求必填字段补充", 30),
      desc: `${reminder.completedByName || reminder.ownerName || "责任同事"} 已提交完成`
    },
    horizontal_content_list: [
      { keyname: "需求ID", value: task.demandId || task.recordId || "-" },
      { keyname: "完成时间", value: chinaDateTime(reminder.completedAt) },
      { keyname: "提醒ID", value: reminder.id }
    ],
    card_action: {
      type: 1,
      url: demandLink
    },
    task_id: reminder.id
  };
}

function createDevProgressMonitorBridge(options) {
  const devProgressModule = options.devProgressModule;
  const robotServer = options.robotServer;
  const appNotifier = options.appNotifier;
  const appFeedbackUrl = String(options.appFeedbackUrl || "").trim();
  const monitorConfig = options.monitorConfig || {};
  const logger = options.logger;
  const bridgeStateFile = options.stateFile || stateFile;
  let timer = null;
  let running = false;
  let wakeTimer = null;
  let wakeTimerAt = 0;
  let wakeTimerReason = "";
  let state = readJsonFile(bridgeStateFile, { sent: {}, lastRun: null });
  if (!state || typeof state !== "object") {
    state = { sent: {}, lastRun: null };
  }
  if (!state.sent || typeof state.sent !== "object") {
    state.sent = {};
  }
  if (!state.groupSent || typeof state.groupSent !== "object" || Array.isArray(state.groupSent)) {
    state.groupSent = {};
  }
  if (!state.groupReminders || typeof state.groupReminders !== "object" || Array.isArray(state.groupReminders)) {
    state.groupReminders = {};
  }
  if (!state.groupBinding || typeof state.groupBinding !== "object" || Array.isArray(state.groupBinding)) {
    state.groupBinding = {};
  }
  if (!state.pilotReminders || typeof state.pilotReminders !== "object" || Array.isArray(state.pilotReminders)) {
    state.pilotReminders = {};
  }
  if (!state.pilotSent || typeof state.pilotSent !== "object" || Array.isArray(state.pilotSent)) {
    state.pilotSent = {};
  }
  if (!state.pilotGroupSummary || typeof state.pilotGroupSummary !== "object" || Array.isArray(state.pilotGroupSummary)) {
    state.pilotGroupSummary = {};
  }
  if (!state.pilotGroupMention || typeof state.pilotGroupMention !== "object" || Array.isArray(state.pilotGroupMention)) {
    state.pilotGroupMention = {};
  }
  if (!state.changeDetection || typeof state.changeDetection !== "object" || Array.isArray(state.changeDetection)) {
    state.changeDetection = {};
  }

  function save() {
    writeJsonAtomic(bridgeStateFile, state);
  }

  function clearWakeTimer() {
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    wakeTimerAt = 0;
    wakeTimerReason = "";
  }

  function effectivePilotReminderMs(pushConfig = normalizePushConfig(monitorConfig)) {
    if (pushConfig.testMode) {
      return pushConfig.testNextTaskDelaySeconds * 1000;
    }
    return pushConfig.pilot.remindMinutes * 60 * 1000;
  }

  function effectivePilotVerifyDelayMs(pushConfig = normalizePushConfig(monitorConfig)) {
    if (pushConfig.testMode) {
      return pushConfig.testVerifyDelaySeconds * 1000;
    }
    return 30 * 1000;
  }

  function scheduleWakeTick(runAt, reason, options = {}) {
    const pushConfig = options.pushConfig || normalizePushConfig(monitorConfig);
    if (!pushConfig.testMode) {
      return false;
    }
    const runAtMs = typeof runAt === "number" ? runAt : timeMs(runAt);
    if (!runAtMs) {
      return false;
    }
    if (wakeTimer && wakeTimerAt && wakeTimerAt <= runAtMs) {
      return false;
    }
    clearWakeTimer();
    const delayMs = Math.max(0, runAtMs - Date.now());
    wakeTimerAt = runAtMs;
    wakeTimerReason = String(reason || "").trim();
    wakeTimer = setTimeout(() => {
      const scheduledAt = wakeTimerAt;
      const scheduledReason = wakeTimerReason;
      clearWakeTimer();
      tick().catch((error) => {
        if (logger && typeof logger.error === "function") {
          logger.error("Dev progress test wake tick failed", {
            reason: scheduledReason,
            scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : "",
            message: error.message
          });
        }
      });
    }, delayMs);
    if (typeof wakeTimer.unref === "function") {
      wakeTimer.unref();
    }
    if (logger && typeof logger.info === "function") {
      logger.info("Dev progress test wake tick scheduled", {
        reason: wakeTimerReason,
        runAt: new Date(runAtMs).toISOString(),
        delayMs
      });
    }
    return true;
  }

  function taskIdentityFromTask(task = {}) {
    return [
      String(task.recordId || "").trim(),
      String(task.demandId || "").trim(),
      String(task.project || "").trim(),
      String(task.demand || "").trim()
    ].join("\u001f");
  }

  function taskIdentityFromItem(item = {}) {
    return taskIdentityFromTask(item.task || {});
  }

  function taskIdentityFromReminder(reminder = {}) {
    return String(reminder.taskIdentity || taskIdentityFromTask(reminder.task || {})).trim();
  }

  function pilotItemMatchesReminder(item, reminder) {
    const expected = reminder && reminder.task ? reminder.task : {};
    const actual = item && item.task ? item.task : {};
    const expectedRecordId = String(expected.recordId || "").trim();
    const expectedDemandId = String(expected.demandId || "").trim();
    if (expectedRecordId && expectedDemandId) {
      return String(actual.recordId || "").trim() === expectedRecordId
        && String(actual.demandId || "").trim() === expectedDemandId;
    }
    return taskIdentityFromItem(item) === taskIdentityFromReminder(reminder);
  }

  function sentRecently(key, nowMs, cooldownMs) {
    const record = state.sent[key];
    if (!record || !record.sentAt) {
      return false;
    }
    const sentAt = new Date(record.sentAt).getTime();
    return Number.isFinite(sentAt) && nowMs - sentAt < cooldownMs;
  }

  function cleanupSent(nowMs, cooldownMs) {
    const retentionMs = Math.max(cooldownMs * 4, 7 * 24 * 60 * 60 * 1000);
    for (const [key, record] of Object.entries(state.sent)) {
      const sentAt = new Date(record && record.sentAt ? record.sentAt : "").getTime();
      if (!Number.isFinite(sentAt) || nowMs - sentAt > retentionMs) {
        delete state.sent[key];
      }
    }
  }

  function groupBindingEnabled(pushConfig = normalizePushConfig(monitorConfig)) {
    return Boolean(
      pushConfig.enabled
      && pushConfig.groupCard.enabled
      && state.groupBinding
      && state.groupBinding.enabled
      && state.groupBinding.chatId
    );
  }

  function monitorEnabled(pushConfig = normalizePushConfig(monitorConfig)) {
    return Boolean(
      monitorConfig.enabled
      || groupBindingEnabled(pushConfig)
      || (pushConfig.pilot.enabled && pushConfig.pilot.targetName)
    );
  }

  function groupRemindersForKey(key) {
    return Object.values(state.groupReminders).filter((reminder) => (
      reminder
      && reminder.key === key
      && reminder.chatId === state.groupBinding.chatId
    ));
  }

  function reminderStatus(reminder) {
    return reminder && reminder.status === "pending"
      ? "awaiting_processing"
      : String(reminder && reminder.status || "");
  }

  function reminderStatusLabel(status) {
    if (status === "processing") {
      return "正在处理";
    }
    if (status === "completed" || status === "resolved") {
      return "已完成";
    }
    return "未操作";
  }

  function activeGroupReminderForKey(key) {
    const reminders = groupRemindersForKey(key);
    const processing = reminders.find((reminder) => reminderStatus(reminder) === "processing");
    if (processing) {
      return processing;
    }
    return reminders
      .filter((reminder) => reminderStatus(reminder) === "awaiting_processing")
      .sort((left, right) => timeMs(right.sentAt) - timeMs(left.sentAt))[0] || null;
  }

  function nextGroupReminderAt(pushConfig = normalizePushConfig(monitorConfig)) {
    const remindMs = pushConfig.groupCard.remindMinutes * 60 * 1000;
    let earliestMs = 0;
    for (const reminder of Object.values(state.groupReminders)) {
      if (!reminder || reminderStatus(reminder) !== "awaiting_processing") {
        continue;
      }
      if (reminder.chatId !== state.groupBinding.chatId) {
        continue;
      }
      const candidateMs = Math.max(
        timeMs(reminder.nextRemindAt),
        timeMs(reminder.sentAt) + remindMs
      );
      if (candidateMs > 0 && (!earliestMs || candidateMs < earliestMs)) {
        earliestMs = candidateMs;
      }
    }
    return earliestMs ? new Date(earliestMs).toISOString() : "";
  }

  function cleanupGroupState(nowMs) {
    for (const [key, record] of Object.entries(state.groupSent)) {
      const sentAt = timeMs(record && record.sentAt);
      if (!sentAt || nowMs - sentAt > GROUP_REMINDER_RETENTION_MS) {
        delete state.groupSent[key];
      }
    }
    for (const [taskId, reminder] of Object.entries(state.groupReminders)) {
      const updatedAt = timeMs(reminder && (reminder.completedAt || reminder.sentAt));
      if (!updatedAt || nowMs - updatedAt > GROUP_REMINDER_RETENTION_MS) {
        delete state.groupReminders[taskId];
      }
    }
  }

  function groupCardCandidates(pushResult, nowMs, cooldownMs, remindMs) {
    const responsibilityTargets = pushResult
      && pushResult.push
      && Array.isArray(pushResult.push.responsibilityTargets)
      ? pushResult.push.responsibilityTargets
      : [];
    const candidates = [];
    for (const target of responsibilityTargets) {
      for (const item of target.items || []) {
        const key = itemKey(target.ownerName || "", item);
        const lastSentAt = timeMs(state.groupSent[key] && state.groupSent[key].sentAt);
        const activeReminder = activeGroupReminderForKey(key);
        if (activeReminder) {
          if (reminderStatus(activeReminder) === "processing") {
            continue;
          }
          const nextRemindAt = Math.max(
            timeMs(activeReminder.nextRemindAt),
            timeMs(activeReminder.sentAt) + remindMs
          );
          if (nextRemindAt > nowMs) {
            continue;
          }
          candidates.push({
            key,
            target,
            item,
            previousReminder: activeReminder,
            isRepeat: true
          });
          continue;
        }
        if (lastSentAt && nowMs - lastSentAt < cooldownMs) {
          continue;
        }
        candidates.push({
          key,
          target,
          item
        });
      }
    }
    return candidates;
  }

  function reconcileGroupReminders(pushResult, resolvedAt) {
    if (!pushResult || pushResult.ok === false) {
      return 0;
    }
    const responsibilityTargets = pushResult
      && pushResult.push
      && Array.isArray(pushResult.push.responsibilityTargets)
      ? pushResult.push.responsibilityTargets
      : [];
    const activeKeys = new Set();
    for (const target of responsibilityTargets) {
      for (const item of target.items || []) {
        activeKeys.add(itemKey(target.ownerName || "", item));
      }
    }
    const resolvedKeys = new Set();
    for (const reminder of Object.values(state.groupReminders)) {
      if (!reminder || reminder.chatId !== state.groupBinding.chatId) {
        continue;
      }
      if (!["awaiting_processing", "processing"].includes(reminderStatus(reminder))) {
        continue;
      }
      if (activeKeys.has(reminder.key)) {
        continue;
      }
      reminder.status = "resolved";
      reminder.missingFields = [];
      reminder.resolvedAt = resolvedAt;
      reminder.resolvedReason = "required_fields_filled";
      reminder.nextRemindAt = "";
      delete state.groupSent[reminder.key];
      resolvedKeys.add(reminder.key);
    }
    if (resolvedKeys.size > 0 && logger && typeof logger.info === "function") {
      logger.info("Dev progress required field group reminders resolved from source", {
        resolvedCount: resolvedKeys.size,
        resolvedAt,
        reason: "required_fields_filled"
      });
    }
    return resolvedKeys.size;
  }

  function pilotRemindersForKey(key) {
    return Object.values(state.pilotReminders).filter((reminder) => reminder && reminder.key === key);
  }

  function pilotRemindersForTaskIdentity(taskIdentity) {
    const identity = String(taskIdentity || "").trim();
    if (!identity) {
      return [];
    }
    return Object.values(state.pilotReminders).filter((reminder) => (
      reminder && taskIdentityFromReminder(reminder) === identity
    ));
  }

  function pilotRemindersForTask(reminder) {
    const byTask = pilotRemindersForTaskIdentity(taskIdentityFromReminder(reminder));
    return byTask.length > 0 ? byTask : pilotRemindersForKey(reminder && reminder.key);
  }

  function logicalPilotReminderFromList(reminders, fallback) {
    const list = Array.isArray(reminders) ? reminders.filter(Boolean) : [];
    return list.find((item) => item.status === "processing")
      || list
        .filter((item) => item.status === "awaiting_processing")
        .sort((left, right) => timeMs(right.sentAt) - timeMs(left.sentAt))[0]
      || list.find((item) => item.status === "completed")
      || list.find((item) => item.status === "resolved")
      || list
        .filter((item) => item.status === "superseded")
        .sort((left, right) => timeMs(right.sentAt) - timeMs(left.sentAt))[0]
      || fallback;
  }

  function pilotReminderCounts() {
    const counts = {
      awaitingProcessingCount: 0,
      processingCount: 0,
      completedCount: 0
    };
    const groups = new Map();
    for (const reminder of Object.values(state.pilotReminders)) {
      if (!reminder) {
        continue;
      }
      const identity = taskIdentityFromReminder(reminder) || String(reminder.key || "").trim();
      if (!identity) {
        continue;
      }
      if (!groups.has(identity)) {
        groups.set(identity, []);
      }
      groups.get(identity).push(reminder);
    }
    for (const reminders of groups.values()) {
      const logical = logicalPilotReminderFromList(reminders, reminders[0]);
      if (logical.status === "awaiting_processing") {
        counts.awaitingProcessingCount += 1;
      } else if (logical.status === "processing") {
        counts.processingCount += 1;
      } else if (logical.status === "completed" || logical.status === "resolved") {
        counts.completedCount += 1;
      }
    }
    return counts;
  }

  function activePilotReminderForKey(key) {
    const reminders = pilotRemindersForKey(key);
    const processing = reminders.find((reminder) => reminder.status === "processing");
    if (processing) {
      return processing;
    }
    return reminders
      .filter((reminder) => reminder.status === "awaiting_processing")
      .sort((left, right) => timeMs(right.sentAt) - timeMs(left.sentAt))[0] || null;
  }

  function activePilotReminderForItem(item, key) {
    const taskReminders = pilotRemindersForTaskIdentity(taskIdentityFromItem(item));
    if (taskReminders.length === 0) {
      return activePilotReminderForKey(key);
    }
    const logical = logicalPilotReminderFromList(taskReminders, taskReminders[0]);
    return logical && ["awaiting_processing", "processing"].includes(logical.status)
      ? logical
      : null;
  }

  function pilotTargets(pushResult) {
    const push = pushResult && pushResult.push ? pushResult.push : {};
    const responsibilityTargets = Array.isArray(push.responsibilityTargets)
      ? push.responsibilityTargets
      : [];
    const pushConfig = normalizePushConfig(monitorConfig);
    const pilotTargetName = pushConfig.pilot.enabled
      ? String(pushConfig.pilot.targetName || "").trim()
      : "";
    if (pilotTargetName) {
      if (pushConfig.pilot.focusDemandIds.length > 0 && push.targetOverride && Array.isArray(push.targets)) {
        return push.targets.filter((target) => (
          String(target && target.ownerName || "").trim() === pilotTargetName
        ));
      }
      const matchedResponsibilityTargets = responsibilityTargets.filter((target) => (
        String(target && target.ownerName || "").trim() === pilotTargetName
      ));
      if (matchedResponsibilityTargets.length > 0) {
        return matchedResponsibilityTargets;
      }
      if (push.targetOverride && Array.isArray(push.targets)) {
        return push.targets.filter((target) => (
          String(target && target.ownerName || "").trim() === pilotTargetName
        ));
      }
      return [];
    }
    if (push.targetOverride && Array.isArray(push.targets)) {
      return push.targets;
    }
    return responsibilityTargets;
  }

  function focusedPilotTargets(pushResult) {
    const targets = pilotTargets(pushResult);
    const focusDemandIds = normalizePushConfig(monitorConfig).pilot.focusDemandIds;
    if (focusDemandIds.length === 0) {
      return targets;
    }
    const priority = new Map(focusDemandIds.map((demandId, index) => [demandId, index]));
    return targets.map((target) => {
      const itemsByDemandId = new Map();
      for (const item of target.items || []) {
        const demandId = normalizeDemandId(item && item.task && item.task.demandId);
        if (!priority.has(demandId)) {
          continue;
        }
        const existing = itemsByDemandId.get(demandId);
        if (!existing) {
          itemsByDemandId.set(demandId, {
            ...item,
            missingFields: [...new Set(item.missingFields || [])]
          });
          continue;
        }
        existing.missingFields = [...new Set([
          ...(existing.missingFields || []),
          ...(item.missingFields || [])
        ])];
      }
      return {
        ...target,
        items: [...itemsByDemandId.values()].sort((left, right) => (
          priority.get(normalizeDemandId(left && left.task && left.task.demandId))
          - priority.get(normalizeDemandId(right && right.task && right.task.demandId))
        ))
      };
    }).filter((target) => target.items.length > 0);
  }

  function pilotCandidates(pushResult, nowMs, remindMs, maxActiveTasks) {
    const targets = focusedPilotTargets(pushResult);
    const candidates = [];
    // A reminder only occupies a delivery slot until the owner responds.
    // Processing tasks keep their state but must not block the next task.
    const awaitingTaskCount = pilotReminderCounts().awaitingProcessingCount;
    const availableNewSlots = Math.max(0, maxActiveTasks - awaitingTaskCount);
    let newCandidateCount = 0;
    for (const target of targets) {
      for (const item of target.items || []) {
        const key = itemKey(target.ownerName || "", item);
        const active = activePilotReminderForItem(item, key);
        if (active && active.status === "processing") {
          continue;
        }
        if (active) {
          const nextAt = Math.max(
            timeMs(active.nextRemindAt),
            timeMs(active.sentAt) + remindMs
          );
          if (nextAt > nowMs) {
            continue;
          }
        }
        if (!active) {
          if (newCandidateCount >= availableNewSlots) {
            continue;
          }
          newCandidateCount += 1;
        }
        candidates.push({
          key,
          target,
          item,
          previousReminder: active,
          isRepeat: Boolean(active)
        });
      }
    }
    if (logger && typeof logger.info === "function") {
      logger.info("Dev progress pilot candidate selection", {
        targetNames: targets.map((target) => target.ownerName || ""),
        focusedDemandIds: targets.flatMap((target) => (
          (target.items || []).map((item) => item && item.task ? item.task.demandId || "" : "")
        )),
        awaitingTaskCount,
        availableNewSlots,
        selectedDemandIds: candidates.slice(0, maxActiveTasks).map((candidate) => (
          candidate.item && candidate.item.task ? candidate.item.task.demandId || "" : ""
        ))
      });
    }
    return candidates.slice(0, maxActiveTasks);
  }

  function reconcilePilotReminders(pushResult, resolvedAt) {
    if (!pushResult || pushResult.ok === false) {
      return 0;
    }
    const targets = focusedPilotTargets(pushResult);
    const activeKeys = new Set();
    for (const target of targets) {
      for (const item of target.items || []) {
        activeKeys.add(itemKey(target.ownerName || "", item));
      }
    }
    const resolvedKeys = new Set();
    for (const reminder of Object.values(state.pilotReminders)) {
      if (!reminder || !["awaiting_processing", "processing"].includes(reminder.status)) {
        continue;
      }
      if (activeKeys.has(reminder.key)) {
        continue;
      }
      reminder.status = "resolved";
      reminder.missingFields = [];
      reminder.resolvedAt = resolvedAt;
      reminder.resolvedReason = "required_fields_filled";
      reminder.nextRemindAt = "";
      delete state.pilotSent[reminder.key];
      resolvedKeys.add(reminder.key);
    }
    if (resolvedKeys.size > 0 && logger && typeof logger.info === "function") {
      logger.info("Dev progress pilot reminders resolved from source", {
        resolvedCount: resolvedKeys.size,
        resolvedAt,
        reason: "required_fields_filled"
      });
    }
    return resolvedKeys.size;
  }

  function pilotFeedbackLink(reminder, token) {
    if (!appFeedbackUrl) {
      return "";
    }
    const url = new URL(appFeedbackUrl);
    url.searchParams.set("reminderId", reminder.id);
    url.searchParams.set("token", token);
    return url.toString();
  }

  function pilotSummaryLink() {
    if (!appFeedbackUrl) {
      return "";
    }
    try {
      return new URL("/dev-required-summary.html", appFeedbackUrl).toString();
    } catch (_) {
      return "";
    }
  }

  function pilotSummaryStatus(issueCount, awaitingCount, processingCount) {
    if (processingCount > 0) {
      return "正在处理";
    }
    if (awaitingCount > 0 || issueCount > 0) {
      return "未操作";
    }
    return "已完成";
  }

  async function flushPilotGroupMention(nowMs = Date.now()) {
    const pending = state.pilotGroupMention;
    if (!pending || pending.status !== "pending") {
      return { sent: false, reason: "none" };
    }
    const dueAtMs = timeMs(pending.nextAttemptAt || pending.dueAt);
    if (dueAtMs > nowMs) {
      return {
        sent: false,
        reason: "waiting",
        nextAttemptAt: new Date(dueAtMs).toISOString()
      };
    }
    if (!robotServer || typeof robotServer.sendMarkdownMessage !== "function") {
      pending.attemptCount = Number(pending.attemptCount || 0) + 1;
      pending.lastError = "企业微信机器人不支持群 Markdown 消息";
      pending.nextAttemptAt = new Date(nowMs + DEFAULT_GROUP_RETRY_MS).toISOString();
      save();
      return { sent: false, reason: "unsupported", nextAttemptAt: pending.nextAttemptAt };
    }
    try {
      const ack = await robotServer.sendMarkdownMessage(pending.chatId, pending.content);
      const errcode = Number(ack && ack.errcode || 0);
      if (errcode !== 0) {
        const error = new Error(String(ack && ack.errmsg || "企业微信返回未知错误"));
        error.errcode = errcode;
        throw error;
      }
      pending.status = "sent";
      pending.sentAt = new Date(nowMs).toISOString();
      pending.lastError = "";
      pending.errcode = 0;
      save();
      if (logger && typeof logger.info === "function") {
        logger.info("Dev progress pilot group mention sent", {
          summarySentAt: pending.summarySentAt,
          mentionUserIds: pending.userIds || [],
          attemptCount: Number(pending.attemptCount || 0) + 1,
          sentAt: pending.sentAt,
          channel: "wecom-smart-bot-group-markdown"
        });
      }
      return { sent: true, sentAt: pending.sentAt };
    } catch (error) {
      const info = errorInfo(error, "需求必填字段群内责任人提醒失败");
      pending.attemptCount = Number(pending.attemptCount || 0) + 1;
      pending.lastError = info.message;
      pending.errcode = Number(info.errcode !== undefined ? info.errcode : info.code || 0);
      pending.nextAttemptAt = new Date(nowMs + DEFAULT_GROUP_RETRY_MS).toISOString();
      save();
      if (logger && typeof logger.warn === "function") {
        logger.warn("Dev progress pilot group mention failed", {
          summarySentAt: pending.summarySentAt,
          mentionUserIds: pending.userIds || [],
          attemptCount: pending.attemptCount,
          errcode: pending.errcode,
          message: pending.lastError,
          retryAt: pending.nextAttemptAt
        });
      }
      return { sent: false, reason: "failed", nextAttemptAt: pending.nextAttemptAt };
    }
  }

  async function sendPilotReminder(candidate, sentAt, pushConfig) {
    if (!appNotifier || typeof appNotifier.send !== "function") {
      throw new Error("需求进度管理自建应用发送器未就绪");
    }
    const target = candidate.target || {};
    const item = candidate.item || {};
    const task = item.task || {};
    const token = crypto.randomBytes(24).toString("hex");
    const pilotRemindMs = effectivePilotReminderMs(pushConfig);
    const reminder = {
      id: pilotReminderId(candidate.key),
      key: candidate.key,
      ownerName: target.ownerName || "",
      originalOwnerName: item.originalOwnerName || "",
      assigneeUserId: target.targetId || "",
      missingFields: Array.isArray(item.missingFields) ? item.missingFields : [],
      statusLabel: item.status || task.status || "",
      status: "awaiting_processing",
      sentAt,
      nextRemindAt: new Date(
        timeMs(sentAt) + pilotRemindMs
      ).toISOString(),
      repeatCount: candidate.previousReminder
        ? Number(candidate.previousReminder.repeatCount || 0) + 1
        : 0,
      previousReminderId: candidate.previousReminder ? candidate.previousReminder.id : "",
      tokenHash: tokenHash(token),
      taskIdentity: taskIdentityFromTask(task),
      task: {
        recordId: task.recordId || "",
        demandId: task.demandId || "",
        demand: task.demand || "",
        project: task.project || "",
        status: task.status || "",
        links: {
          demandLink: task.links && task.links.demandLink ? task.links.demandLink : ""
        }
      }
    };
    const feedbackLink = pilotFeedbackLink(reminder, token);
    if (!feedbackLink) {
      throw new Error("需求必填字段试运行反馈地址未配置");
    }
    const queueCountsBeforeSend = pilotReminderCounts();
    const result = await appNotifier.send({
      messageType: "textcard",
      toUser: reminder.assigneeUserId,
      purpose: "dev_progress_required_fields_pilot",
      title: candidate.isRepeat ? "需求必填字段待响应提醒" : "需求必填字段待处理",
      description: [
        `需求：${reminder.task.demand || "-"}`,
        `缺失字段：${reminder.missingFields.join("、") || "-"}`,
        candidate.isRepeat ? `提醒次数：${reminder.repeatCount + 1}` : "请先点击进入并确认正在处理"
      ].join("\n"),
      url: feedbackLink,
      buttonText: "处理需求"
    });
    if (!result || !result.ok) {
      throw new Error(result && result.reason ? result.reason : "需求进度管理自建应用发送失败");
    }
    if (candidate.previousReminder) {
      for (const previous of pilotRemindersForKey(candidate.key)) {
        if (previous.status === "awaiting_processing") {
          previous.status = "superseded";
          previous.supersededAt = sentAt;
          previous.supersededByReminderId = reminder.id;
        }
      }
    }
    state.pilotReminders[reminder.id] = reminder;
    state.pilotSent[reminder.key] = {
      reminderId: reminder.id,
      sentAt,
      nextRemindAt: reminder.nextRemindAt
    };
    save();
    if (logger && typeof logger.info === "function") {
      logger.info("Dev progress pilot app reminder sent", {
        reminderId: reminder.id,
        ownerName: reminder.ownerName,
        assigneeConfigured: Boolean(reminder.assigneeUserId),
        demandId: reminder.task.demandId,
        recordId: reminder.task.recordId,
        missingFields: reminder.missingFields,
        isRepeat: Boolean(candidate.isRepeat),
        repeatCount: reminder.repeatCount,
        nextRemindAt: reminder.nextRemindAt,
        queuePolicy: "awaiting_only",
        maxAwaitingTasks: pushConfig.pilot.maxActiveTasks,
        awaitingBeforeSend: queueCountsBeforeSend.awaitingProcessingCount,
        processingBeforeSend: queueCountsBeforeSend.processingCount,
        channel: "wecom-app"
      });
    }
    return reminder;
  }

  function nextPilotReminderAt(pushConfig = normalizePushConfig(monitorConfig)) {
    const remindMs = effectivePilotReminderMs(pushConfig);
    let earliestMs = 0;
    for (const reminder of Object.values(state.pilotReminders)) {
      if (!reminder || reminder.status !== "awaiting_processing") {
        continue;
      }
      const candidateMs = Math.max(
        timeMs(reminder.nextRemindAt),
        timeMs(reminder.sentAt) + remindMs
      );
      if (candidateMs > 0 && (!earliestMs || candidateMs < earliestMs)) {
        earliestMs = candidateMs;
      }
    }
    return earliestMs ? new Date(earliestMs).toISOString() : "";
  }

  async function sendPilotGroupSummary(pushResult, pushConfig, sentAt) {
    if (!groupBindingEnabled(pushConfig)) {
      return { sent: false, reason: "group_unbound" };
    }
    const targets = pilotTargets(pushResult);
    const items = targets.flatMap((target) => target.items || []);
    const taskCount = devProgressModule && typeof devProgressModule.countRequiredFieldPushTasks === "function"
      ? devProgressModule.countRequiredFieldPushTasks(items)
      : items.length;
    const reminderCounts = pilotReminderCounts();
    const awaitingCount = reminderCounts.awaitingProcessingCount;
    const processingCount = reminderCounts.processingCount;
    const activeCount = awaitingCount + processingCount;
    const statusText = pilotSummaryStatus(taskCount, awaitingCount, processingCount);
    const summaryLink = pilotSummaryLink();
    if (!summaryLink) {
      throw new Error("需求必填字段试运行群汇总缺少 EA 需求页面地址");
    }
    const signature = crypto.createHash("sha1").update(JSON.stringify({
      keys: items.map((item) => itemKey(pushConfig.pilot.targetName, item)).sort(),
      awaitingCount,
      processingCount,
      statusText,
      cardLayoutVersion: 6
    })).digest("hex");
    const lastSentAt = timeMs(state.pilotGroupSummary.sentAt);
    const summaryMs = pushConfig.pilot.summaryMinutes * 60 * 1000;
    if (lastSentAt && Date.now() - lastSentAt < summaryMs) {
      const nextSummaryAt = new Date(lastSentAt + summaryMs).toISOString();
      state.pilotGroupSummary = {
        ...state.pilotGroupSummary,
        signature,
        issueCount: items.length,
        taskCount,
        awaitingCount,
        processingCount,
        activeCount,
        statusText,
        cardLayoutVersion: 6,
        frequencyMinutes: pushConfig.pilot.summaryMinutes,
        refreshedAt: sentAt,
        nextSummaryAt
      };
      save();
      return {
        sent: false,
        reason: "daily_limit",
        nextSummaryAt
      };
    }
    if (items.length === 0 && !state.pilotGroupSummary.signature) {
      return { sent: false, reason: "no_issue" };
    }
    const card = {
      card_type: "text_notice",
      source: {
        desc: `EA需求监控 · ${statusText}`,
        desc_color: items.length > 0 ? 2 : 1
      },
      main_title: {
        title: "需求必填字段试运行汇总",
        desc: `${pushConfig.pilot.targetName}：当前试运行 ${activeCount} 条`
      },
      horizontal_content_list: [
        { keyname: "全部待核查", value: String(taskCount) },
        { keyname: "待响应", value: String(awaitingCount) },
        { keyname: "处理中", value: String(processingCount) },
        { keyname: "更新时间", value: chinaDateTime(sentAt) }
      ],
      card_action: {
        type: 1,
        url: summaryLink
      },
      task_id: `ea_dev_pilot_summary_${Date.now().toString(36)}`
    };
    const ack = await robotServer.sendTemplateCardMessage(state.groupBinding.chatId, card);
    if (ack && ack.errcode) {
      const error = new Error(`需求必填字段试运行群汇总发送失败：${ack.errcode} ${ack.errmsg || ""}`.trim());
      error.errcode = ack.errcode;
      throw error;
    }
    const mentionTargets = targets
      .map((target) => ({
        ownerName: String(target.ownerName || "").trim(),
        userId: String(target.targetId || "").trim()
      }))
      .filter((target, index, list) =>
        target.userId
        && list.findIndex((item) => item.userId === target.userId) === index
      );
    let mentionScheduled = false;
    let mentionError = "";
    if (mentionTargets.length > 0) {
      const mentionText = mentionTargets.map((target) => `<@${target.userId}>`).join(" ");
      const responsibleNames = mentionTargets.map((target) => target.ownerName || target.userId).join("、");
      const mentionContent = [
        mentionText,
        "**需求必填字段提醒**",
        `> 责任人：${responsibleNames}`,
        `> 当前状态：${statusText}`,
        `> 待核查：${taskCount} 条`,
        `[查看需求详情](${summaryLink})`
      ].join("\n");
      const mentionDueAt = new Date(
        timeMs(sentAt) + pushConfig.pilot.mentionDelaySeconds * 1000
      ).toISOString();
      state.pilotGroupMention = {
        status: "pending",
        chatId: state.groupBinding.chatId,
        content: mentionContent,
        userIds: mentionTargets.map((target) => target.userId),
        ownerNames: mentionTargets.map((target) => target.ownerName || target.userId),
        summarySentAt: sentAt,
        dueAt: mentionDueAt,
        nextAttemptAt: mentionDueAt,
        attemptCount: 0,
        lastError: ""
      };
      mentionScheduled = true;
    } else {
      mentionError = "未解析到责任人的企业微信账号";
    }
    if (!mentionScheduled && logger && typeof logger.warn === "function") {
      logger.warn("Dev progress pilot group mention failed", {
        targetName: pushConfig.pilot.targetName,
        mentionUserIds: mentionTargets.map((target) => target.userId),
        mentionError,
        chatConfigured: Boolean(state.groupBinding.chatId),
        cardSent: true,
        nextMentionWithSummaryAt: new Date(timeMs(sentAt) + summaryMs).toISOString()
      });
    }
    state.pilotGroupSummary = {
      signature,
      sentAt,
      issueCount: items.length,
      taskCount,
      awaitingCount,
      processingCount,
      activeCount,
      statusText,
      cardLayoutVersion: 6,
      statusPlacement: "source_desc",
      frequencyMinutes: pushConfig.pilot.summaryMinutes,
      nextSummaryAt: new Date(timeMs(sentAt) + summaryMs).toISOString(),
      mentionScheduled,
      mentionDueAt: mentionScheduled ? state.pilotGroupMention.dueAt : "",
      mentionUserIds: mentionTargets.map((target) => target.userId),
      mentionError,
      actionUrl: summaryLink
    };
    save();
    if (logger && typeof logger.info === "function") {
      logger.info("Dev progress pilot group summary sent", {
        targetName: pushConfig.pilot.targetName,
        issueCount: items.length,
        taskCount,
        awaitingCount,
        processingCount,
        activeCount,
        statusText,
        cardLayoutVersion: 6,
        statusPlacement: "source_desc",
        sourceDescription: card.source.desc,
        frequencyMinutes: pushConfig.pilot.summaryMinutes,
        mentionScheduled,
        mentionDueAt: mentionScheduled ? state.pilotGroupMention.dueAt : "",
        mentionUserIds: mentionTargets.map((target) => target.userId),
        mentionError,
        actionTarget: "ea_required_summary",
        actionUrl: summaryLink,
        groupConfigured: true,
        nextSummaryAfter: new Date(timeMs(sentAt) + summaryMs).toISOString()
      });
    }
    return { sent: true };
  }

  async function sendGroupReminder(candidate, sentAt) {
    if (!robotServer || typeof robotServer.sendTemplateCardMessage !== "function") {
      throw new Error("企业微信机器人还未提供群模板卡片发送能力");
    }
    const target = candidate.target || {};
    const item = candidate.item || {};
    const task = item.task || {};
    const pushConfig = normalizePushConfig(monitorConfig);
    const repeatCount = candidate.previousReminder
      ? Number(candidate.previousReminder.repeatCount || 0) + 1
      : 0;
    const reminder = {
      id: groupReminderTaskId(candidate.key),
      key: candidate.key,
      chatId: state.groupBinding.chatId,
      ownerName: target.ownerName || "",
      assigneeUserId: target.targetId || "",
      targetSource: target.targetSource || "",
      missingFields: Array.isArray(item.missingFields) ? item.missingFields : [],
      statusLabel: item.status || task.status || "",
      status: "awaiting_processing",
      sentAt,
      nextRemindAt: new Date(
        timeMs(sentAt) + pushConfig.groupCard.remindMinutes * 60 * 1000
      ).toISOString(),
      repeatCount,
      previousReminderId: candidate.previousReminder ? candidate.previousReminder.id : "",
      task: {
        recordId: task.recordId || "",
        demandId: task.demandId || "",
        demand: task.demand || "",
        project: task.project || "",
        status: task.status || "",
        links: {
          demandLink: task.links && task.links.demandLink ? task.links.demandLink : ""
        }
      }
    };
    const ack = await robotServer.sendTemplateCardMessage(reminder.chatId, groupReminderCard(reminder));
    if (ack && ack.errcode) {
      const error = new Error(`企业微信群卡片发送失败：${ack.errcode} ${ack.errmsg || ""}`.trim());
      error.errcode = ack.errcode;
      error.code = ack.errcode;
      error.errmsg = ack.errmsg || "";
      throw error;
    }
    if (candidate.previousReminder) {
      for (const previous of groupRemindersForKey(candidate.key)) {
        if (reminderStatus(previous) === "awaiting_processing") {
          previous.status = "superseded";
          previous.supersededAt = sentAt;
          previous.supersededByReminderId = reminder.id;
        }
      }
    }
    state.groupReminders[reminder.id] = reminder;
    state.groupSent[candidate.key] = {
      sentAt,
      reminderId: reminder.id,
      ownerName: reminder.ownerName,
      assigneeUserId: reminder.assigneeUserId,
      chatId: reminder.chatId
    };
    save();
    if (logger && typeof logger.info === "function") {
      logger.info("Dev progress required field group card sent", {
        reminderId: reminder.id,
        ownerName: reminder.ownerName,
        targetConfigured: Boolean(reminder.chatId),
        assigneeConfigured: Boolean(reminder.assigneeUserId),
        demandId: reminder.task.demandId,
        recordId: reminder.task.recordId,
        missingFields: reminder.missingFields,
        isRepeat: Boolean(candidate.isRepeat),
        repeatCount: reminder.repeatCount,
        previousReminderId: reminder.previousReminderId,
        nextRemindAt: reminder.nextRemindAt,
        errcode: ack && ack.errcode
      });
    }
    return reminder;
  }

  async function evaluateChangeDetection(startedAt, nowMs) {
    const config = normalizeChangeDetectionConfig(monitorConfig);
    if (!config.enabled) {
      return {
        enabled: false,
        shouldScan: true,
        reason: "change_detection_disabled",
        quietMinutes: config.quietMinutes,
        minScanIntervalMinutes: config.minScanIntervalMinutes
      };
    }
    if (!devProgressModule || typeof devProgressModule.getDocumentChangeSignal !== "function") {
      return {
        enabled: true,
        shouldScan: true,
        reason: "change_signal_unavailable",
        quietMinutes: config.quietMinutes,
        minScanIntervalMinutes: config.minScanIntervalMinutes
      };
    }

    const detectionState = state.changeDetection;
    detectionState.lastCheckAt = startedAt;
    detectionState.quietMinutes = config.quietMinutes;
    detectionState.minScanIntervalMinutes = config.minScanIntervalMinutes;

    const signalResult = await devProgressModule.getDocumentChangeSignal();
    if (!signalResult || !signalResult.ok || !signalResult.signal) {
      detectionState.lastErrorAt = startedAt;
      detectionState.lastError = signalResult && signalResult.message
        ? signalResult.message
        : "无法读取需求总表文档修改信号";
      if (config.scanOnSignalError) {
        return {
          enabled: true,
          shouldScan: true,
          reason: "change_signal_error_scan_fallback",
          quietMinutes: config.quietMinutes,
          minScanIntervalMinutes: config.minScanIntervalMinutes,
          error: detectionState.lastError
        };
      }
      return {
        enabled: true,
        shouldScan: false,
        reason: "change_signal_error",
        quietMinutes: config.quietMinutes,
        minScanIntervalMinutes: config.minScanIntervalMinutes,
        error: detectionState.lastError
      };
    }

    const signal = String(signalResult.signal || "");
    detectionState.lastError = "";
    detectionState.lastSeenAt = startedAt;
    detectionState.lastSeenSignal = signal;
    detectionState.lastSeenModifyTime = signalResult.modifyTime || "";
    detectionState.lastSeenDocName = signalResult.docName || "";

    const forceScanAtMs = timeMs(detectionState.forceScanRequestedAt);
    if (forceScanAtMs && forceScanAtMs <= nowMs) {
      return {
        enabled: true,
        shouldScan: true,
        reason: "forced_required_field_verification",
        signal,
        modifyTime: signalResult.modifyTime || "",
        docName: signalResult.docName || "",
        quietMinutes: config.quietMinutes,
        minScanIntervalMinutes: config.minScanIntervalMinutes
      };
    }

    const coveredSignal = detectionState.lastCoveredSignal || "";
    if (!coveredSignal) {
      if (!config.scanOnFirstRun) {
        detectionState.lastCoveredSignal = signal;
        detectionState.lastCoveredModifyTime = signalResult.modifyTime || "";
        detectionState.baselineAt = startedAt;
        return {
          enabled: true,
          shouldScan: false,
          reason: "baseline_initialized",
          signal,
          modifyTime: signalResult.modifyTime || "",
          docName: signalResult.docName || "",
          quietMinutes: config.quietMinutes,
          minScanIntervalMinutes: config.minScanIntervalMinutes
        };
      }
      return {
        enabled: true,
        shouldScan: true,
        reason: "first_run_scan",
        signal,
        modifyTime: signalResult.modifyTime || "",
        docName: signalResult.docName || "",
        quietMinutes: config.quietMinutes,
        minScanIntervalMinutes: config.minScanIntervalMinutes
      };
    }

    if (signal === coveredSignal) {
      delete detectionState.pendingSignal;
      delete detectionState.pendingModifyTime;
      delete detectionState.pendingSince;
      delete detectionState.pendingLastSeenAt;
      return {
        enabled: true,
        shouldScan: false,
        reason: "unchanged",
        signal,
        modifyTime: signalResult.modifyTime || "",
        docName: signalResult.docName || "",
        quietMinutes: config.quietMinutes,
        minScanIntervalMinutes: config.minScanIntervalMinutes
      };
    }

    if (detectionState.pendingSignal !== signal) {
      detectionState.pendingSignal = signal;
      detectionState.pendingModifyTime = signalResult.modifyTime || "";
      detectionState.pendingSince = startedAt;
      detectionState.pendingLastSeenAt = startedAt;
      return {
        enabled: true,
        shouldScan: false,
        reason: "change_pending_quiet_window",
        signal,
        modifyTime: signalResult.modifyTime || "",
        docName: signalResult.docName || "",
        pendingSince: detectionState.pendingSince,
        quietMinutes: config.quietMinutes,
        minScanIntervalMinutes: config.minScanIntervalMinutes
      };
    }

    detectionState.pendingLastSeenAt = startedAt;
    const quietMs = config.quietMinutes * 60 * 1000;
    const pendingSinceMs = timeMs(detectionState.pendingSince);
    if (!pendingSinceMs || nowMs - pendingSinceMs < quietMs) {
      return {
        enabled: true,
        shouldScan: false,
        reason: "change_waiting_quiet_window",
        signal,
        modifyTime: signalResult.modifyTime || "",
        docName: signalResult.docName || "",
        pendingSince: detectionState.pendingSince || "",
        quietMinutes: config.quietMinutes,
        minScanIntervalMinutes: config.minScanIntervalMinutes
      };
    }

    const minScanMs = config.minScanIntervalMinutes * 60 * 1000;
    const lastFullScanMs = timeMs(detectionState.lastFullScanAt);
    if (lastFullScanMs && nowMs - lastFullScanMs < minScanMs) {
      return {
        enabled: true,
        shouldScan: false,
        reason: "min_full_scan_interval",
        signal,
        modifyTime: signalResult.modifyTime || "",
        docName: signalResult.docName || "",
        pendingSince: detectionState.pendingSince || "",
        quietMinutes: config.quietMinutes,
        minScanIntervalMinutes: config.minScanIntervalMinutes
      };
    }

    return {
      enabled: true,
      shouldScan: true,
      reason: "change_detected_quiet_elapsed",
      signal,
      modifyTime: signalResult.modifyTime || "",
      docName: signalResult.docName || "",
      pendingSince: detectionState.pendingSince || "",
      quietMinutes: config.quietMinutes,
      minScanIntervalMinutes: config.minScanIntervalMinutes
    };
  }

  function markChangeDetectionScanned(decision, finishedAt) {
    if (!decision || !decision.enabled || !decision.signal) {
      return;
    }
    const detectionState = state.changeDetection;
    detectionState.lastCoveredSignal = decision.signal;
    detectionState.lastCoveredModifyTime = decision.modifyTime || "";
    detectionState.lastFullScanAt = finishedAt;
    delete detectionState.forceScanRequestedAt;
    delete detectionState.pendingSignal;
    delete detectionState.pendingModifyTime;
    delete detectionState.pendingSince;
    delete detectionState.pendingLastSeenAt;
  }

  function skippedRun(startedAt, reason, changeDecision) {
    state.lastRun = {
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: true,
      skipped: true,
      reason,
      changeDetection: compactChangeDecision(changeDecision)
    };
    save();
    if (logger && typeof logger.info === "function") {
      logger.info("Dev progress monitor tick skipped", {
        reason,
        changeDetection: compactChangeDecision(changeDecision)
      });
    }
    return state.lastRun;
  }

  function filterPendingItems(target, nowMs, cooldownMs) {
    const ownerName = target.ownerName || "";
    const items = Array.isArray(target.items) ? target.items : [];
    const pending = [];
    for (const item of items) {
      const key = itemKey(ownerName, item);
      if (!sentRecently(key, nowMs, cooldownMs)) {
        pending.push({
          key,
          item
        });
      }
    }
    return pending;
  }

  async function sendTarget(target, pendingItems, sentAt) {
    if (!robotServer || typeof robotServer.sendMarkdownMessage !== "function") {
      throw new Error("企业微信机器人还未就绪，不能自动推送开发进度必填项提醒");
    }
    if (!devProgressModule || typeof devProgressModule.formatRequiredFieldPushMessage !== "function") {
      throw new Error("开发进度模块还未提供必填项提醒文案生成能力");
    }

    const items = pendingItems.map((entry) => entry.item);
    const taskCount = typeof devProgressModule.countRequiredFieldPushTasks === "function"
      ? devProgressModule.countRequiredFieldPushTasks(items)
      : items.length;
    let deliveryType = "markdown";
    let file = null;
    let ack = null;
    let fileResult = null;

    if (taskCount <= INLINE_TASK_LIMIT) {
      const message = devProgressModule.formatRequiredFieldPushMessage(target.ownerName, items);
      ack = await robotServer.sendMarkdownMessage(target.targetId, message);
      if (ack && ack.errcode) {
        throw new Error(`企业微信返回失败：${ack.errcode} ${ack.errmsg || ""}`.trim());
      }
    } else {
      if (typeof devProgressModule.exportRequiredFieldPushWorkbook !== "function") {
        throw new Error("开发进度模块还未提供必填项 Excel 导出能力");
      }
      if (typeof robotServer.sendFileMessage !== "function") {
        throw new Error("企业微信机器人还未提供文件发送能力");
      }
      deliveryType = "excel";
      file = devProgressModule.exportRequiredFieldPushWorkbook(target.ownerName, items);
      fileResult = await robotServer.sendFileMessage(target.targetId, file);
      if (fileResult && fileResult.ack && fileResult.ack.errcode) {
        throw new Error(`企业微信文件发送失败：${fileResult.ack.errcode} ${fileResult.ack.errmsg || ""}`.trim());
      }
    }

    for (const entry of pendingItems) {
      const task = entry.item && entry.item.task ? entry.item.task : {};
      state.sent[entry.key] = {
        sentAt,
        ownerName: target.ownerName || "",
        originalOwnerName: entry.item.originalOwnerName || "",
        targetSource: target.targetSource || "",
        targetOverride: Boolean(target.targetOverride),
        deliveryType,
        exportFilename: file ? file.filename : "",
        taskRecordId: task.recordId || "",
        demandId: task.demandId || "",
        missingFields: Array.isArray(entry.item.missingFields) ? entry.item.missingFields : []
      };
    }
    save();
    return {
      deliveryType,
      taskCount,
      filename: file ? file.filename : "",
      ack,
      file: fileResult
    };
  }

  async function tick() {
    const pushConfig = normalizePushConfig(monitorConfig);
    if (!monitorEnabled(pushConfig)) {
      return { ok: true, skipped: true, reason: "disabled" };
    }
    if (pushConfig.enabled && monitorConfig.enabled && pushConfig.testMode && !pushConfig.testTargetName) {
      return { ok: false, skipped: true, reason: "test_target_missing" };
    }
    if (pushConfig.enabled && !monitorConfig.notifyThroughCenter) {
      return { ok: true, skipped: true, reason: "notification_disabled" };
    }
    if (running) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Dev progress monitor tick skipped because previous tick is still running");
      }
      return { ok: true, skipped: true, reason: "running" };
    }

    running = true;
    const startedAt = new Date().toISOString();
    const nowMs = Date.now();
    const cooldownMs = pushConfig.cooldownMinutes * 60 * 1000;
    let changeDecision = null;
    let sentTargetCount = 0;
    let sentIssueCount = 0;
    let sentExcelCount = 0;
    let sentMarkdownCount = 0;
    let skippedCoolingCount = 0;
    let failedTargetCount = 0;
    let sentGroupCardCount = 0;
    let failedGroupCardCount = 0;
    let remainingGroupCardCount = 0;
    let groupRetryAt = "";
    let sentPilotAppCount = 0;
    let failedPilotAppCount = 0;
    let pilotRetryAt = "";
    const deliverySummaries = [];
    try {
      cleanupSent(nowMs, cooldownMs);
      cleanupGroupState(nowMs);
      if (pushConfig.enabled) {
        await flushPilotGroupMention(nowMs);
      }
      changeDecision = await evaluateChangeDetection(startedAt, nowMs);
      if (!changeDecision.shouldScan) {
        return skippedRun(startedAt, changeDecision.reason, changeDecision);
      }
      const personalTestMode = Boolean(monitorConfig.enabled && pushConfig.testMode);
      const effectiveTargetName = pushConfig.pilot.enabled
        ? pushConfig.pilot.targetName
        : (personalTestMode ? pushConfig.testTargetName : "");
      const result = await devProgressModule.prepareRequiredFieldPush({
        limit: pushConfig.scanLimit || undefined,
        focusDemandIds: pushConfig.pilot.focusDemandIds,
        targetOverride: effectiveTargetName
          ? {
            enabled: true,
            targetName: effectiveTargetName
          }
          : undefined
      });
      const targets = result && result.push && Array.isArray(result.push.targets) ? result.push.targets : [];
      const targetLimit = Math.max(1, Math.floor(pushConfig.maxTargetsPerTick));

      if (pushConfig.enabled && monitorConfig.enabled) {
        for (const target of targets) {
          if (sentTargetCount >= targetLimit) {
            break;
          }
          const pendingItems = filterPendingItems(target, nowMs, cooldownMs);
          if (pendingItems.length === 0) {
            skippedCoolingCount += Number(target.issueCount || 0);
            continue;
          }

          try {
            const delivery = await sendTarget(target, pendingItems, new Date().toISOString());
            sentTargetCount += 1;
            sentIssueCount += pendingItems.length;
            if (delivery && delivery.deliveryType === "excel") {
              sentExcelCount += 1;
            } else {
              sentMarkdownCount += 1;
            }
            deliverySummaries.push({
              ownerName: target.ownerName || "",
              deliveryType: delivery && delivery.deliveryType ? delivery.deliveryType : "markdown",
              filename: delivery && delivery.filename ? delivery.filename : "",
              issueCount: pendingItems.length,
              taskCount: delivery && delivery.taskCount ? delivery.taskCount : 0
            });
          } catch (error) {
            failedTargetCount += 1;
            const info = errorInfo(error, "开发进度必填项自动推送失败");
            if (logger && typeof logger.warn === "function") {
              logger.warn("Dev progress required field auto push failed", {
                ownerName: target.ownerName || "",
                errcode: info.errcode,
                errmsg: info.errmsg,
                message: info.message
              });
            }
          }
        }
      }

      if (pushConfig.pilot.enabled) {
        reconcilePilotReminders(result, new Date().toISOString());
        const currentPilotRetryAtMs = timeMs(state.pilotRetryAt);
        if (!currentPilotRetryAtMs || currentPilotRetryAtMs <= nowMs) {
          state.pilotRetryAt = "";
          const candidates = pilotCandidates(
            result,
            nowMs,
            effectivePilotReminderMs(pushConfig),
            pushConfig.pilot.maxActiveTasks
          );
          if (candidates.length > 0) {
            const selectedDemandIds = candidates.map((candidate) => (
              candidate.item && candidate.item.task ? candidate.item.task.demandId || "" : ""
            ));
            for (const candidate of candidates) {
              try {
                await sendPilotReminder(candidate, new Date().toISOString(), pushConfig);
                sentPilotAppCount += 1;
              } catch (error) {
                failedPilotAppCount += 1;
                const info = errorInfo(error, "需求必填字段试运行自建应用发送失败");
                pilotRetryAt = new Date(Date.now() + DEFAULT_GROUP_RETRY_MS).toISOString();
                state.pilotRetryAt = pilotRetryAt;
                if (logger && typeof logger.warn === "function") {
                  logger.warn("Dev progress pilot app reminder failed", {
                    targetName: pushConfig.pilot.targetName,
                    demandId: candidate.item && candidate.item.task ? candidate.item.task.demandId || "" : "",
                    errcode: info.errcode,
                    errmsg: info.errmsg,
                    message: info.message,
                    retryAt: pilotRetryAt
                  });
                }
                break;
              }
            }
            if (logger && typeof logger.info === "function") {
              logger.info("Dev progress pilot app reminder batch finished", {
                targetName: pushConfig.pilot.targetName,
                focusDemandIds: pushConfig.pilot.focusDemandIds,
                selectedDemandIds,
                selectedCount: candidates.length,
                sentCount: sentPilotAppCount,
                failedCount: failedPilotAppCount
              });
            }
          }
        } else {
          pilotRetryAt = state.pilotRetryAt;
        }
      }

      if (groupBindingEnabled(pushConfig)) {
        if (pushConfig.pilot.enabled) {
          try {
            await sendPilotGroupSummary(result, pushConfig, new Date().toISOString());
          } catch (error) {
            const info = errorInfo(error, "需求必填字段试运行群汇总发送失败");
            if (logger && typeof logger.warn === "function") {
              logger.warn("Dev progress pilot group summary failed", {
                targetName: pushConfig.pilot.targetName,
                errcode: info.errcode,
                errmsg: info.errmsg,
                message: info.message
              });
            }
          }
        } else {
          reconcileGroupReminders(result, new Date().toISOString());
        const currentGroupRetryAtMs = timeMs(state.groupRetryAt);
        if (!currentGroupRetryAtMs || currentGroupRetryAtMs <= nowMs) {
          state.groupRetryAt = "";
          const groupCandidates = groupCardCandidates(
            result,
            nowMs,
            cooldownMs,
            pushConfig.groupCard.remindMinutes * 60 * 1000
          );
          const groupLimit = Math.max(1, Math.floor(pushConfig.groupCard.maxCardsPerTick));
          for (const candidate of groupCandidates.slice(0, groupLimit)) {
            try {
              await sendGroupReminder(candidate, new Date().toISOString());
              sentGroupCardCount += 1;
              state.groupRetryAt = "";
            } catch (error) {
              failedGroupCardCount += 1;
              const info = errorInfo(error, "开发进度必填项群卡片发送失败");
              const failureCode = Number(info.errcode !== undefined ? info.errcode : info.code);
              const retryDelayMs = failureCode === 846607
                ? GROUP_FREQUENCY_LIMIT_RETRY_MS
                : DEFAULT_GROUP_RETRY_MS;
              groupRetryAt = new Date(Date.now() + retryDelayMs).toISOString();
              if (logger && typeof logger.warn === "function") {
                logger.warn("Dev progress required field group card failed", {
                  ownerName: candidate.target && candidate.target.ownerName ? candidate.target.ownerName : "",
                  demandId: candidate.item && candidate.item.task ? candidate.item.task.demandId || "" : "",
                  recordId: candidate.item && candidate.item.task ? candidate.item.task.recordId || "" : "",
                  errcode: info.errcode !== undefined ? info.errcode : info.code,
                  errmsg: info.errmsg,
                  retryAt: groupRetryAt,
                  message: info.message
                });
              }
              break;
            }
          }
          remainingGroupCardCount = Math.max(0, groupCandidates.length - sentGroupCardCount);
        } else {
          groupRetryAt = state.groupRetryAt;
        }
        }
      }

      const finishedAt = new Date().toISOString();
      markChangeDetectionScanned(changeDecision, finishedAt);
      const nextReminderAt = nextGroupReminderAt(pushConfig);
      const nextPilotAt = nextPilotReminderAt();
      const nextScanCandidates = [];
      if (groupRetryAt) {
        state.groupRetryAt = groupRetryAt;
        nextScanCandidates.push(groupRetryAt);
      }
      if (remainingGroupCardCount > 0) {
        nextScanCandidates.push(new Date(
          Date.now() + Math.max(1, Number(monitorConfig.intervalMinutes || 1)) * 60 * 1000
        ).toISOString());
      }
      if (nextReminderAt && timeMs(nextReminderAt) > Date.now()) {
        nextScanCandidates.push(nextReminderAt);
      } else if (nextReminderAt && !groupRetryAt) {
        nextScanCandidates.push(new Date(
          Date.now() + Math.max(1, Number(monitorConfig.intervalMinutes || 1)) * 60 * 1000
        ).toISOString());
      }
      if (pilotRetryAt) {
        nextScanCandidates.push(pilotRetryAt);
      } else if (nextPilotAt && timeMs(nextPilotAt) > Date.now()) {
        nextScanCandidates.push(nextPilotAt);
      } else if (nextPilotAt) {
        nextScanCandidates.push(new Date(
          Date.now() + Math.max(1, Number(monitorConfig.intervalMinutes || 1)) * 60 * 1000
        ).toISOString());
      }
      const nextForceScanAt = nextScanCandidates
        .filter(Boolean)
        .sort((left, right) => timeMs(left) - timeMs(right))[0] || "";
      if (nextForceScanAt) {
        state.changeDetection.forceScanRequestedAt = nextForceScanAt;
      }
      scheduleWakeTick(nextForceScanAt, "dev_progress_test_next_scan", { pushConfig });
      state.lastRun = {
        startedAt,
        finishedAt,
        ok: Boolean(result && result.ok),
        changeDetection: compactChangeDecision(changeDecision),
        scannedCount: result && result.scannedCount,
        anomalyCount: result && result.anomalyCount,
        issueCount: result && result.issueCount,
        requiredFieldRuleCount: result && result.rules ? result.rules.requiredFieldRuleCount : undefined,
        targetCount: result && result.push ? result.push.targetCount : 0,
        unresolvedCount: result && result.push ? result.push.unresolvedCount : 0,
        skippedNoOwnerCount: result && result.push ? result.push.skippedNoOwnerCount : 0,
        testMode: pushConfig.testMode,
        testTargetName: pushConfig.testMode ? pushConfig.testTargetName : "",
        formalMode: !pushConfig.testMode && !pushConfig.pilot.enabled,
        autoPushStatus: pushConfig.enabled ? "enabled" : "disabled_pending_recipient_scope",
        sentTargetCount,
        sentIssueCount,
        sentExcelCount,
        sentMarkdownCount,
        sentGroupCardCount,
        failedGroupCardCount,
        remainingGroupCardCount,
        groupRetryAt: state.groupRetryAt || "",
        nextGroupReminderAt: nextReminderAt,
        sentPilotAppCount,
        failedPilotAppCount,
        pilotRetryAt: state.pilotRetryAt || "",
        nextPilotReminderAt: nextPilotAt,
        deliverySummaries,
        skippedCoolingCount,
        failedTargetCount
      };
      save();

      if (logger && typeof logger.info === "function") {
        logger.info("Dev progress required field monitor tick finished", {
          sentTargetCount,
          sentIssueCount,
          sentExcelCount,
          sentMarkdownCount,
          sentGroupCardCount,
          failedGroupCardCount,
          remainingGroupCardCount,
          groupRetryAt: state.groupRetryAt || "",
          nextGroupReminderAt: nextReminderAt,
          sentPilotAppCount,
          failedPilotAppCount,
          pilotRetryAt: state.pilotRetryAt || "",
          nextPilotReminderAt: nextPilotAt,
          deliverySummaries,
          failedTargetCount,
          skippedCoolingCount,
          testMode: pushConfig.testMode,
          testTargetName: pushConfig.testMode ? pushConfig.testTargetName : "",
          formalMode: !pushConfig.testMode && !pushConfig.pilot.enabled,
          autoPushStatus: pushConfig.enabled ? "enabled" : "disabled_pending_recipient_scope"
        });
      }
      return state.lastRun;
    } catch (error) {
      const info = errorInfo(error, "开发进度必填项监控失败");
      state.lastRun = {
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: false,
        error: info.message,
        changeDetection: compactChangeDecision(changeDecision),
        sentTargetCount,
        sentIssueCount,
        sentExcelCount,
        sentMarkdownCount,
        sentGroupCardCount,
        failedGroupCardCount,
        failedTargetCount
      };
      save();
      if (logger && typeof logger.warn === "function") {
        logger.warn("Dev progress required field monitor tick failed", {
          errcode: info.errcode,
          errmsg: info.errmsg,
          message: info.message
        });
      }
      return state.lastRun;
    } finally {
      running = false;
    }
  }

  async function captureTextMessage(message = {}) {
    const compactMessageText = String(message.text || "").trim().replace(/\s+/g, "");
    const commandStart = compactMessageText.search(
      /(?:绑定|设置|取消绑定|解绑|查看|查询)?(?:需求|开发进度)(?:必填|字段)/
    );
    const text = compactMessageText.startsWith("@") && commandStart > 0
      ? compactMessageText.slice(commandStart)
      : compactMessageText;
    const sender = message.sender || {};
    const isGroup = String(sender.chatType || "").toLowerCase().includes("group") && sender.chatId;
    const bindRequested = /^(绑定|设置)(需求|开发进度)(必填|字段)(提醒群|群提醒)$/.test(text);
    const unbindRequested = /^(取消绑定|解绑)(需求|开发进度)(必填|字段)(提醒群|群提醒)$/.test(text);
    const statusRequested = /^(查看|查询)?(需求|开发进度)(必填|字段)(提醒群|群提醒)(状态)?$/.test(text);

    if (!bindRequested && !unbindRequested && !statusRequested) {
      return { handled: false };
    }

    if (bindRequested) {
      if (!isGroup) {
        return {
          handled: true,
          text: "请在需要接收提醒的企业微信群里发送：绑定需求必填提醒群"
        };
      }
      state.groupBinding = {
        enabled: true,
        chatId: sender.chatId,
        boundAt: new Date().toISOString(),
        boundByUserId: sender.userId || "",
        boundByName: sender.name || ""
      };
      state.changeDetection.forceScanRequestedAt = new Date().toISOString();
      save();
      start();
      const starter = setTimeout(() => {
        tick().catch((error) => {
          if (logger && typeof logger.error === "function") {
            logger.error("Dev progress required field group binding scan failed", {
              message: error.message
            });
          }
        });
      }, 2000);
      if (typeof starter.unref === "function") {
        starter.unref();
      }
      if (logger && typeof logger.info === "function") {
        logger.info("Dev progress required field reminder group bound", {
          groupConfigured: true,
          boundByConfigured: Boolean(sender.userId),
          boundByName: sender.name || ""
        });
      }
      return {
        handled: true,
        text: "已绑定当前群为“需求必填字段提醒群”。责任同事需先点击“正在处理”，未点击会继续提醒；补充完成后再点击“已完成”。"
      };
    }

    if (unbindRequested) {
      if (!isGroup || sender.chatId !== state.groupBinding.chatId) {
        return {
          handled: true,
          text: "当前群不是已绑定的需求必填字段提醒群。"
        };
      }
      state.groupBinding = {
        ...state.groupBinding,
        enabled: false,
        unboundAt: new Date().toISOString(),
        unboundByUserId: sender.userId || "",
        unboundByName: sender.name || ""
      };
      save();
      if (!monitorConfig.enabled) {
        stop();
      }
      if (logger && typeof logger.info === "function") {
        logger.info("Dev progress required field reminder group unbound", {
          groupConfigured: true,
          unboundByConfigured: Boolean(sender.userId),
          unboundByName: sender.name || ""
        });
      }
      return {
        handled: true,
        text: "已取消当前群的需求必填字段提醒。"
      };
    }

    return {
      handled: true,
      text: groupBindingEnabled()
        ? `需求必填字段提醒群已绑定，待响应 ${Object.values(state.groupReminders).filter((item) => item && reminderStatus(item) === "awaiting_processing").length} 张，处理中 ${Object.values(state.groupReminders).filter((item) => item && reminderStatus(item) === "processing").length} 张。`
        : "当前未绑定需求必填字段提醒群。请在目标群发送：绑定需求必填提醒群"
    };
  }

  function pilotReminderFromInput(input = {}) {
    const reminder = state.pilotReminders[String(input.reminderId || "")];
    const providedHash = tokenHash(input.token || "");
    if (!reminder || !reminder.tokenHash || providedHash.length !== reminder.tokenHash.length) {
      return null;
    }
    const valid = crypto.timingSafeEqual(
      Buffer.from(providedHash, "utf8"),
      Buffer.from(reminder.tokenHash, "utf8")
    );
    return valid ? reminder : null;
  }

  function logicalPilotReminder(reminder) {
    return logicalPilotReminderFromList(pilotRemindersForTask(reminder), reminder);
  }

  function pilotFeedbackTask(reminder) {
    const logical = logicalPilotReminder(reminder);
    const statusText = {
      awaiting_processing: "待响应",
      processing: "正在处理",
      completed: "已完成",
      resolved: "已完成",
      superseded: "已更新提醒"
    }[logical.status] || logical.status || "未知";
    return {
      id: logical.id,
      demandId: logical.task && (logical.task.demandId || logical.task.recordId) || "",
      demand: logical.task && logical.task.demand || "",
      project: logical.task && logical.task.project || "",
      ownerName: logical.ownerName || "",
      missingFields: logical.missingFields || [],
      status: logical.status,
      statusText,
      canStart: logical.status === "awaiting_processing",
      canComplete: logical.status === "processing",
      demandLink: logical.task && logical.task.links ? logical.task.links.demandLink || "" : "",
      processingAt: logical.processingAt || "",
      completedAt: logical.completedAt || "",
      resolvedAt: logical.resolvedAt || ""
    };
  }

  function pilotReminderTokenSummary(reminder) {
    const hash = String(reminder && reminder.tokenHash || "").trim();
    return hash ? `${hash.slice(0, 12)}...` : "";
  }

  function pilotRefreshTargetName(reminder, pushConfig = normalizePushConfig(monitorConfig)) {
    return String(
      reminder && reminder.ownerName
      || (pushConfig.pilot.enabled ? pushConfig.pilot.targetName : "")
      || (pushConfig.testMode ? pushConfig.testTargetName : "")
      || ""
    ).trim();
  }

  function syncPilotReminderFromItem(reminder, target, item, nextKey) {
    const task = item.task || {};
    reminder.key = nextKey;
    reminder.ownerName = target.ownerName || reminder.ownerName || "";
    reminder.originalOwnerName = item.originalOwnerName || reminder.originalOwnerName || "";
    reminder.assigneeUserId = target.targetId || reminder.assigneeUserId || "";
    reminder.missingFields = Array.isArray(item.missingFields) ? item.missingFields.slice() : [];
    reminder.statusLabel = item.status || task.status || "";
    reminder.taskIdentity = taskIdentityFromTask(task);
    reminder.task = {
      ...(reminder.task || {}),
      recordId: task.recordId || "",
      demandId: task.demandId || "",
      demand: task.demand || "",
      project: task.project || "",
      status: task.status || "",
      links: {
        demandLink: task.links && task.links.demandLink ? task.links.demandLink : ""
      }
    };
  }

  function syncRelatedPilotRemindersFromSource(related, target, item, nextKey, nextStatus, changedAt) {
    for (const relatedReminder of related) {
      if (!relatedReminder) {
        continue;
      }
      syncPilotReminderFromItem(relatedReminder, target, item, nextKey);
      relatedReminder.status = nextStatus;
      relatedReminder.nextRemindAt = nextStatus === "processing" ? "" : relatedReminder.nextRemindAt || "";
      if (nextStatus === "processing") {
        relatedReminder.processingAt = relatedReminder.processingAt || changedAt;
      } else {
        delete relatedReminder.processingAt;
      }
      delete relatedReminder.completedAt;
      delete relatedReminder.resolvedAt;
      delete relatedReminder.resolvedReason;
      delete relatedReminder.supersededAt;
      delete relatedReminder.supersededByReminderId;
    }
  }

  function clearRelatedPilotReminderSnapshots(related, changedAt) {
    for (const relatedReminder of related) {
      if (!relatedReminder) {
        continue;
      }
      relatedReminder.missingFields = [];
      relatedReminder.status = "resolved";
      relatedReminder.resolvedAt = changedAt;
      relatedReminder.resolvedReason = "required_fields_filled";
      relatedReminder.nextRemindAt = "";
      delete relatedReminder.processingAt;
      delete relatedReminder.completedAt;
      delete relatedReminder.supersededAt;
      delete relatedReminder.supersededByReminderId;
    }
  }

  function nextPilotPlannedPushAt(pushConfig = normalizePushConfig(monitorConfig)) {
    return state.changeDetection.forceScanRequestedAt || nextPilotReminderAt(pushConfig) || "";
  }

  async function refreshPilotReminderFromSource(input = {}, options = {}) {
    const reminder = input && input.id ? input : pilotReminderFromInput(input);
    if (!reminder) {
      return { ok: false, message: "需求提醒链接无效或已失效" };
    }
    if (!devProgressModule || typeof devProgressModule.prepareRequiredFieldPush !== "function") {
      return { ok: false, message: "开发进度模块未提供必填项刷新能力" };
    }
    const pushConfig = normalizePushConfig(monitorConfig);
    const targetName = pilotRefreshTargetName(reminder, pushConfig);
    if (!targetName) {
      return { ok: false, message: "需求提醒缺少测试目标，无法刷新字段" };
    }
    const startedAtMs = Date.now();
    const beforeTask = pilotFeedbackTask(reminder);
    const beforeFields = Array.isArray(beforeTask.missingFields) ? beforeTask.missingFields.slice() : [];
    const beforeStatus = beforeTask.status || "";
    const related = pilotRemindersForTask(reminder);
    const oldKeys = [...new Set(related.map((item) => String(item && item.key || "").trim()).filter(Boolean))];
    const result = await devProgressModule.prepareRequiredFieldPush({
      limit: pushConfig.scanLimit || undefined,
      focusDemandIds: pushConfig.pilot.focusDemandIds,
      recordIds: [beforeTask.recordId || (reminder.task && reminder.task.recordId) || ""],
      targetOverride: {
        enabled: true,
        targetName
      },
      requiredFieldTrace: {
        recordId: beforeTask.recordId || (reminder.task && reminder.task.recordId) || "",
        demandId: beforeTask.demandId || (reminder.task && reminder.task.demandId) || ""
      },
      forceLookupMetadataRefresh: true
    });
    if (!result || result.ok === false) {
      return {
        ok: false,
        message: result && (result.message || result.text) ? (result.message || result.text) : "刷新需求总表失败"
      };
    }

    const trace = result.requiredFieldTrace || null;
    const sourceRecordFound = !trace || Number(trace.matchedRecordCount || 0) > 0;
    if (!sourceRecordFound) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Dev progress pilot feedback refresh record not found", {
          reminderId: reminder.id,
          feedbackTokenHashPrefix: pilotReminderTokenSummary(reminder),
          demandId: beforeTask.demandId || "",
          recordId: beforeTask.recordId || "",
          refreshReason: options.reason || "page_open",
          dataSource: "live_required_field_scan_by_record_id",
          requiredFieldTrace: trace
        });
      }
      return {
        ok: false,
        message: "未找到当前需求记录，未更新历史处理状态，请稍后刷新或联系管理员。"
      };
    }

    const targets = pilotTargets(result);
    let matched = null;
    for (const target of targets) {
      for (const item of target.items || []) {
        if (pilotItemMatchesReminder(item, reminder)) {
          matched = {
            target,
            item,
            key: itemKey(target.ownerName || "", item)
          };
          break;
        }
      }
      if (matched) {
        break;
      }
    }

    const changedAt = new Date().toISOString();
    let afterTask = null;
    let statusChanged = false;
    if (matched) {
      const nextStatus = related.some((item) => item && item.status === "processing")
        ? "processing"
        : "awaiting_processing";
      // Every valid link for the same record must render one live scan snapshot.
      syncRelatedPilotRemindersFromSource(related.length > 0 ? related : [reminder], matched.target, matched.item, matched.key, nextStatus, changedAt);
      state.pilotGroupSummary.signature = "";
      afterTask = pilotFeedbackTask(reminder);
      statusChanged = beforeStatus !== (afterTask.status || "");
    } else {
      // Never retain stale missing fields alongside the completed state.
      clearRelatedPilotReminderSnapshots(related.length > 0 ? related : [reminder], changedAt);
      for (const oldKey of oldKeys) {
        delete state.pilotSent[oldKey];
      }
      state.pilotGroupSummary.signature = "";
      const verifyAt = new Date(Date.now() + effectivePilotVerifyDelayMs(pushConfig)).toISOString();
      state.changeDetection.forceScanRequestedAt = verifyAt;
      scheduleWakeTick(verifyAt, "pilot_refresh_resolved", { pushConfig });
      afterTask = pilotFeedbackTask(reminder);
      statusChanged = beforeStatus !== (afterTask.status || "");
    }

    save();
    const durationMs = Date.now() - startedAtMs;
    const afterFields = Array.isArray(afterTask.missingFields) ? afterTask.missingFields.slice() : [];
    if (logger && typeof logger.info === "function") {
      logger.info("Dev progress pilot feedback page refreshed from source", {
        reminderId: reminder.id,
        feedbackTokenHashPrefix: pilotReminderTokenSummary(reminder),
        ownerName: reminder.ownerName || "",
        demandId: afterTask.demandId || beforeTask.demandId || "",
        recordId: reminder.task && reminder.task.recordId ? reminder.task.recordId : "",
        refreshReason: options.reason || "page_open",
        dataSource: "live_required_field_scan_by_record_id",
        relatedReminderCount: related.length,
        snapshotPersisted: true,
        foundInSource: Boolean(matched),
        beforeMissingFields: beforeFields,
        afterMissingFields: afterFields,
        beforeStatus,
        afterStatus: afterTask.status || "",
        statusChanged,
        durationMs,
        nextTaskPlannedPushAt: nextPilotPlannedPushAt(pushConfig),
        requiredFieldTrace: result.requiredFieldTrace || null
      });
    }
    return {
      ok: true,
      message: matched
        ? (afterFields.length > 0 ? "字段已刷新为最新总表结果。" : "字段已全部补齐。")
        : "字段已全部补齐。",
      task: afterTask,
      refresh: {
        durationMs,
        beforeMissingFields: beforeFields,
        afterMissingFields: afterFields,
        beforeStatus,
        afterStatus: afterTask.status || "",
        nextTaskPlannedPushAt: nextPilotPlannedPushAt(pushConfig)
      }
    };
  }

  async function getPilotAppFeedback(input = {}) {
    const reminder = pilotReminderFromInput(input);
    if (!reminder) {
      return { ok: false, message: "需求提醒链接无效或已失效" };
    }
    return refreshPilotReminderFromSource(reminder, {
      reason: input.reason || "page_open"
    });
  }

  function getPilotGroupDetail() {
    const remindersByKey = new Map();
    for (const reminder of Object.values(state.pilotReminders)) {
      if (!reminder || !reminder.key) {
        continue;
      }
      remindersByKey.set(reminder.key, logicalPilotReminder(reminder));
    }
    const reminders = [...remindersByKey.values()];
    const statusPriority = {
      processing: 0,
      awaiting_processing: 1,
      completed: 2,
      resolved: 3,
      superseded: 4
    };
    reminders.sort((left, right) => {
      const priorityDiff = (statusPriority[left.status] ?? 9) - (statusPriority[right.status] ?? 9);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      const leftAt = left.completedAt || left.resolvedAt || left.processingAt || left.sentAt || left.createdAt || "";
      const rightAt = right.completedAt || right.resolvedAt || right.processingAt || right.sentAt || right.createdAt || "";
      return timeMs(rightAt) - timeMs(leftAt);
    });
    const reminder = reminders[0] || null;
    const counts = pilotReminderCounts();
    const feedbackTask = reminder ? pilotFeedbackTask(reminder) : null;
    const task = feedbackTask
      ? {
        id: feedbackTask.id,
        demandId: feedbackTask.demandId,
        demand: feedbackTask.demand,
        project: feedbackTask.project,
        ownerName: feedbackTask.ownerName,
        missingFields: feedbackTask.missingFields,
        status: feedbackTask.status,
        statusText: feedbackTask.status === "awaiting_processing" ? "未操作" : feedbackTask.statusText,
        processingAt: feedbackTask.processingAt,
        completedAt: feedbackTask.completedAt,
        resolvedAt: feedbackTask.resolvedAt
      }
      : null;
    const updatedAt = task
      ? task.completedAt || task.resolvedAt || task.processingAt || reminder.sentAt || reminder.createdAt || ""
      : state.pilotGroupSummary.sentAt || "";
    return {
      ok: true,
      summary: {
        targetName: String(monitorConfig.requiredFieldsPush
          && monitorConfig.requiredFieldsPush.pilot
          && monitorConfig.requiredFieldsPush.pilot.targetName || "").trim(),
        awaitingCount: counts.awaitingProcessingCount,
        processingCount: counts.processingCount,
        completedCount: counts.completedCount,
        activeCount: counts.awaitingProcessingCount + counts.processingCount,
        updatedAt,
        task
      }
    };
  }

  async function submitPilotAppFeedback(input = {}) {
    const reminder = pilotReminderFromInput(input);
    if (!reminder) {
      return { ok: false, message: "需求提醒链接无效或已失效" };
    }
    const action = String(input.action || "");
    if (!["processing", "done"].includes(action)) {
      return { ok: false, message: "不支持的处理状态" };
    }
    const pushConfig = normalizePushConfig(monitorConfig);
    const related = pilotRemindersForTask(reminder);
    const logical = logicalPilotReminder(reminder);
    if (logical.status === "completed" || logical.status === "resolved") {
      return {
        ok: true,
        message: logical.status === "completed" ? "该需求已经提交完成。" : "需求总表字段已经补齐。",
        task: pilotFeedbackTask(logical)
      };
    }
    const changedAt = new Date().toISOString();
    if (action === "processing") {
      for (const item of related) {
        if (item.status === "completed" || item.status === "resolved") {
          continue;
        }
        item.status = "processing";
        item.processingAt = changedAt;
        item.nextRemindAt = "";
      }
      state.pilotGroupSummary.signature = "";
      state.changeDetection.forceScanRequestedAt = changedAt;
      save();
      scheduleWakeTick(changedAt, "pilot_processing_refresh", { pushConfig });
      if (logger && typeof logger.info === "function") {
        logger.info("Dev progress pilot app reminder processing started", {
          reminderId: reminder.id,
          ownerName: reminder.ownerName,
          demandId: reminder.task && reminder.task.demandId || "",
          recordId: reminder.task && reminder.task.recordId || "",
          relatedReminderCount: related.length,
          channel: "wecom-app",
          beforeMissingFields: logical.missingFields || [],
          afterMissingFields: pilotFeedbackTask(reminder).missingFields || [],
          nextTaskPlannedPushAt: nextPilotPlannedPushAt(pushConfig)
        });
      }
      return {
        ok: true,
        message: "已记录正在处理，系统已停止重复催办。",
        task: pilotFeedbackTask(reminder)
      };
    }
    if (logical.status !== "processing") {
      return {
        ok: false,
        message: "请先点击“正在处理”，补齐字段后再点击“已完成”。",
        task: pilotFeedbackTask(reminder)
      };
    }
    for (const item of related) {
      item.status = "completed";
      item.completedAt = changedAt;
      item.nextRemindAt = "";
    }
    for (const item of related) {
      delete state.pilotSent[item.key];
    }
    state.pilotGroupSummary.signature = "";
    const verifyAt = new Date(Date.now() + effectivePilotVerifyDelayMs(pushConfig)).toISOString();
    state.changeDetection.forceScanRequestedAt = verifyAt;
    save();
    scheduleWakeTick(verifyAt, "pilot_completion_verification", { pushConfig });
    if (logger && typeof logger.info === "function") {
      logger.info("Dev progress pilot app reminder completed", {
        reminderId: reminder.id,
        ownerName: reminder.ownerName,
        demandId: reminder.task && reminder.task.demandId || "",
        recordId: reminder.task && reminder.task.recordId || "",
        relatedReminderCount: related.length,
        verifyAfterSeconds: Math.floor(effectivePilotVerifyDelayMs(pushConfig) / 1000),
        channel: "wecom-app",
        beforeMissingFields: logical.missingFields || [],
        afterMissingFields: [],
        nextTaskPlannedPushAt: verifyAt
      });
    }
    return {
      ok: true,
      message: `已提交完成，系统将在 ${Math.floor(effectivePilotVerifyDelayMs(pushConfig) / 1000)} 秒后核对需求总表。`,
      task: pilotFeedbackTask(reminder)
    };
  }

  async function handleTemplateCardEvent(summary = {}, sender = {}) {
    const taskId = String(summary.taskId || "");
    const eventKey = String(summary.eventKey || "");
    if (taskId.startsWith("ea_dev_pilot_summary_")) {
      if (eventKey !== "ea_dev_pilot_summary_status") {
        return { handled: false };
      }
      return {
        handled: true,
        message: "群卡展示试运行汇总状态。请由责任同事在“需求进度管理”个人提醒中点击“正在处理”或“已完成”。"
      };
    }
    if (!taskId.startsWith("ea_dev_required_")) {
      return { handled: false };
    }
    const reminder = state.groupReminders[taskId];
    if (!reminder) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Dev progress required field group card event task missing", {
          reminderId: taskId,
          eventKey: summary.eventKey || "",
          senderConfigured: Boolean(sender.userId)
        });
      }
      return { handled: true };
    }
    if (eventKey === "ea_dev_required_status") {
      return {
        handled: true,
        message: `当前状态：${reminderStatusLabel(reminderStatus(reminder))}。只有责任同事 ${reminder.ownerName || ""} 可以修改状态。`
      };
    }
    if (!["ea_dev_required_processing", "ea_dev_required_done"].includes(eventKey)) {
      return { handled: false };
    }
    if (reminder.assigneeUserId && sender.userId !== reminder.assigneeUserId) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Dev progress required field group card action rejected", {
          reminderId: taskId,
          eventKey,
          ownerName: reminder.ownerName,
          assigneeConfigured: true,
          senderConfigured: Boolean(sender.userId),
          reason: "assignee_mismatch"
        });
      }
      return {
        handled: true,
        message: `只有责任同事 ${reminder.ownerName || ""} 可以操作这张卡片。`
      };
    }

    const relatedReminders = groupRemindersForKey(reminder.key);
    const completedReminder = relatedReminders.find((item) => reminderStatus(item) === "completed");
    if (completedReminder) {
      return {
        handled: true,
        updateCard: completedGroupReminderCard({
          ...completedReminder,
          id: reminder.id
        })
      };
    }

    const processingReminder = relatedReminders.find((item) => reminderStatus(item) === "processing");
    if (eventKey === "ea_dev_required_processing") {
      if (processingReminder) {
        return {
          handled: true,
          updateCard: processingGroupReminderCard({
            ...processingReminder,
            id: reminder.id
          })
        };
      }
      const processingAt = new Date().toISOString();
      const processingByName = sender.name || reminder.ownerName || "";
      for (const related of relatedReminders) {
        if (reminderStatus(related) === "completed") {
          continue;
        }
        related.status = "processing";
        related.processingAt = processingAt;
        related.processingByUserId = sender.userId || "";
        related.processingByName = processingByName;
        related.nextRemindAt = "";
      }
      save();
      if (logger && typeof logger.info === "function") {
        logger.info("Dev progress required field group reminder processing started", {
          reminderId: reminder.id,
          reminderKey: reminder.key,
          relatedReminderCount: relatedReminders.length,
          ownerName: reminder.ownerName,
          processingByConfigured: Boolean(sender.userId),
          processingByName,
          demandId: reminder.task && reminder.task.demandId ? reminder.task.demandId : "",
          recordId: reminder.task && reminder.task.recordId ? reminder.task.recordId : "",
          missingFields: reminder.missingFields || []
        });
      }
      return {
        handled: true,
        updateCard: processingGroupReminderCard(reminder)
      };
    }

    if (!processingReminder) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Dev progress required field completion rejected before processing", {
          reminderId: reminder.id,
          ownerName: reminder.ownerName,
          senderConfigured: Boolean(sender.userId),
          demandId: reminder.task && reminder.task.demandId ? reminder.task.demandId : "",
          recordId: reminder.task && reminder.task.recordId ? reminder.task.recordId : ""
        });
      }
      return {
        handled: true,
        message: "请先点击“正在处理”，完成字段补充后再点击“已完成”。",
        updateCard: groupReminderCard(reminder)
      };
    }

    const completedAt = new Date().toISOString();
    const completedByName = sender.name || reminder.ownerName || "";
    for (const related of relatedReminders) {
      related.status = "completed";
      related.completedAt = completedAt;
      related.completedByUserId = sender.userId || "";
      related.completedByName = completedByName;
      related.nextRemindAt = "";
    }
    delete state.groupSent[reminder.key];
    state.changeDetection.forceScanRequestedAt = completedAt;
    save();
    const verifier = setTimeout(() => {
      tick().catch((error) => {
        if (logger && typeof logger.error === "function") {
          logger.error("Dev progress required field completion verification failed", {
            reminderId: reminder.id,
            message: error.message
          });
        }
      });
    }, 30000);
    if (typeof verifier.unref === "function") {
      verifier.unref();
    }
    if (logger && typeof logger.info === "function") {
      logger.info("Dev progress required field group reminder completed", {
        reminderId: reminder.id,
        ownerName: reminder.ownerName,
        completedByConfigured: Boolean(sender.userId),
        completedByName,
        relatedReminderCount: relatedReminders.length,
        demandId: reminder.task && reminder.task.demandId ? reminder.task.demandId : "",
        recordId: reminder.task && reminder.task.recordId ? reminder.task.recordId : "",
        missingFields: reminder.missingFields || []
      });
    }
    return {
      handled: true,
      updateCard: completedGroupReminderCard({
        ...reminder,
        status: "completed",
        completedAt,
        completedByUserId: sender.userId || "",
        completedByName
      })
    };
  }

  function start() {
    const pushConfig = normalizePushConfig(monitorConfig);
    if (!monitorEnabled(pushConfig)) {
      return false;
    }
    if (timer) {
      return true;
    }
    const intervalMs = Math.max(1, Number(monitorConfig.intervalMinutes || 10)) * 60 * 1000;
    timer = setInterval(() => {
      tick().catch((error) => {
        if (logger && typeof logger.error === "function") {
          logger.error("Dev progress monitor tick failed", { message: error.message });
        }
      });
    }, intervalMs);
    const shouldRunOnStart = Boolean(pushConfig.runOnStart || pushConfig.pilot.enabled);
    if (pushConfig.pilot.enabled) {
      state.changeDetection.forceScanRequestedAt = new Date().toISOString();
      save();
    }
    if (shouldRunOnStart) {
      const starter = setTimeout(() => {
        tick().catch((error) => {
          if (logger && typeof logger.error === "function") {
            logger.error("Dev progress monitor startup tick failed", { message: error.message });
          }
        });
      }, 2000);
      if (typeof starter.unref === "function") {
        starter.unref();
      }
    }
    if (logger && typeof logger.info === "function") {
      logger.info("Dev progress monitor bridge started", {
        intervalMinutes: Number(monitorConfig.intervalMinutes || 10),
        requiredFieldsPushEnabled: pushConfig.enabled,
        cooldownMinutes: pushConfig.cooldownMinutes,
        changeDetection: normalizeChangeDetectionConfig(monitorConfig),
        testMode: pushConfig.testMode,
        testTargetName: pushConfig.testMode ? pushConfig.testTargetName : "",
        pilotEnabled: pushConfig.pilot.enabled,
        pilotTargetName: pushConfig.pilot.targetName,
        pilotStartupScan: shouldRunOnStart,
        groupCardEnabled: groupBindingEnabled(pushConfig),
        groupConfigured: Boolean(state.groupBinding.chatId),
        groupMaxCardsPerTick: pushConfig.groupCard.maxCardsPerTick
      });
    }
    return true;
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    clearWakeTimer();
  }

  function getStatus() {
    const pushConfig = normalizePushConfig(monitorConfig);
    const changeDetectionConfig = normalizeChangeDetectionConfig(monitorConfig);
    const pilotCounts = pilotReminderCounts();
    const formalMode = !pushConfig.testMode && !pushConfig.pilot.enabled;
    const autoPushEnabled = Boolean(pushConfig.enabled && monitorConfig.notifyThroughCenter);
    return {
      enabled: monitorEnabled(pushConfig),
      scanEnabled: Boolean(monitorConfig.enabled),
      personalPushEnabled: Boolean(autoPushEnabled && monitorConfig.enabled),
      running: Boolean(timer),
      intervalMinutes: Number(monitorConfig.intervalMinutes || 10),
      notifyThroughCenter: monitorConfig.notifyThroughCenter !== false,
      changeDetection: {
        ...changeDetectionConfig,
        stateFile: bridgeStateFile,
        state: state.changeDetection || {}
      },
      requiredFieldsPush: {
        enabled: pushConfig.enabled,
        mode: formalMode ? "formal" : "test",
        autoPushStatus: autoPushEnabled ? "enabled" : "disabled_pending_recipient_scope",
        cooldownMinutes: pushConfig.cooldownMinutes,
        scanLimit: pushConfig.scanLimit || 0,
        maxTargetsPerTick: pushConfig.maxTargetsPerTick,
        inlineTaskLimit: INLINE_TASK_LIMIT,
        runOnStart: pushConfig.runOnStart,
        testMode: pushConfig.testMode,
        testTargetName: pushConfig.testMode ? pushConfig.testTargetName : "",
        testVerifyDelaySeconds: pushConfig.testVerifyDelaySeconds,
        testNextTaskDelaySeconds: pushConfig.testNextTaskDelaySeconds,
        pilot: {
          enabled: pushConfig.pilot.enabled,
          targetName: pushConfig.pilot.targetName,
          remindMinutes: pushConfig.pilot.remindMinutes,
          summaryMinutes: pushConfig.pilot.summaryMinutes,
          mentionDelaySeconds: pushConfig.pilot.mentionDelaySeconds,
          maxActiveTasks: pushConfig.pilot.maxActiveTasks,
          focusDemandIds: pushConfig.pilot.focusDemandIds,
          appConfigured: Boolean(appNotifier && appFeedbackUrl),
          awaitingProcessingCount: pilotCounts.awaitingProcessingCount,
          processingCount: pilotCounts.processingCount,
          completedCount: pilotCounts.completedCount,
          retryAt: state.pilotRetryAt || "",
          nextReminderAt: nextPilotReminderAt(pushConfig),
          groupSummary: {
            ...state.pilotGroupSummary,
            frequencyMinutes: pushConfig.pilot.summaryMinutes,
            nextSummaryAt: state.pilotGroupSummary.sentAt
              ? new Date(
                timeMs(state.pilotGroupSummary.sentAt) + pushConfig.pilot.summaryMinutes * 60 * 1000
              ).toISOString()
              : ""
          },
          groupMention: state.pilotGroupMention
        },
        groupCard: {
          enabled: groupBindingEnabled(pushConfig),
          configured: Boolean(state.groupBinding.chatId),
          maxCardsPerTick: pushConfig.groupCard.maxCardsPerTick,
          remindMinutes: pushConfig.groupCard.remindMinutes,
          awaitingProcessingCount: Object.values(state.groupReminders).filter((item) => item && reminderStatus(item) === "awaiting_processing").length,
          processingCount: Object.values(state.groupReminders).filter((item) => item && reminderStatus(item) === "processing").length,
          completedCount: Object.values(state.groupReminders).filter((item) => item && item.status === "completed").length,
          nextReminderAt: nextGroupReminderAt(pushConfig),
          retryAt: state.groupRetryAt || ""
        },
        stateFile: bridgeStateFile,
        sentKeyCount: Object.keys(state.sent || {}).length,
        lastRun: state.lastRun || null
      }
    };
  }

  return {
    start,
    stop,
    tick,
    captureTextMessage,
    handleTemplateCardEvent,
    getPilotAppFeedback,
    getPilotGroupDetail,
    submitPilotAppFeedback,
    getStatus
  };
}

module.exports = {
  createDevProgressMonitorBridge
};
