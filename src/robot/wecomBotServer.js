"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { normalizeRobotMessage } = require("./messageNormalizer");
const { errorInfo } = require("../utils/errorInfo");

function errorMessage(error) {
  return error && error.message ? error.message : String(error || "");
}

function isAuthFailure(error) {
  const message = errorMessage(error);
  return (error && error.code === "WS_AUTH_FAILURE_EXHAUSTED")
    || /Authentication failed|invalid bot_id or secret|853000|Max auth failure attempts/i.test(message);
}

function loadSdk(searchDirs) {
  const paths = [__dirname].concat(searchDirs || []);
  const resolved = require.resolve("@wecom/aibot-node-sdk", { paths });
  return require(resolved);
}

function canLoadSdk(searchDirs) {
  try {
    loadSdk(searchDirs);
    return true;
  } catch (_) {
    return false;
  }
}

function configValue(config, directKey, envKeyName, defaultEnvName) {
  const envName = config[envKeyName] || defaultEnvName;
  return process.env[envName] || config[directKey] || "";
}

function textFromFrame(frame) {
  return frame && frame.body && frame.body.text && frame.body.text.content
    ? String(frame.body.text.content)
    : "";
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...(truncated ${text.length - maxLength} chars)`;
}

function shortHash(value) {
  return crypto
    .createHash("sha1")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 8);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function createMarkdownMessagePayload(content, options = {}) {
  const text = String(content || "").trim();
  const payload = {
    msgtype: "markdown",
    markdown: { content: text }
  };
  if (options && options.mentionAll) {
    payload.mentioned_list = ["@all"];
  }
  return payload;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function limitedKeys(value, limit = 30) {
  return Object.keys(plainObject(value)).slice(0, limit);
}

function safeShortValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
  }

  const text = value.trim();
  if (text.length <= 80) {
    return text;
  }
  return `${text.slice(0, 32)}...(${text.length} chars)`;
}

function isSensitiveProbeKey(key) {
  const normalized = String(key || "").toLowerCase();
  return /secret|token|apikey|api_key|webhook|password|credential|authorization|userid|user_id|chatid|aibotid|msgid|url|content|text|comment|reason|desc/.test(normalized);
}

function isFeedbackSignalKey(key) {
  const normalized = String(key || "").toLowerCase();
  if (!normalized) {
    return false;
  }
  if (/user|chat|bot|msg|url|content|text|comment|reason|desc|time/.test(normalized)) {
    return false;
  }
  return /feedback|thumb|like|dislike|score|rating|satisf|attitude|result|action|vote|choice|type|id/.test(normalized);
}

function shouldIncludeFeedbackProbeValue(prefix, key) {
  if (isSensitiveProbeKey(key)) {
    return false;
  }
  const normalizedPrefix = String(prefix || "").toLowerCase();
  return normalizedPrefix.includes("feedback") || isFeedbackSignalKey(key);
}

function collectFeedbackSignals(target, prefix, result, depth = 0) {
  const source = plainObject(target);
  for (const [key, value] of Object.entries(source)) {
    if (Object.keys(result).length >= 40) {
      return;
    }
    const path = `${prefix}.${key}`;
    if (value && typeof value === "object") {
      if (depth < 3 && shouldIncludeFeedbackProbeValue(prefix, key)) {
        result[`${path}.__keys`] = limitedKeys(value, 20).join(",");
        collectFeedbackSignals(value, path, result, depth + 1);
      }
      continue;
    }
    if (shouldIncludeFeedbackProbeValue(prefix, key)) {
      result[path] = safeShortValue(value);
    }
  }
}

function feedbackIdFromFrame(body, event) {
  const feedback = plainObject(body.feedback);
  const feedbackInfo = plainObject(body.feedback_info || body.feedbackInfo);
  const eventFeedback = plainObject(event.feedback);
  const nestedFeedbackEvent = plainObject(event.feedback_event || event.feedbackEvent);
  return firstString(
    event.feedback_id,
    event.feedbackid,
    event.feedbackId,
    event.id,
    eventFeedback.id,
    nestedFeedbackEvent.id,
    nestedFeedbackEvent.feedback_id,
    nestedFeedbackEvent.feedbackid,
    nestedFeedbackEvent.feedbackId,
    body.feedback_id,
    body.feedbackid,
    body.feedbackId,
    feedback.id,
    feedbackInfo.id
  );
}

function feedbackTypeLabel(type) {
  if (type === 1 || type === "1") {
    return "thumbs_up";
  }
  if (type === 2 || type === "2") {
    return "thumbs_down";
  }
  return "";
}

function customFeedbackLabel(key) {
  const labels = {
    ea_feedback_resolved: "已解决",
    ea_feedback_misunderstood: "理解错了",
    ea_feedback_data_wrong: "数据不对",
    ea_feedback_incomplete: "不完整"
  };
  return labels[key] || key || "";
}

function summarizeTemplateCardEvent(frame) {
  const body = plainObject(frame && frame.body);
  const event = plainObject(body.event);
  const nestedEvent = plainObject(event.template_card_event || event.templateCardEvent);
  const eventKey = firstString(
    event.event_key,
    event.eventKey,
    nestedEvent.event_key,
    nestedEvent.eventKey,
    nestedEvent.key
  );
  const taskId = firstString(
    event.task_id,
    event.taskId,
    nestedEvent.task_id,
    nestedEvent.taskId
  );

  return {
    receivedAt: new Date().toISOString(),
    eventKey,
    label: customFeedbackLabel(eventKey),
    taskId,
    bodyKeys: limitedKeys(body),
    eventKeys: limitedKeys(event),
    eventCardKeys: limitedKeys(nestedEvent),
    signalValues: {
      eventtype: event.eventtype || "",
      eventKey,
      taskId
    },
    hasUser: Boolean(body.from && body.from.userid),
    chatType: body.chattype || "",
    hasChatId: Boolean(body.chatid)
  };
}

function createCustomFeedbackCard(options = {}) {
  const taskId = options.taskId || `ea_feedback_${Date.now()}`;
  const title = options.title || "这次回复解决问题了吗？";
  const desc = options.desc || "这是一张 EA 自定义反馈卡片，按钮文案和数量可以由我们控制。";
  const horizontalContentList = Array.isArray(options.horizontalContentList)
    ? options.horizontalContentList
    : [
      {
        keyname: "用途",
        value: "机器人诊断"
      },
      {
        keyname: "说明",
        value: "点击按钮后 EA 会收到事件"
      }
    ];

  return {
    card_type: "button_interaction",
    source: {
      desc: "EA系统反馈",
      desc_color: 0
    },
    main_title: {
      title,
      desc
    },
    card_action: {
      type: 1,
      url: "https://work.weixin.qq.com"
    },
    horizontal_content_list: horizontalContentList,
    button_list: [
      { text: "已解决", key: "ea_feedback_resolved", style: 1 },
      { text: "理解错了", key: "ea_feedback_misunderstood", style: 2 },
      { text: "数据不对", key: "ea_feedback_data_wrong", style: 2 },
      { text: "不完整", key: "ea_feedback_incomplete", style: 3 }
    ],
    task_id: taskId
  };
}

function summarizeFeedbackEvent(frame) {
  const body = plainObject(frame && frame.body);
  const event = plainObject(body.event);
  const nestedFeedbackEvent = plainObject(event.feedback_event || event.feedbackEvent);
  const feedbackType = nestedFeedbackEvent.type;
  const signals = {};
  collectFeedbackSignals(event, "event", signals);
  collectFeedbackSignals(body, "body", signals);
  collectFeedbackSignals(body.feedback, "body.feedback", signals);
  collectFeedbackSignals(body.feedback_info || body.feedbackInfo, "body.feedbackInfo", signals);
  collectFeedbackSignals(nestedFeedbackEvent, "event.feedback_event", signals);

  return {
    receivedAt: new Date().toISOString(),
    eventType: event.eventtype || body.eventtype || "",
    feedbackId: feedbackIdFromFrame(body, event),
    feedbackType,
    feedbackLabel: feedbackTypeLabel(feedbackType),
    bodyKeys: limitedKeys(body),
    eventKeys: limitedKeys(event),
    eventFeedbackKeys: limitedKeys(nestedFeedbackEvent),
    hasUser: Boolean(body.from && body.from.userid),
    chatType: body.chattype || "",
    hasChatId: Boolean(body.chatid),
    signalValues: signals
  };
}

function senderFromFrame(frame) {
  const body = plainObject(frame && frame.body);
  const from = plainObject(body.from);
  const sender = plainObject(body.sender);
  const user = plainObject(body.user);

  return {
    source: "wecom-smart-bot",
    chatType: body.chattype || "",
    chatId: body.chatid || "",
    chatName: firstString(
      body.chatname,
      body.chat_name,
      body.groupname,
      body.group_name,
      body.roomname,
      body.room_name
    ),
    groupName: firstString(
      body.groupname,
      body.group_name,
      body.chatname,
      body.chat_name
    ),
    userId: firstString(
      body.userid,
      body.user_id,
      body.from_userid,
      body.fromUserId,
      sender.userid,
      sender.user_id,
      from.userid,
      from.user_id,
      user.userid,
      user.user_id
    ),
    name: firstString(
      body.name,
      body.nickname,
      body.username,
      sender.name,
      sender.nickname,
      from.name,
      from.nickname,
      user.name,
      user.nickname
    )
  };
}

function routeSummaryFromResult(result) {
  const route = plainObject(result && result.route);
  const intent = plainObject(result && result.intent);
  const source = Object.keys(route).length > 0 ? route : intent;

  return {
    source: firstString(source.source, source.provider),
    module: firstString(source.module, source.moduleName),
    action: firstString(source.action, source.intent, source.name),
    status: firstString(source.status),
    confidence: source.confidence === undefined ? "" : source.confidence
  };
}

function resultSummaryForDiagnostics(result) {
  const safeResult = plainObject(result);
  return {
    ok: result && result.ok === false ? false : true,
    resultKeys: limitedKeys(safeResult, 30),
    route: routeSummaryFromResult(result),
    textLength: result && result.text ? String(result.text).length : 0
  };
}

function appendReplyTrace(diagnostics, logger, record) {
  if (!diagnostics || typeof diagnostics.appendReplyTrace !== "function") {
    return;
  }

  try {
    diagnostics.appendReplyTrace(record);
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn("Robot reply trace append failed", { message: errorMessage(error) });
    }
  }
}

function appendFeedbackEvent(diagnostics, logger, record) {
  if (!diagnostics || typeof diagnostics.appendFeedbackEvent !== "function") {
    return null;
  }

  try {
    return diagnostics.appendFeedbackEvent(record);
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn("Robot feedback event append failed", { message: errorMessage(error) });
    }
  }
  return null;
}

function markIssueCorrectionRequested(diagnostics, logger, record) {
  if (!diagnostics || typeof diagnostics.markIssueCorrectionRequested !== "function") {
    return null;
  }

  try {
    return diagnostics.markIssueCorrectionRequested(record);
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn("Robot issue correction request mark failed", { message: errorMessage(error) });
    }
  }
  return null;
}

function capturePendingCorrection(diagnostics, logger, record) {
  if (!diagnostics || typeof diagnostics.capturePendingCorrection !== "function") {
    return null;
  }

  try {
    return diagnostics.capturePendingCorrection(record);
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn("Robot issue correction capture failed", { message: errorMessage(error) });
    }
  }
  return null;
}

function correctionPromptText() {
  return [
    "我理解错了。",
    "你原本想查或提交什么内容？请直接补一句。",
    "例如：查刘宇任务、提交一个 Bug、看榜单。"
  ].join("\n");
}

function correctionTargetFromSender(sender) {
  const safeSender = sender || {};
  return safeSender.userId || "";
}

function configuredFeedbackCardMode(config) {
  const mode = config && config.feedbackCard ? config.feedbackCard.mode : "";
  return ["disabled", "private_only", "all_chats"].includes(mode) ? mode : "private_only";
}

function configuredFeedbackCardCooldownMs(config) {
  const value = config && config.feedbackCard ? Number(config.feedbackCard.cooldownMinutes) : NaN;
  const minutes = Number.isFinite(value) ? Math.max(0, value) : 10;
  return minutes * 60 * 1000;
}

function feedbackCardTarget(config, sender) {
  const mode = configuredFeedbackCardMode(config);
  const safeSender = sender || {};
  const userId = safeSender.userId || "";
  const chatId = safeSender.chatId || "";
  const chatType = String(safeSender.chatType || "").toLowerCase();
  const isGroupChat = chatType.includes("group");

  if (mode === "disabled") {
    return { enabled: false, mode, reason: "disabled" };
  }

  if (mode === "private_only") {
    if (userId) {
      return {
        enabled: true,
        mode,
        targetId: userId,
        targetType: "user",
        privateDelivery: true
      };
    }
    return { enabled: false, mode, reason: "missing_user_id" };
  }

  if (isGroupChat && chatId) {
    return {
      enabled: true,
      mode,
      targetId: chatId,
      targetType: "group",
      privateDelivery: false
    };
  }

  if (userId) {
    return {
      enabled: true,
      mode,
      targetId: userId,
      targetType: "user",
      privateDelivery: true
    };
  }

  return { enabled: false, mode, reason: "missing_target" };
}

function correctionReplyTrace({ reply, content, replyContent, receivedAt, sender, correction }) {
  const issue = correction && correction.issue ? correction.issue : {};
  return {
    traceId: reply && reply.feedbackId ? reply.feedbackId : `correction_${Date.now()}`,
    feedbackId: reply && reply.feedbackId ? reply.feedbackId : "",
    channel: "robot_diagnostic_correction",
    receivedAt,
    repliedAt: reply && reply.sentAt ? reply.sentAt : new Date().toISOString(),
    sender,
    message: {
      text: truncateText(content, 1000),
      length: String(content || "").length
    },
    reply: {
      text: truncateText(replyContent, 1000),
      length: replyContent.length
    },
    result: {
      ok: true,
      route: {
        source: "robotDiagnostics",
        module: "robotDiagnostics",
        action: correction && correction.canceled ? "cancelCorrection" : "captureCorrection",
        status: "handled"
      },
      issueId: issue.id || "",
      issueTitle: issue.title || ""
    }
  };
}

function watchdogCaptureReplyTrace({ reply, content, replyContent, receivedAt, sender, capture }) {
  const task = capture && capture.task ? capture.task : {};
  return {
    traceId: reply && reply.feedbackId ? reply.feedbackId : `watchdog_capture_${Date.now()}`,
    feedbackId: reply && reply.feedbackId ? reply.feedbackId : "",
    channel: "watchdog_pending_text",
    receivedAt,
    repliedAt: reply && reply.sentAt ? reply.sentAt : new Date().toISOString(),
    sender,
    message: {
      text: truncateText(content, 1000),
      length: String(content || "").length
    },
    reply: {
      text: truncateText(replyContent, 1000),
      length: replyContent.length
    },
    result: {
      ok: true,
      route: {
        source: "watchdog",
        module: "watchdog",
        action: "captureRejectReason",
        status: "handled"
      },
      taskId: task.id || "",
      taskStatus: task.status || ""
    }
  };
}

function createWecomBotServer(options) {
  const config = options.config || {};
  const router = options.router;
  const logger = options.logger;
  const diagnostics = options.diagnostics;
  const watchdog = options.watchdog;
  const desktopTip = options.desktopTip;
  let monitorManager = options.monitorManager || null;
  const sdkSearchDirs = options.sdkSearchDirs || [];
  let wsClient = null;
  let running = false;
  let stoppingAfterAuthFailure = false;
  const feedbackProbe = {
    enabled: true,
    replyFeedbackAttached: false,
    eventCount: 0,
    lastReplyFeedbackId: "",
    lastReplyAt: "",
    lastEvent: null
  };
  const customFeedbackCardProbe = {
    sentCount: 0,
    eventCount: 0,
    lastTaskId: "",
    lastSentAt: "",
    lastEvent: null
  };
  const feedbackCardLastSentAtByTarget = new Map();
  const processingReplyText = "处理中，请稍等...";

  function setMonitorManager(value) {
    monitorManager = value || null;
  }

  async function replyText(frame, text) {
    if (!wsClient) {
      throw new Error("WeCom bot client is not started");
    }

    const sdk = loadSdk(sdkSearchDirs);
    const streamId = sdk.generateReqId("eazygame");
    const feedback = { id: streamId };
    const sentAt = new Date().toISOString();
    feedbackProbe.replyFeedbackAttached = true;
    feedbackProbe.lastReplyFeedbackId = feedback.id;
    feedbackProbe.lastReplyAt = sentAt;
    const ack = await wsClient.replyStream(frame, streamId, text, true, undefined, feedback);
    return {
      ack,
      feedbackId: feedback.id,
      streamId,
      sentAt
    };
  }

  async function startReplyStream(frame, text = processingReplyText) {
    if (!wsClient) {
      throw new Error("WeCom bot client is not started");
    }

    const sdk = loadSdk(sdkSearchDirs);
    const streamId = sdk.generateReqId("eazygame");
    const feedback = { id: streamId };
    const startedAt = new Date().toISOString();
    feedbackProbe.replyFeedbackAttached = true;
    feedbackProbe.lastReplyFeedbackId = feedback.id;
    feedbackProbe.lastReplyAt = startedAt;
    const ack = await wsClient.replyStream(frame, streamId, text, false, undefined, feedback);
    return {
      ack,
      feedbackId: feedback.id,
      streamId,
      startedAt,
      processingText: text
    };
  }

  async function finishReplyStream(frame, stream, text) {
    if (!stream || !stream.streamId) {
      return replyText(frame, text);
    }
    if (!wsClient) {
      throw new Error("WeCom bot client is not started");
    }

    const sentAt = new Date().toISOString();
    const ack = await wsClient.replyStream(frame, stream.streamId, text, true);
    return {
      ack,
      feedbackId: stream.feedbackId || stream.streamId,
      streamId: stream.streamId,
      startedAt: stream.startedAt || "",
      sentAt,
      processingText: stream.processingText || processingReplyText,
      processingAck: stream.ack
    };
  }

  async function sendMarkdownMessage(targetId, content, options = {}) {
    if (!wsClient || !running) {
      throw new Error("企业微信机器人未运行，不能主动推送");
    }
    if (typeof wsClient.sendMessage !== "function") {
      throw new Error("当前企业微信机器人 SDK 不支持主动推送");
    }
    if (!targetId || !String(targetId).trim()) {
      throw new Error("主动推送目标不能为空");
    }
    const text = String(content || "").trim();
    if (!text) {
      throw new Error("主动推送内容不能为空");
    }

    const payload = createMarkdownMessagePayload(text, options);
    return wsClient.sendMessage(String(targetId).trim(), payload);
  }

  async function sendTemplateCardMessage(targetId, templateCard) {
    if (!wsClient || !running) {
      throw new Error("企业微信机器人未运行，不能主动推送");
    }
    if (typeof wsClient.sendMessage !== "function") {
      throw new Error("当前企业微信机器人 SDK 不支持主动推送");
    }
    if (!targetId || !String(targetId).trim()) {
      throw new Error("主动推送目标不能为空");
    }
    if (!templateCard || typeof templateCard !== "object") {
      throw new Error("模板卡片不能为空");
    }

    return wsClient.sendMessage(String(targetId).trim(), {
      msgtype: "template_card",
      template_card: templateCard
    });
  }

  function fileTargetFromSender(sender) {
    const safeSender = sender || {};
    const chatType = String(safeSender.chatType || "").toLowerCase();
    if (chatType.includes("group") && safeSender.chatId) {
      return safeSender.chatId;
    }
    return safeSender.userId || safeSender.chatId || "";
  }

  function fileTargetTypeFromSender(sender) {
    const safeSender = sender || {};
    const chatType = String(safeSender.chatType || "").toLowerCase();
    if (chatType.includes("group") && safeSender.chatId) {
      return "group";
    }
    if (safeSender.userId) {
      return "user";
    }
    if (safeSender.chatId) {
      return "chat";
    }
    return "unknown";
  }

  function resultFiles(result) {
    const files = Array.isArray(result && result.files) ? result.files : [];
    return files
      .map((file) => ({
        path: file.path || file.filePath || "",
        filename: file.filename || file.name || "",
        mediaType: file.mediaType || "file",
        description: file.description || "",
        targetId: file.targetId || "",
        targetLabel: file.targetLabel || "",
        targetSource: file.targetSource || ""
      }))
      .filter((file) => file.path);
  }

  async function sendFileMessage(targetId, file) {
    if (!wsClient || !running) {
      throw new Error("企业微信机器人未运行，不能发送文件");
    }
    if (typeof wsClient.uploadMedia !== "function" || typeof wsClient.sendMediaMessage !== "function") {
      throw new Error("当前企业微信机器人 SDK 不支持文件上传或媒体消息发送");
    }
    if (!targetId || !String(targetId).trim()) {
      throw new Error("文件发送目标不能为空");
    }
    if (!file.path || !fs.existsSync(file.path)) {
      throw new Error("待发送文件不存在");
    }

    const filename = file.filename || path.basename(file.path);
    const upload = await wsClient.uploadMedia(fs.readFileSync(file.path), {
      type: file.mediaType || "file",
      filename
    });
    const mediaId = upload && upload.media_id ? upload.media_id : "";
    if (!mediaId) {
      throw new Error("文件上传后没有返回 media_id");
    }
    const ack = await wsClient.sendMediaMessage(String(targetId).trim(), "file", mediaId);
    return {
      upload: {
        type: upload.type,
        mediaId,
        createdAt: upload.created_at
      },
      ack
    };
  }

  async function sendResultFiles({ sender, result, replyTraceId }) {
    const files = resultFiles(result);
    if (files.length === 0) {
      return [];
    }

    const targetId = fileTargetFromSender(sender);
    if (!targetId && !files.some((file) => file.targetId)) {
      logger.warn("WeCom smart robot file send skipped; target missing", {
        replyTraceId,
        fileCount: files.length
      });
      return [];
    }

    const sent = [];
    for (const file of files) {
      const fileTargetId = String(file.targetId || targetId || "").trim();
      try {
        const fileResult = await sendFileMessage(fileTargetId, file);
        sent.push({
          filename: file.filename || path.basename(file.path),
          targetConfigured: true,
          errcode: fileResult.ack && fileResult.ack.errcode
        });
        logger.info("WeCom smart robot file sent", {
          replyTraceId,
          filename: file.filename || path.basename(file.path),
          targetType: file.targetId ? "explicit" : fileTargetTypeFromSender(sender),
          errcode: fileResult.ack && fileResult.ack.errcode
        });
      } catch (error) {
        const info = errorInfo(error, "文件发送失败");
        sent.push({
          filename: file.filename || path.basename(file.path),
          ok: false,
          errcode: info.errcode,
          errmsg: info.errmsg,
          message: info.message
        });
        logger.warn("WeCom smart robot file send failed", {
          replyTraceId,
          filename: file.filename || path.basename(file.path),
          errcode: info.errcode,
          errmsg: info.errmsg,
          cmd: info.cmd,
          message: info.message
        });
      }
    }
    return sent;
  }

  async function sendFeedbackCardForReply({ sender, replyTraceId, questionText, answerText }) {
    const target = feedbackCardTarget(config, sender);
    if (!target.enabled) {
      if (logger && typeof logger.debug === "function") {
        logger.debug("WeCom smart robot feedback card skipped", {
          mode: target.mode,
          reason: target.reason
        });
      }
      return null;
    }

    const cooldownMs = configuredFeedbackCardCooldownMs(config);
    const targetKey = `${target.mode}:${target.targetType}:${target.targetId}`;
    const now = Date.now();
    const lastSentAt = feedbackCardLastSentAtByTarget.get(targetKey) || 0;
    if (cooldownMs > 0 && lastSentAt && now - lastSentAt < cooldownMs) {
      if (logger && typeof logger.info === "function") {
        logger.info("WeCom smart robot feedback card skipped by cooldown", {
          mode: target.mode,
          targetType: target.targetType,
          remainingSeconds: Math.ceil((cooldownMs - (now - lastSentAt)) / 1000)
        });
      }
      return null;
    }

    const templateCard = createCustomFeedbackCard({
      taskId: `ea_feedback_${Date.now()}_${shortHash(replyTraceId)}`,
      desc: "点击后只进入 EA 机器人诊断，不会在群里展示具体原因。",
      horizontalContentList: [
        {
          keyname: "用途",
          value: "机器人诊断"
        },
        {
          keyname: "说明",
          value: target.privateDelivery ? "这张卡片只发给你" : "点击原因不会公开显示"
        }
      ]
    });
    const sentAt = new Date().toISOString();

    try {
      const ack = await sendTemplateCardMessage(target.targetId, templateCard);
      const buttons = templateCard.button_list.map((button) => ({
        text: button.text,
        key: button.key
      }));
      customFeedbackCardProbe.sentCount += 1;
      customFeedbackCardProbe.lastTaskId = templateCard.task_id;
      customFeedbackCardProbe.lastSentAt = sentAt;
      feedbackCardLastSentAtByTarget.set(targetKey, now);
      appendReplyTrace(diagnostics, logger, {
        traceId: templateCard.task_id,
        linkedReplyTraceId: replyTraceId || "",
        channel: "custom_feedback_card_reply",
        sentAt,
        sender: Object.assign({}, sender, {
          targetId: target.targetId,
          targetType: target.targetType,
          privateDelivery: target.privateDelivery
        }),
        message: {
          text: truncateText(questionText, 1000),
          length: String(questionText || "").length
        },
        reply: {
          text: truncateText(answerText, 2000),
          length: String(answerText || "").length,
          cardTitle: templateCard.main_title.title,
          cardDesc: templateCard.main_title.desc,
          buttons
        },
        result: {
          ok: !(ack && ack.errcode),
          route: {
            source: "wecom-smart-bot",
            module: "robotDiagnostics",
            action: "customFeedbackCardForReply",
            status: "sent"
          },
          feedbackCard: {
            mode: target.mode,
            targetType: target.targetType,
            privateDelivery: target.privateDelivery,
            linkedReplyTraceId: replyTraceId || ""
          },
          ack: {
            errcode: ack && ack.errcode,
            errmsg: ack && ack.errmsg,
            cmd: ack && ack.cmd
          }
        }
      });
      logger.info("WeCom smart robot feedback card sent", {
        taskId: templateCard.task_id,
        linkedReplyTraceId: replyTraceId,
        targetType: target.targetType,
        errcode: ack && ack.errcode
      });
      return { ack, taskId: templateCard.task_id };
    } catch (error) {
      const info = errorInfo(error, "自定义反馈卡片发送失败");
      logger.warn("WeCom smart robot feedback card send failed", {
        linkedReplyTraceId: replyTraceId,
        mode: target.mode,
        targetType: target.targetType,
        errcode: info.errcode,
        errmsg: info.errmsg,
        cmd: info.cmd,
        message: info.message
      });
      return null;
    }
  }

  async function sendCustomFeedbackCard(targetId) {
    const templateCard = createCustomFeedbackCard();
    const ack = await sendTemplateCardMessage(targetId, templateCard);
    const sentAt = new Date().toISOString();
    customFeedbackCardProbe.sentCount += 1;
    customFeedbackCardProbe.lastTaskId = templateCard.task_id;
    customFeedbackCardProbe.lastSentAt = sentAt;
    appendReplyTrace(diagnostics, logger, {
      traceId: templateCard.task_id,
      channel: "custom_feedback_card_test",
      sentAt,
      sender: {
        source: "admin-console",
        targetId: String(targetId || "")
      },
      message: {
        text: "管理台发送自定义反馈卡片测试",
        length: 14
      },
      reply: {
        text: templateCard.main_title.title,
        length: templateCard.main_title.title.length,
        buttons: templateCard.button_list.map((button) => ({
          text: button.text,
          key: button.key
        }))
      },
      result: {
        ok: !(ack && ack.errcode),
        route: {
          source: "admin-console",
          module: "robotDiagnostics",
          action: "customFeedbackCardTest"
        },
        ack: {
          errcode: ack && ack.errcode,
          errmsg: ack && ack.errmsg,
          cmd: ack && ack.cmd
        }
      }
    });
    return {
      ack,
      card: {
        taskId: templateCard.task_id,
        title: templateCard.main_title.title,
        buttons: templateCard.button_list.map((button) => ({
          text: button.text,
          key: button.key
        }))
      }
    };
  }

  async function handleRawMessage(raw) {
    const message = normalizeRobotMessage(raw);
    return router.handleMessage(message);
  }

  async function start() {
    if (!config.enabled) {
      logger.info("WeCom smart robot is disabled");
      return false;
    }

    const botId = configValue(config, "botId", "botIdEnv", "WECOM_SMART_BOT_ID");
    const secret = configValue(config, "secret", "secretEnv", "WECOM_SMART_BOT_SECRET");
    if (!botId || !secret) {
      logger.warn("WeCom smart robot is enabled but Bot ID or Secret is missing");
      return false;
    }

    let sdk = null;
    try {
      sdk = loadSdk(sdkSearchDirs);
    } catch (error) {
      logger.error("WeCom smart robot SDK is not available", { message: error.message });
      return false;
    }

    wsClient = new sdk.WSClient({
      botId,
      secret,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 0,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {}
      }
    });

    wsClient.on("connected", () => {
      if (!stoppingAfterAuthFailure) {
        logger.info("WeCom smart robot connected, authenticating");
      }
    });

    wsClient.on("authenticated", () => {
      running = true;
      logger.info("WeCom smart robot authenticated");
    });

    wsClient.on("disconnected", (reason) => {
      running = false;
      if (!stoppingAfterAuthFailure) {
        logger.warn("WeCom smart robot disconnected", { reason: reason || "" });
      }
    });

    wsClient.on("reconnecting", (attempt) => {
      if (!stoppingAfterAuthFailure) {
        logger.warn("WeCom smart robot reconnecting", { attempt });
      }
    });

    wsClient.on("error", (error) => {
      if (isAuthFailure(error)) {
        stoppingAfterAuthFailure = true;
        running = false;
        logger.error("WeCom smart robot auth failed; robot entry stopped, admin service remains online");
        try {
          wsClient.disconnect();
        } catch (_) {
        }
        return;
      }

      logger.error("WeCom smart robot error", { message: errorMessage(error) });
    });

    wsClient.on("message.text", async (frame) => {
      const content = textFromFrame(frame);
      const receivedAt = new Date().toISOString();
      const sender = senderFromFrame(frame);
      logger.info("WeCom text message received", { length: content.length });
      let processingReply = null;
      try {
        if (desktopTip && typeof desktopTip.captureWecomGroupBindingMessage === "function") {
          const desktopTipGroupResult = await desktopTip.captureWecomGroupBindingMessage({
            text: content,
            sender,
            raw: frame
          });
          if (desktopTipGroupResult && desktopTipGroupResult.handled) {
            const replyContent = desktopTipGroupResult.message || "已处理 M04 通知群设置。";
            const reply = await replyText(frame, replyContent);
            logger.info("WeCom desktop tip group binding command handled", {
              sourceKey: "desktop_tip_wecom_group_registry",
              action: desktopTipGroupResult.action || "",
              ok: Boolean(desktopTipGroupResult.ok),
              chatType: sender.chatType || "",
              hasChatId: Boolean(sender.chatId),
              hasUserId: Boolean(sender.userId),
              replyStarted: Boolean(reply && reply.streamId)
            });
            return;
          }
        }

        if (monitorManager && typeof monitorManager.captureTextMessage === "function") {
          const monitorResult = await monitorManager.captureTextMessage({
            text: content,
            sender,
            raw: frame
          });
          if (monitorResult && monitorResult.handled) {
            const replyContent = monitorResult.text || "已处理。";
            const reply = await replyText(frame, replyContent);
            logger.info("WeCom dev progress monitor group command handled", {
              chatType: sender.chatType || "",
              hasChatId: Boolean(sender.chatId),
              hasUserId: Boolean(sender.userId),
              replyStarted: Boolean(reply && reply.streamId)
            });
            return;
          }
        }

        const correction = capturePendingCorrection(diagnostics, logger, {
          sender,
          text: content,
          receivedAt
        });
        if (correction && correction.captured) {
          const replyContent = correction.canceled
            ? "好的，这次诊断补充已取消。"
            : "收到，我已把你的正确意图记录到机器人诊断问题单里。";
          const reply = await replyText(frame, replyContent);
          appendReplyTrace(diagnostics, logger, correctionReplyTrace({
            reply,
            content,
            replyContent,
            receivedAt,
            sender,
            correction
          }));
          logger.info("WeCom smart robot correction captured", {
            issueId: correction.issue && correction.issue.id,
            canceled: Boolean(correction.canceled)
          });
          return;
        }

        if (watchdog && typeof watchdog.capturePendingTextMessage === "function") {
          const watchdogCapture = await watchdog.capturePendingTextMessage({
            sender,
            text: content,
            receivedAt
          });
          if (watchdogCapture && watchdogCapture.handled) {
            const replyContent = watchdogCapture.text || "已记录。";
            const reply = await replyText(frame, replyContent);
            appendReplyTrace(diagnostics, logger, watchdogCaptureReplyTrace({
              reply,
              content,
              replyContent,
              receivedAt,
              sender,
              capture: watchdogCapture
            }));
            logger.info("WeCom smart robot watchdog pending text captured", {
              taskId: watchdogCapture.task && watchdogCapture.task.id,
              status: watchdogCapture.task && watchdogCapture.task.status
            });
            return;
          }
        }

        try {
          processingReply = await startReplyStream(frame);
          logger.info("WeCom smart robot processing reply sent", {
            feedbackId: processingReply.feedbackId
          });
        } catch (processingError) {
          logger.warn("WeCom smart robot processing reply failed", {
            message: errorMessage(processingError)
          });
        }

        const result = await router.handleMessage({
          text: content,
          sender,
          raw: frame
        });
        const replyContent = result.text || "没有可回复的内容。";
        const reply = await finishReplyStream(frame, processingReply, replyContent);
        appendReplyTrace(diagnostics, logger, {
          traceId: reply.feedbackId,
          feedbackId: reply.feedbackId,
          channel: "wecom_smart_bot_reply",
          receivedAt,
          repliedAt: reply.sentAt,
          sender,
          message: {
            text: truncateText(content, 1000),
            length: content.length
          },
          reply: {
            text: truncateText(replyContent, 2000),
            length: replyContent.length,
            streamed: Boolean(processingReply),
            processingText: processingReply ? processingReply.processingText : "",
            processingStartedAt: processingReply ? processingReply.startedAt : ""
          },
          result: resultSummaryForDiagnostics(result)
        });
        logger.info("WeCom smart robot reply sent", { feedbackId: reply.feedbackId });
        await sendResultFiles({
          sender,
          result,
          replyTraceId: reply.feedbackId
        });
        await sendFeedbackCardForReply({
          sender,
          replyTraceId: reply.feedbackId,
          questionText: content,
          answerText: replyContent
        });
      } catch (error) {
        logger.error("WeCom smart robot reply failed", { message: errorMessage(error) });
        const replyContent = `查询失败：${errorMessage(error)}`;
        let failureReply = null;
        try {
          failureReply = await finishReplyStream(frame, processingReply, replyContent);
        } catch (replyError) {
          logger.error("WeCom smart robot failure reply failed", { message: errorMessage(replyError) });
        }
        appendReplyTrace(diagnostics, logger, {
          traceId: failureReply && failureReply.feedbackId ? failureReply.feedbackId : `reply_failure_${Date.now()}`,
          feedbackId: failureReply && failureReply.feedbackId ? failureReply.feedbackId : "",
          channel: "wecom_smart_bot_reply",
          receivedAt,
          repliedAt: failureReply && failureReply.sentAt ? failureReply.sentAt : new Date().toISOString(),
          sender,
          message: {
            text: truncateText(content, 1000),
            length: content.length
          },
          reply: {
            text: truncateText(replyContent, 2000),
            length: replyContent.length,
            sent: Boolean(failureReply),
            streamed: Boolean(processingReply),
            processingText: processingReply ? processingReply.processingText : "",
            processingStartedAt: processingReply ? processingReply.startedAt : ""
          },
          result: {
            ok: false,
            error: {
              message: errorMessage(error)
            }
          }
        });
      }
    });

    wsClient.on("event.feedback_event", (frame) => {
      const summary = summarizeFeedbackEvent(frame);
      feedbackProbe.eventCount += 1;
      feedbackProbe.lastEvent = summary;
      appendFeedbackEvent(diagnostics, logger, {
        kind: "native_thumbs",
        traceId: summary.feedbackId,
        feedbackId: summary.feedbackId,
        receivedAt: summary.receivedAt,
        sender: senderFromFrame(frame),
        feedback: {
          type: summary.feedbackType,
          label: summary.feedbackLabel
        },
        event: summary
      });
      logger.info("WeCom smart robot feedback event received", summary);
    });

    wsClient.on("event.template_card_event", async (frame) => {
      const summary = summarizeTemplateCardEvent(frame);
      const sender = senderFromFrame(frame);
      if (
        monitorManager
        && typeof monitorManager.handleTemplateCardEvent === "function"
        && summary.taskId
        && summary.taskId.startsWith("ea_dev_required_")
      ) {
        try {
          const result = await monitorManager.handleTemplateCardEvent(summary, sender);
          logger.info("WeCom dev progress required field card event received", {
            taskId: summary.taskId,
            eventKey: summary.eventKey,
            handled: Boolean(result && result.handled),
            updateCard: Boolean(result && result.updateCard)
          });
          if (result && result.message && sender.userId) {
            try {
              await sendMarkdownMessage(sender.userId, result.message);
            } catch (messageError) {
              logger.warn("WeCom dev progress card permission notice failed", {
                taskId: summary.taskId,
                eventKey: summary.eventKey,
                message: messageError.message
              });
            }
          }
          if (result && result.handled && result.updateCard && typeof wsClient.updateTemplateCard === "function") {
            const ack = await wsClient.updateTemplateCard(frame, {
              ...result.updateCard,
              task_id: summary.taskId
            });
            logger.info("WeCom dev progress required field card updated", {
              taskId: summary.taskId,
              eventKey: summary.eventKey,
              errcode: ack && ack.errcode,
              errmsg: ack && ack.errmsg
            });
          }
        } catch (error) {
          const info = errorInfo(error, "需求必填项群卡片事件处理失败");
          logger.warn("WeCom dev progress required field card event failed", {
            taskId: summary.taskId,
            eventKey: summary.eventKey,
            errcode: info.errcode,
            errmsg: info.errmsg,
            message: info.message
          });
        }
        return;
      }

      if (
        watchdog
        && typeof watchdog.handleTemplateCardEvent === "function"
        && summary.taskId
        && summary.taskId.startsWith("ea_watch_")
      ) {
        try {
          const result = await watchdog.handleTemplateCardEvent(summary, sender);
          logger.info("WeCom smart robot watchdog card event received", {
            taskId: summary.taskId,
            eventKey: summary.eventKey,
            handled: Boolean(result && result.handled)
          });
          if (result && result.handled && result.updateCard && typeof wsClient.updateTemplateCard === "function") {
            try {
              const ack = await wsClient.updateTemplateCard(frame, {
                ...result.updateCard,
                task_id: summary.taskId
              });
              logger.info("WeCom smart robot watchdog card updated", {
                taskId: summary.taskId,
                eventKey: summary.eventKey,
                errcode: ack && ack.errcode,
                errmsg: ack && ack.errmsg
              });
            } catch (error) {
              const info = errorInfo(error, "盯梢卡片更新失败");
              logger.warn("WeCom smart robot watchdog card update failed", {
                taskId: summary.taskId,
                eventKey: summary.eventKey,
                errcode: info.errcode,
                errmsg: info.errmsg,
                cmd: info.cmd,
                reqId: info.reqId,
                message: info.message
              });
            }
          }
        } catch (error) {
          const info = errorInfo(error, "盯梢卡片事件处理失败");
          logger.warn("WeCom smart robot watchdog card event failed", {
            taskId: summary.taskId,
            eventKey: summary.eventKey,
            errcode: info.errcode,
            errmsg: info.errmsg,
            message: info.message
          });
        }
        return;
      }

      customFeedbackCardProbe.eventCount += 1;
      customFeedbackCardProbe.lastEvent = summary;
      const diagnosticIssue = appendFeedbackEvent(diagnostics, logger, {
        kind: "custom_feedback_card",
        traceId: summary.taskId,
        taskId: summary.taskId,
        receivedAt: summary.receivedAt,
        sender,
        feedback: {
          eventKey: summary.eventKey,
          label: summary.label
        },
        event: summary
      });
      logger.info("WeCom smart robot template card event received", summary);

      if (
        summary.eventKey === "ea_feedback_misunderstood" &&
        diagnosticIssue &&
        diagnosticIssue.id
      ) {
        const targetId = correctionTargetFromSender(sender);
        if (targetId) {
          const promptText = correctionPromptText();
          try {
            const ack = await sendMarkdownMessage(targetId, promptText);
            markIssueCorrectionRequested(diagnostics, logger, {
              issueId: diagnosticIssue.id,
              sender,
              promptText,
              promptTargetId: targetId
            });
            logger.info("WeCom smart robot correction prompt sent", {
              issueId: diagnosticIssue.id,
              targetId,
              errcode: ack && ack.errcode
            });
          } catch (error) {
            const info = errorInfo(error, "诊断纠正追问发送失败");
            logger.warn("WeCom smart robot correction prompt failed", {
              issueId: diagnosticIssue.id,
              targetConfigured: Boolean(targetId),
              errcode: info.errcode,
              errmsg: info.errmsg,
              cmd: info.cmd,
              message: info.message
            });
          }
        } else {
          logger.warn("WeCom smart robot correction prompt skipped; user id missing", {
            issueId: diagnosticIssue.id,
            chatType: sender.chatType || ""
          });
        }
      }

      if (summary.taskId && summary.taskId.startsWith("ea_feedback_") && typeof wsClient.updateTemplateCard === "function") {
        try {
          const ack = await wsClient.updateTemplateCard(frame, {
            card_type: "text_notice",
            source: {
              desc: "EA系统反馈",
              desc_color: 3
            },
            main_title: {
              title: "已收到反馈",
              desc: "这条反馈已进入 EA 机器人诊断记录。"
            },
            card_action: {
              type: 1,
              url: "https://work.weixin.qq.com"
            },
            task_id: summary.taskId
          });
          logger.info("WeCom smart robot template card updated", {
            taskId: summary.taskId,
            eventKey: summary.eventKey,
            errcode: ack && ack.errcode,
            errmsg: ack && ack.errmsg
          });
        } catch (error) {
          const info = errorInfo(error, "模板卡片更新失败");
          logger.warn("WeCom smart robot template card update failed", {
            taskId: summary.taskId,
            eventKey: summary.eventKey,
            errcode: info.errcode,
            errmsg: info.errmsg,
            cmd: info.cmd,
            reqId: info.reqId,
            message: info.message
          });
        }
      }
    });

    wsClient.on("event.enter_chat", async (frame) => {
      try {
        await wsClient.replyWelcome(frame, {
          msgtype: "text",
          text: {
            content: config.welcomeText || "EazyGame Assistant 已在线。"
          }
        });
      } catch (error) {
        logger.warn("WeCom smart robot welcome failed", { message: errorMessage(error) });
      }
    });

    wsClient.connect();
    running = true;
    logger.info("WeCom smart robot long connection started");
    return true;
  }

  function stop() {
    if (wsClient) {
      try {
        wsClient.disconnect();
      } catch (_) {
      }
      wsClient = null;
    }
    running = false;
  }

  function getStatus() {
    return {
      enabled: Boolean(config.enabled),
      running,
      provider: config.provider || "wecom-smart-bot",
      sdkAvailable: canLoadSdk(sdkSearchDirs),
      botIdConfigured: Boolean(configValue(config, "botId", "botIdEnv", "WECOM_SMART_BOT_ID")),
      secretConfigured: Boolean(configValue(config, "secret", "secretEnv", "WECOM_SMART_BOT_SECRET")),
      feedbackCard: {
        mode: configuredFeedbackCardMode(config),
        cooldownMinutes: configuredFeedbackCardCooldownMs(config) / 60000,
        updatePrivacy: "generic"
      },
      feedbackProbe: {
        enabled: feedbackProbe.enabled,
        replyFeedbackAttached: feedbackProbe.replyFeedbackAttached,
        eventCount: feedbackProbe.eventCount,
        lastReplyFeedbackId: feedbackProbe.lastReplyFeedbackId,
        lastReplyAt: feedbackProbe.lastReplyAt,
        lastEvent: feedbackProbe.lastEvent
      },
      customFeedbackCardProbe: {
        sentCount: customFeedbackCardProbe.sentCount,
        eventCount: customFeedbackCardProbe.eventCount,
        lastTaskId: customFeedbackCardProbe.lastTaskId,
        lastSentAt: customFeedbackCardProbe.lastSentAt,
        lastEvent: customFeedbackCardProbe.lastEvent
      }
    };
  }

  return {
    start,
    stop,
    sendMarkdownMessage,
    sendFileMessage,
    sendTemplateCardMessage,
    sendCustomFeedbackCard,
    setMonitorManager,
    handleRawMessage,
    getStatus
  };
}

module.exports = {
  createWecomBotServer,
  createMarkdownMessagePayload,
  senderFromFrame
};
