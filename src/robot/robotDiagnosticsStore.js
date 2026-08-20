"use strict";

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { projectRoot } = require("../utils/paths");
const { maskSecrets } = require("../utils/secretMask");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const ISSUE_STATUSES = new Set(["open", "analyzing", "fixed", "ignored"]);
const CORRECTION_EXPIRE_MS = 2 * 60 * 60 * 1000;

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendJsonLine(filePath, record) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(maskSecrets(record))}\n`, "utf8");
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    const text = fs.readFileSync(filePath, "utf8").trim();
    return text ? JSON.parse(text) : fallback;
  } catch (_) {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(maskSecrets(value), null, 2)}\n`, "utf8");
}

function readJsonLines(filePath, limit) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) {
    return [];
  }

  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-clampLimit(limit))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return {
          recordType: "parse_error",
          message: error.message,
          rawLength: line.length
        };
      }
    })
    .reverse();
}

function readAllJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) {
    return [];
  }

  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function fileStatus(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      sizeBytes: 0,
      updatedAt: ""
    };
  }

  const stat = fs.statSync(filePath);
  return {
    exists: true,
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString()
  };
}

function stableHash(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 12);
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...(truncated ${text.length - maxLength} chars)`;
}

function senderKey(sender) {
  const safeSender = sender && typeof sender === "object" ? sender : {};
  if (safeSender.userId) {
    return `user:${safeSender.userId}`;
  }
  if (safeSender.chatId) {
    return `chat:${safeSender.chatId}`;
  }
  if (safeSender.name) {
    return `name:${safeSender.name}`;
  }
  return "";
}

function sortNewestFirst(rows) {
  return rows.slice().sort((a, b) => {
    const left = Date.parse(a.updatedAt || a.createdAt || a.savedAt || 0) || 0;
    const right = Date.parse(b.updatedAt || b.createdAt || b.savedAt || 0) || 0;
    return right - left;
  });
}

function createRobotDiagnosticsStore(options = {}) {
  const logger = options.logger;
  const dataDir = options.dataDir || path.join(projectRoot, "data", "robot-diagnostics");
  const replyTraceFile = path.join(dataDir, "reply-traces.jsonl");
  const feedbackEventFile = path.join(dataDir, "feedback-events.jsonl");
  const issuesFile = path.join(dataDir, "diagnostic-issues.json");

  function appendSafe(filePath, record) {
    try {
      appendJsonLine(filePath, {
        savedAt: new Date().toISOString(),
        ...record
      });
    } catch (error) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Robot diagnostics write failed", {
          fileName: path.basename(filePath),
          message: error.message
        });
      }
    }
  }

  function appendReplyTrace(record) {
    appendSafe(replyTraceFile, {
      recordType: "reply_trace",
      ...record
    });
  }

  function appendFeedbackEvent(record) {
    appendSafe(feedbackEventFile, {
      recordType: "feedback_event",
      ...record
    });
    return upsertIssueFromFeedbackEvent(record);
  }

  function readIssues() {
    const data = readJsonFile(issuesFile, { issues: [] });
    return Array.isArray(data.issues) ? data.issues : [];
  }

  function writeIssues(issues) {
    writeJsonFile(issuesFile, {
      version: 1,
      updatedAt: new Date().toISOString(),
      issues: sortNewestFirst(issues)
    });
  }

  function findReplyTrace(traceId) {
    if (!traceId) {
      return null;
    }

    const traces = readAllJsonLines(replyTraceFile);
    for (let index = traces.length - 1; index >= 0; index -= 1) {
      const trace = traces[index];
      if (trace && (trace.traceId === traceId || trace.feedbackId === traceId)) {
        return trace;
      }
    }
    return null;
  }

  function issueDescriptorFromFeedback(record) {
    const feedback = record && record.feedback ? record.feedback : {};
    if (record.kind === "native_thumbs") {
      if (feedback.type === 2 || feedback.type === "2" || feedback.label === "thumbs_down") {
        return {
          category: "native_thumbs_down",
          title: "原生踩：机器人回复不满意",
          reason: "用户点击了企业微信原生踩"
        };
      }
      return null;
    }

    if (record.kind === "custom_feedback_card") {
      const eventKey = feedback.eventKey || "";
      const label = feedback.label || "";
      if (eventKey === "ea_feedback_resolved" || label === "已解决") {
        return null;
      }
      if (eventKey === "ea_feedback_misunderstood") {
        return {
          category: "misunderstood",
          title: "理解错了",
          reason: "用户反馈机器人理解错了"
        };
      }
      if (eventKey === "ea_feedback_data_wrong") {
        return {
          category: "data_wrong",
          title: "数据不对",
          reason: "用户反馈机器人数据不对"
        };
      }
      if (eventKey === "ea_feedback_incomplete") {
        return {
          category: "incomplete",
          title: "回复不完整",
          reason: "用户反馈机器人回复不完整"
        };
      }
      return {
        category: "custom_negative",
        title: label || "自定义反馈",
        reason: label || eventKey || "用户提交了自定义反馈"
      };
    }

    return null;
  }

  function upsertIssueFromFeedbackEvent(record) {
    const descriptor = issueDescriptorFromFeedback(record);
    if (!descriptor) {
      return null;
    }

    const now = new Date().toISOString();
    const traceId = record.traceId || record.feedbackId || record.taskId || "";
    const feedback = record.feedback || {};
    const issueKey = [
      record.kind || "",
      traceId,
      feedback.type || "",
      feedback.eventKey || "",
      descriptor.category
    ].join("|");
    const issueId = `rd_${stableHash(issueKey)}`;
    const linkedTrace = findReplyTrace(traceId);
    const issues = readIssues();
    const existingIndex = issues.findIndex((issue) => issue.id === issueId);
    const basePatch = {
      updatedAt: now,
      lastFeedbackAt: record.receivedAt || now,
      feedbackCount: 1,
      source: {
        kind: record.kind || "",
        traceId,
        feedbackId: record.feedbackId || "",
        taskId: record.taskId || ""
      },
      feedback: {
        type: feedback.type || "",
        eventKey: feedback.eventKey || "",
        label: feedback.label || ""
      },
      sender: record.sender || {},
      linkedTrace: linkedTrace
        ? {
          traceId: linkedTrace.traceId || linkedTrace.feedbackId || "",
          channel: linkedTrace.channel || "",
          repliedAt: linkedTrace.repliedAt || linkedTrace.sentAt || "",
          sender: linkedTrace.sender || {},
          message: linkedTrace.message || {},
          reply: linkedTrace.reply || {},
          result: linkedTrace.result || {}
        }
        : null
    };

    if (existingIndex >= 0) {
      const current = issues[existingIndex];
      issues[existingIndex] = {
        ...current,
        ...basePatch,
        status: current.status || "open",
        feedbackCount: Number(current.feedbackCount || 0) + 1
      };
      writeIssues(issues);
      return issues[existingIndex];
    }

    const issue = {
      id: issueId,
      status: "open",
      createdAt: now,
      title: descriptor.title,
      category: descriptor.category,
      reason: descriptor.reason,
      note: "",
      ...basePatch
    };
    issues.push(issue);
    writeIssues(issues);
    return issue;
  }

  function listIssues(options = {}) {
    const limit = clampLimit(options.limit);
    const status = String(options.status || "all");
    const issues = readIssues();
    const filtered = status === "all"
      ? issues
      : issues.filter((issue) => issue.status === status);
    return sortNewestFirst(filtered).slice(0, limit);
  }

  function updateIssueStatus(options = {}) {
    const issueId = String(options.issueId || "").trim();
    const status = String(options.status || "").trim();
    if (!issueId) {
      return { ok: false, message: "诊断问题 ID 不能为空" };
    }
    if (!ISSUE_STATUSES.has(status)) {
      return { ok: false, message: "诊断问题状态无效" };
    }

    const issues = readIssues();
    const index = issues.findIndex((issue) => issue.id === issueId);
    if (index < 0) {
      return { ok: false, message: "诊断问题不存在" };
    }

    const now = new Date().toISOString();
    issues[index] = {
      ...issues[index],
      status,
      note: typeof options.note === "string" ? options.note.trim() : issues[index].note || "",
      updatedAt: now,
      statusUpdatedAt: now,
      statusUpdatedBy: options.actor || "admin-console"
    };
    writeIssues(issues);
    return {
      ok: true,
      issue: issues[index]
    };
  }

  function markIssueCorrectionRequested(options = {}) {
    const issueId = String(options.issueId || "").trim();
    if (!issueId) {
      return { ok: false, message: "诊断问题 ID 不能为空" };
    }

    const issues = readIssues();
    const index = issues.findIndex((issue) => issue.id === issueId);
    if (index < 0) {
      return { ok: false, message: "诊断问题不存在" };
    }

    const now = new Date();
    const requestedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + CORRECTION_EXPIRE_MS).toISOString();
    const currentCorrection = issues[index].correction || {};
    issues[index] = {
      ...issues[index],
      updatedAt: requestedAt,
      correction: {
        ...currentCorrection,
        status: "waiting",
        requestedAt,
        expiresAt,
        promptText: truncateText(options.promptText || "", 500),
        promptTargetId: String(options.promptTargetId || ""),
        senderKey: senderKey(options.sender),
        sender: options.sender || {},
        requestCount: Number(currentCorrection.requestCount || 0) + 1
      }
    };
    writeIssues(issues);
    return {
      ok: true,
      issue: issues[index]
    };
  }

  function capturePendingCorrection(options = {}) {
    const key = senderKey(options.sender);
    const text = String(options.text || "").trim();
    if (!key || !text) {
      return { ok: false, captured: false, message: "没有可记录的纠正内容" };
    }

    const receivedAt = options.receivedAt || new Date().toISOString();
    const nowMs = Date.parse(receivedAt) || Date.now();
    const issues = readIssues();
    const candidates = issues
      .map((issue, index) => ({ issue, index }))
      .filter(({ issue }) => {
        const correction = issue.correction || {};
        if (correction.status !== "waiting" || correction.senderKey !== key) {
          return false;
        }
        const expiresAt = Date.parse(correction.expiresAt || 0) || 0;
        return !expiresAt || expiresAt >= nowMs;
      })
      .sort((left, right) => {
        const leftTime = Date.parse(left.issue.correction.requestedAt || left.issue.updatedAt || 0) || 0;
        const rightTime = Date.parse(right.issue.correction.requestedAt || right.issue.updatedAt || 0) || 0;
        return rightTime - leftTime;
      });

    if (candidates.length === 0) {
      return { ok: true, captured: false };
    }

    const { index } = candidates[0];
    const currentCorrection = issues[index].correction || {};
    const isCancel = /^(取消|不用了|算了|先不管|不用)$/i.test(text);
    issues[index] = {
      ...issues[index],
      updatedAt: receivedAt,
      correction: {
        ...currentCorrection,
        status: isCancel ? "canceled" : "received",
        receivedAt,
        text: isCancel ? "" : truncateText(text, 1000),
        sender: options.sender || currentCorrection.sender || {}
      }
    };
    writeIssues(issues);
    return {
      ok: true,
      captured: true,
      canceled: isCancel,
      issue: issues[index]
    };
  }

  function listRecent(options = {}) {
    const limit = clampLimit(options.limit);
    const issues = listIssues({
      limit,
      status: options.status || "all"
    });
    return {
      limit,
      replyTraces: readJsonLines(replyTraceFile, limit),
      feedbackEvents: readJsonLines(feedbackEventFile, limit),
      issues,
      files: getStatus().files
    };
  }

  function getStatus() {
    return {
      enabled: true,
      dataDir,
      files: {
        replyTraces: fileStatus(replyTraceFile),
        feedbackEvents: fileStatus(feedbackEventFile),
        issues: fileStatus(issuesFile)
      }
    };
  }

  return {
    appendReplyTrace,
    appendFeedbackEvent,
    listIssues,
    updateIssueStatus,
    markIssueCorrectionRequested,
    capturePendingCorrection,
    listRecent,
    getStatus
  };
}

module.exports = {
  createRobotDiagnosticsStore
};
