"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { projectRoot } = require("../../utils/paths");
const { formatLocalMinute } = require("../../utils/localDateTime");
const {
  resolveWeComUserName,
  resolveWeComUserIdByName
} = require("../../wecom/wecomUserResolver");
const { errorInfo } = require("../../utils/errorInfo");

const storeDir = path.join(projectRoot, "data", "watchdog");
const storeFile = path.join(storeDir, "watchdog-tasks.json");
const DEFAULT_INTERVAL_MINUTES = 180;
const DEFAULT_ONCE_REMINDER_HOUR = 9;
const TICK_MS = 60 * 1000;
const REMARK_UPDATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const WECOM_SEND_FREQUENCY_ERRCODE = 846607;
const DEFAULT_SEND_QUEUE_MIN_INTERVAL_MS = 65 * 1000;
const DEFAULT_SEND_QUEUE_FREQUENCY_BACKOFF_MS = 30 * 60 * 1000;
const DEFAULT_SEND_QUEUE_MAX_FREQUENCY_BACKOFF_MS = 8 * 60 * 60 * 1000;
const DEFAULT_SEND_QUEUE_FAILURE_BACKOFF_MS = 2 * 60 * 1000;
const DEFAULT_SEND_QUEUE_MAX_SENDS_PER_TICK = 1;
const DEFAULT_SEND_QUEUE_BATCH_SUMMARY_COOLDOWN_MS = 30 * 60 * 1000;
const APP_FEEDBACK_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const APP_FEEDBACK_NOTE_MAX_LENGTH = 500;
const APP_RESULT_NOTICE_RECOVERY_WINDOW_MS = 30 * 60 * 1000;
const MAX_APP_RESULT_NOTICES_PER_TICK = 10;
const MAX_APP_DELIVERIES_DURING_ROBOT_BACKOFF = 20;
const APP_SITUATION_QUESTION_KEY = "ea_watch_situation";
const APP_SITUATION_OPTIONS = Object.freeze([
  { id: "none", text: "无补充", note: "" },
  { id: "on_track", text: "按计划推进", note: "按计划推进" },
  { id: "waiting_confirm", text: "等待确认", note: "等待确认" },
  { id: "waiting_resource", text: "等待资源", note: "等待资源" },
  { id: "waiting_integration", text: "等待联调", note: "等待联调" },
  { id: "waiting_test", text: "等待测试", note: "等待测试" },
  { id: "technical_block", text: "技术困难", note: "技术困难" },
  { id: "coordination_needed", text: "需要协调", note: "需要协调" },
  { id: "schedule_risk", text: "进度有风险", note: "进度有风险" },
  { id: "delayed", text: "计划延期", note: "计划延期" }
]);
const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const WORKDAY_SCHEDULE_TEXT = "(?:工作日|工作天|周一\\s*(?:到|至|-|~)\\s*周?五|星期一\\s*(?:到|至|-|~)\\s*(?:星期)?五|礼拜一\\s*(?:到|至|-|~)\\s*(?:礼拜)?五)";
const CLOCK_SCHEDULE_TEXT = "\\s*(上午|早上|下午|晚上|中午)?\\s*(\\d{1,2})(?:\\s*(?:[:：点时])\\s*(\\d{1,2})?\\s*分?)?";
const WORKDAY_SCHEDULE_REGEXP = new RegExp(`${WORKDAY_SCHEDULE_TEXT}(?:\\s*(?:每天|每日|天天))?${CLOCK_SCHEDULE_TEXT}`);
const DAILY_WORKDAY_SCHEDULE_REGEXP = new RegExp(`(?:每天|每日|天天)\\s*${WORKDAY_SCHEDULE_TEXT}${CLOCK_SCHEDULE_TEXT}`);
const WORKDAY_SCHEDULE_GLOBAL_REGEXP = new RegExp(`${WORKDAY_SCHEDULE_TEXT}(?:\\s*(?:每天|每日|天天))?${CLOCK_SCHEDULE_TEXT}`, "g");
const DAILY_WORKDAY_SCHEDULE_GLOBAL_REGEXP = new RegExp(`(?:每天|每日|天天)\\s*${WORKDAY_SCHEDULE_TEXT}${CLOCK_SCHEDULE_TEXT}`, "g");

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

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function taskId() {
  return `wd_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function draftId() {
  return `wdf_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function appFeedbackRefForTaskId(value) {
  const taskIdValue = normalizeText(value);
  if (!taskIdValue) {
    return "";
  }
  return crypto.createHash("sha256")
    .update(`ea-watchdog-feedback-v1:${taskIdValue}`)
    .digest("hex")
    .slice(0, 12);
}

function truncate(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeSendQueueConfig(rawConfig = {}) {
  const raw = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
    ? rawConfig
    : {};
  const frequencyLimitBackoffMs = boundedNumber(
    raw.frequencyLimitBackoffMs,
    DEFAULT_SEND_QUEUE_FREQUENCY_BACKOFF_MS,
    60 * 1000,
    60 * 60 * 1000
  );
  const frequencyLimitMaxBackoffMs = boundedNumber(
    raw.frequencyLimitMaxBackoffMs,
    DEFAULT_SEND_QUEUE_MAX_FREQUENCY_BACKOFF_MS,
    frequencyLimitBackoffMs,
    24 * 60 * 60 * 1000
  );
  return {
    enabled: raw.enabled !== false,
    minIntervalMs: boundedNumber(raw.minIntervalMs, DEFAULT_SEND_QUEUE_MIN_INTERVAL_MS, 1000, 10 * 60 * 1000),
    frequencyLimitBackoffMs,
    frequencyLimitMaxBackoffMs: Math.max(frequencyLimitBackoffMs, frequencyLimitMaxBackoffMs),
    failureBackoffMs: boundedNumber(raw.failureBackoffMs, DEFAULT_SEND_QUEUE_FAILURE_BACKOFF_MS, 30 * 1000, 30 * 60 * 1000),
    maxSendsPerTick: boundedNumber(raw.maxSendsPerTick, DEFAULT_SEND_QUEUE_MAX_SENDS_PER_TICK, 1, 20),
    batchSameTargetEnabled: raw.batchSameTargetEnabled !== false,
    batchSummaryMinTasks: boundedNumber(raw.batchSummaryMinTasks, 2, 2, 20),
    batchSummaryCooldownMs: boundedNumber(raw.batchSummaryCooldownMs, DEFAULT_SEND_QUEUE_BATCH_SUMMARY_COOLDOWN_MS, 60 * 1000, 60 * 60 * 1000)
  };
}

function errcodeFromError(error) {
  const info = errorInfo(error);
  const direct = Number(info.errcode !== undefined ? info.errcode : info.code);
  if (Number.isFinite(direct)) {
    return direct;
  }
  const matched = String(info.message || "").match(/errcode:\s*(\d+)|\b(846607)\b/i);
  if (!matched) {
    return null;
  }
  const value = Number(matched[1] || matched[2]);
  return Number.isFinite(value) ? value : null;
}

function isSendFrequencyLimitError(error) {
  return errcodeFromError(error) === WECOM_SEND_FREQUENCY_ERRCODE;
}

function assertWeComAckOk(ack) {
  if (!ack || ack.errcode === undefined || Number(ack.errcode) === 0) {
    return;
  }
  throw ack;
}

function normalizeRemark(value) {
  const text = String(value || "")
    .replace(/[，,。！？!?.；;：:]+$/g, "")
    .trim();
  if (/^(?:无|没有|暂无|空|清空|删除|去掉)$/i.test(text)) {
    return "";
  }
  return truncate(text, 300);
}

function extractRemark(text) {
  const raw = String(text || "").trim();
  const patterns = [
    /(?:备注|说明|补充说明)\s*(?:改成|改为|更新为|设为|换成)\s*([^\n，,。！？!?.；;]+)/,
    /(?:备注|说明|补充说明)\s*(?:是|为|叫|:|：)\s*([^\n，,。！？!?.；;]+)/,
    /(?:备注|说明|补充说明)\s+([^\n，,。！？!?.；;]+)/,
    /(?:备注|说明|补充说明)([^\n，,。！？!?.；;]+)/
  ];
  for (const pattern of patterns) {
    const matched = raw.match(pattern);
    if (matched && matched[1]) {
      return normalizeRemark(matched[1]);
    }
  }
  return "";
}

function stripRemarkText(text) {
  return String(text || "")
    .replace(/(?:备注|说明|补充说明)\s*(?:改成|改为|更新为|设为|换成|是|为|叫|:|：)?\s*[^\n，,。！？!?.；;]+/g, "")
    .trim();
}

function taskRemarkText(task = {}) {
  return normalizeRemark(task.remark || "");
}

function remarkCardItem(task = {}) {
  const remark = taskRemarkText(task);
  return remark
    ? {
        keyname: "备注",
        value: truncate(remark, 60)
      }
    : null;
}

function remarkLine(task = {}) {
  const remark = taskRemarkText(task);
  return remark ? `备注：${remark}` : "";
}

function watchdogTaskId(task = {}) {
  return String(task.id || "").trim();
}

function watchdogTaskIdLine(task = {}) {
  const id = watchdogTaskId(task);
  return id ? `任务ID：${id}` : "";
}

function watchdogTaskIdCardItem(task = {}) {
  const id = watchdogTaskId(task);
  return id
    ? {
        keyname: "任务ID",
        value: id
      }
    : null;
}

function minutesFromIntervalUnit(value, unit) {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (unit === "分钟" || unit === "分") {
    return Math.max(1, Math.round(value));
  }
  if (unit === "天" || unit === "日") {
    return Math.max(1, Math.round(value * 24 * 60));
  }
  return Math.max(1, Math.round(value * 60));
}

function parseIntervalMinutes(text) {
  const raw = String(text || "");
  if (/(?:每天|每日)(?:一次|盯一次|提醒一次|收集一次)?/.test(raw)) {
    return 24 * 60;
  }

  const prefixed = raw.match(/(?:每隔|每|间隔)\s*(\d+(?:\.\d+)?)\s*(分钟|分|小时|个小时|h|H|天|日)(?:一次|盯一次|盯一下|盯梢一次|提醒一次|收集一次)?/);
  if (prefixed) {
    return minutesFromIntervalUnit(Number(prefixed[1]), prefixed[2]);
  }

  const bareShort = raw.match(/(^|[^\d月])(\d+(?:\.\d+)?)\s*(分钟|分|小时|个小时|h|H)(?:一次|盯一次|盯一下|盯梢一次|提醒一次|收集一次)?/);
  if (bareShort) {
    return minutesFromIntervalUnit(Number(bareShort[2]), bareShort[3]);
  }

  const bareDay = raw.match(/(^|[^\d月])(\d+(?:\.\d+)?)\s*(天|日)(?:一次|盯一次|盯一下|盯梢一次|提醒一次|收集一次)/);
  if (bareDay) {
    return minutesFromIntervalUnit(Number(bareDay[2]), bareDay[3]);
  }

  return null;
}

function intervalMinutesFromText(text, defaultMinutes = DEFAULT_INTERVAL_MINUTES) {
  return parseIntervalMinutes(text) || defaultMinutes;
}

function intervalText(minutes) {
  const value = Number(minutes || 0);
  if (value > 0 && value % (24 * 60) === 0) {
    return `${value / (24 * 60)}天`;
  }
  if (value > 0 && value % 60 === 0) {
    return `${value / 60}小时`;
  }
  return `${Math.max(1, value)}分钟`;
}

function intervalDisplay(minutes) {
  return `${intervalText(minutes)}一次`;
}

function weekdayValue(value) {
  const text = String(value || "").trim();
  const map = {
    "日": 0,
    "天": 0,
    "0": 0,
    "7": 0,
    "一": 1,
    "1": 1,
    "二": 2,
    "2": 2,
    "三": 3,
    "3": 3,
    "四": 4,
    "4": 4,
    "五": 5,
    "5": 5,
    "六": 6,
    "6": 6
  };
  return Object.prototype.hasOwnProperty.call(map, text) ? map[text] : null;
}

function normalizeMinute(value) {
  const minute = Number(value);
  return Number.isFinite(minute) ? Math.max(0, Math.min(59, Math.floor(minute))) : 0;
}

function parseClockInText(text, defaultHour = DEFAULT_ONCE_REMINDER_HOUR) {
  const raw = String(text || "").trim();
  const matched = raw.match(/(上午|早上|下午|晚上|中午)?\s*(\d{1,2})(?:\s*(?:[:：点时])\s*(\d{1,2})?\s*分?)?/);
  if (!matched) {
    return null;
  }
  return {
    hour: normalizeClockHour(matched[2] || defaultHour, matched[1]),
    minute: normalizeMinute(matched[3] || 0)
  };
}

function recurringScheduleDisplay(schedule = {}) {
  if (!schedule || typeof schedule !== "object") {
    return "";
  }
  const hour = Number(schedule.hour);
  const minute = Number(schedule.minute || 0);
  if (!Number.isFinite(hour)) {
    return "";
  }
  const timeText = `${String(Math.max(0, Math.min(23, Math.floor(hour)))).padStart(2, "0")}:${String(Math.max(0, Math.min(59, Math.floor(minute)))).padStart(2, "0")}`;
  if (schedule.type === "daily_time") {
    return `每天 ${timeText}`;
  }
  if (schedule.type === "workday_time") {
    return `工作日 ${timeText}`;
  }
  if (schedule.type === "weekly_time") {
    const weekday = Number(schedule.weekday);
    const label = WEEKDAY_LABELS[weekday] || "";
    return label ? `每周${label} ${timeText}` : "";
  }
  return "";
}

function fixedScheduleIntervalMinutes(schedule = {}) {
  if (schedule.type === "weekly_time") {
    return 7 * 24 * 60;
  }
  if (schedule.type === "daily_time" || schedule.type === "workday_time") {
    return 24 * 60;
  }
  return 0;
}

function isWorkdayDate(date) {
  const weekday = date.getDay();
  return weekday >= 1 && weekday <= 5;
}

function parseRecurringScheduleFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  const workday = raw.match(WORKDAY_SCHEDULE_REGEXP) || raw.match(DAILY_WORKDAY_SCHEDULE_REGEXP);
  if (workday && workday[2]) {
    return {
      type: "workday_time",
      hour: normalizeClockHour(workday[2], workday[1]),
      minute: normalizeMinute(workday[3] || 0)
    };
  }

  const weekly = raw.match(/(?:每\s*)?(?:周|星期|礼拜)\s*([一二三四五六日天1-7])(?:\s*(上午|早上|下午|晚上|中午)?\s*(\d{1,2})(?:\s*(?:[:：点时])\s*(\d{1,2})?\s*分?)?)?/);
  if (weekly) {
    const weekday = weekdayValue(weekly[1]);
    if (weekday !== null) {
      const clock = weekly[3]
        ? { hour: normalizeClockHour(weekly[3], weekly[2]), minute: normalizeMinute(weekly[4] || 0) }
        : { hour: DEFAULT_ONCE_REMINDER_HOUR, minute: 0 };
      return {
        type: "weekly_time",
        weekday,
        hour: clock.hour,
        minute: clock.minute
      };
    }
  }

  const daily = raw.match(/(?:每天|每日|天天)(?:\s*(上午|早上|下午|晚上|中午)?\s*(\d{1,2})(?:\s*(?:[:：点时])\s*(\d{1,2})?\s*分?)?)?/);
  if (daily && (daily[1] || daily[2])) {
    const hour = daily[2] ? normalizeClockHour(daily[2], daily[1]) : normalizeClockHour(DEFAULT_ONCE_REMINDER_HOUR, daily[1]);
    return {
      type: "daily_time",
      hour,
      minute: normalizeMinute(daily[3] || 0)
    };
  }

  return null;
}

function nextRecurringScheduleDate(schedule = {}, fromDate = new Date()) {
  const display = recurringScheduleDisplay(schedule);
  if (!display) {
    return null;
  }
  const base = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const hour = Math.max(0, Math.min(23, Math.floor(Number(schedule.hour || 0))));
  const minute = Math.max(0, Math.min(59, Math.floor(Number(schedule.minute || 0))));
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
  if (schedule.type === "daily_time") {
    if (next.getTime() <= base.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }
  if (schedule.type === "workday_time") {
    if (next.getTime() <= base.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    while (!isWorkdayDate(next)) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }
  if (schedule.type === "weekly_time") {
    const weekday = Number(schedule.weekday);
    if (!Number.isFinite(weekday)) {
      return null;
    }
    let dayOffset = weekday - base.getDay();
    if (dayOffset < 0 || (dayOffset === 0 && next.getTime() <= base.getTime())) {
      dayOffset += 7;
    }
    next.setDate(next.getDate() + dayOffset);
    return next;
  }
  return null;
}

function nextRunAtForRecurringTask(task = {}, fromDate = new Date()) {
  const scheduled = nextRecurringScheduleDate(task.recurringSchedule, fromDate);
  if (scheduled) {
    return scheduled.toISOString();
  }
  const minutes = Number(task.intervalMinutes || DEFAULT_INTERVAL_MINUTES);
  return new Date(fromDate.getTime() + Math.max(1, minutes) * 60 * 1000).toISOString();
}

function isOneTimeTask(task = {}) {
  return String(task.mode || "recurring") === "once";
}

function scheduleDisplay(task = {}) {
  if (isOneTimeTask(task)) {
    const dueAt = task.dueAt || task.nextRunAt || "";
    return dueAt ? `一次性：${formatLocalMinute(dueAt)}` : "一次性：等待补充下次时间";
  }
  const fixedSchedule = recurringScheduleDisplay(task.recurringSchedule);
  if (fixedSchedule) {
    return fixedSchedule;
  }
  return intervalDisplay(task.intervalMinutes);
}

function hasChinese(value) {
  return /[\u4e00-\u9fa5]/.test(String(value || ""));
}

function requesterDisplayName(task = {}) {
  return task.requesterDisplayName
    || task.requesterName
    || task.requesterUserId
    || "未知";
}

function normalizeClockHour(hour, period) {
  let value = Number(hour);
  if (!Number.isFinite(value)) {
    value = DEFAULT_ONCE_REMINDER_HOUR;
  }
  const label = String(period || "");
  if ((label === "下午" || label === "晚上") && value < 12) {
    value += 12;
  }
  if (label === "中午" && value < 11) {
    value += 12;
  }
  return Math.max(0, Math.min(23, Math.floor(value)));
}

function localDateFromParts(year, month, day, hour, minute) {
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function futureLocalDate(year, month, day, hour, minute, now = new Date(), allowNextYear = false) {
  let date = localDateFromParts(year, month, day, hour, minute);
  if (!date) {
    return null;
  }
  if (date.getTime() <= now.getTime() && allowNextYear) {
    date = localDateFromParts(year + 1, month, day, hour, minute);
  }
  return date && date.getTime() > now.getTime() ? date : null;
}

function parseOneTimeAtFromText(text, now = new Date()) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  const iso = raw.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s*(上午|早上|下午|晚上|中午)?\s*(\d{1,2})(?:[:：点时](\d{1,2})?分?)?)?/);
  if (iso) {
    const hour = iso[5] ? normalizeClockHour(iso[5], iso[4]) : DEFAULT_ONCE_REMINDER_HOUR;
    const minute = iso[6] ? Number(iso[6]) : 0;
    return futureLocalDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), hour, minute, now, false);
  }

  const chinese = raw.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?(?:\s*(上午|早上|下午|晚上|中午)?\s*(\d{1,2})(?:[:：点时](\d{1,2})?分?)?)?/);
  if (chinese) {
    const hasYear = Boolean(chinese[1]);
    const year = hasYear ? Number(chinese[1]) : now.getFullYear();
    const hour = chinese[5] ? normalizeClockHour(chinese[5], chinese[4]) : DEFAULT_ONCE_REMINDER_HOUR;
    const minute = chinese[6] ? Number(chinese[6]) : 0;
    return futureLocalDate(year, Number(chinese[2]), Number(chinese[3]), hour, minute, now, !hasYear);
  }

  const relative = raw.match(/(今天|今日|明天|后天)(?:\s*(上午|早上|下午|晚上|中午)?\s*(\d{1,2})(?:[:：点时](\d{1,2})?分?)?)?/);
  if (relative) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const offset = relative[1] === "明天" ? 1 : relative[1] === "后天" ? 2 : 0;
    date.setDate(date.getDate() + offset);
    const hour = relative[3] ? normalizeClockHour(relative[3], relative[2]) : DEFAULT_ONCE_REMINDER_HOUR;
    const minute = relative[4] ? Number(relative[4]) : 0;
    date.setHours(hour, minute, 0, 0);
    if (date.getTime() <= now.getTime()) {
      date.setTime(now.getTime() + 60 * 1000);
    }
    return date;
  }

  return null;
}

function stripOneTimeText(text) {
  return String(text || "")
    .replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s*(?:上午|早上|下午|晚上|中午)?\s*\d{1,2}(?:[:：点时]\d{1,2}?分?)?)?/g, "")
    .replace(/(?:(?:\d{4})\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*(?:日|号)?(?:\s*(?:上午|早上|下午|晚上|中午)?\s*\d{1,2}(?:[:：点时]\d{1,2}?分?)?)?/g, "")
    .replace(/(?:今天|今日|明天|后天)(?:\s*(?:上午|早上|下午|晚上|中午)?\s*\d{1,2}(?:[:：点时]\d{1,2}?分?)?)?/g, "")
    .replace(/(?:一次性时间|提醒时间|盯梢日期|时间节点|盯梢时间)\s*(?:是|为|:|：)?/g, "")
    .trim();
}

function extractAttachment(text) {
  const raw = String(text || "").trim();
  const explicit = raw.match(/(?:附件|链接|地址|网址|文件)\s*(?:是|为|:|：)\s*([^\n]+)/);
  if (explicit && explicit[1]) {
    return truncate(explicit[1].trim(), 300);
  }
  const url = raw.match(/https?:\/\/[^\s，,。！？!?.；;]+/i);
  return url ? truncate(url[0], 300) : "";
}

function stripAttachmentText(text) {
  return String(text || "")
    .replace(/(?:附件|链接|地址|网址|文件)\s*(?:是|为|:|：)\s*[^\n，,。！？!?.；;]+/g, "")
    .replace(/https?:\/\/[^\s，,。！？!?.；;]+/gi, "")
    .trim();
}

function extractAssigneeName(text) {
  const raw = String(text || "").trim();
  const patterns = [
    /(?:盯梢|盯一下|盯一盯|盯下|盯|催|提醒)\s*@?([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_.@-]{1,7})(?=\s*(?:处理|完成|跟进|确认|检查|看下|看一下|推进|做|办|更新|修复))/,
    /(?:盯梢|盯一下|盯一盯|盯下|盯|催|提醒)\s*@?([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_.@-]{1,31})/,
    /(?:负责人|被盯梢人|对象|同事|找|向|提醒|催)\s*(?:是|为|叫|:|：)?\s*@?([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_.@-]{1,31})/,
    /@([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_.@-]{1,31})/
  ];
  const stopWords = new Set(["这个", "那个", "一个", "一下", "一次", "任务", "内容", "事项", "进度", "项目", "需求", "人"]);
  for (const pattern of patterns) {
    const matched = raw.match(pattern);
    if (matched && matched[1]) {
      const name = matched[1].replace(/[，,。！？!?.；;：:]$/g, "").trim();
      if (name && !stopWords.has(name)) {
        return name;
      }
    }
  }
  return "";
}

function stripIntervalText(text) {
  return stripRemarkText(stripOneTimeText(text))
    .replace(WORKDAY_SCHEDULE_GLOBAL_REGEXP, "")
    .replace(DAILY_WORKDAY_SCHEDULE_GLOBAL_REGEXP, "")
    .replace(/(?:每天|每日|天天)\s*(?:上午|早上|下午|晚上|中午)?\s*\d{1,2}(?:(?:[:：]\s*\d{1,2})|(?:[点时]\s*\d{0,2}\s*分?))?/g, "")
    .replace(/(?:每天|每日|天天)(?:一次|盯一次|提醒一次|收集一次)?/g, "")
    .replace(/(?:每\s*)?(?:周|星期|礼拜)\s*[一二三四五六日天1-7]\s*(?:上午|早上|下午|晚上|中午)?\s*\d{0,2}(?:(?:[:：]\s*\d{1,2})|(?:[点时]\s*\d{0,2}\s*分?))?/g, "")
    .replace(/(?:每隔|每|间隔)?\s*\d+(?:\.\d+)?\s*(?:分钟|分|小时|个小时|h|H|天|日)(?:一次|盯一次|盯一下|盯梢一次|提醒一次|收集一次)?/g, "")
    .replace(/[，,。！？!?.；;：:]+$/g, "")
    .trim();
}

function extractTaskContent(text, assigneeName) {
  const raw = stripRemarkText(stripAttachmentText(String(text || "").trim()));
  const explicit = raw.match(/(?:任务|内容|事项|目标|事情)\s*(?:是|为|:|：)\s*([\s\S]+)$/);
  if (explicit && explicit[1]) {
    return truncate(stripIntervalText(explicit[1]), 300);
  }
  let cleaned = stripIntervalText(raw)
    .replace(/^(?:请|帮我|麻烦)?\s*/, "")
    .replace(/(?:创建|新建)?\s*(?:一个|一条)?\s*盯梢(?:任务|系统)?/g, "")
    .replace(/(?:盯梢|盯一下|盯一盯|盯下|盯|催|提醒)/g, "")
    .replace(/(?:负责人|被盯梢人|对象|同事|找|向|提醒|催)\s*(?:是|为|叫|:|：)?/g, "")
    .replace(/[，,。！？!?.；;：:]+/g, " ")
    .trim();
  if (assigneeName) {
    cleaned = cleaned.replace(new RegExp(assigneeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "").trim();
  }
  cleaned = cleaned.replace(/^(?:我要知道|我想知道|需要知道|确认|看看|看下|看一下)\s*/g, "").trim();
  return truncate(cleaned, 300);
}

function parseWatchdogFormFields(text) {
  const result = {};
  const raw = String(text || "");
  const lines = raw.split(/\r?\n|[；;]/).map((line) => line.trim()).filter(Boolean);
  const patterns = [
    { key: "assigneeName", pattern: /^(?:被盯梢人|盯梢人|对象|负责人|同事)\s*(?:是|为|:|：)\s*(.+)$/ },
    { key: "content", pattern: /^(?:盯梢任务|任务|内容|事项|目标|事情)\s*(?:是|为|:|：)\s*(.+)$/ },
    { key: "dueText", pattern: /^(?:一次性时间|提醒时间|盯梢日期|时间节点)\s*(?:是|为|:|：)\s*(.+)$/ },
    { key: "intervalText", pattern: /^(?:盯梢间隔|盯梢时间|间隔|频率|时间)\s*(?:是|为|:|：)\s*(.+)$/ },
    { key: "remark", pattern: /^(?:备注|说明|补充说明)\s*(?:是|为|:|：)\s*(.+)$/ },
    { key: "attachment", pattern: /^(?:附件|链接|地址|网址|文件)\s*(?:是|为|:|：)\s*(.+)$/ }
  ];
  for (const line of lines) {
    for (const item of patterns) {
      const matched = line.match(item.pattern);
      if (matched && matched[1]) {
        result[item.key] = matched[1].trim();
      }
    }
  }
  if (!result.attachment) {
    result.attachment = extractAttachment(raw);
  }
  if (!result.remark) {
    result.remark = extractRemark(raw);
  } else {
    result.remark = normalizeRemark(result.remark);
  }
  return result;
}

function looksLikeWatchdogFormText(text) {
  return /(?:被盯梢人|盯梢人|盯梢任务|盯梢间隔|盯梢时间|提醒时间|一次性时间|时间节点|附件)\s*(?:是|为|:|：)/.test(String(text || ""));
}

function looksLikeWatchdogHelpText(text) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    return false;
  }
  return /(?:怎么|如何|怎样).{0,10}(?:盯梢|定时提醒|提醒同事)/.test(rawText)
    || /(?:盯梢|定时提醒).{0,10}(?:怎么用|如何用|怎样用|用法|说明|格式|填写|模式)/.test(rawText);
}

function looksLikeVersionSummaryQueryText(text) {
  const rawText = String(text || "").trim();
  if (!rawText || !/版本/.test(rawText)) {
    return false;
  }
  if (/(?:系统版本|应用版本|机器人版本|EA版本|H5版本|版本号)/i.test(rawText)) {
    return false;
  }
  const hasProject = /(?:高校|恶魔高校|一骑|一骑当千|女王|女王之刃|QB|噬血|噬血代码)/i.test(rawText);
  const hasTimeRange = /(?:今天|今日|昨天|明天|本周|这周|这个星期|上周|本月|这个月|当月|上月|本季度|这季度|今年|本年|去年|\d{4}\s*(?:年|[-/.])\s*\d{1,2}|\d{1,2}\s*月)/.test(rawText);
  const asksVersion = /(?:有(?:哪些|什么|啥)?版本|版本(?:么|吗|有哪些|有什么|有啥|列表|统计|情况)|几个版本|多少版本|哪几个版本)/.test(rawText);
  return asksVersion || hasProject || hasTimeRange;
}

function looksLikeDemandCollaborationEntryText(text) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    return false;
  }
  return /^(?:打开|进入|访问|查看|发我|发一下|给我|我要|来个)?\s*(?:需求协作|需求待办|需求H5|需求h5|需求页面|需求入口)/.test(rawText);
}

function looksLikeKnownNonWatchdogCommandText(text) {
  return looksLikeVersionSummaryQueryText(text)
    || looksLikeDemandCollaborationEntryText(text);
}

function looksLikeRescheduleInstructionText(text) {
  const rawText = normalizeText(text);
  if (!rawText) {
    return false;
  }
  return /(?:下次|下一次|下回|下轮).{0,12}(?:盯梢|提醒|时间|迭代)/.test(rawText)
    || /(?:补|填|填写|设置|修改|更新|调整|改到|改成|改为).{0,12}(?:下次|下一次|下回|下轮).{0,12}(?:盯梢|提醒|时间|迭代)?/.test(rawText)
    || /(?:盯梢|提醒).{0,8}(?:改到|改成|改为|调整到|设置为|更新为).{0,20}(?:今天|今日|明天|后天|\d{1,2}\s*月|\d{4}[-/.])/.test(rawText);
}

function looksLikeRemarkUpdateText(text) {
  const rawText = normalizeText(text);
  if (!rawText) {
    return false;
  }
  return /(?:备注|说明|补充说明)\s*(?:是|为|叫|改成|改为|更新为|设为|换成|:|：)?\s*\S+/.test(rawText)
    || /(?:清空|删除|去掉|移除).{0,6}(?:备注|说明|补充说明)/.test(rawText);
}

function remarkFromUpdateText(text) {
  const rawText = normalizeText(text);
  if (/(?:清空|删除|去掉|移除).{0,6}(?:备注|说明|补充说明)/.test(rawText)) {
    return "";
  }
  return extractRemark(rawText);
}

function samePersonName(left, right) {
  const leftText = normalizeText(left).toLowerCase();
  const rightText = normalizeText(right).toLowerCase();
  return Boolean(leftText && rightText && leftText === rightText);
}

function mentionsDifferentAssignee(text, task = {}) {
  const fields = parseWatchdogFormFields(text);
  const mentioned = fields.assigneeName || extractAssigneeName(text);
  if (!mentioned || isSelfName(mentioned)) {
    return false;
  }
  return !samePersonName(mentioned, task.assigneeName)
    && !samePersonName(mentioned, task.assigneeUserId);
}

function looksLikeStandaloneWatchdogCommandText(text, currentTask = {}) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    return false;
  }
  const fields = parseWatchdogFormFields(rawText);
  if (looksLikeRescheduleInstructionText(rawText)) {
    return false;
  }
  if (looksLikeWatchdogHelpText(rawText)) {
    return true;
  }
  if (/(?:取消|停止|删除|关闭|停掉|终止|不再|别再).{0,16}(?:盯梢|定时提醒)/.test(rawText)
    || /(?:盯梢|定时提醒).{0,16}(?:取消|停止|删除|关闭|停掉|终止|不再|别再)/.test(rawText)) {
    return true;
  }
  if (/(?:盯梢|定时提醒).{0,16}(?:列表|清单|状态|运行|运作|进行中|正在|多少|几条|几项|有哪些|哪些)/.test(rawText)) {
    return true;
  }
  if (fields.assigneeName && fields.content) {
    return true;
  }
  if ((fields.intervalText || fields.dueText) && (fields.assigneeName || fields.content)) {
    return true;
  }
  if (mentionsDifferentAssignee(rawText, currentTask)) {
    return true;
  }
  return /(?:盯梢|盯一下|盯一盯|盯下|帮我盯|创建.{0,8}盯梢|新建.{0,8}盯梢)/.test(rawText);
}

function isSelfName(value) {
  return /^(?:我|自己|本人)$/.test(String(value || "").trim());
}

function targetFromSender(sender = {}) {
  return sender.userId || sender.chatId || "";
}

function statusLabel(key) {
  const labels = {
    ea_watch_done: "已完成",
    ea_watch_progress: "正常推进",
    ea_watch_blocked: "遇到困难",
    ea_watch_delay: "需要延期"
  };
  return labels[key] || key || "";
}

function appSituationSelection() {
  return {
    question_key: APP_SITUATION_QUESTION_KEY,
    title: "当前情况",
    selected_id: "none",
    option_list: APP_SITUATION_OPTIONS.map((item) => ({
      id: item.id,
      text: item.text
    }))
  };
}

function appSituationFromSelectedItems(selectedItems) {
  const item = (Array.isArray(selectedItems) ? selectedItems : []).find((candidate) => (
    normalizeText(candidate && (candidate.questionKey || candidate.question_key)) === APP_SITUATION_QUESTION_KEY
  ));
  const optionIds = Array.isArray(item && item.optionIds)
    ? item.optionIds
    : (Array.isArray(item && item.option_ids) ? item.option_ids : []);
  const selectedId = normalizeText(optionIds[0]);
  const selected = APP_SITUATION_OPTIONS.find((option) => option.id === selectedId);
  return selected || APP_SITUATION_OPTIONS[0];
}

function initialActionLabel(key) {
  const labels = {
    ea_watch_initial_received: "收到",
    ea_watch_initial_reject: "拒绝"
  };
  return labels[key] || key || "";
}

function draftActionLabel(key) {
  const labels = {
    ea_watch_draft_confirm: "确认创建",
    ea_watch_draft_edit: "补充信息",
    ea_watch_draft_cancel: "取消"
  };
  return labels[key] || key || "";
}

function controlActionLabel(key) {
  const labels = {
    ea_watch_control_cancel: "取消盯梢",
    ea_watch_control_confirm_cancel: "确认取消",
    ea_watch_control_keep: "继续盯梢"
  };
  return labels[key] || key || "";
}

function rescheduleActionLabel(key) {
  const labels = {
    ea_watch_set_next_time: "填写下次时间"
  };
  return labels[key] || key || "";
}

function isWatchdogTaskId(taskCardId) {
  return String(taskCardId || "").startsWith("ea_watch_");
}

function isWatchdogDraftTaskId(taskCardId) {
  return String(taskCardId || "").startsWith("ea_watch_draft_");
}

function isWatchdogInitialTaskId(taskCardId) {
  return String(taskCardId || "").startsWith("ea_watch_initial_");
}

function isWatchdogControlTaskId(taskCardId) {
  return String(taskCardId || "").startsWith("ea_watch_control_");
}

function isWatchdogRescheduleTaskId(taskCardId) {
  return String(taskCardId || "").startsWith("ea_watch_reschedule_");
}

function parseWatchdogCardTaskId(taskCardId) {
  const text = String(taskCardId || "");
  if (!isWatchdogTaskId(text)) {
    return "";
  }
  return text.replace(/^ea_watch_/, "").replace(/_\d+$/, "");
}

function parseWatchdogDraftCardTaskId(taskCardId) {
  const text = String(taskCardId || "");
  if (!isWatchdogDraftTaskId(text)) {
    return "";
  }
  return text.replace(/^ea_watch_draft_/, "").replace(/_\d+$/, "");
}

function parseWatchdogInitialCardTaskId(taskCardId) {
  const text = String(taskCardId || "");
  if (!isWatchdogInitialTaskId(text)) {
    return "";
  }
  return text.replace(/^ea_watch_initial_/, "").replace(/_\d+$/, "");
}

function parseWatchdogControlCardTaskId(taskCardId) {
  const text = String(taskCardId || "");
  if (!isWatchdogControlTaskId(text)) {
    return "";
  }
  return text.replace(/^ea_watch_control_/, "").replace(/_\d+$/, "");
}

function parseWatchdogRescheduleCardTaskId(taskCardId) {
  const text = String(taskCardId || "");
  if (!isWatchdogRescheduleTaskId(text)) {
    return "";
  }
  return text.replace(/^ea_watch_reschedule_/, "").replace(/_\d+$/, "");
}

function missingDraftFields(draft) {
  const missing = [];
  if (!String(draft.assigneeName || "").trim()) {
    missing.push("被盯梢人");
  }
  if (!String(draft.content || "").trim()) {
    missing.push("任务");
  }
  if (String(draft.mode || "recurring") === "once") {
    if (!String(draft.dueAt || "").trim()) {
      missing.push("提醒时间");
    }
  } else if (!Number(draft.intervalMinutes || 0) && !recurringScheduleDisplay(draft.recurringSchedule)) {
    missing.push("盯梢间隔");
  }
  return missing;
}

function formTemplateText(draft = {}) {
  return [
    "请按下面格式补充盯梢信息：",
    `被盯梢人：${draft.assigneeName || ""}`,
    `盯梢任务：${draft.content || ""}`,
    String(draft.mode || "recurring") === "once"
      ? `提醒时间：${draft.dueAt ? formatLocalMinute(draft.dueAt) : ""}`
      : `盯梢间隔：${recurringScheduleDisplay(draft.recurringSchedule) || (draft.intervalMinutes ? intervalDisplay(draft.intervalMinutes) : "3小时一次")}`,
    `备注：${draft.remark || ""}`,
    `附件：${draft.attachment || "无"}`,
    "固定时间可以写：每天 10:00、工作日 11:00，或：每周一 16:00。",
    "一次性盯梢可以把“盯梢间隔”改成“提醒时间：5月26日 10:00”。"
  ].join("\n");
}

function createDraftCard(draft, cardTaskId) {
  const missing = missingDraftFields(draft);
  return {
    card_type: "button_interaction",
    source: {
      desc: "EA盯梢",
      desc_color: missing.length ? 2 : 0
    },
    main_title: {
      title: missing.length ? "请补充盯梢信息" : "请确认盯梢信息",
      desc: missing.length ? `缺少：${missing.join("、")}` : "确认后会给被盯梢人发送确认卡片，之后按间隔发送进度卡片。"
    },
    card_action: {
      type: 1,
      url: "https://work.weixin.qq.com"
    },
    horizontal_content_list: [
      {
        keyname: "被盯梢人",
        value: draft.assigneeName || "待填写"
      },
      {
        keyname: "任务",
        value: draft.content ? truncate(draft.content, 60) : "待填写"
      },
      {
        keyname: "备注",
        value: draft.remark ? truncate(draft.remark, 60) : "无"
      },
      {
        keyname: String(draft.mode || "recurring") === "once" ? "提醒时间" : "盯梢间隔",
        value: String(draft.mode || "recurring") === "once"
          ? (draft.dueAt ? formatLocalMinute(draft.dueAt) : "待填写")
          : (recurringScheduleDisplay(draft.recurringSchedule) || (draft.intervalMinutes ? intervalDisplay(draft.intervalMinutes) : "3小时一次"))
      },
      {
        keyname: "附件",
        value: draft.attachment || "无"
      }
    ],
    button_list: [
      { text: "确认创建", key: "ea_watch_draft_confirm", style: 1 },
      { text: "补充信息", key: "ea_watch_draft_edit", style: 2 },
      { text: "取消", key: "ea_watch_draft_cancel", style: 3 }
    ],
    task_id: cardTaskId
  };
}

function createInitialAckCard(task, cardTaskId) {
  const contents = [
    watchdogTaskIdCardItem(task),
    {
      keyname: "发起人",
      value: requesterDisplayName(task)
    },
      {
      keyname: "盯梢时间",
      value: scheduleDisplay(task)
    }
  ].filter(Boolean);
  const remark = remarkCardItem(task);
  if (remark) {
    contents.push(remark);
  }
  if (task.attachment) {
    contents.push({
      keyname: "附件",
      value: truncate(task.attachment, 60)
    });
  }
  return {
    card_type: "button_interaction",
    source: {
      desc: "EA盯梢",
      desc_color: 0
    },
    main_title: {
      title: "请确认盯梢任务",
      desc: truncate(task.content, 60)
    },
    card_action: {
      type: 1,
      url: "https://work.weixin.qq.com"
    },
    horizontal_content_list: contents,
    button_list: [
      { text: "收到", key: "ea_watch_initial_received", style: 1 },
      { text: "拒绝", key: "ea_watch_initial_reject", style: 2 }
    ],
    task_id: cardTaskId
  };
}

function createProgressCard(task, cardTaskId) {
  const contents = [
    watchdogTaskIdCardItem(task),
    {
      keyname: "发起人",
      value: requesterDisplayName(task)
    },
    {
      keyname: "频率",
      value: isOneTimeTask(task) ? "一次性提醒" : scheduleDisplay(task)
    },
    {
      keyname: "创建时间",
      value: formatLocalMinute(task.createdAt)
    }
  ].filter(Boolean);
  const remark = remarkLine(task);
  return {
    card_type: "button_interaction",
    source: {
      desc: "EA盯梢",
      desc_color: 0
    },
    main_title: {
      title: truncate(task.content, 60),
      desc: remark ? truncate(remark, 60) : ""
    },
    card_action: {
      type: 1,
      url: "https://work.weixin.qq.com"
    },
    horizontal_content_list: contents,
    button_list: [
      { text: "已完成", key: "ea_watch_done", style: 1 },
      { text: "正常推进", key: "ea_watch_progress", style: 1 },
      { text: "遇到困难", key: "ea_watch_blocked", style: 2 },
      { text: "需要延期", key: "ea_watch_delay", style: 3 }
    ],
    task_id: cardTaskId
  };
}

function createControlCard(task, cardTaskId) {
  const contents = [
    watchdogTaskIdCardItem(task),
    {
      keyname: "被盯梢人",
      value: task.assigneeName || task.assigneeUserId || "未知"
    },
    {
      keyname: isOneTimeTask(task) ? "提醒时间" : "盯梢间隔",
      value: scheduleDisplay(task)
    },
    {
      keyname: "创建时间",
      value: formatLocalMinute(task.createdAt)
    }
  ].filter(Boolean);
  const remark = remarkCardItem(task);
  if (remark) {
    contents.push(remark);
  }
  return {
    card_type: "button_interaction",
    source: {
      desc: "EA盯梢",
      desc_color: 0
    },
    main_title: {
      title: truncate(task.content, 60),
      desc: ""
    },
    card_action: {
      type: 1,
      url: "https://work.weixin.qq.com"
    },
    horizontal_content_list: contents,
    button_list: [
      { text: "取消盯梢", key: "ea_watch_control_cancel", style: 3 }
    ],
    task_id: cardTaskId
  };
}

function controlCancelConfirmCard(task) {
  return {
    card_type: "button_interaction",
    source: {
      desc: "EA盯梢",
      desc_color: 2
    },
    main_title: {
      title: "确认取消盯梢？",
      desc: truncate(task.content, 60)
    },
    card_action: {
      type: 1,
      url: "https://work.weixin.qq.com"
    },
    horizontal_content_list: [
      watchdogTaskIdCardItem(task),
      {
        keyname: "被盯梢人",
        value: task.assigneeName || task.assigneeUserId || "未知"
      },
      {
        keyname: "下次盯梢",
        value: task.nextRunAt ? formatLocalMinute(task.nextRunAt) : (task.awaitingRescheduleFrom ? "等待补充时间" : "无")
      }
    ].filter(Boolean),
    button_list: [
      { text: "确认取消", key: "ea_watch_control_confirm_cancel", style: 2 },
      { text: "先不取消", key: "ea_watch_control_keep", style: 1 }
    ]
  };
}

function createRequesterRescheduleCard(task, label, cardTaskId) {
  const contents = [
    watchdogTaskIdCardItem(task),
    {
      keyname: "任务",
      value: truncate(task.content, 60)
    },
    {
      keyname: "状态",
      value: "等待补充下次盯梢时间"
    },
    {
      keyname: "当前下次",
      value: task.nextRunAt ? formatLocalMinute(task.nextRunAt) : "待补充"
    }
  ].filter(Boolean);
  const remark = remarkCardItem(task);
  if (remark) {
    contents.push(remark);
  }
  return {
    card_type: "button_interaction",
    source: {
      desc: "EA盯梢反馈",
      desc_color: 0
    },
    main_title: {
      title: `${task.assigneeName || task.assigneeUserId || "未知"} 反馈：${label}`,
      desc: truncate(task.content, 60)
    },
    card_action: {
      type: 1,
      url: "https://work.weixin.qq.com"
    },
    horizontal_content_list: contents,
    button_list: [
      { text: "填写下次时间", key: "ea_watch_set_next_time", style: 1 }
    ],
    task_id: cardTaskId
  };
}

function initialAckCardUpdate(title, desc, color = 0) {
  return {
    card_type: "text_notice",
    source: {
      desc: "EA盯梢",
      desc_color: color
    },
    main_title: {
      title,
      desc
    },
    card_action: {
      type: 1,
      url: "https://work.weixin.qq.com"
    }
  };
}

function controlCardUpdate(title, desc, color = 0) {
  return {
    card_type: "text_notice",
    source: {
      desc: "EA盯梢",
      desc_color: color
    },
    main_title: {
      title,
      desc
    },
    card_action: {
      type: 1,
      url: "https://work.weixin.qq.com"
    }
  };
}

function rescheduleCardUpdate(title, desc, color = 0) {
  return {
    card_type: "text_notice",
    source: {
      desc: "EA盯梢反馈",
      desc_color: color
    },
    main_title: {
      title,
      desc
    },
    card_action: {
      type: 1,
      url: "https://work.weixin.qq.com"
    }
  };
}

function cardUpdateForResponse(task, label, options = {}) {
  if (options.denied) {
    return {
      card_type: "text_notice",
      source: { desc: "EA盯梢", desc_color: 2 },
      main_title: { title: "无反馈权限", desc: "只有被盯梢人可以反馈这条任务。" },
      card_action: { type: 1, url: "https://work.weixin.qq.com" }
    };
  }
  if (options.duplicate) {
    return {
      card_type: "text_notice",
      source: { desc: "EA盯梢", desc_color: 3 },
      main_title: { title: "反馈已记录", desc: "请勿重复提交这条盯梢反馈。" },
      card_action: { type: 1, url: "https://work.weixin.qq.com" }
    };
  }
  const completed = task.status === "completed";
  const nativeApp = options.source === "wecom-app-native";
  const note = normalizeText(options.note);
  const recorded = `已记录：${label}${note ? `；当前情况：${note}` : ""}。`;
  const nextStep = completed
    ? "这条任务已停止盯梢。"
    : task.awaitingRescheduleFrom
      ? (nativeApp
        ? "请联系发起人另行设置下一次提醒时间。"
        : "请在对话里补充新的提醒时间，或回复循环时间。")
      : "下次会继续按间隔盯梢。";
  return {
    card_type: "text_notice",
    source: {
      desc: "EA盯梢",
      desc_color: completed ? 3 : 0
    },
    main_title: {
      title: completed ? "盯梢已完成" : "进度已收到",
      desc: recorded
    },
    sub_title_text: nextStep,
    card_action: {
      type: 1,
      url: "https://work.weixin.qq.com"
    }
  };
}

function draftCardUpdate(title, desc, color = 0) {
  return {
    card_type: "text_notice",
    source: {
      desc: "EA盯梢",
      desc_color: color
    },
    main_title: {
      title,
      desc
    },
    card_action: {
      type: 1,
      url: "https://work.weixin.qq.com"
    }
  };
}

function rejectReasonPromptText(task) {
  return [
    "请回复拒绝理由，我会反馈给发起人。",
    `任务：${task.content}`,
    watchdogTaskIdLine(task)
  ].join("\n");
}

function rejectReasonNoticeText(task) {
  const assignee = task.assigneeName || task.assigneeUserId || "未知";
  return [
    "【EA盯梢反馈】",
    `**任务：${task.content}**`,
    `**${assignee}** 反馈：**拒绝盯梢**`,
    remarkLine(task),
    `理由：${task.rejectReason || "未填写"}`,
    watchdogTaskIdLine(task)
  ].filter(Boolean).join("\n");
}

function resultNoticeText(task, label) {
  const assignee = task.assigneeName || task.assigneeUserId || "未知";
  const headline = task.status === "completed" ? "【EA盯梢已完成】" : "【EA盯梢反馈】";
  const nextText = task.status === "completed"
    ? "状态：已完成，盯梢已停止"
    : task.awaitingRescheduleFrom
      ? "状态：等待补充下次盯梢时间\n操作：可点反馈卡片里的“填写下次时间”，或直接回复“下次盯梢时间 6月24日 16:00”"
      : task.nextRunAt
        ? `下次盯梢：${formatLocalMinute(task.nextRunAt)}`
        : "下次盯梢：待补充";
  const remarkHint = task.status === "completed"
    ? ""
    : "如需修改备注，可直接回复：备注：新的备注内容。";
  return [
    headline,
    `**任务：${task.content}**`,
    `**${assignee}** 反馈：**${label}**`,
    remarkLine(task),
    task.lastFeedbackNote ? `说明：${task.lastFeedbackNote}` : "",
    nextText,
    remarkHint,
    watchdogTaskIdLine(task)
  ].filter(Boolean).join("\n");
}

function cancelNoticeToAssigneeText(task) {
  return [
    "【EA盯梢通知】",
    `${requesterDisplayName(task)} 已取消这条盯梢。`,
    `任务：${task.content}`,
    watchdogTaskIdLine(task),
    remarkLine(task)
  ].filter(Boolean).join("\n");
}

function dueBatchSummaryText(tasks = []) {
  const safeTasks = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  const assignee = safeTasks[0]
    ? (safeTasks[0].assigneeName || safeTasks[0].assigneeUserId || "同事")
    : "同事";
  return [
    "【EA盯梢提醒】",
    `${assignee}，你有 ${safeTasks.length} 条盯梢同时到点。`,
    "我会按发送队列错峰发送可反馈卡片，避免企业微信频率限制。",
    ...safeTasks.slice(0, 8).map((task, index) => {
      const typeText = !task.firstReminderSentAt || (task.initialAckRequired && !task.initialAckCardSentAt)
        ? "首次确认"
        : "进度反馈";
      return `${index + 1}. ${truncate(task.content, 42)}｜任务ID：${watchdogTaskId(task)}｜${typeText}｜${scheduleDisplay(task)}`;
    }),
    safeTasks.length > 8 ? `还有 ${safeTasks.length - 8} 条未展开。` : ""
  ].filter(Boolean).join("\n");
}

function cancelTaskSummary(task) {
  return `${task.assigneeName || task.assigneeUserId || "未知"}｜${truncate(task.content, 48)}｜任务ID：${watchdogTaskId(task)}｜${scheduleDisplay(task)}`;
}

function cancelConfirmText(task) {
  return [
    "请确认是否取消这条盯梢：",
    `对象：${task.assigneeName || task.assigneeUserId || "未知"}`,
    `任务：${task.content}`,
    watchdogTaskIdLine(task),
    remarkLine(task),
    `盯梢时间：${scheduleDisplay(task)}`,
    "回复“确认”执行，回复“取消”放弃。"
  ].filter(Boolean).join("\n");
}

function cancelCandidatesText(tasks) {
  return [
    "找到多条进行中的盯梢，请回复编号、对象或任务关键词：",
    ...tasks.slice(0, 8).map((task, index) => `${index + 1}. ${cancelTaskSummary(task)}`),
    tasks.length > 8 ? `还有 ${tasks.length - 8} 条，请补充更具体的对象或任务关键词。` : ""
  ].filter(Boolean).join("\n");
}

function cancelDoneText(task) {
  return [
    "已取消盯梢。",
    `对象：${task.assigneeName || task.assigneeUserId || "未知"}`,
    `任务：${task.content}`,
    watchdogTaskIdLine(task),
    remarkLine(task)
  ].filter(Boolean).join("\n");
}

function oneTimeReschedulePromptText(task) {
  return [
    "这条一次性盯梢还没有结束。",
    "请回复新的提醒时间，例如：5月28日 18:00。",
    "也可以回复循环时间，例如：每2小时一次、每天 10:00、工作日 11:00、每周一 16:00。",
    "如需修改备注，可回复：备注：新的备注内容。",
    `任务：${task.content}`,
    watchdogTaskIdLine(task)
  ].join("\n");
}

function requesterReschedulePromptText(task) {
  return [
    "请回复新的下次盯梢时间，例如：6月24日 16:00。",
    "也可以回复循环时间，例如：每2小时一次、每天 10:00、工作日 11:00、每周一 16:00。",
    "如需修改备注，可回复：备注：新的备注内容。",
    `任务：${task.content}`,
    watchdogTaskIdLine(task)
  ].join("\n");
}

function watchdogHelpText() {
  return [
    "盯梢有两种模式：",
    "",
    "1. 循环盯梢：一直按固定间隔提醒，直到对方点“已完成”或发起人取消。",
    "示例：盯梢李猛，任务是首充礼包联调，1小时一次",
    "固定时间示例：每天 10:00 盯梢李猛处理首充礼包",
    "工作日示例：工作日每天 11点 盯梢李猛处理首充礼包",
    "固定星期示例：每周一 16:00 盯梢李猛处理周报",
    "固定格式：",
    "被盯梢人：李猛",
    "盯梢任务：首充礼包联调",
    "盯梢间隔：1小时一次 / 每天 10:00 / 工作日 11:00 / 每周一 16:00",
    "备注：优先确认联调阻塞点",
    "附件：无",
    "",
    "2. 一次性盯梢：只在指定时间提醒一次。",
    "示例：5月26日 10:00 提醒李猛处理首充礼包",
    "固定格式：",
    "被盯梢人：李猛",
    "盯梢任务：处理首充礼包",
    "提醒时间：5月26日 10:00",
    "备注：到点前确认是否已处理",
    "附件：无",
    "",
    "一次性盯梢到点后，如果任务没结束，被盯梢人可以回复新的时间，例如“5月28日 18:00”，也可以回复“每2小时一次 / 每天 10:00 / 工作日 11:00 / 每周一 16:00”改成循环盯梢。",
    "发起人收到盯梢反馈后，可以回复“备注：新的备注内容”更新备注，任务会继续按原规则盯梢。"
  ].join("\n");
}

function watchdogCreateHintText(reason) {
  return [
    reason,
    "循环盯梢示例：盯梢李猛，任务是首充礼包联调，1小时一次。",
    "一次性盯梢示例：5月26日 10:00 提醒李猛处理首充礼包。",
    "也可以问我：怎么盯梢。"
  ].join("\n");
}

function statusCounts(tasks) {
  const counts = {
    active: 0,
    completed: 0,
    canceled: 0,
    rejected: 0,
    rejectedPendingReason: 0,
    other: 0
  };
  for (const task of tasks) {
    if (task.status === "active") {
      counts.active += 1;
    } else if (task.status === "completed") {
      counts.completed += 1;
    } else if (task.status === "canceled") {
      counts.canceled += 1;
    } else if (task.status === "rejected") {
      counts.rejected += 1;
    } else if (task.status === "rejected_pending_reason") {
      counts.rejectedPendingReason += 1;
    } else {
      counts.other += 1;
    }
  }
  return counts;
}

function activeTaskListLine(task, index) {
  const nextRun = task.nextRunAt ? formatLocalMinute(task.nextRunAt) : (task.awaitingRescheduleFrom ? "等待补时间" : "待发送");
  const requester = requesterDisplayName(task);
  const assignee = task.assigneeName || task.assigneeUserId || "未知";
  const modeText = isOneTimeTask(task) ? "一次性" : "循环";
  const remark = taskRemarkText(task);
  return [
    `${index + 1}. ${assignee}`,
    truncate(task.content, 42),
    modeText,
    `发起人：${requester}`,
    `任务ID：${watchdogTaskId(task)}`,
    `下次：${nextRun}`,
    remark ? `备注：${truncate(remark, 28)}` : ""
  ].filter(Boolean).join("｜");
}

function activeTaskSummary(task) {
  return {
    id: task.id,
    assigneeName: task.assigneeName || "",
    assigneeUserId: task.assigneeUserId || "",
    requesterName: requesterDisplayName(task),
    requesterUserId: task.requesterUserId || "",
    content: task.content || "",
    remark: taskRemarkText(task),
    mode: task.mode || "recurring",
    intervalMinutes: task.intervalMinutes || 0,
    recurringSchedule: task.recurringSchedule || null,
    dueAt: task.dueAt || "",
    nextRunAt: task.nextRunAt || "",
    createdAt: task.createdAt || ""
  };
}

function cancelSearchText(text) {
  return normalizeText(text)
    .replace(/(?:请|帮我|麻烦|顺便|把|将|这个|这条|一下)/g, " ")
    .replace(/(?:取消|停止|删除|关闭|停掉|终止|不再|别再|不用|不要)/g, " ")
    .replace(/(?:盯梢|定时提醒|提醒|任务|系统)/g, " ")
    .replace(/[，,。！？!?.；;：:、]+/g, " ")
    .trim();
}

function rescheduleSearchText(text) {
  return stripIntervalText(text)
    .replace(/(?:请|帮我|麻烦|顺便|把|将|这个|这条|一下)/g, " ")
    .replace(/(?:下次|下一次|下回|下轮|补|填|填写|设置|修改|更新|调整|改到|改成|改为)/g, " ")
    .replace(/(?:盯梢|定时提醒|提醒|任务|系统|时间|日期|迭代)/g, " ")
    .replace(/[，,。！？!?.；;：:、]+/g, " ")
    .trim();
}

function compactText(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, "");
}

function taskCancelHaystack(task) {
  return compactText([
    `${task.assigneeName || ""}${task.content || ""}`,
    task.id,
    task.assigneeName,
    task.assigneeUserId,
    task.content,
    task.remark,
    task.attachment
  ].filter(Boolean).join(" "));
}

function taskMatchesCancelKeyword(task, keyword) {
  const cleaned = cancelSearchText(keyword);
  if (!cleaned) {
    return true;
  }
  const haystack = taskCancelHaystack(task);
  const compactKeyword = compactText(cleaned);
  if (compactKeyword && haystack.includes(compactKeyword)) {
    return true;
  }
  const tokens = uniqueNonEmpty(cleaned.split(/\s+/)).map(compactText).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function taskMatchesRescheduleKeyword(task, keyword) {
  const cleaned = rescheduleSearchText(keyword);
  if (!cleaned) {
    return false;
  }
  const haystack = taskCancelHaystack(task);
  const compactKeyword = compactText(cleaned);
  if (compactKeyword && haystack.includes(compactKeyword)) {
    return true;
  }
  const tokens = uniqueNonEmpty(cleaned.split(/\s+/)).map(compactText).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function requesterMatchesSender(task, sender = {}) {
  const senderTarget = targetFromSender(sender);
  const senderUserId = sender.userId || "";
  return Boolean(
    (task.requesterTargetId && senderTarget && task.requesterTargetId === senderTarget)
    || (task.requesterUserId && senderUserId && task.requesterUserId === senderUserId)
  );
}

function taskTerminalNotice(task) {
  if (task.status === "canceled") {
    return controlCardUpdate("盯梢已取消", "这条任务已停止盯梢。", 2);
  }
  if (task.status === "completed") {
    return controlCardUpdate("盯梢已完成", "这条任务已停止盯梢。", 3);
  }
  if (task.status === "rejected" || task.status === "rejected_pending_reason") {
    return controlCardUpdate("盯梢已拒绝", "这条任务不会继续盯梢。", 2);
  }
  return null;
}

function createWatchdogModule(options = {}) {
  const logger = options.logger;
  const stateFile = options.storeFile ? path.resolve(String(options.storeFile)) : storeFile;
  const config = {
    enabled: options.moduleConfig && options.moduleConfig.enabled !== undefined
      ? Boolean(options.moduleConfig.enabled)
      : true,
    defaultIntervalMinutes: Number(options.moduleConfig && options.moduleConfig.defaultIntervalMinutes) || DEFAULT_INTERVAL_MINUTES,
    tickMs: Number(options.moduleConfig && options.moduleConfig.tickMs) || TICK_MS,
    auth: {
      corpIdEnv: options.moduleConfig && options.moduleConfig.auth && options.moduleConfig.auth.corpIdEnv
        ? options.moduleConfig.auth.corpIdEnv
        : "WECOM_DOC_CORP_ID",
      secretEnv: options.moduleConfig && options.moduleConfig.auth && options.moduleConfig.auth.secretEnv
        ? options.moduleConfig.auth.secretEnv
        : "WECOM_DOC_SECRET"
    },
    personAliases: options.moduleConfig && options.moduleConfig.personAliases && typeof options.moduleConfig.personAliases === "object"
      ? options.moduleConfig.personAliases
      : {},
    appPush: {
      enabled: Boolean(options.moduleConfig && options.moduleConfig.appPush && options.moduleConfig.appPush.enabled),
      deliveryMode: "app_only",
      feedbackUrl: normalizeText(options.appFeedbackUrl),
      failureBackoffMs: boundedNumber(
        options.moduleConfig && options.moduleConfig.appPush && options.moduleConfig.appPush.failureBackoffMs,
        5 * 60 * 1000,
        60 * 1000,
        8 * 60 * 60 * 1000
      ),
      testTargetUserId: normalizeText(options.moduleConfig && options.moduleConfig.appPush && options.moduleConfig.appPush.testTargetUserId),
      nativeCardEnabled: Boolean(options.moduleConfig && options.moduleConfig.appPush && options.moduleConfig.appPush.nativeCard && options.moduleConfig.appPush.nativeCard.enabled)
    },
    sendQueue: normalizeSendQueueConfig(options.moduleConfig && options.moduleConfig.sendQueue)
  };
  let robotServer = null;
  const desktopTip = options.desktopTip || null;
  const appNotifier = options.appNotifier || null;
  let timer = null;
  let sending = false;
  let lastWatchdogSendAt = 0;
  let sendBackoffUntil = 0;
  let targetSendBackoffUntil = new Map();
  let frequencyLimitFailureCount = 0;
  let lastBackoffLogAt = 0;
  let watchdogSendTail = Promise.resolve();
  let pendingWatchdogSendCount = 0;
  let watchdogSendSequence = 0;
  let state = readJsonFile(stateFile, { tasks: [] });
  if (!Array.isArray(state.tasks)) {
    state.tasks = [];
  }
  if (!Array.isArray(state.drafts)) {
    state.drafts = [];
  }

  function save() {
    writeJsonAtomic(stateFile, state);
  }

  function dateValueMs(value) {
    const ms = new Date(value || "").getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }

  function sendQueueRuntimeState() {
    if (!state.sendQueueRuntime || typeof state.sendQueueRuntime !== "object" || Array.isArray(state.sendQueueRuntime)) {
      state.sendQueueRuntime = {};
    }
    return state.sendQueueRuntime;
  }

  function persistedTargetBackoffs() {
    return Object.fromEntries(
      [...targetSendBackoffUntil.entries()]
        .filter(([targetId, until]) => targetId && until > Date.now())
        .map(([targetId, until]) => [targetId, new Date(until).toISOString()])
    );
  }

  function persistSendQueueRuntimeState(reason, details = {}) {
    const runtime = sendQueueRuntimeState();
    const nextLastSendAt = lastWatchdogSendAt ? new Date(lastWatchdogSendAt).toISOString() : "";
    const nextGlobalBackoffUntil = sendBackoffUntil ? new Date(sendBackoffUntil).toISOString() : "";
    const nextTargetBackoffs = persistedTargetBackoffs();
    const nextFrequencyLimitFailureCount = Math.max(0, Number(frequencyLimitFailureCount) || 0);
    const currentTargetBackoffs = runtime.targetBackoffUntil && typeof runtime.targetBackoffUntil === "object"
      ? runtime.targetBackoffUntil
      : {};
    const changed = runtime.lastWatchdogSendAt !== nextLastSendAt
      || runtime.globalBackoffUntil !== nextGlobalBackoffUntil
      || Number(runtime.frequencyLimitFailureCount || 0) !== nextFrequencyLimitFailureCount
      || JSON.stringify(currentTargetBackoffs) !== JSON.stringify(nextTargetBackoffs);
    if (!changed) {
      return false;
    }
    runtime.lastWatchdogSendAt = nextLastSendAt;
    runtime.globalBackoffUntil = nextGlobalBackoffUntil;
    runtime.targetBackoffUntil = nextTargetBackoffs;
    runtime.frequencyLimitFailureCount = nextFrequencyLimitFailureCount;
    runtime.updatedAt = new Date().toISOString();
    runtime.lastChangeReason = reason || "update";
    save();
    if (logger && typeof logger.info === "function") {
      logger.info("Watchdog send queue runtime persisted", {
        reason: reason || "update",
        lastWatchdogSendAt: nextLastSendAt,
        globalBackoffUntil: nextGlobalBackoffUntil,
        frequencyLimitFailureCount: nextFrequencyLimitFailureCount,
        targetBackoffCount: Object.keys(nextTargetBackoffs).length,
        ...details
      });
    }
    return true;
  }

  function restoreSendQueueRuntimeState() {
    const runtime = sendQueueRuntimeState();
    lastWatchdogSendAt = dateValueMs(runtime.lastWatchdogSendAt);
    sendBackoffUntil = dateValueMs(runtime.globalBackoffUntil);
    frequencyLimitFailureCount = boundedNumber(runtime.frequencyLimitFailureCount, 0, 0, 20);
    const rawTargetBackoffs = runtime.targetBackoffUntil && typeof runtime.targetBackoffUntil === "object"
      ? runtime.targetBackoffUntil
      : {};
    for (const [targetId, until] of Object.entries(rawTargetBackoffs)) {
      const untilMs = dateValueMs(until);
      if (targetId && untilMs > Date.now()) {
        targetSendBackoffUntil.set(targetId, untilMs);
      }
    }
    if (sendBackoffUntil > Date.now() && logger && typeof logger.warn === "function") {
      logger.warn("Watchdog send queue global backoff restored", {
        globalBackoffUntil: new Date(sendBackoffUntil).toISOString(),
        remainingMs: sendBackoffUntil - Date.now(),
        targetBackoffCount: targetSendBackoffUntil.size,
        frequencyLimitFailureCount
      });
    }
  }

  function frequencyLimitBackoffMsForFailureCount(failureCount) {
    const normalizedCount = Math.max(1, Math.min(20, Number(failureCount) || 1));
    return Math.min(
      config.sendQueue.frequencyLimitMaxBackoffMs,
      config.sendQueue.frequencyLimitBackoffMs * (2 ** (normalizedCount - 1))
    );
  }

  function migrateFrequencyLimitBackoffPolicy() {
    const nowMs = Date.now();
    if (sendBackoffUntil <= nowMs || frequencyLimitFailureCount > 0) {
      return false;
    }
    frequencyLimitFailureCount = 2;
    const upgradedBackoffMs = frequencyLimitBackoffMsForFailureCount(frequencyLimitFailureCount);
    const upgradedUntil = nowMs + upgradedBackoffMs;
    sendBackoffUntil = Math.max(sendBackoffUntil, upgradedUntil);
    for (const [targetId, until] of targetSendBackoffUntil.entries()) {
      targetSendBackoffUntil.set(targetId, Math.max(until, sendBackoffUntil));
    }
    persistSendQueueRuntimeState("migrate_frequency_limit_backoff_policy", {
      frequencyLimitFailureCount,
      backoffMs: upgradedBackoffMs,
      globalBackoffUntil: new Date(sendBackoffUntil).toISOString()
    });
    if (logger && typeof logger.warn === "function") {
      logger.warn("Watchdog send queue frequency backoff policy migrated", {
        frequencyLimitFailureCount,
        backoffMs: upgradedBackoffMs,
        globalBackoffUntil: new Date(sendBackoffUntil).toISOString(),
        reason: "existing_frequency_limit_backoff_without_streak"
      });
    }
    return true;
  }

  function migratePendingFrequencyBackoff() {
    if (sendBackoffUntil > Date.now()) {
      return false;
    }
    const candidates = activeTasks()
      .map((task) => ({
        task,
        retryAtMs: dateValueMs(task.nextRunAt || task.controlCardRetryAt),
        isFrequencyLimited: new RegExp(`\\b${WECOM_SEND_FREQUENCY_ERRCODE}\\b`).test(String(task.lastError || task.controlCardLastError || ""))
      }))
      .filter((item) => item.isFrequencyLimited && item.retryAtMs > Date.now());
    if (candidates.length === 0) {
      return false;
    }
    const latestRetryAtMs = Math.max(...candidates.map((item) => item.retryAtMs));
    const latestCandidates = candidates.filter((item) => item.retryAtMs === latestRetryAtMs);
    sendBackoffUntil = latestRetryAtMs;
    for (const item of latestCandidates) {
      const targetId = targetBackoffKey(item.task.assigneeUserId || item.task.requesterTargetId);
      if (targetId) {
        targetSendBackoffUntil.set(targetId, latestRetryAtMs);
      }
    }
    persistSendQueueRuntimeState("migrate_pending_frequency_backoff", {
      migratedTaskIds: latestCandidates.map((item) => item.task.id),
      globalBackoffUntil: new Date(latestRetryAtMs).toISOString()
    });
    if (logger && typeof logger.warn === "function") {
      logger.warn("Watchdog send queue global backoff migrated from pending tasks", {
        taskIds: latestCandidates.map((item) => item.task.id),
        globalBackoffUntil: new Date(latestRetryAtMs).toISOString(),
        remainingMs: latestRetryAtMs - Date.now()
      });
    }
    return true;
  }

  function migrateLegacyRetryAttemptTimestamps() {
    const nowIso = new Date().toISOString();
    let initialReminderCount = 0;
    let controlCardCount = 0;
    for (const task of activeTasks()) {
      const initialError = String(task.lastError || "");
      if (isPendingInitialReminderLike(task)
        && !dateValueMs(task.initialReminderLastAttemptAt)
        && new RegExp(`\\b${WECOM_SEND_FREQUENCY_ERRCODE}\\b|盯梢发送队列正在退避`).test(initialError)) {
        task.initialReminderLastAttemptAt = task.updatedAt || task.nextRunAt || nowIso;
        initialReminderCount += 1;
      }
      const controlError = String(task.controlCardLastError || task.lastError || "");
      if (needsControlCardRetry(task)
        && !dateValueMs(task.controlCardLastAttemptAt)
        && new RegExp(`\\b${WECOM_SEND_FREQUENCY_ERRCODE}\\b|盯梢发送队列正在退避`).test(controlError)) {
        task.controlCardLastAttemptAt = task.updatedAt || task.controlCardRetryAt || nowIso;
        controlCardCount += 1;
      }
    }
    if (initialReminderCount > 0 || controlCardCount > 0) {
      save();
      if (logger && typeof logger.info === "function") {
        logger.info("Watchdog legacy retry attempts migrated", {
          initialReminderCount,
          controlCardCount,
          strategy: "preserve_recent_new_tasks_before_legacy_retries"
        });
      }
    }
  }

  function activeTasks() {
    return state.tasks.filter((task) => task.status === "active");
  }

  function isPendingInitialReminderLike(task) {
    return Boolean(task
      && task.status === "active"
      && !isOneTimeTask(task)
      && (!task.firstReminderSentAt || (task.initialAckRequired && !task.initialAckCardSentAt)));
  }

  function normalizeBacklogDedupeContent(value) {
    return normalizeText(value)
      .replace(/^(?:任务|事项|内容)\s*(?:是|为|:|：)?\s*/g, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function backlogDedupeKey(task) {
    const requesterKey = task.requesterTargetId || task.requesterUserId || "";
    const assigneeKey = task.assigneeUserId || task.assigneeName || "";
    const contentKey = normalizeBacklogDedupeContent(task.content || "");
    if (!requesterKey || !assigneeKey || !contentKey) {
      return "";
    }
    return `${requesterKey}|${assigneeKey}|${contentKey}`;
  }

  function mergeDuplicatePendingInitialTasks(reason = "startup") {
    const groups = new Map();
    for (const task of state.tasks) {
      if (!isPendingInitialReminderLike(task)) {
        continue;
      }
      const key = backlogDedupeKey(task);
      if (!key) {
        continue;
      }
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(task);
    }

    const nowIso = new Date().toISOString();
    let mergedCount = 0;
    const mergedGroups = [];
    for (const tasks of groups.values()) {
      if (tasks.length <= 1) {
        continue;
      }
      const sorted = tasks.slice().sort((left, right) => {
        const leftTime = new Date(left.createdAt || left.updatedAt || left.nextRunAt).getTime();
        const rightTime = new Date(right.createdAt || right.updatedAt || right.nextRunAt).getTime();
        return rightTime - leftTime;
      });
      const keptTask = sorted[0];
      const duplicateIds = [];
      for (const task of sorted.slice(1)) {
        task.status = "canceled";
        task.nextRunAt = "";
        task.controlCardRetryAt = "";
        task.canceledAt = nowIso;
        task.canceledByUserId = "system";
        task.canceledByName = "系统";
        task.canceledVia = "dedupe_backlog";
        task.dedupedAt = nowIso;
        task.dedupedIntoTaskId = keptTask.id;
        task.dedupedReason = "同一发起人、同一被盯梢人、同一任务内容的首次提醒积压，只保留一条触发";
        task.lastError = `重复积压已合并到盯梢 ${keptTask.id}`;
        task.updatedAt = nowIso;
        duplicateIds.push(task.id);
        mergedCount += 1;
      }
      keptTask.dedupedDuplicateTaskIds = uniqueNonEmpty([...(keptTask.dedupedDuplicateTaskIds || []), ...duplicateIds]);
      keptTask.dedupedAt = nowIso;
      keptTask.updatedAt = nowIso;
      mergedGroups.push({
        keptTaskId: keptTask.id,
        duplicateTaskIds: duplicateIds,
        assigneeUserId: keptTask.assigneeUserId || "",
        assigneeName: keptTask.assigneeName || "",
        content: keptTask.content || ""
      });
    }

    if (mergedCount > 0) {
      save();
      if (logger && typeof logger.info === "function") {
        logger.info("Watchdog duplicate pending initial tasks merged", {
          reason,
          mergedCount,
          groupCount: mergedGroups.length,
          groups: mergedGroups
        });
      }
    }
    return mergedCount;
  }

  function needsControlCardRetry(task) {
    return Boolean(task
      && task.status === "active"
      && task.requesterTargetId
      && !task.controlCardSentAt
      && !controlCardSkipReason(task));
  }

  function controlCardSkipReason(task, nowMs = Date.now()) {
    if (!task || task.status !== "active") {
      return `task_${normalizeText(task && task.status) || "missing"}`;
    }
    if (!isOneTimeTask(task)) {
      return "";
    }
    const dueAtMs = dateValueMs(task.dueAt || task.nextRunAt);
    return dueAtMs && dueAtMs <= nowMs ? "one_time_due_reached" : "";
  }

  function markControlCardSkipped(task, reason) {
    const now = new Date().toISOString();
    task.controlCardSkippedAt = now;
    task.controlCardSkipReason = reason;
    task.controlCardRetryAt = "";
    task.controlCardQueuedAt = "";
    task.controlCardLastError = "";
    task.updatedAt = now;
    save();
    if (logger && typeof logger.info === "function") {
      logger.info("Watchdog control card skipped", {
        taskId: task.id,
        mode: task.mode || "",
        status: task.status || "",
        dueAt: task.dueAt || "",
        reason
      });
    }
  }

  function ensurePendingControlCardRetries() {
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    let patchedCount = 0;
    let acceleratedCount = 0;
    for (const task of state.tasks) {
      if (needsControlCardRetry(task) && !task.controlCardRetryAt) {
        task.controlCardRetryAt = task.updatedAt || task.createdAt || nowIso;
        task.controlCardQueuedAt = task.controlCardQueuedAt || nowIso;
        task.controlCardLastError = task.controlCardLastError || "盯梢控制卡尚未发送，已加入后台补发队列";
        patchedCount += 1;
      }

      const isLocalBackoffQueued = /盯梢发送队列正在退避/.test(String(task.lastError || task.controlCardLastError || ""));
      const globalBackoffActive = sendBackoffUntil > nowMs;
      if (!isLocalBackoffQueued || globalBackoffActive) {
        continue;
      }
      const pendingInitialReminder = task.status === "active"
        && !isOneTimeTask(task)
        && (!task.firstReminderSentAt || (task.initialAckRequired && !task.initialAckCardSentAt));
      const nextRunMs = new Date(task.nextRunAt || "").getTime();
      if (pendingInitialReminder && Number.isFinite(nextRunMs) && nextRunMs > nowMs) {
        task.nextRunAt = nowIso;
        acceleratedCount += 1;
      }
      const controlRetryMs = new Date(task.controlCardRetryAt || "").getTime();
      if (needsControlCardRetry(task) && Number.isFinite(controlRetryMs) && controlRetryMs > nowMs) {
        task.controlCardRetryAt = nowIso;
        task.controlCardQueuedAt = task.controlCardQueuedAt || nowIso;
        acceleratedCount += 1;
      }
    }
    if (patchedCount > 0 || acceleratedCount > 0) {
      save();
      if (logger && typeof logger.info === "function") {
        logger.info("Watchdog control card retry fields migrated", {
          taskCount: patchedCount,
          acceleratedCount
        });
      }
    }
  }

  restoreSendQueueRuntimeState();
  migratePendingFrequencyBackoff();
  migrateFrequencyLimitBackoffPolicy();
  migrateLegacyRetryAttemptTimestamps();
  ensurePendingControlCardRetries();
  mergeDuplicatePendingInitialTasks("startup");

  function pendingDrafts() {
    return state.drafts.filter((draft) => draft.status === "pending");
  }

  function findTask(id) {
    return state.tasks.find((task) => task.id === id) || null;
  }

  function findDraft(id) {
    return state.drafts.find((draft) => draft.id === id) || null;
  }

  function cancelableTasksForSender(sender = {}) {
    return activeTasks()
      .filter((task) => requesterMatchesSender(task, sender))
      .sort((left, right) => new Date(right.updatedAt || right.createdAt).getTime() - new Date(left.updatedAt || left.createdAt).getTime());
  }

  function cancelCandidatesForText(text, sender = {}, candidateTaskIds = null) {
    const allowedIds = Array.isArray(candidateTaskIds) && candidateTaskIds.length > 0
      ? new Set(candidateTaskIds.map((id) => String(id || "").trim()).filter(Boolean))
      : null;
    return cancelableTasksForSender(sender)
      .filter((task) => !allowedIds || allowedIds.has(task.id))
      .filter((task) => taskMatchesCancelKeyword(task, text));
  }

  function activeTasksForList(scope, sender = {}) {
    const mineOnly = scope === "mine";
    return activeTasks()
      .filter((task) => !mineOnly || requesterMatchesSender(task, sender))
      .sort((left, right) => {
        const leftTime = left.nextRunAt ? new Date(left.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
        const rightTime = right.nextRunAt ? new Date(right.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
        return leftTime - rightTime;
      });
  }

  function candidateBySelection(text, candidates) {
    const raw = String(text || "").trim();
    const numberMatched = raw.match(/^\s*(?:第)?(\d+)(?:条|个)?\s*$/);
    if (numberMatched) {
      const index = Number(numberMatched[1]) - 1;
      return candidates[index] ? [candidates[index]] : [];
    }
    return candidates.filter((task) => taskMatchesCancelKeyword(task, raw));
  }

  function latestDraftForSender(sender = {}) {
    const target = targetFromSender(sender);
    const userId = sender.userId || "";
    return pendingDrafts()
      .filter((draft) => (target && draft.requesterTargetId === target) || (userId && draft.requesterUserId === userId))
      .sort((left, right) => new Date(right.updatedAt || right.createdAt).getTime() - new Date(left.updatedAt || left.createdAt).getTime())[0] || null;
  }

  async function resolveAssignee(assigneeName, sender = {}) {
    if (isSelfName(assigneeName)) {
      return {
        userId: sender.userId || "",
        name: sender.name || sender.userId || "我",
        source: "sender"
      };
    }
    const aliasUserId = String(config.personAliases[assigneeName] || "").trim();
    if (aliasUserId) {
      return {
        userId: aliasUserId,
        name: assigneeName,
        source: "alias"
      };
    }
    const userId = await resolveWeComUserIdByName(config.auth, assigneeName);
    return {
      userId,
      name: assigneeName,
      source: userId === assigneeName ? "userid" : "directory"
    };
  }

  async function resolveRequesterDisplayName(sender = {}) {
    const rawName = normalizeText(sender.name || "");
    const userId = normalizeText(sender.userId || "");
    if (rawName && hasChinese(rawName)) {
      return rawName;
    }
    if (userId) {
      try {
        const resolvedName = normalizeText(await resolveWeComUserName(config.auth, userId));
        if (resolvedName && hasChinese(resolvedName)) {
          return resolvedName;
        }
        if (!rawName && resolvedName) {
          return resolvedName;
        }
      } catch (error) {
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog requester name resolve failed", {
            requesterUserId: userId,
            message: error && error.message ? error.message : String(error)
          });
        }
      }
    }
    return rawName || userId || "发起人";
  }

  async function ensureTaskRequesterDisplayName(task) {
    if (!task) {
      return "未知";
    }
    const current = requesterDisplayName(task);
    if (hasChinese(current)) {
      return current;
    }
    const userId = normalizeText(task.requesterUserId || "");
    if (!userId) {
      task.requesterDisplayName = current;
      return current;
    }
    try {
      const resolvedName = normalizeText(await resolveWeComUserName(config.auth, userId));
      if (resolvedName && resolvedName !== current) {
        task.requesterDisplayName = resolvedName;
        if (hasChinese(resolvedName)) {
          task.requesterName = resolvedName;
        }
        task.updatedAt = new Date().toISOString();
        save();
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog requester name resolved", {
            taskId: task.id || "",
            requesterUserId: userId,
            requesterName: requesterDisplayName(task)
          });
        }
      }
    } catch (error) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Watchdog requester name resolve failed", {
          taskId: task.id || "",
          requesterUserId: userId,
          message: error && error.message ? error.message : String(error)
        });
      }
    }
    return requesterDisplayName(task);
  }

  function targetBackoffKey(targetId) {
    return String(targetId || "").trim();
  }

  function compactTargetSendBackoffs(nowMs = Date.now()) {
    let changed = false;
    for (const [key, until] of targetSendBackoffUntil.entries()) {
      if (!until || until <= nowMs) {
        targetSendBackoffUntil.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  function compactSendBackoffs(nowMs = Date.now()) {
    let changed = false;
    if (sendBackoffUntil && sendBackoffUntil <= nowMs) {
      sendBackoffUntil = 0;
      changed = true;
    }
    changed = compactTargetSendBackoffs(nowMs) || changed;
    if (changed) {
      persistSendQueueRuntimeState("backoff_expired", { now: new Date(nowMs).toISOString() });
    }
    return changed;
  }

  function targetBackoffSnapshot(nowMs = Date.now()) {
    compactSendBackoffs(nowMs);
    return [...targetSendBackoffUntil.entries()]
      .map(([targetId, until]) => ({
        targetId,
        backoffUntil: new Date(until).toISOString(),
        backoffRemainingMs: Math.max(0, until - nowMs)
      }))
      .sort((left, right) => right.backoffRemainingMs - left.backoffRemainingMs);
  }

  function sendQueueRemainingMs(nowMs = Date.now(), targetId = "") {
    compactSendBackoffs(nowMs);
    const key = targetBackoffKey(targetId);
    const targetUntil = key ? Number(targetSendBackoffUntil.get(key) || 0) : 0;
    return Math.max(0, Math.max(sendBackoffUntil, targetUntil) - nowMs);
  }

  function retryDelayMsForError(error) {
    const retryAfterMs = Number(error && error.retryAfterMs);
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return Math.max(1000, Math.ceil(retryAfterMs));
    }
    return isSendFrequencyLimitError(error)
      ? config.sendQueue.frequencyLimitBackoffMs
      : config.sendQueue.failureBackoffMs;
  }

  function retryAtForError(error) {
    const requestedDelayMs = Number(error && error.retryAfterMs);
    const delayMs = Number.isFinite(requestedDelayMs) && requestedDelayMs > 0
      ? requestedDelayMs
      : retryDelayMsForError(error);
    return new Date(Date.now() + delayMs).toISOString();
  }

  function createSendBackoffError(remainingMs) {
    const seconds = Math.max(1, Math.ceil(Number(remainingMs || 0) / 1000));
    const error = new Error(`盯梢发送队列正在退避，预计 ${seconds} 秒后重试 (errcode: ${WECOM_SEND_FREQUENCY_ERRCODE})`);
    error.code = WECOM_SEND_FREQUENCY_ERRCODE;
    error.errcode = WECOM_SEND_FREQUENCY_ERRCODE;
    error.retryAfterMs = remainingMs;
    return error;
  }

  async function waitForWatchdogSendSlot(messageType, targetId, meta = {}) {
    if (!config.sendQueue.enabled) {
      return;
    }
    const nowMs = Date.now();
    const remainingMs = sendQueueRemainingMs(nowMs, targetId);
    if (remainingMs > 0) {
      const key = targetBackoffKey(targetId);
      const targetUntil = key ? Number(targetSendBackoffUntil.get(key) || 0) : 0;
      const activeBackoffUntil = Math.max(sendBackoffUntil, targetUntil);
      if (logger && typeof logger.info === "function" && nowMs - lastBackoffLogAt >= 60 * 1000) {
        lastBackoffLogAt = nowMs;
        logger.info("Watchdog send queue backing off", {
          messageType,
          targetId: targetId || "",
          taskId: meta.taskId || "",
          taskIds: meta.taskIds || [],
          backoffScope: sendBackoffUntil > nowMs ? "global" : "target",
          backoffUntil: activeBackoffUntil ? new Date(activeBackoffUntil).toISOString() : "",
          globalBackoffUntil: sendBackoffUntil ? new Date(sendBackoffUntil).toISOString() : "",
          targetBackoffUntil: targetUntil ? new Date(targetUntil).toISOString() : "",
          remainingMs,
          queueId: meta.queueId || "",
          queueDepth: meta.queueDepth || 0,
          queueWaitMs: meta.queueWaitMs || 0
        });
      }
      throw createSendBackoffError(remainingMs);
    }
    const waitMs = Math.max(0, lastWatchdogSendAt + config.sendQueue.minIntervalMs - nowMs);
    if (waitMs > 0) {
      if (logger && typeof logger.info === "function") {
        logger.info("Watchdog send queue waiting", {
          messageType,
          targetId: targetId || "",
          taskId: meta.taskId || "",
          taskIds: meta.taskIds || [],
          waitMs,
          queueId: meta.queueId || "",
          queueDepth: meta.queueDepth || 0,
          queueWaitMs: meta.queueWaitMs || 0
        });
      }
      await sleep(waitMs);
    }
  }

  function noteWatchdogSendSuccess(messageType, targetId, ack, meta = {}) {
    lastWatchdogSendAt = Date.now();
    frequencyLimitFailureCount = 0;
    const key = targetBackoffKey(targetId);
    if (key) {
      targetSendBackoffUntil.delete(key);
    } else {
      sendBackoffUntil = 0;
    }
    persistSendQueueRuntimeState("delivered", {
      messageType,
      targetId: targetId || "",
      taskId: meta.taskId || "",
      queueId: meta.queueId || ""
    });
    if (logger && typeof logger.info === "function") {
      logger.info("Watchdog send queue delivered", {
        messageType,
        targetId: targetId || "",
        taskId: meta.taskId || "",
        taskIds: meta.taskIds || [],
        errcode: ack && ack.errcode,
        errmsg: ack && ack.errmsg,
        queueId: meta.queueId || "",
        queueDepth: meta.queueDepth || 0,
        queueWaitMs: meta.queueWaitMs || 0,
        frequencyLimitFailureCount
      });
    }
  }

  function noteWatchdogSendFailure(error, messageType, targetId, meta = {}) {
    const info = errorInfo(error, "盯梢发送失败");
    if (isSendFrequencyLimitError(error)) {
      frequencyLimitFailureCount = Math.min(20, Math.max(0, frequencyLimitFailureCount) + 1);
      const backoffMs = frequencyLimitBackoffMsForFailureCount(frequencyLimitFailureCount);
      const nextBackoffUntil = Date.now() + backoffMs;
      try {
        error.retryAfterMs = backoffMs;
      } catch (_) {
        // The SDK may throw an immutable acknowledgement object; the global state still records the delay.
      }
      const key = targetBackoffKey(targetId);
      sendBackoffUntil = Math.max(sendBackoffUntil, nextBackoffUntil);
      if (key) {
        targetSendBackoffUntil.set(key, Math.max(Number(targetSendBackoffUntil.get(key) || 0), nextBackoffUntil));
      }
      lastBackoffLogAt = Date.now();
      persistSendQueueRuntimeState("frequency_limit", {
        messageType,
        targetId: targetId || "",
        taskId: meta.taskId || "",
        queueId: meta.queueId || "",
        errcode: info.errcode,
        frequencyLimitFailureCount,
        backoffMs
      });
      if (logger && typeof logger.warn === "function") {
        logger.warn("Watchdog send queue frequency backoff started", {
          messageType,
          backoffScope: key ? "global+target" : "global",
          targetId: targetId || "",
          taskId: meta.taskId || "",
          taskIds: meta.taskIds || [],
          errcode: info.errcode,
          errmsg: info.errmsg,
          backoffUntil: new Date(sendBackoffUntil).toISOString(),
          globalBackoffUntil: new Date(sendBackoffUntil).toISOString(),
          targetBackoffUntil: key ? new Date(targetSendBackoffUntil.get(key)).toISOString() : "",
          backoffMs,
          frequencyLimitFailureCount,
          message: info.message,
          queueId: meta.queueId || "",
          queueDepth: meta.queueDepth || 0,
          queueWaitMs: meta.queueWaitMs || 0
        });
      }
      return;
    }
    if (logger && typeof logger.warn === "function") {
      logger.warn("Watchdog send queue delivery failed", {
        messageType,
        targetId: targetId || "",
        taskId: meta.taskId || "",
        taskIds: meta.taskIds || [],
        errcode: info.errcode,
        errmsg: info.errmsg,
        retryAfterMs: config.sendQueue.failureBackoffMs,
        message: info.message,
        queueId: meta.queueId || "",
        queueDepth: meta.queueDepth || 0,
        queueWaitMs: meta.queueWaitMs || 0
      });
    }
  }

  function enqueueWatchdogSend(messageType, targetId, meta = {}, deliver) {
    const queueId = `watch_send_${++watchdogSendSequence}`;
    const queuedAtMs = Date.now();
    const queueDepth = pendingWatchdogSendCount + 1;
    pendingWatchdogSendCount += 1;
    const queuedMeta = {
      ...meta,
      queueId,
      queueDepth,
      queuedAt: new Date(queuedAtMs).toISOString()
    };
    if (logger && typeof logger.info === "function") {
      logger.info("Watchdog send queue enqueued", {
        messageType,
        targetId: targetId || "",
        taskId: meta.taskId || "",
        taskIds: meta.taskIds || [],
        queueId,
        queueDepth,
        pendingWatchdogSendCount
      });
    }

    const run = async () => {
      const queueWaitMs = Math.max(0, Date.now() - queuedAtMs);
      const dispatchMeta = { ...queuedMeta, queueWaitMs };
      if (logger && typeof logger.info === "function") {
        logger.info("Watchdog send queue dispatching", {
          messageType,
          targetId: targetId || "",
          taskId: meta.taskId || "",
          taskIds: meta.taskIds || [],
          queueId,
          queueDepth,
          queueWaitMs,
          pendingWatchdogSendCount
        });
      }
      await waitForWatchdogSendSlot(messageType, targetId, dispatchMeta);
      try {
        const ack = await deliver();
        if (ack && ack.skipped) {
          if (logger && typeof logger.info === "function") {
            logger.info("Watchdog send queue delivery skipped", {
              messageType,
              targetId: targetId || "",
              taskId: meta.taskId || "",
              queueId,
              queueWaitMs,
              reason: ack.skipReason || "delivery_preflight"
            });
          }
          return ack;
        }
        assertWeComAckOk(ack);
        noteWatchdogSendSuccess(messageType, targetId, ack, dispatchMeta);
        return ack;
      } catch (error) {
        noteWatchdogSendFailure(error, messageType, targetId, dispatchMeta);
        throw error;
      }
    };

    const result = watchdogSendTail.then(run, run);
    watchdogSendTail = result.catch(() => undefined);
    return result.finally(() => {
      pendingWatchdogSendCount = Math.max(0, pendingWatchdogSendCount - 1);
    });
  }

  async function sendMarkdown(targetId, text, meta = {}) {
    if (!robotServer || typeof robotServer.sendMarkdownMessage !== "function") {
      throw new Error("企业微信机器人还未就绪，不能发送盯梢消息");
    }
    return enqueueWatchdogSend(
      "markdown",
      targetId,
      meta,
      () => robotServer.sendMarkdownMessage(targetId, text)
    );
  }

  function isAppPushRequested() {
    return Boolean(config.appPush.enabled);
  }

  function isAppPushEnabled() {
    if (!isAppPushRequested() || !appNotifier || typeof appNotifier.send !== "function") {
      return false;
    }
    const status = appPushStatus();
    return status.configured !== false;
  }

  function appPushStatus() {
    if (!appNotifier || typeof appNotifier.getStatus !== "function") {
      return { configured: false, reason: "notifier_unavailable" };
    }
    return appNotifier.getStatus();
  }

  function isWecomAppSource(value) {
    return normalizeText(value).startsWith("wecom-app");
  }

  function appPushNativeCardReady() {
    const status = appPushStatus();
    return Boolean(config.appPush.nativeCardEnabled && status && status.nativeCard && status.nativeCard.ready);
  }

  function appFeedbackTokenMatches(task, token) {
    const expected = String(task && task.appFeedbackToken || "");
    const actual = String(token || "").trim();
    if (!expected || !actual) {
      return false;
    }
    const expectedBuffer = Buffer.from(expected, "utf8");
    const actualBuffer = Buffer.from(actual, "utf8");
    return expectedBuffer.length === actualBuffer.length
      && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  }

  function appFeedbackUrlForTask(task) {
    if (!config.appPush.feedbackUrl) {
      return "";
    }
    try {
      const url = new URL(config.appPush.feedbackUrl);
      if (url.protocol !== "https:") {
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog app feedback URL must use HTTPS; sending text reminder without feedback link", {
            taskId: task.id,
            protocol: url.protocol,
            host: url.host
          });
        }
        return "";
      }
      url.searchParams.delete("taskId");
      url.searchParams.delete("token");
      url.searchParams.delete("ref");
      url.searchParams.set("ref", appFeedbackRefForTaskId(task.id));
      url.hash = "";
      return url.toString();
    } catch (error) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Watchdog app feedback URL is invalid", {
          taskId: task.id,
          message: error.message
        });
      }
      return "";
    }
  }

  function escapeTextcardHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function appPushHeadline(tipType) {
    const isInitial = tipType === "watchdog_initial";
    const isOnce = tipType === "watchdog_once";
    return isInitial
      ? "EA盯梢确认"
      : (isOnce ? "EA一次性盯梢提醒" : "EA盯梢进度提醒");
  }

  function appPushReminderText(task, tipType, feedbackAvailable = false) {
    const headline = appPushHeadline(tipType);
    const lines = [
      `【${headline}】`,
      `任务：${task.content || ""}`,
      watchdogTaskIdLine(task),
      `发起人：${requesterDisplayName(task)}`,
      `${isOneTimeTask(task) ? "提醒时间" : "盯梢时间"}：${scheduleDisplay(task)}`,
      taskRemarkText(task) ? `备注：${taskRemarkText(task)}` : "",
      feedbackAvailable
        ? "请点击卡片按钮提交处理结果。"
        : "反馈按钮正在升级，当前提醒仅供查看；请勿点击旧卡片中的网页反馈入口。"
    ];
    return lines.filter(Boolean).join("\n");
  }

  function appNativeCardTaskId(task, tipType) {
    const prefix = tipType === "watchdog_initial" ? "ea_watch_initial_" : "ea_watch_";
    return `${prefix}${task.id}_${Date.now()}`;
  }

  function appNativeReminderCard(task, tipType) {
    const isInitial = tipType === "watchdog_initial";
    const feedbackUrl = isInitial ? "" : appFeedbackUrlForTask(task);
    const contents = [
      watchdogTaskIdCardItem(task),
      { keyname: "发起人", value: requesterDisplayName(task) },
      { keyname: isOneTimeTask(task) ? "提醒时间" : "盯梢时间", value: scheduleDisplay(task) }
    ];
    const remark = remarkCardItem(task);
    if (remark) contents.push(remark);
    if (feedbackUrl) {
      contents.push({ keyname: "当前情况说明", value: "点击卡片填写" });
    }
    return {
      card_type: "button_interaction",
      source: { desc: "EA盯梢", desc_color: 0 },
      main_title: {
        title: appPushHeadline(tipType),
        desc: truncate(task.content, 60)
      },
      card_action: feedbackUrl ? { type: 1, url: feedbackUrl } : { type: 0 },
      horizontal_content_list: contents.filter(Boolean),
      button_list: isInitial
        ? [
            { text: "正在处理", key: "ea_watch_initial_received", style: 1 },
            { text: "拒绝盯梢", key: "ea_watch_initial_reject", style: 2 }
          ]
        : [
            { text: "已完成", key: "ea_watch_done", style: 1 },
            { text: "正常推进", key: "ea_watch_progress", style: 1 },
            { text: "遇到困难", key: "ea_watch_blocked", style: 2 },
            { text: "需要延期", key: "ea_watch_delay", style: 3 }
          ],
      task_id: appNativeCardTaskId(task, tipType)
    };
  }

  function appPushReminderPayload(task, tipType) {
    if (appPushNativeCardReady()) {
      return {
        messageType: "template_card",
        templateCard: appNativeReminderCard(task, tipType)
      };
    }
    // The former textcard opened a webview that WeCom blocks before reaching EA.
    // Until signed native callbacks are configured, only send a safe non-clickable reminder.
    return {
      text: appPushReminderText(task, tipType, false)
    };
  }

  async function trySendWatchdogAppPush(task, tipType) {
    if (!isAppPushRequested()) {
      return {
        ok: false,
        skipped: true,
        reason: "watchdog_app_push_disabled"
      };
    }
    if (!appNotifier || typeof appNotifier.send !== "function") {
      return {
        ok: false,
        skipped: true,
        reason: "watchdog_app_notifier_unavailable"
      };
    }
    if (!task.assigneeUserId) {
      return {
        ok: false,
        skipped: true,
        reason: "assignee_user_id_missing"
      };
    }

    try {
      const payload = appPushReminderPayload(task, tipType);
      const result = await appNotifier.send({
        targetUserId: task.assigneeUserId,
        purpose: `watchdog_${tipType}`,
        ...payload
      });
      if (!result || !result.ok) {
        return {
          ok: false,
          skipped: Boolean(result && result.skipped),
          reason: (result && result.reason) || "app_push_not_sent"
        };
      }
      const sentAt = new Date().toISOString();
      task.appPushCount = Number(task.appPushCount || 0) + 1;
      task.appPushLastSentAt = sentAt;
      task.appPushLastMessageType = tipType;
      task.appPushLastMessageId = result.msgid || "";
      task.appPushLastError = "";
      task.lastReminderChannel = "wecom-app";
      task.updatedAt = sentAt;
      save();
      if (logger && typeof logger.info === "function") {
        logger.info("Watchdog app push sent", {
          taskId: task.id,
          tipType,
          targetUserId: task.assigneeUserId,
          msgid: result.msgid || "",
          appPushCount: task.appPushCount
        });
        if (payload.messageType !== "template_card") {
          logger.warn("Watchdog app reminder sent without feedback link because native callback is not ready", {
            taskId: task.id,
            nativeCardEnabled: config.appPush.nativeCardEnabled,
            nativeCardConfigured: Boolean(appPushStatus().nativeCard && appPushStatus().nativeCard.ready)
          });
        }
      }
      return {
        ok: true,
        sentAt,
        msgid: result.msgid || "",
        channel: "wecom-app"
      };
    } catch (error) {
      const info = errorInfo(error, "企业微信自建应用盯梢推送失败");
      task.appPushLastError = info.message;
      task.appPushLastFailedAt = new Date().toISOString();
      task.updatedAt = task.appPushLastFailedAt;
      save();
      if (logger && typeof logger.warn === "function") {
        logger.warn("Watchdog app push failed", {
          taskId: task.id,
          tipType,
          targetUserId: task.assigneeUserId,
          errcode: info.errcode,
          errmsg: info.errmsg,
          message: info.message,
          fallbackToRobot: false,
          retryBackoffMs: config.appPush.failureBackoffMs
        });
      }
      return {
        ok: false,
        error: info.message,
        errcode: info.errcode
      };
    }
  }

  function throwAppPushFailure(result) {
    const error = new Error((result && (result.error || result.reason)) || "企业微信自建应用盯梢推送失败");
    error.errcode = result && result.errcode;
    error.retryAfterMs = config.appPush.failureBackoffMs;
    throw error;
  }

  async function queueDesktopFallbackAfterAppPushFailure(task, tipType) {
    const sourceId = `watchdog_app_failed_${task.id}_${Date.now()}`;
    const result = await queueDesktopTip(task, tipType, sourceId);
    const queuedAt = new Date().toISOString();
    task.appPushDesktopFallbackAt = queuedAt;
    task.appPushDesktopFallbackEventId = result && result.event && result.event.id ? result.event.id : "";
    task.appPushDesktopFallbackError = result && result.ok ? "" : ((result && (result.error || result.reason)) || "desktop_tip_not_queued");
    task.updatedAt = queuedAt;
    save();
    if (logger && typeof logger.warn === "function") {
      logger.warn("Watchdog app push failed; desktop fallback queued", {
        taskId: task.id,
        tipType,
        targetUserId: task.assigneeUserId || "",
        queued: Boolean(result && result.ok),
        eventId: task.appPushDesktopFallbackEventId,
        desktopFallbackError: task.appPushDesktopFallbackError
      });
    }
    return result;
  }

  function appResultNoticeText(task, label, note = "") {
    const assignee = task.assigneeName || task.assigneeUserId || "未知";
    const headline = task.status === "completed" ? "【EA盯梢已完成】" : "【EA盯梢反馈】";
    const nextText = task.status === "completed"
      ? "状态：已完成，盯梢已停止"
      : task.awaitingRescheduleFrom
        ? "状态：等待补充下次盯梢时间，请在 1 号机器人对话中填写新的时间或循环时间"
        : task.nextRunAt
          ? `下次盯梢：${formatLocalMinute(task.nextRunAt)}`
          : "下次盯梢：待补充";
    return [
      headline,
      `任务：${task.content || ""}`,
      `${assignee} 反馈：${label}`,
      taskRemarkText(task) ? `备注：${taskRemarkText(task)}` : "",
      note ? `说明：${note}` : "",
      nextText,
      watchdogTaskIdLine(task)
    ].filter(Boolean).join("\n");
  }

  function appCompletedResultCard(task, label, note = "") {
    const assignee = task.assigneeName || task.assigneeUserId || "未知";
    const contents = [
      watchdogTaskIdCardItem(task),
      { keyname: "被盯梢人", value: assignee },
      { keyname: "反馈结果", value: label || "已完成" }
    ];
    if (note) {
      contents.push({ keyname: "当前情况", value: truncate(note, 80) });
    }
    return {
      card_type: "text_notice",
      source: { desc: "EA盯梢", desc_color: 3 },
      main_title: {
        title: "盯梢已完成",
        desc: truncate(task.content || "", 60)
      },
      horizontal_content_list: contents.filter(Boolean),
      sub_title_text: "这条任务已停止盯梢。",
      card_action: {
        type: 1,
        url: "https://work.weixin.qq.com"
      }
    };
  }

  function latestAppResultResponse(task) {
    const responses = Array.isArray(task.responses) ? task.responses : [];
    return responses.slice().reverse().find((item) => (
      item
      && isWecomAppSource(item.source)
      && ["ea_watch_done", "ea_watch_progress", "ea_watch_blocked", "ea_watch_delay", "ea_watch_initial_reject"].includes(item.eventKey)
    )) || null;
  }

  function setPendingAppResultNotice(task, label, note, responseAt, errorMessage = "") {
    const retryAt = new Date(Date.now() + config.appPush.failureBackoffMs).toISOString();
    task.pendingAppResultNotice = {
      label,
      note: normalizeText(note),
      responseAt: responseAt || new Date().toISOString()
    };
    task.appResultNoticeRetryAt = retryAt;
    task.appResultNoticeLastError = errorMessage;
    task.appResultNoticeLastFailedAt = new Date().toISOString();
    task.updatedAt = task.appResultNoticeLastFailedAt;
    save();
    return retryAt;
  }

  async function trySendWatchdogAppResultNotice(task, label, options = {}) {
    const requesterUserId = normalizeText(task.requesterUserId);
    if (!isAppPushRequested() || !requesterUserId) {
      return {
        ok: false,
        skipped: true,
        reason: !requesterUserId ? "requester_user_id_missing" : "watchdog_app_push_disabled"
      };
    }
    const note = normalizeText(options.note);
    const responseAt = options.responseAt || new Date().toISOString();
    try {
      const completed = task.status === "completed";
      const result = await appNotifier.send({
        targetUserId: requesterUserId,
        ...(completed
          ? {
            messageType: "template_card",
            templateCard: appCompletedResultCard(task, label, note)
          }
          : { text: appResultNoticeText(task, label, note) }),
        purpose: "watchdog_result_notice"
      });
      if (!result || !result.ok) {
        const reason = (result && result.reason) || "app_result_notice_not_sent";
        const retryAt = setPendingAppResultNotice(task, label, note, responseAt, reason);
        return { ok: false, reason, retryAt, channel: "wecom-app" };
      }
      const sentAt = new Date().toISOString();
      task.appResultNoticeSentAt = sentAt;
      task.appResultNoticeMessageId = result.msgid || "";
      task.appResultNoticeResponseAt = responseAt;
      task.appResultNoticeLastError = "";
      task.appResultNoticeRetryAt = "";
      task.pendingAppResultNotice = null;
      task.updatedAt = sentAt;
      save();
      if (logger && typeof logger.info === "function") {
        logger.info("Watchdog app result notice sent", {
          taskId: task.id,
          requesterUserId,
          label,
          messageType: completed ? "template_card" : "text",
          responseAt,
          msgid: result.msgid || ""
        });
      }
      return {
        ok: true,
        channel: "wecom-app",
        msgid: result.msgid || ""
      };
    } catch (error) {
      const info = errorInfo(error, "盯梢自建应用反馈通知失败");
      const retryAt = setPendingAppResultNotice(task, label, note, responseAt, info.message);
      if (logger && typeof logger.warn === "function") {
        logger.warn("Watchdog app result notice failed", {
          taskId: task.id,
          requesterUserId,
          label,
          errcode: info.errcode,
          errmsg: info.errmsg,
          message: info.message,
          retryAt
        });
      }
      return {
        ok: false,
        channel: "wecom-app",
        error: info.message,
        retryAt
      };
    }
  }

  async function sendWatchdogResultNotice(task, label, options = {}) {
    const responseAt = options.responseAt || new Date().toISOString();
    const note = normalizeText(options.note);
    const appResult = await trySendWatchdogAppResultNotice(task, label, { note, responseAt });
    if (!appResult.skipped) {
      return appResult;
    }
    if (!task.requesterTargetId) {
      return appResult;
    }
    const shouldSendRescheduleCard = isOneTimeTask(task) && task.awaitingRescheduleFrom;
    const ack = shouldSendRescheduleCard
      ? await sendRequesterRescheduleCard(task, label)
      : await sendMarkdown(task.requesterTargetId, resultNoticeText(task, label), {
        taskId: task.id,
        purpose: "result_notice"
      });
    if (ack && ack.errcode) {
      throw new Error(`企业微信返回失败：${ack.errcode} ${ack.errmsg || ""}`.trim());
    }
    return {
      ok: true,
      channel: shouldSendRescheduleCard ? "wecom-robot-card" : "wecom-robot",
      noticeType: shouldSendRescheduleCard ? "requester_reschedule_card" : "markdown",
      msgid: ""
    };
  }

  function pendingAppResultNoticeForTask(task, nowMs) {
    const pending = task.pendingAppResultNotice;
    if (pending && pending.label) {
      const retryAtMs = dateValueMs(task.appResultNoticeRetryAt);
      if (!retryAtMs || retryAtMs <= nowMs) {
        return pending;
      }
      return null;
    }
    const latest = latestAppResultResponse(task);
    const responseAtMs = latest ? dateValueMs(latest.receivedAt) : 0;
    if (!latest || !responseAtMs || nowMs - responseAtMs > APP_RESULT_NOTICE_RECOVERY_WINDOW_MS) {
      return null;
    }
    if (task.appResultNoticeResponseAt === latest.receivedAt) {
      return null;
    }
    return {
      label: latest.label || statusLabel(latest.eventKey),
      note: latest.note || "",
      responseAt: latest.receivedAt
    };
  }

  async function retryPendingAppResultNotices(nowMs) {
    if (!isAppPushRequested()) {
      return 0;
    }
    const candidates = state.tasks
      .map((task) => ({ task, notice: pendingAppResultNoticeForTask(task, nowMs) }))
      .filter((item) => item.notice)
      .sort((left, right) => dateValueMs(left.notice.responseAt) - dateValueMs(right.notice.responseAt))
      .slice(0, MAX_APP_RESULT_NOTICES_PER_TICK);
    let sentCount = 0;
    for (const item of candidates) {
      const result = await trySendWatchdogAppResultNotice(item.task, item.notice.label, {
        note: item.notice.note,
        responseAt: item.notice.responseAt
      });
      if (result.ok) {
        sentCount += 1;
      }
    }
    if (candidates.length > 0 && logger && typeof logger.info === "function") {
      logger.info("Watchdog app result notice retry processed", {
        candidateCount: candidates.length,
        sentCount
      });
    }
    return sentCount;
  }

  function appFeedbackStatusText(task) {
    const labels = {
      active: task && task.awaitingRescheduleFrom ? "等待补充下次时间" : "进行中",
      completed: "已完成",
      canceled: "已取消",
      rejected: "已拒绝",
      rejected_pending_reason: "等待拒绝理由"
    };
    return labels[task && task.status] || "已结束";
  }

  function appFeedbackTaskView(task) {
    const responses = Array.isArray(task.responses) ? task.responses : [];
    const initialAckEvents = Array.isArray(task.initialAckEvents) ? task.initialAckEvents : [];
    const lastResponse = responses[responses.length - 1] || initialAckEvents[initialAckEvents.length - 1] || null;
    return {
      id: task.id,
      status: task.status || "",
      statusText: appFeedbackStatusText(task),
      canFeedback: task.status === "active" && !task.awaitingRescheduleFrom,
      content: task.content || "",
      remark: taskRemarkText(task),
      attachment: task.attachment || "",
      requesterName: requesterDisplayName(task),
      assigneeName: task.assigneeName || "",
      mode: isOneTimeTask(task) ? "once" : "recurring",
      modeText: isOneTimeTask(task) ? "一次性" : "循环",
      schedule: scheduleDisplay(task),
      nextRunAt: task.nextRunAt || "",
      nextRunText: task.nextRunAt ? formatLocalMinute(task.nextRunAt) : "",
      awaitingReschedule: Boolean(task.awaitingRescheduleFrom),
      lastFeedback: lastResponse
        ? {
          label: lastResponse.label || "",
          receivedAt: lastResponse.receivedAt || "",
          note: lastResponse.note || task.lastFeedbackNote || ""
        }
        : null
    };
  }

  function findTaskByAppFeedbackRef(value) {
    const feedbackRef = normalizeText(value).toLowerCase();
    if (!/^[a-f0-9]{12}$/.test(feedbackRef)) {
      return null;
    }
    const matches = state.tasks.filter((task) => appFeedbackRefForTaskId(task && task.id) === feedbackRef);
    if (matches.length !== 1) {
      if (matches.length > 1 && logger && typeof logger.warn === "function") {
        logger.warn("Watchdog app feedback ref collision detected", {
          feedbackRef,
          matchCount: matches.length
        });
      }
      return null;
    }
    return matches[0];
  }

  function appFeedbackAccessResult(input = {}) {
    if (!config.enabled) {
      return { ok: false, message: "盯梢系统尚未启用" };
    }
    const taskIdValue = normalizeText(input.taskId);
    const token = normalizeText(input.token);
    const feedbackRef = normalizeText(input.ref).toLowerCase();
    const legacyAccess = Boolean(taskIdValue || token);
    const task = legacyAccess ? findTask(taskIdValue) : findTaskByAppFeedbackRef(feedbackRef);
    if (!task) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Watchdog app feedback task not found", {
          accessMode: legacyAccess ? "legacy_token" : "signed_identity",
          taskId: legacyAccess ? taskIdValue : "",
          feedbackRef: legacyAccess ? "" : feedbackRef
        });
      }
      return { ok: false, statusCode: 400, message: "未找到这条盯梢任务" };
    }
    if (legacyAccess && !appFeedbackTokenMatches(task, token)) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Watchdog app feedback access denied", {
          accessMode: "legacy_token",
          taskId: task.id,
          assigneeUserId: task.assigneeUserId || ""
        });
      }
      return { ok: false, statusCode: 400, message: "反馈链接已失效或无权访问" };
    }
    if (!legacyAccess) {
      const identityUserId = normalizeText(input.assigneeUserId);
      if (!identityUserId || identityUserId !== normalizeText(task.assigneeUserId)) {
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog app feedback signed identity denied", {
            accessMode: "signed_identity",
            taskId: task.id,
            feedbackRef,
            assigneeUserId: task.assigneeUserId || "",
            identityUserId
          });
        }
        return {
          ok: false,
          statusCode: 403,
          code: "watchdog_feedback_forbidden",
          message: "这条盯梢不属于当前登录用户，不能查看或反馈"
        };
      }
    }
    return { ok: true, task, accessMode: legacyAccess ? "legacy_token" : "signed_identity" };
  }

  function getAppFeedbackTask(input = {}) {
    const access = appFeedbackAccessResult(input);
    if (!access.ok) {
      return access;
    }
    return {
      ok: true,
      task: appFeedbackTaskView(access.task)
    };
  }

  async function rejectWatchdogFromApp(task, sender, reason) {
    const now = new Date().toISOString();
    task.initialAckEvents = Array.isArray(task.initialAckEvents) ? task.initialAckEvents : [];
    task.initialAckEvents.push({
      receivedAt: now,
      eventKey: "ea_watch_initial_reject",
      label: "拒绝",
      senderUserId: sender.userId,
      source: "wecom-app"
    });
    task.responses = Array.isArray(task.responses) ? task.responses : [];
    task.responses.push({
      receivedAt: now,
      eventKey: "ea_watch_initial_reject",
      label: "拒绝盯梢",
      senderUserId: sender.userId,
      source: "wecom-app",
      note: reason
    });
    task.status = "rejected";
    task.initialAckStatus = "rejected";
    task.initialRejectedAt = now;
    task.rejectReason = reason;
    task.rejectReasonAt = now;
    task.lastFeedbackNote = reason;
    task.awaitingRejectReasonFrom = "";
    task.awaitingRescheduleFrom = "";
    task.awaitingRescheduleAt = "";
    task.awaitingRescheduleReason = "";
    task.nextRunAt = "";
    task.updatedAt = now;
    clearAwaitingRemarkUpdate(task);
    save();

    if (task.requesterUserId || task.requesterTargetId) {
      try {
        const notice = await sendWatchdogResultNotice(task, "拒绝盯梢", {
          note: reason,
          responseAt: now
        });
        if (!notice.ok && logger && typeof logger.warn === "function") {
          logger.warn("Watchdog app reject notice queued for retry", {
            taskId: task.id,
            retryAt: notice.retryAt || "",
            reason: notice.reason || notice.error || ""
          });
        }
      } catch (error) {
        const info = errorInfo(error, "盯梢应用拒绝通知失败");
        task.lastError = info.message;
        task.updatedAt = new Date().toISOString();
        save();
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog app reject notice failed", {
            taskId: task.id,
            errcode: info.errcode,
            errmsg: info.errmsg,
            message: info.message
          });
        }
      }
    }
  }

  function isDuplicateAppFeedback(task, eventKey, note) {
    const records = eventKey === "ea_watch_initial_received"
      ? (Array.isArray(task.initialAckEvents) ? task.initialAckEvents : [])
      : (Array.isArray(task.responses) ? task.responses : []);
    const latest = records.length > 0 ? records[records.length - 1] : null;
    if (!latest || !isWecomAppSource(latest.source) || latest.eventKey !== eventKey) {
      return false;
    }
    const receivedAtMs = dateValueMs(latest.receivedAt);
    if (!receivedAtMs || Date.now() - receivedAtMs > APP_FEEDBACK_DUPLICATE_WINDOW_MS) {
      return false;
    }
    return normalizeText(latest.note) === normalizeText(note);
  }

  async function submitAppFeedback(input = {}) {
    const access = appFeedbackAccessResult(input);
    if (!access.ok) {
      return access;
    }
    const task = access.task;
    if (task.status !== "active" || task.awaitingRescheduleFrom) {
      return {
        ok: false,
        message: `这条盯梢${appFeedbackStatusText(task)}，不能重复反馈。`,
        task: appFeedbackTaskView(task)
      };
    }

    const action = normalizeText(input.action).toLowerCase();
    const note = normalizeText(input.note);
    if (note.length > APP_FEEDBACK_NOTE_MAX_LENGTH) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Watchdog app feedback note rejected because it is too long", {
          taskId: task.id,
          action,
          assigneeUserId: task.assigneeUserId || "",
          noteLength: note.length,
          maxLength: APP_FEEDBACK_NOTE_MAX_LENGTH
        });
      }
      return {
        ok: false,
        message: `当前情况说明不能超过 ${APP_FEEDBACK_NOTE_MAX_LENGTH} 字。`,
        task: appFeedbackTaskView(task)
      };
    }
    const sender = {
      userId: task.assigneeUserId || "",
      name: task.assigneeName || task.assigneeUserId || "",
      source: "wecom-app",
      chatType: "wecom-app"
    };
    const eventKeyByAction = {
      received: "ea_watch_initial_received",
      done: "ea_watch_done",
      progress: "ea_watch_progress",
      blocked: "ea_watch_blocked",
      delay: "ea_watch_delay"
    };

    if (action === "reject") {
      if (!note) {
        return {
          ok: false,
          message: "请先填写拒绝原因。",
          task: appFeedbackTaskView(task)
        };
      }
      await rejectWatchdogFromApp(task, sender, note);
    } else if (eventKeyByAction[action]) {
      const eventKey = eventKeyByAction[action];
      if (isDuplicateAppFeedback(task, eventKey, note)) {
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog duplicate app feedback ignored", {
            taskId: task.id,
            action,
            assigneeUserId: task.assigneeUserId || ""
          });
        }
        return {
          ok: true,
          duplicate: true,
          message: "相同反馈已经记录，请等待下一次盯梢。",
          task: appFeedbackTaskView(task)
        };
      }
      const result = eventKey === "ea_watch_initial_received"
        ? await handleInitialCardEvent({
          taskId: `ea_watch_initial_${task.id}_${Date.now()}`,
          eventKey,
          feedbackNote: note
        }, sender)
        : await handleTemplateCardEvent({
          taskId: `ea_watch_${task.id}_${Date.now()}`,
          eventKey,
          feedbackNote: note
        }, sender);
      if (!result || !result.handled) {
        return {
          ok: false,
          message: "反馈处理失败，请稍后再试。",
          task: appFeedbackTaskView(task)
        };
      }
    } else {
      return {
        ok: false,
        message: "未识别的反馈操作。",
        task: appFeedbackTaskView(task)
      };
    }

    if (logger && typeof logger.info === "function") {
      logger.info("Watchdog app feedback accepted", {
        taskId: task.id,
        action,
        assigneeUserId: task.assigneeUserId || "",
        status: task.status,
        noteLength: note.length
      });
    }
    const needsReschedule = isOneTimeTask(task) && task.awaitingRescheduleFrom;
    return {
      ok: true,
      message: action === "reject"
        ? "拒绝理由已提交，盯梢已结束。"
        : (needsReschedule
          ? "反馈已记录。请在 1 号机器人对话中补充下一次提醒时间或循环时间。"
          : "反馈已记录。"),
      task: appFeedbackTaskView(task)
    };
  }

  async function sendAppPushTest() {
    const targetUserId = config.appPush.testTargetUserId;
    if (!targetUserId) {
      return {
        ok: false,
        message: "盯梢自建应用测试目标未配置"
      };
    }
    if (!appNotifier || typeof appNotifier.send !== "function") {
      return {
        ok: false,
        message: "盯梢自建应用发送器未就绪"
      };
    }
    const result = await appNotifier.send({
      targetUserId,
      purpose: "watchdog_app_push_test",
      text: [
        "【EA盯梢应用推送测试】",
        "这是一条通过企业微信自建应用发送的测试消息。",
        "如果你看到了这条消息，说明盯梢可以不再依赖 1 号机器人主动私发。",
        `测试时间：${formatLocalMinute(new Date())}`
      ].join("\n")
    });
    if (logger && typeof logger.info === "function") {
      logger.info("Watchdog app push test requested", {
        targetUserId,
        ok: Boolean(result && result.ok),
        skipped: Boolean(result && result.skipped),
        reason: result && result.reason ? result.reason : "",
        msgid: result && result.msgid ? result.msgid : ""
      });
    }
    return {
      ok: Boolean(result && result.ok),
      message: result && result.ok
        ? "盯梢自建应用测试消息已提交发送"
        : ((result && result.reason) || "盯梢自建应用测试消息未发送"),
      targetUserId,
      channel: result && result.channel ? result.channel : "wecom-app",
      msgid: result && result.msgid ? result.msgid : ""
    };
  }

  async function sendTemplateCard(targetId, card, meta = {}) {
    if (!robotServer || typeof robotServer.sendTemplateCardMessage !== "function") {
      throw new Error("企业微信机器人还未就绪，不能发送盯梢卡片");
    }
    return enqueueWatchdogSend(
      "template_card",
      targetId,
      meta,
      () => {
        const skipReason = typeof meta.skipBeforeSend === "function"
          ? normalizeText(meta.skipBeforeSend())
          : "";
        if (skipReason) {
          return { errcode: 0, skipped: true, skipReason };
        }
        return robotServer.sendTemplateCardMessage(targetId, card);
      }
    );
  }

  async function queueDesktopTip(task, tipType, sourceId) {
    if (!desktopTip || typeof desktopTip.createTip !== "function") {
      return {
        ok: false,
        skipped: true,
        reason: "desktop tip module is not available"
      };
    }
    if (!task.assigneeUserId) {
      return {
        ok: false,
        skipped: true,
        reason: "assignee user id is missing"
      };
    }

    const isInitial = tipType === "watchdog_initial";
    const isOnce = tipType === "watchdog_once";
    const title = isInitial
      ? "EA盯梢确认"
      : (isOnce ? "EA一次性盯梢" : "EA盯梢进度提醒");
    const detailLines = [
      `发起人：${requesterDisplayName(task)}`,
      `任务：${task.content || ""}`,
      watchdogTaskIdLine(task),
      `${isOneTimeTask(task) ? "提醒时间" : "盯梢时间"}：${scheduleDisplay(task)}`
    ];
    if (task.attachment) {
      detailLines.push(`附件：${truncate(task.attachment, 80)}`);
    }

    try {
      const result = desktopTip.createTip({
        type: tipType,
        source: "watchdog",
        sourceId: sourceId || task.id,
        targetUserId: task.assigneeUserId,
        targetName: task.assigneeName || "",
        title,
        body: task.content || "",
        detailLines,
        priority: isInitial ? "high" : "normal",
        meta: {
          taskId: task.id,
          mode: task.mode || "recurring",
          requesterUserId: task.requesterUserId || "",
          requesterName: requesterDisplayName(task),
          assigneeUserId: task.assigneeUserId || "",
          assigneeName: task.assigneeName || ""
        }
      });
      if (logger && typeof logger.info === "function") {
        logger.info("Watchdog desktop tip queued", {
          taskId: task.id,
          tipType,
          eventId: result && result.event && result.event.id,
          targetUserId: task.assigneeUserId
        });
      }
      return result;
    } catch (error) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Watchdog desktop tip queue failed", {
          taskId: task.id,
          tipType,
          targetUserId: task.assigneeUserId,
          message: error.message
        });
      }
      return {
        ok: false,
        error: error.message
      };
    }
  }

  async function sendDraftCard(draft) {
    const cardTaskId = `ea_watch_draft_${draft.id}_${Date.now()}`;
    const card = createDraftCard(draft, cardTaskId);
    const ack = await sendTemplateCard(draft.requesterTargetId, card, {
      taskId: draft.id,
      purpose: "draft_card"
    });
    draft.cardTaskId = cardTaskId;
    draft.cardSentAt = new Date().toISOString();
    draft.updatedAt = draft.cardSentAt;
    draft.lastError = "";
    save();
    return ack;
  }

  async function sendControlCard(task) {
    if (!task.requesterTargetId) {
      return null;
    }
    const currentSkipReason = controlCardSkipReason(task);
    if (currentSkipReason) {
      markControlCardSkipped(task, currentSkipReason);
      return { errcode: 0, skipped: true, skipReason: currentSkipReason };
    }
    const cardTaskId = `ea_watch_control_${task.id}_${Date.now()}`;
    const card = createControlCard(task, cardTaskId);
    const ack = await sendTemplateCard(task.requesterTargetId, card, {
      taskId: task.id,
      purpose: "control_card",
      skipBeforeSend: () => controlCardSkipReason(task)
    });
    if (ack && ack.skipped) {
      markControlCardSkipped(task, ack.skipReason || "delivery_preflight");
      return ack;
    }
    task.controlCardTaskId = cardTaskId;
    task.controlCardSentAt = new Date().toISOString();
    task.controlCardRetryAt = "";
    task.controlCardQueuedAt = "";
    task.controlCardLastError = "";
    task.updatedAt = task.controlCardSentAt;
    task.lastError = "";
    save();
    return ack;
  }

  async function sendRequesterRescheduleCard(task, label) {
    if (!task.requesterTargetId) {
      return null;
    }
    const cardTaskId = `ea_watch_reschedule_${task.id}_${Date.now()}`;
    const card = createRequesterRescheduleCard(task, label, cardTaskId);
    const ack = await sendTemplateCard(task.requesterTargetId, card, {
      taskId: task.id,
      purpose: "requester_reschedule_card"
    });
    task.requesterRescheduleCardTaskId = cardTaskId;
    task.requesterRescheduleCardSentAt = new Date().toISOString();
    task.updatedAt = task.requesterRescheduleCardSentAt;
    task.lastError = "";
    save();
    return ack;
  }

  async function sendControlCardQuietly(task) {
    if (!task.requesterTargetId) {
      return {
        sent: false,
        queued: false,
        retryAt: "",
        error: ""
      };
    }
    const currentSkipReason = controlCardSkipReason(task);
    if (currentSkipReason) {
      markControlCardSkipped(task, currentSkipReason);
      return {
        sent: false,
        queued: false,
        skipped: true,
        reason: currentSkipReason,
        retryAt: "",
        error: ""
      };
    }
    const nowMs = Date.now();
    const cadenceWaitMs = config.sendQueue.enabled
      ? Math.max(0, lastWatchdogSendAt + config.sendQueue.minIntervalMs - nowMs)
      : 0;
    const backoffWaitMs = config.sendQueue.enabled ? sendQueueRemainingMs(nowMs, task.requesterTargetId) : 0;
    if (config.sendQueue.enabled && (pendingWatchdogSendCount > 0 || cadenceWaitMs > 0 || backoffWaitMs > 0)) {
      const retryDelayMs = Math.max(config.tickMs, cadenceWaitMs, backoffWaitMs, 1000);
      const nowIso = new Date(nowMs).toISOString();
      const retryAt = new Date(nowMs + retryDelayMs).toISOString();
      task.controlCardRetryAt = retryAt;
      task.controlCardQueuedAt = task.controlCardQueuedAt || nowIso;
      task.controlCardLastError = "盯梢控制卡等待后台发送队列";
      task.updatedAt = nowIso;
      save();
      if (logger && typeof logger.info === "function") {
        logger.info("Watchdog control card deferred without blocking requester response", {
          taskId: task.id,
          pendingWatchdogSendCount,
          cadenceWaitMs,
          backoffWaitMs,
          retryAt
        });
      }
      return {
        sent: false,
        queued: true,
        skipped: false,
        retryAt,
        error: ""
      };
    }
    try {
      const ack = await sendControlCard(task);
      if (ack && ack.skipped) {
        return {
          sent: false,
          queued: false,
          skipped: true,
          reason: ack.skipReason || "delivery_preflight",
          retryAt: "",
          error: ""
        };
      }
      return {
        sent: true,
        queued: false,
        retryAt: "",
        error: ""
      };
    } catch (error) {
      const info = errorInfo(error, "盯梢控制卡发送失败");
      const retryAt = retryAtForError(error);
      const nowIso = new Date().toISOString();
      task.controlCardRetryAt = retryAt;
      task.controlCardQueuedAt = task.controlCardQueuedAt || nowIso;
      task.controlCardLastError = info.message;
      task.lastError = info.message;
      task.updatedAt = nowIso;
      save();
      if (logger && typeof logger.warn === "function") {
        logger.warn("Watchdog control card send queued for retry", {
          taskId: task.id,
          errcode: info.errcode,
          errmsg: info.errmsg,
          retryAt,
          message: info.message
        });
      }
      return {
        sent: false,
        queued: true,
        retryAt,
        error: info.message
      };
    }
  }

  function reminderSendText(sent, queued, sentText, channel = "") {
    if (sent) {
      if (channel === "wecom-app") {
        return "已通过 EA 盯梢自建应用向被盯梢人发送提醒；之后会按盯梢时间继续提醒。";
      }
      return sentText;
    }
    if (queued) {
      return "首次确认卡片已加入发送队列，后台会自动重试。";
    }
    return "首次确认卡片暂时无法发送，后台会自动重试。";
  }

  function controlCardSendText(result) {
    if (result && result.sent) {
      return "已给发起人发送盯梢控制卡。";
    }
    if (result && result.queued) {
      return "盯梢控制卡已加入发送队列，后台会自动重试；仍可用文字取消盯梢。";
    }
    if (result && result.skipped && result.reason === "one_time_due_reached") {
      return "一次性任务已到提醒时间，不再发送取消卡片。";
    }
    if (result && result.skipped) {
      return "任务状态已变化，不再发送盯梢控制卡。";
    }
    return "盯梢控制卡暂时无法发送，仍可用文字取消盯梢。";
  }

  async function sendInitialReminder(task) {
    let markdownAck = null;
    let cardAck = null;
    let appAck = null;
    await ensureTaskRequesterDisplayName(task);
    const appPush = await trySendWatchdogAppPush(task, "watchdog_initial");
    if (appPush.ok) {
      const shouldCountReminder = !task.firstReminderSentAt;
      task.initialAppPushSentAt = appPush.sentAt;
      task.firstReminderSentAt = task.firstReminderSentAt || appPush.sentAt;
      task.initialAckRequired = false;
      task.lastPingAt = appPush.sentAt;
      if (shouldCountReminder) {
        task.reminderCount = Number(task.reminderCount || 0) + 1;
      }
      task.nextRunAt = nextRunAtForRecurringTask(task, new Date());
      task.lastError = "";
      task.updatedAt = new Date().toISOString();
      save();
      await queueDesktopTip(task, "watchdog_initial", appPush.msgid || task.id);
      return {
        markdown: markdownAck,
        card: cardAck,
        app: appPush
      };
    }
    if (isAppPushRequested()) {
      await queueDesktopFallbackAfterAppPushFailure(task, "watchdog_initial");
      throwAppPushFailure(appPush);
    }
    if (!task.initialAckCardSentAt) {
      const shouldCountReminder = !task.firstReminderSentAt;
      const cardTaskId = `ea_watch_initial_${task.id}_${Date.now()}`;
      const card = createInitialAckCard(task, cardTaskId);
      cardAck = await sendTemplateCard(task.assigneeUserId, card, {
        taskId: task.id,
        purpose: "initial_ack_card"
      });
      const sentAt = new Date().toISOString();
      task.initialAckCardTaskId = cardTaskId;
      task.initialAckCardSentAt = sentAt;
      task.firstReminderSentAt = task.firstReminderSentAt || sentAt;
      task.initialAckRequired = task.initialAckRequired !== false;
      task.initialAckStatus = task.initialAckStatus || "pending";
      task.lastPingAt = sentAt;
      if (shouldCountReminder) {
        task.reminderCount = Number(task.reminderCount || 0) + 1;
      }
      task.updatedAt = sentAt;
      save();
      await queueDesktopTip(task, "watchdog_initial", cardTaskId);
    }
    if (task.initialAckCardSentAt && !task.firstReminderSentAt) {
      task.firstReminderSentAt = task.initialAckCardSentAt;
      task.lastPingAt = task.initialAckCardSentAt;
    }
    task.nextRunAt = nextRunAtForRecurringTask(task, new Date());
    task.lastError = "";
    task.updatedAt = new Date().toISOString();
    save();
    return {
      markdown: markdownAck,
      card: cardAck,
      app: appAck
    };
  }

  async function sendOneTimeReminder(task) {
    let markdownAck = null;
    let cardAck = null;
    let appAck = null;
    await ensureTaskRequesterDisplayName(task);
    const appPush = await trySendWatchdogAppPush(task, "watchdog_once");
    if (appPush.ok) {
      const shouldCountReminder = !task.oneTimeReminderSentAt;
      task.pendingAppPushSentAt = appPush.sentAt;
      task.oneTimeReminderSentAt = task.oneTimeReminderSentAt || appPush.sentAt;
      task.firstReminderSentAt = task.firstReminderSentAt || appPush.sentAt;
      task.lastPingAt = appPush.sentAt;
      if (shouldCountReminder) {
        task.reminderCount = Number(task.reminderCount || 0) + 1;
      }
      task.nextRunAt = "";
      task.lastError = "";
      task.updatedAt = new Date().toISOString();
      save();
      await queueDesktopTip(task, "watchdog_once", appPush.msgid || task.id);
      return {
        markdown: markdownAck,
        card: cardAck,
        app: appPush
      };
    }
    if (isAppPushRequested()) {
      await queueDesktopFallbackAfterAppPushFailure(task, "watchdog_once");
      throwAppPushFailure(appPush);
    }
    if (!task.pendingCardTaskId) {
      const shouldCountReminder = !task.oneTimeReminderSentAt;
      const cardTaskId = `ea_watch_${task.id}_${Date.now()}`;
      const card = createProgressCard(task, cardTaskId);
      cardAck = await sendTemplateCard(task.assigneeUserId, card, {
        taskId: task.id,
        purpose: "one_time_progress_card"
      });
      const sentAt = new Date().toISOString();
      task.pendingCardTaskId = cardTaskId;
      task.pendingCardSentAt = sentAt;
      task.oneTimeReminderSentAt = task.oneTimeReminderSentAt || sentAt;
      task.firstReminderSentAt = task.firstReminderSentAt || sentAt;
      task.lastPingAt = sentAt;
      task.cardCount = Number(task.cardCount || 0) + 1;
      if (shouldCountReminder) {
        task.reminderCount = Number(task.reminderCount || 0) + 1;
      }
      task.updatedAt = sentAt;
      save();
      await queueDesktopTip(task, "watchdog_once", cardTaskId);
    }
    if (task.pendingCardSentAt && !task.oneTimeReminderSentAt) {
      task.oneTimeReminderSentAt = task.pendingCardSentAt;
      task.firstReminderSentAt = task.firstReminderSentAt || task.pendingCardSentAt;
      task.lastPingAt = task.pendingCardSentAt;
    }
    task.nextRunAt = "";
    task.lastError = "";
    task.updatedAt = new Date().toISOString();
    save();
    return {
      markdown: markdownAck,
      card: cardAck,
      app: appAck
    };
  }

  async function createTaskFromDraft(draft) {
    const missing = missingDraftFields(draft);
    if (missing.length > 0) {
      return {
        ok: false,
        missing,
        text: `盯梢信息还缺少：${missing.join("、")}。`
      };
    }

    let resolved;
    try {
      resolved = await resolveAssignee(draft.assigneeName, {
        userId: draft.requesterUserId,
        name: draft.requesterName
      });
    } catch (error) {
      return {
        ok: false,
        text: `我暂时无法读取通讯录来识别“${draft.assigneeName}”：${error.message}`
      };
    }
    if (!resolved.userId) {
      return {
        ok: false,
        text: `我没能识别“${draft.assigneeName}”对应的企业微信账号。请确认姓名和通讯录一致，或者换成更准确的中文姓名。`
      };
    }

    const now = new Date();
    const task = {
      id: taskId(),
      status: "active",
      content: draft.content,
      remark: normalizeRemark(draft.remark || ""),
      attachment: draft.attachment || "",
      assigneeName: resolved.name || draft.assigneeName,
      assigneeUserId: resolved.userId,
      requesterUserId: draft.requesterUserId || "",
      requesterName: draft.requesterDisplayName || draft.requesterName || draft.requesterUserId || "发起人",
      requesterDisplayName: draft.requesterDisplayName || draft.requesterName || draft.requesterUserId || "发起人",
      requesterTargetId: draft.requesterTargetId,
      requesterChatType: draft.requesterChatType || "",
      intervalMinutes: draft.intervalMinutes,
      recurringSchedule: draft.recurringSchedule || null,
      mode: draft.mode || "recurring",
      dueAt: draft.dueAt || "",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: String(draft.mode || "recurring") === "once" && draft.dueAt ? new Date(draft.dueAt).toISOString() : now.toISOString(),
      firstReminderSentAt: "",
      lastPingAt: "",
      reminderCount: 0,
      cardCount: 0,
      responses: [],
      lastError: "",
      draftId: draft.id,
      initialAckRequired: String(draft.mode || "recurring") !== "once"
    };

    state.tasks.push(task);
    draft.status = "confirmed";
    draft.taskId = task.id;
    draft.updatedAt = now.toISOString();
    save();

    let reminderSent = false;
    let reminderQueued = false;
    if (!isOneTimeTask(task)) {
      try {
        await sendInitialReminder(task);
        reminderSent = true;
      } catch (error) {
        const info = errorInfo(error, "首次盯梢提醒发送失败");
        reminderQueued = true;
        task.lastError = info.message;
        task.nextRunAt = retryAtForError(error);
        task.updatedAt = new Date().toISOString();
        save();
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog initial reminder failed", {
            taskId: task.id,
            errcode: info.errcode,
            errmsg: info.errmsg,
            retryAt: task.nextRunAt,
            message: info.message
          });
        }
      }
    }
    const controlCardResult = await sendControlCardQuietly(task);

    return {
      ok: true,
      task,
      reminderSent,
      reminderQueued,
      controlCardSent: Boolean(controlCardResult.sent),
      controlCardQueued: Boolean(controlCardResult.queued),
      controlCardRetryAt: controlCardResult.retryAt || ""
    };
  }

  async function sendProgressCard(task) {
    await ensureTaskRequesterDisplayName(task);
    const appPush = await trySendWatchdogAppPush(task, "watchdog_progress");
    if (appPush.ok) {
      task.progressAppPushSentAt = appPush.sentAt;
      task.lastPingAt = appPush.sentAt;
      task.reminderCount = Number(task.reminderCount || 0) + 1;
      task.nextRunAt = nextRunAtForRecurringTask(task, new Date());
      task.lastError = "";
      task.updatedAt = new Date().toISOString();
      save();
      await queueDesktopTip(task, "watchdog_progress", appPush.msgid || task.id);
      return appPush;
    }
    if (isAppPushRequested()) {
      await queueDesktopFallbackAfterAppPushFailure(task, "watchdog_progress");
      throwAppPushFailure(appPush);
    }
    const cardTaskId = `ea_watch_${task.id}_${Date.now()}`;
    const card = createProgressCard(task, cardTaskId);
    const ack = await sendTemplateCard(task.assigneeUserId, card, {
      taskId: task.id,
      purpose: "progress_card"
    });
    task.pendingCardTaskId = cardTaskId;
    task.pendingCardSentAt = new Date().toISOString();
    task.lastPingAt = task.pendingCardSentAt;
    task.cardCount = Number(task.cardCount || 0) + 1;
    task.nextRunAt = nextRunAtForRecurringTask(task, new Date());
    task.lastError = "";
    task.updatedAt = new Date().toISOString();
    save();
    await queueDesktopTip(task, "watchdog_progress", cardTaskId);
    return ack;
  }

  async function sendDueTask(task) {
    if (isOneTimeTask(task)) {
      return sendOneTimeReminder(task);
    }
    if (!task.firstReminderSentAt || (task.initialAckRequired && !task.initialAckCardSentAt)) {
      return sendInitialReminder(task);
    }
    return sendProgressCard(task);
  }

  function taskRetryPriorityMs(task, attemptField, fallbackFields = []) {
    const lastAttemptMs = dateValueMs(task && task[attemptField]);
    if (lastAttemptMs > 0) {
      return lastAttemptMs;
    }
    for (const field of fallbackFields) {
      const fallbackMs = dateValueMs(task && task[field]);
      if (fallbackMs > 0) {
        return fallbackMs;
      }
    }
    return 0;
  }

  function orderRetryTasksFairly(tasks, attemptField, fallbackFields = [], options = {}) {
    const preferNewestUnattempted = Boolean(options.preferNewestUnattempted);
    return tasks.slice().sort((left, right) => {
      const leftAttemptMs = dateValueMs(left && left[attemptField]);
      const rightAttemptMs = dateValueMs(right && right[attemptField]);
      if (leftAttemptMs === 0 && rightAttemptMs > 0) {
        return -1;
      }
      if (leftAttemptMs > 0 && rightAttemptMs === 0) {
        return 1;
      }
      const leftPriority = leftAttemptMs || taskRetryPriorityMs(left, attemptField, fallbackFields);
      const rightPriority = rightAttemptMs || taskRetryPriorityMs(right, attemptField, fallbackFields);
      if (leftPriority !== rightPriority) {
        return leftAttemptMs === 0 && preferNewestUnattempted
          ? rightPriority - leftPriority
          : leftPriority - rightPriority;
      }
      return String(left.id || "").localeCompare(String(right.id || ""));
    });
  }

  function markRetryAttempt(task, attemptField, purpose, attemptOrder, candidateCount) {
    const attemptedAt = new Date().toISOString();
    task[attemptField] = attemptedAt;
    task.updatedAt = attemptedAt;
    save();
    if (logger && typeof logger.info === "function") {
      logger.info("Watchdog retry task selected", {
        purpose,
        taskId: task.id,
        assigneeUserId: task.assigneeUserId || "",
        requesterTargetId: task.requesterTargetId || "",
        attemptField,
        attemptedAt,
        attemptOrder,
        candidateCount,
        strategy: "least_recently_attempted"
      });
    }
    return attemptedAt;
  }

  function dueTasksForNow(nowMs) {
    return orderRetryTasksFairly(
      activeTasks().filter((task) => task.nextRunAt && new Date(task.nextRunAt).getTime() <= nowMs),
      "deliveryLastAttemptAt",
      ["updatedAt", "nextRunAt", "createdAt"]
    );
  }

  function isPendingInitialReminderTask(task, nowMs = Date.now()) {
    if (!isPendingInitialReminderLike(task)) {
      return false;
    }
    const nextRunMs = new Date(task.nextRunAt || "").getTime();
    return Number.isFinite(nextRunMs) && nextRunMs <= nowMs;
  }

  function pendingInitialReminderTasks(nowMs = Date.now()) {
    return orderRetryTasksFairly(
      activeTasks().filter((task) => isPendingInitialReminderTask(task, nowMs)),
      "initialReminderLastAttemptAt",
      ["createdAt", "updatedAt", "nextRunAt"],
      { preferNewestUnattempted: true }
    );
  }

  async function sendInitialReminderRetries(nowMs, remainingSlots) {
    if (remainingSlots <= 0) {
      return 0;
    }
    let sentCount = 0;
    const tasks = pendingInitialReminderTasks(nowMs);
    for (const [index, task] of tasks.entries()) {
      if (sentCount >= remainingSlots) {
        break;
      }
      markRetryAttempt(task, "initialReminderLastAttemptAt", "initial_reminder_retry", index + 1, tasks.length);
      try {
        await sendInitialReminder(task);
        sentCount += 1;
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog initial reminder retry sent", {
            taskId: task.id,
            assigneeUserId: task.assigneeUserId,
            initialAckCardSentAt: task.initialAckCardSentAt || "",
            nextRunAt: task.nextRunAt || ""
          });
        }
      } catch (error) {
        const info = errorInfo(error, "首次盯梢提醒重试发送失败");
        const retryAt = retryAtForError(error);
        task.lastError = info.message;
        task.nextRunAt = retryAt;
        task.updatedAt = new Date().toISOString();
        save();
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog initial reminder retry failed", {
            taskId: task.id,
            assigneeUserId: task.assigneeUserId,
            errcode: info.errcode,
            errmsg: info.errmsg,
            retryAt,
            message: info.message
          });
        }
        if (isSendFrequencyLimitError(error)) {
          break;
        }
      }
    }
    if (tasks.length > sentCount && logger && typeof logger.info === "function") {
      logger.info("Watchdog initial reminder retries deferred by send queue", {
        dueInitialReminderCount: tasks.length,
        sentCount,
        maxSendsPerTick: config.sendQueue.maxSendsPerTick
      });
    }
    return sentCount;
  }

  function pendingControlCardRetryTasks(nowMs = Date.now()) {
    return orderRetryTasksFairly(
      activeTasks()
      .filter((task) => needsControlCardRetry(task) && task.controlCardRetryAt)
      .filter((task) => {
        const retryMs = new Date(task.controlCardRetryAt).getTime();
        return Number.isFinite(retryMs) && retryMs <= nowMs;
      }),
      "controlCardLastAttemptAt",
      ["updatedAt", "controlCardRetryAt", "createdAt"]
    );
  }

  async function sendControlCardRetries(nowMs, remainingSlots) {
    if (remainingSlots <= 0) {
      return 0;
    }
    let sentCount = 0;
    let skippedCount = 0;
    const tasks = pendingControlCardRetryTasks(nowMs);
    for (const [index, task] of tasks.entries()) {
      if (sentCount >= remainingSlots) {
        break;
      }
      markRetryAttempt(task, "controlCardLastAttemptAt", "control_card_retry", index + 1, tasks.length);
      try {
        const ack = await sendControlCard(task);
        if (ack && ack.skipped) {
          skippedCount += 1;
          continue;
        }
        sentCount += 1;
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog control card retry sent", {
            taskId: task.id,
            requesterTargetId: task.requesterTargetId,
            sentAt: task.controlCardSentAt
          });
        }
      } catch (error) {
        const info = errorInfo(error, "盯梢控制卡重试发送失败");
        const retryAt = retryAtForError(error);
        const nowIso = new Date().toISOString();
        task.controlCardRetryAt = retryAt;
        task.controlCardQueuedAt = task.controlCardQueuedAt || nowIso;
        task.controlCardLastError = info.message;
        task.lastError = info.message;
        task.updatedAt = nowIso;
        save();
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog control card retry failed", {
            taskId: task.id,
            requesterTargetId: task.requesterTargetId,
            errcode: info.errcode,
            errmsg: info.errmsg,
            retryAt,
            message: info.message
          });
        }
        if (isSendFrequencyLimitError(error)) {
          break;
        }
      }
    }
    if (tasks.length > sentCount + skippedCount && logger && typeof logger.info === "function") {
      logger.info("Watchdog control card retries deferred by send queue", {
        dueControlCardRetryCount: tasks.length,
        sentCount,
        skippedCount,
        maxSendsPerTick: config.sendQueue.maxSendsPerTick
      });
    }
    return sentCount;
  }

  function dueTaskGroupsByTarget(dueTasks, nowMs) {
    const groups = new Map();
    for (const task of dueTasks) {
      const targetId = String(task.assigneeUserId || "").trim();
      if (!targetId) {
        continue;
      }
      const lastSummaryAt = new Date(task.lastBatchSummarySentAt || "").getTime();
      const summaryCoolingDown = Number.isFinite(lastSummaryAt)
        && nowMs - lastSummaryAt < config.sendQueue.batchSummaryCooldownMs;
      if (summaryCoolingDown) {
        continue;
      }
      if (!groups.has(targetId)) {
        groups.set(targetId, []);
      }
      groups.get(targetId).push(task);
    }
    return [...groups.values()]
      .filter((tasks) => tasks.length >= config.sendQueue.batchSummaryMinTasks)
      .sort((left, right) => right.length - left.length);
  }

  async function sendDueBatchSummaries(dueTasks, nowMs, remainingSlots) {
    if (isAppPushEnabled() || !config.sendQueue.enabled || !config.sendQueue.batchSameTargetEnabled || remainingSlots <= 0) {
      return 0;
    }
    let sentCount = 0;
    const groups = dueTaskGroupsByTarget(dueTasks, nowMs);
    for (const tasks of groups) {
      if (sentCount >= remainingSlots) {
        break;
      }
      const targetId = tasks[0] && tasks[0].assigneeUserId;
      try {
        const taskIds = tasks.map((task) => task.id);
        await sendMarkdown(targetId, dueBatchSummaryText(tasks), {
          taskIds,
          purpose: "due_batch_summary"
        });
        const sentAt = new Date().toISOString();
        for (const task of tasks) {
          task.lastBatchSummarySentAt = sentAt;
          task.batchSummaryCount = Number(task.batchSummaryCount || 0) + 1;
          task.updatedAt = sentAt;
        }
        save();
        sentCount += 1;
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog due batch summary sent", {
            targetId,
            taskIds,
            taskCount: tasks.length,
            sentAt
          });
        }
      } catch (error) {
        const info = errorInfo(error, "盯梢批量摘要发送失败");
        const retryAt = retryAtForError(error);
        for (const task of tasks) {
          task.lastError = info.message;
          task.nextRunAt = retryAt;
          task.updatedAt = new Date().toISOString();
        }
        save();
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog due batch summary failed", {
            targetId,
            taskIds: tasks.map((task) => task.id),
            taskCount: tasks.length,
            errcode: info.errcode,
            errmsg: info.errmsg,
            retryAt,
            message: info.message
          });
        }
        if (isSendFrequencyLimitError(error)) {
          break;
        }
      }
    }
    return sentCount;
  }

  async function sendDueAppTasksDuringRobotBackoff(nowMs) {
    const allDueTasks = dueTasksForNow(nowMs);
    const dueTasks = allDueTasks.slice(0, MAX_APP_DELIVERIES_DURING_ROBOT_BACKOFF);
    let deliveredTaskCount = 0;
    for (const task of dueTasks) {
      if (!task.nextRunAt || new Date(task.nextRunAt).getTime() > Date.now()) {
        continue;
      }
      markRetryAttempt(task, "deliveryLastAttemptAt", "app_delivery_during_robot_backoff", deliveredTaskCount + 1, dueTasks.length);
      try {
        await sendDueTask(task);
        deliveredTaskCount += 1;
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog app delivery sent during robot backoff", {
            taskId: task.id,
            assigneeUserId: task.assigneeUserId || "",
            reminderCount: task.reminderCount || 0,
            nextRunAt: task.nextRunAt || ""
          });
        }
      } catch (error) {
        const info = errorInfo(error, "机器人退避期间自建应用盯梢推送失败");
        task.lastError = info.message;
        task.nextRunAt = retryAtForError(error);
        task.updatedAt = new Date().toISOString();
        save();
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog app delivery failed during robot backoff", {
            taskId: task.id,
            errcode: info.errcode,
            errmsg: info.errmsg,
            retryAt: task.nextRunAt,
            message: info.message
          });
        }
      }
    }
    if (allDueTasks.length > MAX_APP_DELIVERIES_DURING_ROBOT_BACKOFF && logger && typeof logger.info === "function") {
      logger.info("Watchdog app delivery deferred by app backoff batch limit", {
        dueCount: allDueTasks.length,
        deliveredTaskCount,
        maxDeliveries: MAX_APP_DELIVERIES_DURING_ROBOT_BACKOFF
      });
    }
    return deliveredTaskCount;
  }

  async function tick() {
    if (!config.enabled || sending) {
      return;
    }
    sending = true;
    try {
      const now = Date.now();
      compactSendBackoffs(now);
      const backoffMs = config.sendQueue.enabled ? sendQueueRemainingMs(now) : 0;
      const appPushActive = isAppPushRequested();
      await retryPendingAppResultNotices(now);
      if (backoffMs > 0 && !appPushActive) {
        if (logger && typeof logger.info === "function" && now - lastBackoffLogAt >= 60 * 1000) {
          lastBackoffLogAt = now;
          logger.info("Watchdog tick skipped during send backoff", {
            backoffMs,
            backoffScope: "global",
            backoffUntil: sendBackoffUntil ? new Date(sendBackoffUntil).toISOString() : ""
          });
        }
        return;
      }
      if (backoffMs > 0 && logger && typeof logger.info === "function" && now - lastBackoffLogAt >= 60 * 1000) {
        lastBackoffLogAt = now;
        logger.info("Watchdog robot send backoff active; app delivery continues", {
          backoffMs,
          backoffUntil: sendBackoffUntil ? new Date(sendBackoffUntil).toISOString() : "",
          channel: "wecom-app"
        });
      }

      if (backoffMs > 0 && appPushActive) {
        mergeDuplicatePendingInitialTasks("app_delivery_during_robot_backoff");
        await sendDueAppTasksDuringRobotBackoff(now);
        return;
      }

      mergeDuplicatePendingInitialTasks("tick");
      let sentCount = backoffMs > 0 && appPushActive
        ? 0
        : await sendControlCardRetries(now, config.sendQueue.maxSendsPerTick);
      if (config.sendQueue.enabled && sendQueueRemainingMs() > 0 && !appPushActive) {
        return;
      }
      if (config.sendQueue.enabled && sentCount >= config.sendQueue.maxSendsPerTick) {
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog tick slots used by control card retries", {
            sendCount: sentCount,
            maxSendsPerTick: config.sendQueue.maxSendsPerTick,
            pendingControlCardRetryCount: pendingControlCardRetryTasks(Date.now()).length
          });
        }
        return;
      }

      sentCount += await sendInitialReminderRetries(now, config.sendQueue.maxSendsPerTick - sentCount);
      if (config.sendQueue.enabled && sendQueueRemainingMs() > 0 && !appPushActive) {
        return;
      }
      if (config.sendQueue.enabled && sentCount >= config.sendQueue.maxSendsPerTick) {
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog tick slots used by initial reminder retries", {
            sendCount: sentCount,
            maxSendsPerTick: config.sendQueue.maxSendsPerTick,
            pendingInitialReminderCount: pendingInitialReminderTasks(Date.now()).length
          });
        }
        return;
      }

      const dueTasks = dueTasksForNow(now).filter((task) => !isPendingInitialReminderTask(task, now));
      if (dueTasks.length === 0) {
        return;
      }

      sentCount += await sendDueBatchSummaries(dueTasks, now, config.sendQueue.maxSendsPerTick - sentCount);
      let deliveredTaskCount = 0;
      for (const task of dueTasks) {
        if (config.sendQueue.enabled && sentCount >= config.sendQueue.maxSendsPerTick) {
          break;
        }
        if (!task.nextRunAt || new Date(task.nextRunAt).getTime() > Date.now()) {
          continue;
        }
        markRetryAttempt(task, "deliveryLastAttemptAt", "due_task_delivery", deliveredTaskCount + 1, dueTasks.length);
        try {
          await sendDueTask(task);
          sentCount += 1;
          deliveredTaskCount += 1;
          if (logger && typeof logger.info === "function") {
            logger.info("Watchdog ping sent", {
              taskId: task.id,
              mode: task.mode || "recurring",
              assigneeConfigured: Boolean(task.assigneeUserId),
              reminderCount: task.reminderCount || 0,
              cardCount: task.cardCount || 0,
              nextRunAt: task.nextRunAt || ""
            });
          }
        } catch (error) {
          const info = errorInfo(error, "盯梢推送失败");
          task.lastError = info.message;
          task.nextRunAt = retryAtForError(error);
          task.updatedAt = new Date().toISOString();
          save();
          if (logger && typeof logger.warn === "function") {
            logger.warn("Watchdog ping failed", {
              taskId: task.id,
              errcode: info.errcode,
              errmsg: info.errmsg,
              retryAt: task.nextRunAt,
              message: info.message
            });
          }
          if (isSendFrequencyLimitError(error)) {
            break;
          }
        }
      }

      if (logger && typeof logger.info === "function" && dueTasks.length > deliveredTaskCount) {
        logger.info("Watchdog due tasks deferred by send queue", {
          dueCount: dueTasks.length,
          deliveredTaskCount,
          sendCount: sentCount,
          maxSendsPerTick: config.sendQueue.maxSendsPerTick
        });
      }
    } finally {
      sending = false;
    }
  }

  async function createTaskFromText(context = {}) {
    if (!config.enabled) {
      return {
        ok: false,
        text: "盯梢系统还没有启用。"
      };
    }

    const text = String(context.text || "").trim();
    const sender = context.sender || {};
    if (looksLikeWatchdogHelpText(text)) {
      return helpWatchdog(context);
    }

    const formFields = parseWatchdogFormFields(text);
    const now = new Date();
    const oneTimeAt = parseOneTimeAtFromText(formFields.dueText || formFields.intervalText || text, now);
    const mode = oneTimeAt ? "once" : "recurring";
    const assigneeName = formFields.assigneeName || extractAssigneeName(text);
    if (!assigneeName) {
      return {
        ok: false,
        text: watchdogCreateHintText("要盯梢谁？")
      };
    }

    const content = formFields.content || extractTaskContent(text, assigneeName) || (mode === "once" ? "到时间提醒" : "");
    if (!content || content.length < 2) {
      return {
        ok: false,
        text: watchdogCreateHintText("盯梢的任务内容是什么？")
      };
    }

    let resolved;
    try {
      resolved = await resolveAssignee(assigneeName, sender);
    } catch (error) {
      return {
        ok: false,
        text: `我暂时无法读取通讯录来识别“${assigneeName}”：${error.message}`
      };
    }
    if (!resolved.userId) {
      return {
        ok: false,
        text: `我没能识别“${assigneeName}”对应的企业微信账号。请确认姓名和通讯录一致，或者换成更准确的中文姓名。`
      };
    }

    const recurringSchedule = mode === "once"
      ? null
      : parseRecurringScheduleFromText(formFields.intervalText || text);
    const intervalMinutes = mode === "once"
      ? 0
      : recurringSchedule
      ? fixedScheduleIntervalMinutes(recurringSchedule)
      : formFields.intervalText
      ? intervalMinutesFromText(formFields.intervalText, config.defaultIntervalMinutes)
      : intervalMinutesFromText(text, config.defaultIntervalMinutes);
    const attachment = formFields.attachment || extractAttachment(text);
    const remark = normalizeRemark(formFields.remark || extractRemark(text));
    const requesterName = await resolveRequesterDisplayName(sender);
    const task = {
      id: taskId(),
      status: "active",
      content,
      remark,
      attachment: /^(?:无|没有|暂无)$/i.test(String(attachment || "").trim()) ? "" : attachment,
      assigneeName: resolved.name || assigneeName,
      assigneeUserId: resolved.userId,
      requesterUserId: sender.userId || "",
      requesterName,
      requesterDisplayName: requesterName,
      requesterTargetId: targetFromSender(sender),
      requesterChatType: sender.chatType || "",
      mode,
      intervalMinutes,
      recurringSchedule,
      dueAt: oneTimeAt ? oneTimeAt.toISOString() : "",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: oneTimeAt ? oneTimeAt.toISOString() : now.toISOString(),
      firstReminderSentAt: "",
      oneTimeReminderSentAt: "",
      lastPingAt: "",
      reminderCount: 0,
      cardCount: 0,
      responses: [],
      lastError: "",
      initialAckRequired: mode !== "once"
    };

    state.tasks.push(task);
    save();

    let reminderSent = false;
    let reminderQueued = false;
    if (mode !== "once") {
      try {
        await sendInitialReminder(task);
        reminderSent = true;
      } catch (error) {
        const info = errorInfo(error, "首次盯梢提醒发送失败");
        reminderQueued = true;
        task.lastError = info.message;
        task.nextRunAt = retryAtForError(error);
        task.updatedAt = new Date().toISOString();
        save();
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog initial reminder failed", {
            taskId: task.id,
            errcode: info.errcode,
            errmsg: info.errmsg,
            retryAt: task.nextRunAt,
            message: info.message
          });
        }
      }
    }
    const controlCardResult = await sendControlCardQuietly(task);

    if (logger && typeof logger.info === "function") {
      logger.info("Watchdog task created", {
        taskId: task.id,
        mode: task.mode,
        requesterUserId: task.requesterUserId,
        requesterName: requesterDisplayName(task),
        assigneeConfigured: Boolean(task.assigneeUserId),
        nextRunAt: task.nextRunAt || "",
        intervalMinutes: task.intervalMinutes || 0,
        recurringSchedule: recurringScheduleDisplay(task.recurringSchedule),
        hasRemark: Boolean(taskRemarkText(task)),
        reminderSent,
        reminderQueued,
        controlCardSent: Boolean(controlCardResult.sent),
        controlCardQueued: Boolean(controlCardResult.queued),
        controlCardRetryAt: controlCardResult.retryAt || ""
      });
    }

    const lines = [
      mode === "once" ? "一次性盯梢已创建。" : "盯梢任务已创建。",
      `对象：${task.assigneeName}`,
      `任务：${task.content}`,
      watchdogTaskIdLine(task),
      taskRemarkText(task) ? `备注：${taskRemarkText(task)}` : "",
      `盯梢模式：${mode === "once" ? "一次性" : "循环"}`,
      mode === "once" ? `提醒时间：${formatLocalMinute(task.dueAt)}` : `盯梢时间：${scheduleDisplay(task)}`,
      task.attachment ? `附件：${task.attachment}` : "",
      mode === "once"
        ? "到时间会提醒被盯梢人，并收集是否完成。"
        : reminderSendText(reminderSent, reminderQueued, "已给被盯梢人发送确认卡片；下次开始会发送进度卡片。", task.lastReminderChannel),
      controlCardSendText(controlCardResult)
    ].filter(Boolean);

    return {
      ok: true,
      module: "watchdog",
      action: "create_watchdog",
      text: lines.join("\n"),
      data: task
    };
  }

  function cancelConfirmationResult(task, via) {
    return {
      ok: true,
      module: "watchdog",
      action: "cancel_watchdog",
      text: cancelConfirmText(task),
      confirmationTask: {
        module: "watchdog",
        action: "cancel_watchdog",
        params: {
          taskId: task.id,
          confirmed: true,
          canceledVia: via || "text"
        },
        requireConfirmation: false,
        normalizedText: `取消盯梢 ${cancelTaskSummary(task)}`
      },
      data: {
        taskId: task.id,
        task
      }
    };
  }

  function cancelCandidatesResult(candidates, prefix = "") {
    return {
      ok: true,
      module: "watchdog",
      action: "cancel_watchdog",
      text: [prefix, cancelCandidatesText(candidates)].filter(Boolean).join("\n"),
      pending: {
        module: "watchdog",
        action: "cancel_watchdog",
        params: {
          candidateTaskIds: candidates.map((task) => task.id)
        }
      },
      data: {
        candidates: candidates.map((task) => ({
          id: task.id,
          assigneeName: task.assigneeName,
          content: task.content,
          intervalMinutes: task.intervalMinutes
        }))
      }
    };
  }

  async function cancelActiveTask(task, sender = {}, via = "text") {
    if (!task) {
      return {
        ok: false,
        module: "watchdog",
        action: "cancel_watchdog",
        text: "这条盯梢任务不存在，可能已经被清理。"
      };
    }
    if (!requesterMatchesSender(task, sender)) {
      return {
        ok: false,
        module: "watchdog",
        action: "cancel_watchdog",
        text: "只有这条盯梢的发起人可以取消。"
      };
    }
    if (task.status === "canceled") {
      return {
        ok: true,
        module: "watchdog",
        action: "cancel_watchdog",
        text: "这条盯梢已经取消了。",
        data: task
      };
    }
    if (task.status === "completed") {
      return {
        ok: true,
        module: "watchdog",
        action: "cancel_watchdog",
        text: "这条盯梢已经完成，不需要再取消。",
        data: task
      };
    }
    if (task.status !== "active") {
      return {
        ok: false,
        module: "watchdog",
        action: "cancel_watchdog",
        text: "这条盯梢当前不是进行中状态，不能取消。",
        data: task
      };
    }

    const now = new Date().toISOString();
    task.status = "canceled";
    task.canceledAt = now;
    task.canceledByUserId = sender.userId || "";
    task.canceledByName = sender.name || sender.userId || "";
    task.canceledVia = via || "text";
    task.nextRunAt = "";
    task.pendingCardTaskId = "";
    task.pendingCardSentAt = "";
    clearAwaitingRemarkUpdate(task);
    task.updatedAt = now;
    save();

    if (task.assigneeUserId) {
      try {
        await sendMarkdown(task.assigneeUserId, cancelNoticeToAssigneeText(task), {
          taskId: task.id,
          purpose: "cancel_notice"
        });
      } catch (error) {
        const info = errorInfo(error, "盯梢取消通知发送失败");
        task.lastError = info.message;
        task.updatedAt = new Date().toISOString();
        save();
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog cancel notice failed", {
            taskId: task.id,
            errcode: info.errcode,
            errmsg: info.errmsg,
            message: info.message
          });
        }
      }
    }

    if (logger && typeof logger.info === "function") {
      logger.info("Watchdog task canceled", {
        taskId: task.id,
        via: task.canceledVia,
        canceledBy: task.canceledByUserId
      });
    }

    return {
      ok: true,
      module: "watchdog",
      action: "cancel_watchdog",
      text: cancelDoneText(task),
      data: task
    };
  }

  async function cancelTaskFromText(context = {}) {
    if (!config.enabled) {
      return {
        ok: false,
        module: "watchdog",
        action: "cancel_watchdog",
        text: "盯梢系统还没有启用。"
      };
    }

    const routeTask = context.route && context.route.task ? context.route.task : {};
    const params = routeTask.params || {};
    const sender = context.sender || {};
    const text = String(params.selectionText || context.text || "").trim();

    if (params.confirmed && params.taskId) {
      return cancelActiveTask(findTask(params.taskId), sender, params.canceledVia || "text");
    }

    const scopedCandidates = Array.isArray(params.candidateTaskIds) && params.candidateTaskIds.length > 0
      ? cancelCandidatesForText("", sender, params.candidateTaskIds)
      : null;
    const candidates = scopedCandidates
      ? candidateBySelection(text, scopedCandidates)
      : cancelCandidatesForText(text, sender);

    if (candidates.length === 0) {
      if (scopedCandidates && scopedCandidates.length > 0) {
        return cancelCandidatesResult(scopedCandidates, "没有从候选里匹配到这条盯梢。");
      }
      return {
        ok: false,
        module: "watchdog",
        action: "cancel_watchdog",
        text: "没有找到可取消的进行中盯梢。请确认对象或任务关键词。"
      };
    }

    if (candidates.length > 1) {
      return cancelCandidatesResult(candidates);
    }

    return cancelConfirmationResult(candidates[0], "text");
  }

  async function listWatchdogTasks(context = {}) {
    if (!config.enabled) {
      return {
        ok: false,
        module: "watchdog",
        action: "list_watchdog",
        text: "盯梢系统还没有启用。"
      };
    }

    const routeTask = context.route && context.route.task ? context.route.task : {};
    const params = routeTask.params || {};
    const sender = context.sender || {};
    const text = String(context.text || routeTask.normalizedText || "").trim();
    const scope = params.scope === "mine" || /(?:我的|我发起|我创建|自己)/.test(text) ? "mine" : "all";
    const tasks = activeTasksForList(scope, sender);
    const counts = statusCounts(state.tasks);
    const listLimit = 10;
    const visibleTasks = tasks.slice(0, listLimit);
    const scopeText = scope === "mine" ? "你发起的" : "全系统";
    const lines = [
      `${scopeText}正在运作的盯梢：${tasks.length} 条。`,
      `状态统计：运行中 ${counts.active} 条，已完成 ${counts.completed} 条，已取消 ${counts.canceled} 条，已拒绝 ${counts.rejected + counts.rejectedPendingReason} 条，总计 ${state.tasks.length} 条。`
    ];

    if (visibleTasks.length > 0) {
      lines.push("运行中列表：");
      lines.push(...visibleTasks.map(activeTaskListLine));
      if (tasks.length > visibleTasks.length) {
        lines.push(`还有 ${tasks.length - visibleTasks.length} 条未展开。`);
      }
    } else {
      lines.push(scope === "mine" ? "你当前没有正在运作的盯梢。" : "当前没有正在运作的盯梢。");
    }

    if (logger && typeof logger.info === "function") {
      logger.info("Watchdog list queried", {
        scope,
        activeCount: tasks.length,
        totalCount: state.tasks.length,
        senderUserId: sender.userId || ""
      });
    }

    return {
      ok: true,
      module: "watchdog",
      action: "list_watchdog",
      text: lines.join("\n"),
      data: {
        scope,
        activeCount: tasks.length,
        totalCount: state.tasks.length,
        counts,
        tasks: tasks.map(activeTaskSummary)
      }
    };
  }

  async function helpWatchdog(context = {}) {
    const sender = context.sender || {};
    if (logger && typeof logger.info === "function") {
      logger.info("Watchdog help queried", {
        senderUserId: sender.userId || "",
        chatId: sender.chatId || ""
      });
    }
    return {
      ok: true,
      module: "watchdog",
      action: "help_watchdog",
      text: watchdogHelpText(),
      data: {
        modes: ["recurring", "once"]
      }
    };
  }

  async function handleInitialCardEvent(summary, sender) {
    const id = parseWatchdogInitialCardTaskId(summary.taskId);
    const task = findTask(id);
    if (!task) {
      return {
        handled: true,
        updateCard: initialAckCardUpdate("盯梢任务不存在", "这张卡片对应的任务可能已被清理。", 2)
      };
    }

    if (!senderCanFeedbackTask(task, sender)) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Watchdog initial feedback rejected for non-assignee", {
          taskId: task.id,
          eventKey: summary.eventKey || "",
          source: sender && sender.source ? sender.source : "",
          senderConfigured: Boolean(sender && sender.userId),
          assigneeConfigured: Boolean(task.assigneeUserId)
        });
      }
      return {
        handled: true,
        task,
        updateCard: initialAckCardUpdate("无反馈权限", "只有被盯梢人可以反馈这条任务。", 2)
      };
    }
    if (!["ea_watch_initial_received", "ea_watch_initial_reject"].includes(summary.eventKey)) {
      return {
        handled: true,
        task,
        updateCard: initialAckCardUpdate("盯梢操作未识别", "请重新点击正在处理或拒绝盯梢。", 2)
      };
    }

    if (task.status === "completed") {
      return {
        handled: true,
        task,
        updateCard: initialAckCardUpdate("盯梢已结束", "这条任务已完成，不再收集确认。", 3)
      };
    }
    if (task.status === "canceled") {
      return {
        handled: true,
        task,
        updateCard: initialAckCardUpdate("盯梢已取消", "这条任务已停止盯梢。", 2)
      };
    }
    if (task.status === "rejected" || task.status === "rejected_pending_reason") {
      return {
        handled: true,
        task,
        updateCard: initialAckCardUpdate("盯梢已拒绝", "拒绝理由已经反馈给发起人。", 2)
      };
    }

    if (hasRecordedCardEvent(task.initialAckEvents, summary, sender)) {
      return {
        handled: true,
        task,
        updateCard: initialAckCardUpdate("反馈已记录", "请勿重复提交这条盯梢反馈。", 3)
      };
    }

    const now = new Date().toISOString();
    const feedbackNote = normalizeText(summary.feedbackNote);
    task.initialAckEvents = Array.isArray(task.initialAckEvents) ? task.initialAckEvents : [];
    task.initialAckEvents.push({
      receivedAt: now,
      eventKey: summary.eventKey,
      label: initialActionLabel(summary.eventKey),
      senderUserId: sender && sender.userId ? sender.userId : "",
      cardTaskId: summary.taskId,
      source: sender && sender.source ? sender.source : "wecom-card",
      note: feedbackNote
    });
    task.lastFeedbackNote = feedbackNote;
    task.updatedAt = now;

    if (summary.eventKey === "ea_watch_initial_received") {
      task.initialAckStatus = "received";
      task.initialAckAt = now;
      save();
      return {
        handled: true,
        task,
        updateCard: initialAckCardUpdate("已收到", "后续会按盯梢时间收集进度。", 3)
      };
    }

    if (summary.eventKey === "ea_watch_initial_reject") {
      if (sender && sender.source === "wecom-app-native") {
        task.status = "rejected";
        task.initialAckStatus = "rejected";
        task.initialRejectedAt = now;
        task.awaitingRejectReasonFrom = "";
        task.nextRunAt = "";
        save();
        try {
          await sendWatchdogResultNotice(task, "拒绝盯梢", { note: "", responseAt: now });
        } catch (error) {
          const info = errorInfo(error, "盯梢拒绝通知失败");
          if (logger && typeof logger.warn === "function") {
            logger.warn("Watchdog native reject notice failed", {
              taskId: task.id,
              errcode: info.errcode,
              errmsg: info.errmsg,
              message: info.message
            });
          }
        }
        return {
          handled: true,
          task,
          updateCard: initialAckCardUpdate("盯梢已拒绝", "已记录并通知发起人。", 2)
        };
      }
      task.status = "rejected_pending_reason";
      task.initialAckStatus = "rejected_pending_reason";
      task.initialRejectedAt = now;
      task.awaitingRejectReasonFrom = sender && sender.userId ? sender.userId : task.assigneeUserId;
      task.nextRunAt = "";
      save();
      try {
        await sendMarkdown(task.assigneeUserId, rejectReasonPromptText(task), {
          taskId: task.id,
          purpose: "reject_reason_prompt"
        });
      } catch (error) {
        const info = errorInfo(error, "盯梢拒绝理由追问失败");
        task.lastError = info.message;
        save();
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog reject reason prompt failed", {
            taskId: task.id,
            errcode: info.errcode,
            errmsg: info.errmsg,
            message: info.message
          });
        }
      }
      return {
        handled: true,
        task,
        updateCard: initialAckCardUpdate("请补充拒绝理由", "直接回复拒绝理由，我会反馈给发起人。", 2)
      };
    }

    save();
    return {
      handled: true,
      task,
      updateCard: initialAckCardUpdate("盯梢操作未识别", "请重新点击收到或拒绝。", 2)
    };
  }

  function senderCanFeedbackTask(task, sender = {}) {
    const senderUserId = normalizeText(sender && sender.userId);
    return Boolean(task && task.assigneeUserId && senderUserId && task.assigneeUserId === senderUserId);
  }

  function hasRecordedCardEvent(records, summary = {}, sender = {}) {
    const senderUserId = normalizeText(sender && sender.userId);
    return Array.isArray(records) && records.some((record) => (
      record
      && record.cardTaskId === summary.taskId
      && record.eventKey === summary.eventKey
      && record.senderUserId === senderUserId
    ));
  }

  async function handleControlCardEvent(summary, sender) {
    const id = parseWatchdogControlCardTaskId(summary.taskId);
    const task = findTask(id);
    if (!task) {
      return {
        handled: true,
        updateCard: controlCardUpdate("盯梢任务不存在", "这张卡片对应的任务可能已被清理。", 2)
      };
    }

    const terminalNotice = taskTerminalNotice(task);
    if (terminalNotice) {
      return {
        handled: true,
        task,
        updateCard: terminalNotice
      };
    }

    if (!requesterMatchesSender(task, sender)) {
      return {
        handled: true,
        task,
        updateCard: controlCardUpdate("不能取消盯梢", "只有这条盯梢的发起人可以取消。", 2)
      };
    }

    const now = new Date().toISOString();
    task.controlCardEvents = Array.isArray(task.controlCardEvents) ? task.controlCardEvents : [];
    task.controlCardEvents.push({
      receivedAt: now,
      eventKey: summary.eventKey,
      label: controlActionLabel(summary.eventKey),
      senderUserId: sender && sender.userId ? sender.userId : "",
      cardTaskId: summary.taskId
    });
    task.updatedAt = now;

    if (summary.eventKey === "ea_watch_control_cancel") {
      save();
      return {
        handled: true,
        task,
        updateCard: controlCancelConfirmCard(task)
      };
    }

    if (summary.eventKey === "ea_watch_control_keep") {
      save();
      return {
        handled: true,
        task,
        updateCard: controlCardUpdate("继续盯梢", "已保留这条盯梢任务，后续会按原频率继续。", 3)
      };
    }

    if (summary.eventKey === "ea_watch_control_confirm_cancel") {
      const result = await cancelActiveTask(task, sender, "control_card");
      return {
        handled: true,
        task,
        updateCard: result.ok
          ? controlCardUpdate("盯梢已取消", "这条任务已停止盯梢。", 2)
          : controlCardUpdate("取消失败", result.text || "请稍后再试。", 2)
      };
    }

    save();
    return {
      handled: true,
      task,
      updateCard: controlCardUpdate("盯梢操作未识别", "请重新点击控制卡按钮。", 2)
    };
  }

  async function handleRequesterRescheduleCardEvent(summary, sender) {
    const id = parseWatchdogRescheduleCardTaskId(summary.taskId);
    const task = findTask(id);
    if (!task) {
      return {
        handled: true,
        updateCard: rescheduleCardUpdate("盯梢任务不存在", "这张卡片对应的任务可能已被清理。", 2)
      };
    }

    const terminalNotice = taskTerminalNotice(task);
    if (terminalNotice) {
      return {
        handled: true,
        task,
        updateCard: terminalNotice
      };
    }

    if (!requesterMatchesSender(task, sender)) {
      return {
        handled: true,
        task,
        updateCard: rescheduleCardUpdate("不能填写下次时间", "只有这条盯梢的发起人可以填写。", 2)
      };
    }

    if (!isOneTimeTask(task) || !task.awaitingRescheduleFrom) {
      return {
        handled: true,
        task,
        updateCard: rescheduleCardUpdate("暂时不用补时间", "这条盯梢当前不在等待补下次时间。", 0)
      };
    }

    const now = new Date().toISOString();
    task.rescheduleCardEvents = Array.isArray(task.rescheduleCardEvents) ? task.rescheduleCardEvents : [];
    task.rescheduleCardEvents.push({
      receivedAt: now,
      eventKey: summary.eventKey,
      label: rescheduleActionLabel(summary.eventKey),
      senderUserId: sender && sender.userId ? sender.userId : "",
      cardTaskId: summary.taskId
    });
    task.updatedAt = now;

    if (summary.eventKey === "ea_watch_set_next_time") {
      task.awaitingRescheduleRequesterFrom = sender && sender.userId ? sender.userId : "";
      task.awaitingRescheduleRequesterTargetId = targetFromSender(sender);
      task.awaitingRescheduleRequesterAt = now;
      save();
      try {
        await sendMarkdown(targetFromSender(sender) || task.requesterTargetId, requesterReschedulePromptText(task), {
          taskId: task.id,
          purpose: "requester_reschedule_prompt"
        });
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog requester reschedule input requested", {
            taskId: task.id,
            senderUserId: sender && sender.userId ? sender.userId : "",
            cardTaskId: summary.taskId
          });
        }
      } catch (error) {
        const info = errorInfo(error, "发起人补下次盯梢时间提示发送失败");
        task.lastError = info.message;
        task.updatedAt = new Date().toISOString();
        save();
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog requester reschedule prompt failed", {
            taskId: task.id,
            errcode: info.errcode,
            errmsg: info.errmsg,
            message: info.message
          });
        }
      }
      return {
        handled: true,
        task,
        updateCard: rescheduleCardUpdate("等待输入下次时间", "请在对话里回复：6月24日 16:00，或：每2小时一次。", 0)
      };
    }

    save();
    return {
      handled: true,
      task,
      updateCard: rescheduleCardUpdate("盯梢操作未识别", "请重新点击“填写下次时间”。", 2)
    };
  }

  async function handleTemplateCardEvent(summary, sender, helpers = {}) {
    if (!summary || !isWatchdogTaskId(summary.taskId)) {
      return { handled: false };
    }
    if (isWatchdogDraftTaskId(summary.taskId)) {
      const id = parseWatchdogDraftCardTaskId(summary.taskId);
      const draft = findDraft(id);
      if (!draft) {
        return {
          handled: true,
          updateCard: draftCardUpdate("盯梢信息不存在", "这张卡片对应的信息可能已被清理。", 2)
        };
      }

      const now = new Date().toISOString();
      draft.events = Array.isArray(draft.events) ? draft.events : [];
      draft.events.push({
        receivedAt: now,
        eventKey: summary.eventKey,
        label: draftActionLabel(summary.eventKey),
        senderUserId: sender && sender.userId ? sender.userId : "",
        cardTaskId: summary.taskId
      });
      draft.updatedAt = now;

      if (summary.eventKey === "ea_watch_draft_cancel") {
        draft.status = "canceled";
        save();
        return {
          handled: true,
          updateCard: draftCardUpdate("已取消盯梢", "这条盯梢信息已取消。", 2)
        };
      }

      if (summary.eventKey === "ea_watch_draft_edit") {
        save();
        try {
          await sendMarkdown(draft.requesterTargetId, formTemplateText(draft), {
            taskId: draft.id,
            purpose: "draft_form_prompt"
          });
        } catch (error) {
          const info = errorInfo(error, "盯梢补充格式发送失败");
          draft.lastError = info.message;
          save();
        }
        return {
          handled: true,
          updateCard: draftCardUpdate("等待补充盯梢信息", "请按对话里的固定格式补充。", 0)
        };
      }

      if (summary.eventKey === "ea_watch_draft_confirm") {
        const missing = missingDraftFields(draft);
        if (missing.length > 0) {
          save();
          try {
            await sendMarkdown(draft.requesterTargetId, formTemplateText(draft), {
              taskId: draft.id,
              purpose: "draft_missing_fields"
            });
          } catch (_) {
          }
          return {
            handled: true,
            updateCard: draftCardUpdate("盯梢信息不完整", `还缺少：${missing.join("、")}。请按对话里的格式补充。`, 2)
          };
        }

        const result = await createTaskFromDraft(draft);
        if (!result.ok) {
          save();
          try {
            await sendMarkdown(draft.requesterTargetId, `${result.text}\n${formTemplateText(draft)}`, {
              taskId: draft.id,
              purpose: "draft_create_failed"
            });
          } catch (_) {
          }
          return {
            handled: true,
            updateCard: draftCardUpdate("盯梢创建失败", result.text || "请检查盯梢信息后重新提交。", 2)
          };
        }

        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog task created from draft", {
            draftId: draft.id,
            taskId: result.task.id,
            requesterName: requesterDisplayName(result.task),
            reminderSent: Boolean(result.reminderSent),
            reminderQueued: Boolean(result.reminderQueued),
            controlCardSent: Boolean(result.controlCardSent),
            controlCardQueued: Boolean(result.controlCardQueued),
            controlCardRetryAt: result.controlCardRetryAt || ""
          });
        }
        return {
          handled: true,
          task: result.task,
          updateCard: draftCardUpdate(
            "盯梢任务已创建",
            [
              isOneTimeTask(result.task)
                ? "到时间会提醒被盯梢人，并收集是否完成。"
                : reminderSendText(result.reminderSent, result.reminderQueued, "已给被盯梢人发送确认卡片；之后会按间隔发送进度卡片。", result.task.lastReminderChannel),
              controlCardSendText({
                sent: result.controlCardSent,
                queued: result.controlCardQueued
              })
            ].join(" "),
            3
          )
        };
      }

      save();
      return {
        handled: true,
        updateCard: draftCardUpdate("盯梢操作未识别", "请重新发起盯梢。", 2)
      };
    }

    if (isWatchdogInitialTaskId(summary.taskId)) {
      return handleInitialCardEvent(summary, sender);
    }

    if (isWatchdogControlTaskId(summary.taskId)) {
      return handleControlCardEvent(summary, sender);
    }

    if (isWatchdogRescheduleTaskId(summary.taskId)) {
      return handleRequesterRescheduleCardEvent(summary, sender);
    }

    const id = parseWatchdogCardTaskId(summary.taskId);
    const task = findTask(id);
    if (!task) {
      return {
        handled: true,
        updateCard: {
          card_type: "text_notice",
          source: { desc: "EA盯梢", desc_color: 2 },
          main_title: { title: "盯梢任务不存在", desc: "这张卡片对应的任务可能已被清理。" },
          card_action: { type: 1, url: "https://work.weixin.qq.com" }
        }
      };
    }
    if (!senderCanFeedbackTask(task, sender)) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Watchdog card feedback rejected for non-assignee", {
          taskId: task.id,
          eventKey: summary.eventKey || "",
          source: sender && sender.source ? sender.source : "",
          senderConfigured: Boolean(sender && sender.userId),
          assigneeConfigured: Boolean(task.assigneeUserId)
        });
      }
      return {
        handled: true,
        task,
        updateCard: cardUpdateForResponse(task, "无反馈权限", { denied: true })
      };
    }
    const terminalNotice = taskTerminalNotice(task);
    if (terminalNotice) {
      return {
        handled: true,
        task,
        updateCard: terminalNotice
      };
    }

    if (![
      "ea_watch_done",
      "ea_watch_progress",
      "ea_watch_blocked",
      "ea_watch_delay"
    ].includes(summary.eventKey)) {
      return {
        handled: true,
        task,
        updateCard: cardUpdateForResponse(task, "操作未识别", { denied: true })
      };
    }
    if (hasRecordedCardEvent(task.responses, summary, sender)) {
      return {
        handled: true,
        task,
        updateCard: cardUpdateForResponse(task, "反馈已记录", { duplicate: true })
      };
    }

    const label = statusLabel(summary.eventKey);
    const now = new Date().toISOString();
    const situation = appSituationFromSelectedItems(summary.selectedItems);
    const feedbackNote = normalizeText(summary.feedbackNote || situation.note);
    task.responses = Array.isArray(task.responses) ? task.responses : [];
    task.responses.push({
      receivedAt: now,
      eventKey: summary.eventKey,
      label,
      senderUserId: sender && sender.userId ? sender.userId : "",
      cardTaskId: summary.taskId,
      source: sender && sender.source ? sender.source : "wecom-card",
      note: feedbackNote
    });
    task.lastFeedbackNote = feedbackNote;
    task.pendingCardTaskId = "";
    task.pendingCardSentAt = "";
    task.updatedAt = now;

    if (summary.eventKey === "ea_watch_done") {
      task.status = "completed";
      task.completedAt = now;
      task.nextRunAt = "";
      task.awaitingRescheduleFrom = "";
      task.awaitingRescheduleAt = "";
      task.awaitingRescheduleReason = "";
      clearAwaitingRemarkUpdate(task);
    } else if (isOneTimeTask(task)) {
      task.status = "active";
      task.nextRunAt = "";
      task.awaitingRescheduleFrom = sender && sender.userId ? sender.userId : task.assigneeUserId;
      task.awaitingRescheduleAt = now;
      task.awaitingRescheduleReason = summary.eventKey;
      markAwaitingRemarkUpdate(task, sender, summary.eventKey, now);
    } else {
      task.status = "active";
      task.nextRunAt = nextRunAtForRecurringTask(task, new Date());
      markAwaitingRemarkUpdate(task, sender, summary.eventKey, now);
    }
    save();

    if (isOneTimeTask(task) && task.awaitingRescheduleFrom && !String(sender && sender.source || "").startsWith("wecom-app")) {
      try {
        await sendMarkdown(task.assigneeUserId, oneTimeReschedulePromptText(task), {
          taskId: task.id,
          purpose: "one_time_reschedule_prompt"
        });
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog one-time reschedule prompt sent", {
            taskId: task.id,
            senderUserId: sender && sender.userId ? sender.userId : "",
            eventKey: summary.eventKey
          });
        }
      } catch (error) {
        const info = errorInfo(error, "一次性盯梢补时间提示发送失败");
        task.lastError = info.message;
        task.updatedAt = new Date().toISOString();
        save();
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog one-time reschedule prompt failed", {
            taskId: task.id,
            errcode: info.errcode,
            errmsg: info.errmsg,
            message: info.message
          });
        }
      }
    }

    if (
      (task.requesterUserId || task.requesterTargetId)
      && (
        summary.eventKey === "ea_watch_done"
        || summary.eventKey === "ea_watch_progress"
        || summary.eventKey === "ea_watch_blocked"
        || summary.eventKey === "ea_watch_delay"
        || (isOneTimeTask(task) && task.awaitingRescheduleFrom)
      )
    ) {
      try {
        const notice = await sendWatchdogResultNotice(task, label, {
          note: feedbackNote,
          responseAt: now
        });
        if (notice.ok && logger && typeof logger.info === "function") {
          logger.info("Watchdog result notice sent", {
            taskId: task.id,
            eventKey: summary.eventKey,
            channel: notice.channel || "",
            targetConfigured: Boolean(task.requesterUserId || task.requesterTargetId),
            msgid: notice.msgid || ""
          });
        } else if (!notice.ok && logger && typeof logger.warn === "function") {
          logger.warn("Watchdog result notice queued for app retry", {
            taskId: task.id,
            eventKey: summary.eventKey,
            channel: notice.channel || "wecom-app",
            retryAt: notice.retryAt || "",
            reason: notice.reason || notice.error || ""
          });
        }
      } catch (error) {
        const info = errorInfo(error, "盯梢结果通知失败");
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog result notice failed", {
            taskId: task.id,
            errcode: info.errcode,
            errmsg: info.errmsg,
            message: info.message
          });
        }
      }
    }

    if (logger && typeof logger.info === "function") {
      logger.info("Watchdog card response received", {
        taskId: task.id,
        eventKey: summary.eventKey,
        situationId: situation.id,
        noteLength: feedbackNote.length,
        completed: task.status === "completed"
      });
    }

    return {
      handled: true,
      task,
      updateCard: cardUpdateForResponse(task, label, {
        source: sender && sender.source ? sender.source : "",
        note: feedbackNote
      })
    };
  }

  function pendingRejectTaskForSender(sender = {}) {
    const userId = sender.userId || "";
    if (!userId) {
      return null;
    }
    return state.tasks
      .filter((task) => task.status === "rejected_pending_reason")
      .filter((task) => task.awaitingRejectReasonFrom === userId || task.assigneeUserId === userId)
      .sort((left, right) => new Date(right.updatedAt || right.createdAt).getTime() - new Date(left.updatedAt || left.createdAt).getTime())[0] || null;
  }

  function pendingRescheduleTaskForSender(sender = {}, options = {}) {
    const userId = sender.userId || "";
    const senderTarget = targetFromSender(sender);
    const allowRequester = Boolean(options.allowRequester);
    if (!userId && !senderTarget) {
      return null;
    }
    return state.tasks
      .filter((task) => task.status === "active" && isOneTimeTask(task))
      .filter((task) => (
        (userId && (task.awaitingRescheduleFrom === userId || task.assigneeUserId === userId || task.awaitingRescheduleRequesterFrom === userId))
        || (senderTarget && task.awaitingRescheduleRequesterTargetId === senderTarget)
        || (allowRequester && requesterMatchesSender(task, sender))
      ))
      .sort((left, right) => {
        const leftTime = new Date(left.awaitingRescheduleRequesterAt || left.awaitingRescheduleAt || left.updatedAt || left.createdAt).getTime();
        const rightTime = new Date(right.awaitingRescheduleRequesterAt || right.awaitingRescheduleAt || right.updatedAt || right.createdAt).getTime();
        return rightTime - leftTime;
      })[0] || null;
  }

  function clearAwaitingRemarkUpdate(task) {
    task.awaitingRemarkFrom = "";
    task.awaitingRemarkTargetId = "";
    task.awaitingRemarkAt = "";
    task.awaitingRemarkEventKey = "";
    task.awaitingRemarkAssigneeUserId = "";
  }

  function markAwaitingRemarkUpdate(task, sender = {}, eventKey = "", now = new Date().toISOString()) {
    if (!task.requesterTargetId) {
      clearAwaitingRemarkUpdate(task);
      return;
    }
    task.awaitingRemarkFrom = task.requesterUserId || "";
    task.awaitingRemarkTargetId = task.requesterTargetId || "";
    task.awaitingRemarkAt = now;
    task.awaitingRemarkEventKey = eventKey || "";
    task.awaitingRemarkAssigneeUserId = sender && sender.userId ? sender.userId : "";
  }

  function pendingRemarkTaskForSender(sender = {}) {
    const userId = sender.userId || "";
    const senderTarget = targetFromSender(sender);
    const now = Date.now();
    if (!userId && !senderTarget) {
      return null;
    }
    return activeTasks()
      .filter((task) => {
        const at = new Date(task.awaitingRemarkAt || "").getTime();
        return Number.isFinite(at) && now - at <= REMARK_UPDATE_WINDOW_MS;
      })
      .filter((task) => (
        (senderTarget && task.awaitingRemarkTargetId === senderTarget)
        || (userId && task.awaitingRemarkFrom === userId)
        || requesterMatchesSender(task, sender)
      ))
      .sort((left, right) => new Date(right.awaitingRemarkAt || right.updatedAt || right.createdAt).getTime() - new Date(left.awaitingRemarkAt || left.updatedAt || left.createdAt).getTime())[0] || null;
  }

  async function captureRemarkUpdateText(task, context = {}) {
    const sender = context.sender || {};
    const text = normalizeText(context.text);
    const remark = remarkFromUpdateText(text);
    const now = new Date().toISOString();
    task.remark = remark;
    task.remarkUpdatedAt = now;
    task.remarkUpdatedByUserId = sender.userId || "";
    task.remarkUpdatedByName = sender.name || sender.userId || "";
    task.remarkEvents = Array.isArray(task.remarkEvents) ? task.remarkEvents : [];
    task.remarkEvents.push({
      updatedAt: now,
      value: remark,
      senderUserId: sender.userId || "",
      senderName: sender.name || "",
      source: "feedback_followup"
    });
    clearAwaitingRemarkUpdate(task);
    task.updatedAt = now;
    save();
    if (logger && typeof logger.info === "function") {
      logger.info("Watchdog remark updated", {
        taskId: task.id,
        senderUserId: sender.userId || "",
        remarkLength: remark.length,
        nextRunAt: task.nextRunAt || "",
        mode: task.mode || "recurring"
      });
    }
    return {
      handled: true,
      task,
      text: [
        remark ? "备注已更新。" : "备注已清空。",
        `对象：${task.assigneeName || task.assigneeUserId || "未知"}`,
        `任务：${task.content}`,
        watchdogTaskIdLine(task),
        remark ? `备注：${remark}` : "",
        task.nextRunAt ? `下次盯梢：${formatLocalMinute(task.nextRunAt)}` : (task.awaitingRescheduleFrom ? "这条一次性盯梢仍需补充下次时间。" : "盯梢会继续按原规则运行。")
      ].filter(Boolean).join("\n")
    };
  }

  function reschedulableOneTimeTasksForSender(sender = {}) {
    const userId = sender.userId || "";
    return activeTasks()
      .filter((task) => isOneTimeTask(task))
      .filter((task) => requesterMatchesSender(task, sender) || (userId && task.assigneeUserId === userId))
      .sort((left, right) => {
        const leftTime = new Date(left.nextRunAt || left.awaitingRescheduleAt || left.updatedAt || left.createdAt).getTime();
        const rightTime = new Date(right.nextRunAt || right.awaitingRescheduleAt || right.updatedAt || right.createdAt).getTime();
        return leftTime - rightTime;
      });
  }

  function rescheduleCandidatesText(tasks) {
    return [
      "找到多条进行中的一次性盯梢，请补充对象或任务关键词后再设置下次时间：",
      ...tasks.slice(0, 8).map((task, index) => `${index + 1}. ${task.assigneeName || task.assigneeUserId || "未知"}｜${truncate(task.content, 42)}｜任务ID：${watchdogTaskId(task)}｜下次：${task.nextRunAt ? formatLocalMinute(task.nextRunAt) : "待补充"}`),
      tasks.length > 8 ? `还有 ${tasks.length - 8} 条，请补充更具体的对象或任务关键词。` : ""
    ].filter(Boolean).join("\n");
  }

  async function captureOneTimeRescheduleText(task, context = {}) {
    const sender = context.sender || {};
    const text = normalizeText(context.text);
    const requestedByRequester = requesterMatchesSender(task, sender)
      || task.awaitingRescheduleRequesterFrom === (sender.userId || "")
      || task.awaitingRescheduleRequesterTargetId === targetFromSender(sender);
    if (!text) {
      return {
        handled: true,
        task,
        text: oneTimeReschedulePromptText(task)
      };
    }

    const dueAt = parseOneTimeAtFromText(text);
    const recurringSchedule = dueAt ? null : parseRecurringScheduleFromText(text);
    const nextIntervalMinutes = recurringSchedule ? fixedScheduleIntervalMinutes(recurringSchedule) : parseIntervalMinutes(text);
    const now = new Date();
    if (dueAt) {
      task.mode = "once";
      task.dueAt = dueAt.toISOString();
      task.nextRunAt = task.dueAt;
      task.recurringSchedule = null;
      task.oneTimeReminderSentAt = "";
      task.pendingCardTaskId = "";
      task.pendingCardSentAt = "";
      task.awaitingRescheduleFrom = "";
      task.awaitingRescheduleAt = "";
      task.awaitingRescheduleReason = "";
      task.awaitingRescheduleRequesterFrom = "";
      task.awaitingRescheduleRequesterTargetId = "";
      task.awaitingRescheduleRequesterAt = "";
      task.updatedAt = now.toISOString();
      task.lastError = "";
      save();
      if (logger && typeof logger.info === "function") {
        logger.info("Watchdog one-time rescheduled", {
          taskId: task.id,
          senderUserId: sender.userId || "",
          requestedByRequester,
          nextRunAt: task.nextRunAt
        });
      }
      return {
        handled: true,
        task,
        text: [
          "已设置下一次一次性盯梢时间。",
          `对象：${task.assigneeName || task.assigneeUserId || "未知"}`,
          `任务：${task.content}`,
          watchdogTaskIdLine(task),
          `提醒时间：${formatLocalMinute(task.nextRunAt)}`
        ].join("\n")
      };
    }

    if (nextIntervalMinutes) {
      task.mode = "recurring";
      task.dueAt = "";
      task.intervalMinutes = nextIntervalMinutes;
      task.recurringSchedule = recurringSchedule || null;
      task.nextRunAt = nextRunAtForRecurringTask(task, now);
      task.pendingCardTaskId = "";
      task.pendingCardSentAt = "";
      task.awaitingRescheduleFrom = "";
      task.awaitingRescheduleAt = "";
      task.awaitingRescheduleReason = "";
      task.awaitingRescheduleRequesterFrom = "";
      task.awaitingRescheduleRequesterTargetId = "";
      task.awaitingRescheduleRequesterAt = "";
      task.updatedAt = now.toISOString();
      task.lastError = "";
      save();
      if (logger && typeof logger.info === "function") {
        logger.info("Watchdog one-time converted to recurring", {
          taskId: task.id,
          senderUserId: sender.userId || "",
          requestedByRequester,
          intervalMinutes: task.intervalMinutes,
          recurringSchedule: recurringScheduleDisplay(task.recurringSchedule),
          nextRunAt: task.nextRunAt
        });
      }
      return {
        handled: true,
        task,
        text: [
          "已改为循环盯梢。",
          `对象：${task.assigneeName || task.assigneeUserId || "未知"}`,
          `任务：${task.content}`,
          watchdogTaskIdLine(task),
          `盯梢时间：${scheduleDisplay(task)}`,
          `下次盯梢：${formatLocalMinute(task.nextRunAt)}`
        ].join("\n")
      };
    }

    return {
      handled: true,
      task,
      text: [
        "我没识别出新的提醒时间或循环时间。",
        "请回复类似：5月28日 18:00、每2小时一次、每天 10:00、工作日 11:00，或：每周一 16:00。"
      ].join("\n")
    };
  }

  async function capturePendingTextMessage(context = {}) {
    if (!config.enabled) {
      return { handled: false };
    }
    const sender = context.sender || {};
    if (looksLikeRemarkUpdateText(context.text)) {
      const remarkTask = pendingRemarkTaskForSender(sender);
      if (remarkTask) {
        if (looksLikeStandaloneWatchdogCommandText(context.text, remarkTask)) {
          if (logger && typeof logger.info === "function") {
            logger.info("Watchdog pending remark skipped for standalone command", {
              taskId: remarkTask.id,
              senderUserId: sender.userId || "",
              textLength: String(context.text || "").length
            });
          }
          return { handled: false };
        }
        return captureRemarkUpdateText(remarkTask, context);
      }
    }
    const explicitReschedule = looksLikeRescheduleInstructionText(context.text);
    const rescheduleTask = pendingRescheduleTaskForSender(sender, {
      allowRequester: explicitReschedule
    });
    if (rescheduleTask) {
      if (!explicitReschedule && looksLikeKnownNonWatchdogCommandText(context.text)) {
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog pending reschedule skipped for non-watchdog command", {
            taskId: rescheduleTask.id,
            senderUserId: sender.userId || "",
            textLength: String(context.text || "").length
          });
        }
        return { handled: false };
      }
      if (!explicitReschedule && looksLikeStandaloneWatchdogCommandText(context.text, rescheduleTask)) {
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog pending reschedule skipped for standalone command", {
            taskId: rescheduleTask.id,
            senderUserId: sender.userId || "",
            textLength: String(context.text || "").length
          });
        }
        return { handled: false };
      }
      if (explicitReschedule && logger && typeof logger.info === "function") {
        logger.info("Watchdog explicit reschedule text captured", {
          taskId: rescheduleTask.id,
          senderUserId: sender.userId || "",
          requesterMatched: requesterMatchesSender(rescheduleTask, sender),
          textLength: String(context.text || "").length
        });
      }
      return captureOneTimeRescheduleText(rescheduleTask, context);
    }

    const task = pendingRejectTaskForSender(sender);
    if (!task) {
      return { handled: false };
    }

    const reason = normalizeText(context.text);
    if (!reason) {
      return {
        handled: true,
        task,
        text: "拒绝理由不能为空，请直接回复原因。"
      };
    }

    const now = new Date().toISOString();
    task.status = "rejected";
    task.initialAckStatus = "rejected";
    task.rejectReason = reason;
    task.rejectReasonAt = now;
    task.awaitingRejectReasonFrom = "";
    task.nextRunAt = "";
    task.updatedAt = now;
    save();

    if (task.requesterTargetId) {
      try {
        const ack = await sendMarkdown(task.requesterTargetId, rejectReasonNoticeText(task), {
          taskId: task.id,
          purpose: "reject_reason_notice"
        });
        if (ack && ack.errcode) {
          throw new Error(`企业微信返回失败：${ack.errcode} ${ack.errmsg || ""}`.trim());
        }
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog reject reason notice sent", {
            taskId: task.id,
            targetConfigured: Boolean(task.requesterTargetId),
            errcode: ack && ack.errcode,
            errmsg: ack && ack.errmsg
          });
        }
      } catch (error) {
        const info = errorInfo(error, "盯梢拒绝理由通知失败");
        task.lastError = info.message;
        task.updatedAt = new Date().toISOString();
        save();
        if (logger && typeof logger.warn === "function") {
          logger.warn("Watchdog reject reason notice failed", {
            taskId: task.id,
            errcode: info.errcode,
            errmsg: info.errmsg,
            message: info.message
          });
        }
      }
    }

    return {
      handled: true,
      task,
      text: "拒绝理由已提交，我已反馈给发起人。"
    };
  }

  async function rescheduleWatchdogFromText(context = {}) {
    const sender = context.sender || {};
    let task = pendingRescheduleTaskForSender(sender, {
      allowRequester: true
    });
    if (!task) {
      const candidates = reschedulableOneTimeTasksForSender(sender);
      const keywordCandidates = candidates.filter((item) => taskMatchesRescheduleKeyword(item, context.text));
      const matchedCandidates = keywordCandidates.length > 0 ? keywordCandidates : candidates;
      if (matchedCandidates.length === 1) {
        task = matchedCandidates[0];
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog active one-time task selected for reschedule", {
            taskId: task.id,
            senderUserId: sender.userId || "",
            selectedByKeyword: keywordCandidates.length === 1,
            nextRunAt: task.nextRunAt || ""
          });
        }
      } else if (matchedCandidates.length > 1) {
        if (logger && typeof logger.info === "function") {
          logger.info("Watchdog reschedule requested with multiple candidates", {
            senderUserId: sender.userId || "",
            candidateCount: matchedCandidates.length,
            keywordCandidateCount: keywordCandidates.length
          });
        }
        return {
          ok: false,
          module: "watchdog",
          action: "reschedule_watchdog",
          text: rescheduleCandidatesText(matchedCandidates),
          data: {
            candidates: matchedCandidates.map((item) => ({
              id: item.id,
              assigneeName: item.assigneeName || "",
              content: item.content || "",
              nextRunAt: item.nextRunAt || ""
            }))
          }
        };
      }
    }

    if (!task) {
      if (logger && typeof logger.info === "function") {
        logger.info("Watchdog reschedule requested without pending task", {
          senderUserId: sender.userId || "",
          chatId: sender.chatId || "",
          textLength: String(context.text || "").length
        });
      }
      return {
        ok: false,
        module: "watchdog",
        action: "reschedule_watchdog",
        text: [
          "当前没有找到等待补下次时间的一次性盯梢。",
          "需要先让被盯梢人在进度卡里点“正常推进 / 遇到困难 / 需要延期”，或点反馈卡里的“填写下次时间”后再输入。"
        ].join("\n")
      };
    }

    const result = await captureOneTimeRescheduleText(task, context);
    return {
      ok: Boolean(result && result.handled),
      module: "watchdog",
      action: "reschedule_watchdog",
      text: result && result.text ? result.text : "已处理下次盯梢时间。",
      data: {
        taskId: task.id,
        nextRunAt: task.nextRunAt || "",
        mode: task.mode || ""
      }
    };
  }

  function handle(context = {}) {
    const routeTask = context.route && context.route.task ? context.route.task : {};
    const action = String(routeTask.action || "").toLowerCase();
    if (action === "cancel_watchdog") {
      return cancelTaskFromText(context);
    }
    if (action === "list_watchdog") {
      return listWatchdogTasks(context);
    }
    if (action === "help_watchdog") {
      return helpWatchdog(context);
    }
    if (action === "reschedule_watchdog") {
      return rescheduleWatchdogFromText(context);
    }
    return createTaskFromText(context);
  }

  function setRobotServer(nextRobotServer) {
    robotServer = nextRobotServer;
  }

  function runTickSafely() {
    tick().catch((error) => {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Watchdog tick failed", { message: error.message });
      }
    });
  }

  function start() {
    if (timer || !config.enabled) {
      return;
    }
    timer = setInterval(runTickSafely, Math.max(5000, config.tickMs));
    runTickSafely();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStatus() {
    const now = Date.now();
    const targetBackoffs = targetBackoffSnapshot(now);
    return {
      enabled: Boolean(config.enabled),
      running: Boolean(timer),
      defaultIntervalMinutes: config.defaultIntervalMinutes,
      storeFile: stateFile,
      activeCount: activeTasks().length,
      totalCount: state.tasks.length,
      canceledCount: state.tasks.filter((task) => task.status === "canceled").length,
      oneTimeCount: state.tasks.filter((task) => task.status === "active" && isOneTimeTask(task)).length,
      awaitingRescheduleCount: state.tasks.filter((task) => task.status === "active" && task.awaitingRescheduleFrom).length,
      pendingAppResultNoticeCount: state.tasks.filter((task) => Boolean(pendingAppResultNoticeForTask(task, now))).length,
      deduplicatedBacklogCount: state.tasks.filter((task) => task.canceledVia === "dedupe_backlog").length,
      queuedControlCardCount: activeTasks().filter((task) => needsControlCardRetry(task)).length,
      pendingControlCardRetryCount: pendingControlCardRetryTasks(Date.now()).length,
      pendingRejectCount: state.tasks.filter((task) => task.status === "rejected_pending_reason").length,
      pendingDraftCount: pendingDrafts().length,
      appPush: {
        enabled: Boolean(config.appPush.enabled),
        deliveryMode: config.appPush.deliveryMode,
        failureBackoffMs: config.appPush.failureBackoffMs,
        feedbackPageConfigured: Boolean(config.appPush.feedbackUrl),
        testTargetConfigured: Boolean(config.appPush.testTargetUserId),
        failedTaskCount: activeTasks().filter((task) => Boolean(task.appPushLastError)).length,
        notifier: appPushStatus()
      },
      sendQueue: {
        enabled: Boolean(config.sendQueue.enabled),
        serializing: true,
        pendingCount: pendingWatchdogSendCount,
        lastWatchdogSendAt: lastWatchdogSendAt ? new Date(lastWatchdogSendAt).toISOString() : "",
        minIntervalMs: config.sendQueue.minIntervalMs,
        maxSendsPerTick: config.sendQueue.maxSendsPerTick,
        frequencyLimitBackoffMs: config.sendQueue.frequencyLimitBackoffMs,
        frequencyLimitMaxBackoffMs: config.sendQueue.frequencyLimitMaxBackoffMs,
        frequencyLimitFailureCount,
        failureBackoffMs: config.sendQueue.failureBackoffMs,
        batchSameTargetEnabled: Boolean(config.sendQueue.batchSameTargetEnabled),
        backoffUntil: sendBackoffUntil ? new Date(sendBackoffUntil).toISOString() : "",
        globalBackoffUntil: sendBackoffUntil ? new Date(sendBackoffUntil).toISOString() : "",
        globalBackoffRemainingMs: Math.max(0, sendBackoffUntil - now),
        backoffRemainingMs: sendQueueRemainingMs(now),
        targetBackoffCount: targetBackoffs.length,
        targetBackoffs: targetBackoffs.slice(0, 10)
      }
    };
  }

  return {
    name: "watchdog",
    handle,
    setRobotServer,
    start,
    stop,
    tick,
    handleTemplateCardEvent,
    capturePendingTextMessage,
    sendAppPushTest,
    getAppFeedbackTask,
    submitAppFeedback,
    getStatus
  };
}

module.exports = {
  appFeedbackRefForTaskId,
  createWatchdogModule,
  intervalMinutesFromText,
  extractAssigneeName,
  extractTaskContent,
  extractRemark,
  looksLikeRemarkUpdateText,
  remarkFromUpdateText,
  parseWatchdogFormFields,
  looksLikeVersionSummaryQueryText,
  looksLikeKnownNonWatchdogCommandText,
  looksLikeRescheduleInstructionText,
  parseOneTimeAtFromText,
  parseRecurringScheduleFromText,
  nextRecurringScheduleDate,
  recurringScheduleDisplay,
  isWatchdogTaskId
};
