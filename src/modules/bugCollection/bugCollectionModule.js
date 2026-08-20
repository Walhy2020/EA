"use strict";

const { getBugCollectionSettings } = require("../../config/settingsStore");
const { formatLocalMinute } = require("../../utils/localDateTime");
const { maskSecrets } = require("../../utils/secretMask");
const { resolveWeComUserName } = require("../../wecom/wecomUserResolver");
const {
  addIssueRecord,
  listBugCollectionFields,
  migrateBugCollectionTaskIds
} = require("./bugCollectionClient");

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const recentIssueKeys = new Map();

function sanitizeText(value) {
  return maskSecrets(String(value || ""))
    .replace(/((?:api[_ -]?key|secret|token|webhook|password|密码|密钥)\s*[:=：]\s*)[^\s,，;；]+/gi, "$1***")
    .trim();
}

function hasChineseText(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ""));
}

function canonicalText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function issueDedupeKey(issue) {
  return [
    issue.issueType,
    issue.submitter,
    issue.title,
    issue.description,
    issue.screenshot
  ].map(canonicalText).join("\u001f");
}

function cleanupRecentIssues() {
  const cutoff = Date.now() - DEDUPE_WINDOW_MS;
  for (const [key, value] of recentIssueKeys.entries()) {
    if (!value.createdAt || value.createdAt < cutoff) {
      recentIssueKeys.delete(key);
    }
  }
}

function reserveIssueWrite(issue) {
  cleanupRecentIssues();
  const key = issueDedupeKey(issue);
  if (!key.replace(/\u001f/g, "")) {
    return { duplicate: false, key: "" };
  }

  const existing = recentIssueKeys.get(key);
  if (existing && Date.now() - existing.createdAt < DEDUPE_WINDOW_MS) {
    return { duplicate: true, existing };
  }

  const entry = {
    title: displayIssueTitle(issue),
    createdAt: Date.now()
  };
  recentIssueKeys.set(key, entry);
  return { duplicate: false, key };
}

function releaseIssueWrite(key) {
  if (key) {
    recentIssueKeys.delete(key);
  }
}

function normalizeIssueType(value, text = "") {
  const rawValue = String(value || "").trim();
  if (/^(bug|Bug|BUG|缺陷|报错|异常|错误|故障)$/i.test(rawValue)) {
    return "Bug";
  }
  if (/^(需求|建议|优化|反馈|问题|功能)$/i.test(rawValue)) {
    return "需求";
  }

  const rawText = String(text || "");
  return /(bug|BUG|Bug|报错|异常|错误|失败|闪退|卡死|白屏|打不开|无法|不能|崩溃)/.test(rawText)
    ? "Bug"
    : "需求";
}

function displayIssueTitle(issue) {
  return `${issue.issueType || "需求"} - ${issue.title}`;
}

async function senderDisplayName(sender = {}, settings, logger) {
  const directName = sanitizeText(sender.name || "");
  if (directName && hasChineseText(directName)) {
    return directName;
  }

  const userId = sanitizeText(sender.userId || "");
  if (userId) {
    try {
      const resolvedName = sanitizeText(await resolveWeComUserName(settings.auth || {}, userId));
      return resolvedName || directName || userId;
    } catch (error) {
      if (logger) {
        logger.warn("Bug collection submitter name resolve failed", {
          hasUserId: true,
          message: error.message
        });
      }
      return directName || userId;
    }
  }

  return directName || sanitizeText(sender.chatId || sender.source || "未知");
}

async function normalizeIssue(context = {}, settings, logger) {
  const task = context.route && context.route.task ? context.route.task : {};
  const params = task.params || {};
  const title = sanitizeText(params.title || params.summary || "");
  const description = sanitizeText(params.description || params.content || context.text || "");
  const screenshot = sanitizeText(params.screenshot || params.image || params.attachment || "");
  const issueType = normalizeIssueType(
    params.issueType || params.type || params.category,
    `${title} ${description} ${context.text || ""}`
  );
  const submitter = sanitizeText(await senderDisplayName(context.sender || {}, settings, logger) || params.submitter || "未知");
  return {
    issueType,
    title,
    description,
    screenshot,
    submitter,
    createdAt: sanitizeText(params.createdAt || formatLocalMinute()),
    updatedAt: sanitizeText(params.updatedAt || "")
  };
}

function validateIssue(issue) {
  const missing = [];
  if (!issue.title) {
    missing.push("标题");
  }
  if (!issue.description) {
    missing.push("描述");
  }
  return missing;
}

function createBugCollectionModule(options = {}) {
  const logger = options.logger;

  async function collectIssue(context = {}) {
    const settings = getBugCollectionSettings();
    if (!settings.ready) {
      return {
        ok: false,
        module: "bugCollection",
        action: "collect_issue",
        text: "需求和 Bug 收集表还没有配置完整，暂时不能写入。"
      };
    }

    const issue = await normalizeIssue(context, settings, logger);
    const missing = validateIssue(issue);
    if (missing.length > 0) {
      return {
        ok: false,
        module: "bugCollection",
        action: "collect_issue",
        text: `还缺少 ${missing.join("、")}，请补充后我再记录。`,
        data: { missing, issue }
      };
    }

    const reservation = reserveIssueWrite(issue);
    if (reservation.duplicate) {
      return {
        ok: true,
        module: "bugCollection",
        action: "collect_issue",
        text: `这条反馈刚才已经提交过了：${reservation.existing.title || displayIssueTitle(issue)}`,
        data: {
          duplicate: true,
          issue: {
            issueType: issue.issueType,
            title: issue.title,
            description: issue.description,
            screenshot: issue.screenshot,
            submitter: issue.submitter,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt
          }
        }
      };
    }

    const result = await addIssueRecord(settings, issue);
    if (!result.ok) {
      releaseIssueWrite(reservation.key);
      return {
        ok: false,
        module: "bugCollection",
        action: "collect_issue",
        text: result.message || "写入需求和 Bug 收集表失败。",
        data: result
      };
    }

    if (logger) {
      logger.info("Bug collection issue written", {
        taskId: result.taskId || "",
        issueType: issue.issueType,
        titleLength: issue.title.length,
        descriptionLength: issue.description.length,
        submitter: issue.submitter
      });
    }

    return {
      ok: true,
      module: "bugCollection",
      action: "collect_issue",
      text: result.taskId
        ? `反馈已经提交：${displayIssueTitle(issue)}（ID：${result.taskId}）`
        : `反馈已经提交：${displayIssueTitle(issue)}`,
      data: {
        taskId: result.taskId || "",
        issue: {
          issueType: issue.issueType,
          title: issue.title,
          description: issue.description,
          screenshot: issue.screenshot,
          submitter: issue.submitter,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt
        }
      }
    };
  }

  async function previewFields() {
    const settings = getBugCollectionSettings();
    return listBugCollectionFields(settings);
  }

  async function migrateTaskIds() {
    const settings = getBugCollectionSettings();
    return migrateBugCollectionTaskIds(settings);
  }

  async function handle(context = {}) {
    return collectIssue(context);
  }

  async function getStatus() {
    const settings = getBugCollectionSettings();
    return {
      enabled: Boolean(settings.enabled),
      source: settings.source,
      ready: Boolean(settings.ready),
      sheetIdConfigured: Boolean(settings.sheetId),
      fieldMappingCount: Object.values(settings.fieldMapping || {}).filter(Boolean).length
    };
  }

  return {
    name: "bugCollection",
    handle,
    collectIssue,
    migrateTaskIds,
    previewFields,
    getStatus
  };
}

module.exports = {
  createBugCollectionModule
};
