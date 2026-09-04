"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { projectRoot, resolveProjectPath } = require("../utils/paths");
const { sanitizedConfigSummary } = require("../config/configLoader");
const {
  getBugCollectionSettings,
  getDemandWorkflowRulesSettings,
  getDevProgressSettings,
  getAllSettings,
  getRobotSettings,
  updateAiSettings,
  updateBasicSettings,
  updateBugCollectionSettings,
  updateDemandWorkflowRulesSettings,
  updateDevProgressSettings,
  updateNotificationSettings,
  updateRankSettings,
  updateRobotSettings,
  updateRobotOutboundTestSettings
} = require("../config/settingsStore");
const { testDevProgressConnection } = require("../modules/devProgress/wecomSmartsheetClient");
const {
  cleanupBugCollectionFields,
  createBugCollectionDocument,
  listBugCollectionFields,
  migrateBugCollectionTaskIds,
  setupBugCollectionSheet
} = require("../modules/bugCollection/bugCollectionClient");
const { errorInfo } = require("../utils/errorInfo");
const { maskSecrets } = require("../utils/secretMask");
const { resolveWeComOAuthUserId, resolveWeComUserName } = require("../wecom/wecomUserResolver");
const { demandH5OAuthCallbackUrl, demandWebLoginCallbackUrl } = require("./demandH5OAuth");
const { resolveDemandH5EntryPolicy, isDemandH5OAuthRequestOriginAllowed } = require("./demandH5EntryPolicy");
const { signDemandH5State, verifyDemandH5State } = require("./demandH5AuthState");
const {
  DEFAULT_TTL_MS,
  clearDemandH5SessionCookie,
  createDemandH5Session,
  demandH5SessionCookie,
  readDemandH5Session
} = require("./demandH5Session");

const packageInfo = require("../../package.json");
const staticDir = path.join(__dirname, "static");

function contentType(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

function sendJson(res, statusCode, payload, options = {}) {
  const shouldMask = options.maskSecrets !== false;
  const body = JSON.stringify(shouldMask ? maskSecrets(payload) : payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function requestDesktopTipToken(req, url, body = {}) {
  return String(
    req.headers["x-ea-tip-token"]
    || url.searchParams.get("token")
    || body.token
    || ""
  ).trim();
}

function trimText(value) {
  return String(value || "").trim();
}

function maskLogId(value) {
  const text = trimText(value);
  if (!text) return "";
  if (text.length <= 4) return "***";
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const staticAliases = {
    "/demand": "/demand-h5.html",
    "/demand/": "/demand-h5.html"
  };
  const pathname = staticAliases[url.pathname] || (url.pathname === "/" ? "/index.html" : url.pathname);
  const targetPath = path.normalize(path.join(staticDir, pathname));

  if (!targetPath.startsWith(staticDir) || !fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
    return false;
  }

  res.writeHead(200, {
    "Content-Type": contentType(targetPath),
    "Cache-Control": "no-store"
  });
  fs.createReadStream(targetPath).pipe(res);
  return true;
}

function demandH5ReturnPath(value) {
  const target = new URL(String(value || "/demand-h5.html"), "http://localhost");
  if (!new Set(["/", "/index.html", "/demand-h5.html", "/demand", "/demand/", "/watchdog-feedback.html"]).has(target.pathname)) {
    return "/demand-h5.html";
  }
  if (target.pathname === "/watchdog-feedback.html") {
    const feedbackRef = String(target.searchParams.get("ref") || "").trim().toLowerCase();
    target.search = "";
    target.hash = "";
    if (/^[a-f0-9]{12}$/.test(feedbackRef)) {
      target.searchParams.set("ref", feedbackRef);
    }
    return `${target.pathname}${target.search}`;
  }
  target.searchParams.delete("code");
  target.searchParams.delete("state");
  target.searchParams.delete("userName");
  target.searchParams.delete("name");
  target.searchParams.delete("submitter");
  target.searchParams.delete("entryAuth");
  target.searchParams.delete("entryError");
  return `${target.pathname}${target.search}${target.hash}`;
}

function h5EntryRequestMeta(req, url, result) {
  const cache = result && result.cache && typeof result.cache === "object" ? result.cache : {};
  return {
    entryId: String(req.headers["x-ea-demand-entry-id"] || "").slice(0, 80),
    entrySource: String(req.headers["x-ea-demand-entry-source"] || "").slice(0, 80),
    pageVersion: String(req.headers["x-ea-demand-page-version"] || "").slice(0, 32),
    project: String(url.searchParams.get("project") || "").slice(0, 80),
    forceRefresh: url.searchParams.get("forceRefresh") === "1",
    waitForRefresh: url.searchParams.get("waitForRefresh") === "1",
    ignoredUserNameParameter: Boolean(url.searchParams.get("userName")),
    itemCount: Array.isArray(result && result.items) ? result.items.length : 0,
    cacheVersion: Number(cache.version || 0),
    cacheRefreshedAt: String(cache.refreshedAt || ""),
    cacheSignalCheckedAt: String(cache.signalCheckedAt || ""),
    cacheModifyTime: String(cache.modifyTime || ""),
    cachePartialRefreshedAt: String(cache.partialRefreshedAt || ""),
    cachePartialRefreshedCount: Number(cache.partialRefreshedCount || 0),
    cacheRecentInteractionCount: Number(cache.recentInteractionCount || 0),
    cacheSignalUnchanged: Boolean(cache.signalUnchanged),
    cacheBackgroundSyncStarted: Boolean(cache.backgroundSyncStarted),
    cacheSignalError: String(cache.signalError || "").slice(0, 300),
    cacheRefreshError: String(cache.refreshError || "").slice(0, 300),
    cacheRefreshInProgress: Boolean(cache.refreshInProgress),
    cacheNeedsRefresh: Boolean(cache.needsRefresh),
    ok: Boolean(result && result.ok)
  };
}

function createAdminServer(options) {
  const config = options.config;
  const router = options.router;
  const modules = options.modules;
  const robotServer = options.robotServer;
  const robotDiagnostics = options.robotDiagnostics;
  const monitorManager = options.monitorManager;
  const notificationCenter = options.notificationCenter;
  const wecomAppCallback = options.wecomAppCallback;
  const logger = options.logger;
  let server = null;
  let healthServer = null;
  const clientManualSendLastAtByClientId = new Map();
  const clientManualSendRateLimitMs = 60 * 1000;
  const clientManualMessageForbiddenFields = [
    "recipientUsers",
    "recipientGroups",
    "recipients",
    "recipientIds",
    "recipientGroupId",
    "recipientScope",
    "recipientType",
    "targetUserId",
    "targetClientId",
    "clientIds",
    "targetClientIds",
    "targetUserIds",
    "chatId",
    "chatIds",
    "groupChatId",
    "groupChatIds",
    "operatorUserId",
    "updatedBy",
    "createdBy",
    "userId",
    "sourceKey"
  ];

  function normalizeManualWecomGroupOptions(body = {}) {
    const raw = body.wecomGroups && typeof body.wecomGroups === "object" && !Array.isArray(body.wecomGroups)
      ? body.wecomGroups
      : {};
    const enabled = raw.enabled === true;
    const targets = Array.isArray(raw.targets) ? raw.targets : [];
    return {
      enabled,
      targets: targets.map((target) => ({
        groupId: trimText(target && target.groupId),
        mentionMode: trimText(target && target.mentionMode) === "all" ? "all" : "none"
      })).filter((target) => target.groupId)
    };
  }

  function manualWecomGroupMessage({ title, body, operatorName, mentionMode }) {
    const lines = [];
    if (mentionMode === "all") {
      lines.push("@所有人");
    }
    lines.push(`**${trimText(title) || "EA桌面提醒"}**`);
    lines.push("");
    lines.push(trimText(body));
    if (operatorName) {
      lines.push("");
      lines.push(`发送人：${operatorName}`);
    }
    return lines.join("\n");
  }

  function disabledManualWecomGroupResult() {
    return {
      enabled: false,
      requestedCount: 0,
      successCount: 0,
      failedCount: 0,
      results: []
    };
  }

  function prepareDesktopTipManualWecomGroups(body = {}) {
    const options = normalizeManualWecomGroupOptions(body);
    if (!options.enabled) {
      return disabledManualWecomGroupResult();
    }
    if (options.targets.length <= 0) {
      const error = new Error("勾选企业微信群通知后至少选择 1 个已绑定群");
      error.statusCode = 400;
      throw error;
    }
    if (!modules.desktopTip || typeof modules.desktopTip.resolveWecomGroupTargets !== "function") {
      const error = new Error("EA 桌面提醒群通知模块未启用");
      error.statusCode = 503;
      throw error;
    }
    const targets = modules.desktopTip.resolveWecomGroupTargets(options.targets);
    return {
      enabled: true,
      requestedCount: targets.length,
      targets
    };
  }

  function clientSenderIdFromRequest(req, url, body = {}) {
    return trimText(
      (body && body.clientId)
      || url.searchParams.get("clientId")
      || req.headers["x-ea-tip-client-id"]
      || ""
    );
  }

  function requireRegisteredDesktopTipClient(req, res, url, body = {}) {
    const clientId = clientSenderIdFromRequest(req, url, body);
    if (!clientId) {
      sendJson(res, 401, { ok: false, message: "缺少已登记 EA 桌面提醒客户端 clientId" });
      return null;
    }
    const client = modules.desktopTip && typeof modules.desktopTip.getRegisteredClient === "function"
      ? modules.desktopTip.getRegisteredClient(clientId)
      : null;
    if (!client) {
      sendJson(res, 403, { ok: false, message: "当前客户端尚未登记，请先启动 EA 桌面提醒并成功连接一次" });
      return null;
    }
    return client;
  }

  function rejectClientManualMessageForbiddenFields(body = {}) {
    const forbiddenFields = clientManualMessageForbiddenFields
      .filter((field) => Object.prototype.hasOwnProperty.call(body || {}, field));
    const rawTargets = body && body.wecomGroups && Array.isArray(body.wecomGroups.targets)
      ? body.wecomGroups.targets
      : [];
    const forbiddenNested = rawTargets.some((target) => target && typeof target === "object" && (
      Object.prototype.hasOwnProperty.call(target, "chatId")
      || Object.prototype.hasOwnProperty.call(target, "chatIds")
      || Object.prototype.hasOwnProperty.call(target, "userId")
      || Object.prototype.hasOwnProperty.call(target, "targetUserId")
      || Object.prototype.hasOwnProperty.call(target, "targetClientId")
      || Object.prototype.hasOwnProperty.call(target, "operatorUserId")
    ));
    if (forbiddenFields.length > 0) {
      const error = new Error("客户端发送通知不允许指定接收人、群 chatId、操作者或任意目标参数");
      error.statusCode = 400;
      error.forbiddenFields = forbiddenFields;
      throw error;
    }
    if (forbiddenNested) {
      const error = new Error("客户端发送通知的企业微信群只允许使用服务端返回的 groupId 和通知方式");
      error.statusCode = 400;
      throw error;
    }
  }

  function publicClientWecomGroups(status = {}) {
    const groups = Array.isArray(status.groups) ? status.groups : [];
    return {
      enabled: Boolean(status.enabled),
      groupCount: groups.length,
      groups: groups.map((group) => ({
        groupId: trimText(group && group.groupId),
        displayName: trimText(group && group.displayName),
        source: trimText(group && group.source),
        boundAt: trimText(group && group.boundAt),
        updatedAt: trimText(group && group.updatedAt)
      })).filter((group) => group.groupId)
    };
  }

  function assertClientManualRateLimit(clientId) {
    const key = trimText(clientId);
    const now = Date.now();
    const lastAt = Number(clientManualSendLastAtByClientId.get(key) || 0);
    const waitMs = clientManualSendRateLimitMs - (now - lastAt);
    if (waitMs > 0) {
      const error = new Error(`发送太频繁，请 ${Math.ceil(waitMs / 1000)} 秒后再试`);
      error.statusCode = 429;
      error.retryAfterSeconds = Math.ceil(waitMs / 1000);
      throw error;
    }
    clientManualSendLastAtByClientId.set(key, now);
  }

  function validateClientManualMessageContent(body = {}) {
    const title = trimText(body.title);
    const messageBody = trimText(body.body || body.content);
    if (!title) {
      const error = new Error("普通桌面消息标题不能为空");
      error.statusCode = 400;
      throw error;
    }
    if (!messageBody) {
      const error = new Error("普通桌面消息内容不能为空");
      error.statusCode = 400;
      throw error;
    }
    if (title.length > 80) {
      const error = new Error("普通桌面消息标题不能超过 80 个字符");
      error.statusCode = 400;
      throw error;
    }
    if (messageBody.length > 1000) {
      const error = new Error("普通桌面消息内容不能超过 1000 个字符");
      error.statusCode = 400;
      throw error;
    }
  }

  async function sendDesktopTipManualWecomGroups({ body, identity, desktopResult, prepared, sourceKey = "admin_manual_message" }) {
    const groupPlan = prepared || prepareDesktopTipManualWecomGroups(body);
    if (!groupPlan.enabled) {
      return disabledManualWecomGroupResult();
    }
    const targets = groupPlan.targets || [];
    const results = [];
    for (const target of targets) {
      try {
        if (!robotServer || typeof robotServer.sendMarkdownMessage !== "function") {
          throw new Error("1号机器人主动群发送能力未启用");
        }
        const ack = await robotServer.sendMarkdownMessage(
          target.chatId,
          manualWecomGroupMessage({
            title: body.title,
            body: body.body || body.content,
            operatorName: identity.name || "",
            mentionMode: target.mentionMode
          }),
          { mentionAll: target.mentionMode === "all" }
        );
        const ok = !(ack && ack.errcode);
        results.push({
          groupId: target.groupId,
          displayName: target.displayName,
          mentionMode: target.mentionMode,
          ok,
          errcode: ack && ack.errcode,
          errmsg: trimText(ack && ack.errmsg)
        });
      } catch (error) {
        results.push({
          groupId: target.groupId,
          displayName: target.displayName,
          mentionMode: target.mentionMode,
          ok: false,
          message: error && error.message ? error.message : String(error || "")
        });
      }
    }
    const successCount = results.filter((item) => item.ok).length;
    const failedCount = results.length - successCount;
    if (logger && typeof logger.info === "function") {
      logger.info("Desktop tip manual WeCom group notification finished", {
        sourceKey,
        batchId: desktopResult && desktopResult.batchId ? desktopResult.batchId : "",
        operatorUserId: maskLogId(identity && identity.userId),
        requestedCount: targets.length,
        successCount,
        failedCount,
        mentionAllCount: targets.filter((item) => item.mentionMode === "all").length
      });
    }
    return {
      enabled: true,
      requestedCount: targets.length,
      successCount,
      failedCount,
      results
    };
  }

  function httpsServerOptions() {
    const settings = config.app && config.app.server && config.app.server.https;
    if (!settings || settings.enabled !== true) {
      return null;
    }
    const certPath = resolveProjectPath(settings.certPath);
    const keyPath = resolveProjectPath(settings.keyPath);
    if (!certPath || !keyPath || !fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      throw new Error("EA HTTPS 证书或私钥文件不存在");
    }
    return {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      certPath,
      keyPath,
      healthHost: String(settings.healthHost || "127.0.0.1").trim() || "127.0.0.1",
      healthPort: Number(settings.healthPort || 0)
    };
  }

  function startLocalHealthServer(options) {
    if (!options || !Number.isInteger(options.healthPort) || options.healthPort <= 0) {
      return;
    }
    healthServer = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true, service: "ea-admin-https" });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("Not found");
    });
    healthServer.listen(options.healthPort, options.healthHost, () => {
      logger.info("EA local health server started", {
        url: `http://${options.healthHost}:${options.healthPort}/healthz`
      });
    });
  }

  function showSecretsInAdmin() {
    return !(config.app && config.app.security && config.app.security.showSecretsInAdmin === false);
  }

  function settingsResponseOptions() {
    return { maskSecrets: !showSecretsInAdmin() };
  }

  function redirectToDemandH5(res, returnPath, errorCode = "") {
    const target = new URL(demandH5ReturnPath(returnPath), "http://localhost");
    if (errorCode) target.searchParams.set("entryError", errorCode);
    res.writeHead(302, { Location: `${target.pathname}${target.search}${target.hash}`, "Cache-Control": "no-store" });
    res.end();
  }

  function redirectToDemandLogin(res, returnPath, errorCode = "") {
    const target = new URL("/demand-login.html", "http://localhost");
    target.searchParams.set("returnTo", demandH5ReturnPath(returnPath));
    if (errorCode) target.searchParams.set("entryError", errorCode);
    res.writeHead(302, { Location: `${target.pathname}${target.search}`, "Cache-Control": "no-store" });
    res.end();
  }

  function demandH5AuthSettings() {
    const auth = (getDevProgressSettings() || {}).auth || {};
    return {
      auth,
      corpId: String(process.env[auth.corpIdEnv] || "").trim(),
      agentId: String(process.env[auth.agentIdEnv] || "").trim(),
      secret: String(process.env[auth.secretEnv] || "").trim()
    };
  }

  function demandH5SessionResult(req) {
    const settings = demandH5AuthSettings();
    if (!settings.secret) return { ok: false, reason: "session_secret_unavailable" };
    return readDemandH5Session(req, settings.secret);
  }

  function requireDemandH5Identity(req, res, routeName) {
    const session = demandH5SessionResult(req);
    if (session.ok) return session.identity;
    logger.warn("Demand H5 authenticated request rejected", {
      route: routeName,
      method: req.method,
      reason: session.reason,
      entryId: String(req.headers["x-ea-demand-entry-id"] || "").slice(0, 80)
    });
    const unavailable = session.reason === "session_secret_unavailable";
    sendJson(res, unavailable ? 503 : 401, {
      ok: false,
      code: unavailable ? "demand_session_unavailable" : "demand_session_required",
      message: unavailable ? "需求进度登录服务暂不可用" : "登录已失效，请重新使用企业微信扫码登录"
    });
    return null;
  }

  function issueDemandH5Session(identity, secret) {
    const session = createDemandH5Session(identity, secret, { ttlMs: DEFAULT_TTL_MS });
    return {
      ...session,
      cookie: demandH5SessionCookie(session.token, { secure: true, maxAgeSeconds: DEFAULT_TTL_MS / 1000 })
    };
  }

  function demandH5EntryPolicy() {
    const demandCollaboration = config.modules && config.modules.modules && config.modules.modules.demandCollaboration
      ? config.modules.modules.demandCollaboration
      : {};
    const requiredFieldsPush = getDevProgressSettings()?.monitor?.requiredFieldsPush || {};
    return resolveDemandH5EntryPolicy({
      oauthRedirectOrigin: demandCollaboration.oauthRedirectOrigin,
      internalHttpOAuth: demandCollaboration.internalHttpOAuth,
      testMode: Boolean(requiredFieldsPush.testMode),
      testFallbackUserName: demandCollaboration.testFallbackUserName
    });
  }

  async function handleDemandH5Auth(req, res) {
    const url = new URL(req.url, "http://localhost");
    const { auth, corpId, agentId, secret } = demandH5AuthSettings();
    const code = String(url.searchParams.get("code") || "").trim();
    const host = String(req.headers.host || "").trim();

    if (!corpId || !agentId || !secret) {
      logger.warn("Demand H5 WeCom auth unavailable", { hasCorpId: Boolean(corpId), hasAgentId: Boolean(agentId), hasSecret: Boolean(secret) });
      redirectToDemandH5(res, url.searchParams.get("returnTo"), "wecom_auth_unavailable");
      return;
    }

    const entryPolicy = demandH5EntryPolicy();
    if (!entryPolicy.oauth.enabled) {
      logger.warn("Demand H5 WeCom auth skipped", {
        policyMode: entryPolicy.mode,
        oauthReason: entryPolicy.oauth.reason,
        hasTestFallback: Boolean(entryPolicy.testFallbackName)
      });
      redirectToDemandH5(res, url.searchParams.get("returnTo"), "wecom_auth_not_ready");
      return;
    }
    const requestProtocol = req.socket.encrypted ? "https" : "http";
    if (!isDemandH5OAuthRequestOriginAllowed(entryPolicy, { protocol: requestProtocol, host })) {
      logger.warn("Demand H5 WeCom auth request origin rejected", {
        requestProtocol,
        requestHost: host,
        expectedOrigin: entryPolicy.oauth.origin,
        callbackSource: entryPolicy.oauth.reason,
        hasCode: Boolean(code)
      });
      redirectToDemandH5(res, url.searchParams.get("returnTo"), "wecom_auth_origin_rejected");
      return;
    }

    if (!code) {
      const returnPath = demandH5ReturnPath(url.searchParams.get("returnTo"));
      const state = signDemandH5State(returnPath, secret, { audience: "wecom_h5" });
      const callbackUrl = demandH5OAuthCallbackUrl(entryPolicy.oauth.origin);
      const authorizeUrl = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
      authorizeUrl.searchParams.set("appid", corpId);
      authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("scope", "snsapi_base");
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("agentid", agentId);
      logger.info("Demand H5 WeCom auth started", {
        returnPath,
        callbackUrl,
        callbackOrigin: entryPolicy.oauth.origin,
        callbackSource: entryPolicy.oauth.reason,
        requestHost: host
      });
      res.writeHead(302, { Location: `${authorizeUrl.toString()}#wechat_redirect`, "Cache-Control": "no-store" });
      res.end();
      return;
    }

    const returnPath = verifyDemandH5State(url.searchParams.get("state"), secret, {
      audience: "wecom_h5",
      normalizeReturnPath: demandH5ReturnPath
    });
    if (!returnPath) {
      logger.warn("Demand H5 WeCom auth state rejected", { hasCode: true });
      redirectToDemandH5(res, "/demand-h5.html", "wecom_auth_state_invalid");
      return;
    }

    try {
      const userId = await resolveWeComOAuthUserId(auth, code);
      const name = await resolveWeComUserName(auth, userId);
      if (!name || name === userId) throw new Error("企业微信身份未返回中文姓名");
      const session = issueDemandH5Session({ userId, name }, secret);
      logger.info("Demand H5 WeCom auth completed", {
        loginMode: "wecom_workbench",
        returnPath,
        userId,
        userName: name,
        sessionId: session.sessionId,
        expiresAt: session.expiresAt
      });
      res.writeHead(302, {
        Location: returnPath,
        "Cache-Control": "no-store",
        "Set-Cookie": session.cookie
      });
      res.end();
    } catch (error) {
      logger.warn("Demand H5 WeCom auth failed", { message: error && error.message ? error.message : String(error || "") });
      redirectToDemandH5(res, returnPath, "wecom_auth_failed");
    }
  }

  async function handleDemandWebLogin(req, res) {
    const url = new URL(req.url, "http://localhost");
    const { auth, corpId, agentId, secret } = demandH5AuthSettings();
    const code = String(url.searchParams.get("code") || "").trim();
    const host = String(req.headers.host || "").trim();
    const returnTo = url.searchParams.get("returnTo");

    if (!corpId || !agentId || !secret) {
      logger.warn("Demand web login unavailable", {
        hasCorpId: Boolean(corpId),
        hasAgentId: Boolean(agentId),
        hasSecret: Boolean(secret)
      });
      redirectToDemandLogin(res, returnTo, "wecom_auth_unavailable");
      return;
    }

    const entryPolicy = demandH5EntryPolicy();
    if (!entryPolicy.oauth.enabled) {
      logger.warn("Demand web login origin unavailable", {
        policyMode: entryPolicy.mode,
        oauthReason: entryPolicy.oauth.reason
      });
      redirectToDemandLogin(res, returnTo, "wecom_auth_not_ready");
      return;
    }

    const requestProtocol = req.socket.encrypted ? "https" : "http";
    if (!isDemandH5OAuthRequestOriginAllowed(entryPolicy, { protocol: requestProtocol, host })) {
      logger.warn("Demand web login request origin rejected", {
        requestProtocol,
        requestHost: host,
        expectedOrigin: entryPolicy.oauth.origin,
        hasCode: Boolean(code)
      });
      redirectToDemandLogin(res, returnTo, "wecom_auth_origin_rejected");
      return;
    }

    if (!code) {
      const returnPath = demandH5ReturnPath(returnTo);
      const state = signDemandH5State(returnPath, secret, { audience: "wecom_pc" });
      const callbackUrl = demandWebLoginCallbackUrl(entryPolicy.oauth.origin);
      const authorizeUrl = new URL("https://login.work.weixin.qq.com/wwlogin/sso/login");
      authorizeUrl.searchParams.set("login_type", "CorpApp");
      authorizeUrl.searchParams.set("appid", corpId);
      authorizeUrl.searchParams.set("agentid", agentId);
      authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("lang", "zh");
      logger.info("Demand web QR login started", {
        returnPath,
        callbackUrl,
        requestHost: host
      });
      res.writeHead(302, { Location: authorizeUrl.toString(), "Cache-Control": "no-store" });
      res.end();
      return;
    }

    const returnPath = verifyDemandH5State(url.searchParams.get("state"), secret, {
      audience: "wecom_pc",
      normalizeReturnPath: demandH5ReturnPath
    });
    if (!returnPath) {
      logger.warn("Demand web QR login state rejected", { hasCode: true });
      redirectToDemandLogin(res, "/demand-h5.html", "wecom_auth_state_invalid");
      return;
    }

    try {
      const userId = await resolveWeComOAuthUserId(auth, code);
      const name = await resolveWeComUserName(auth, userId);
      if (!name || name === userId) throw new Error("企业微信身份未返回中文姓名");
      const session = issueDemandH5Session({ userId, name }, secret);
      logger.info("Demand web QR login completed", {
        loginMode: "wecom_pc_qr",
        returnPath,
        userId,
        userName: name,
        sessionId: session.sessionId,
        expiresAt: session.expiresAt
      });
      res.writeHead(302, {
        Location: returnPath,
        "Cache-Control": "no-store",
        "Set-Cookie": session.cookie
      });
      res.end();
    } catch (error) {
      logger.warn("Demand web QR login failed", {
        message: error && error.message ? error.message : String(error || "")
      });
      redirectToDemandLogin(res, returnPath, "wecom_auth_failed");
    }
  }

  function handleDemandWebLogout(req, res) {
    const url = new URL(req.url, "http://localhost");
    const session = demandH5SessionResult(req);
    logger.info("Demand web session logged out", {
      sessionId: session.ok ? session.identity.sessionId : "",
      userName: session.ok ? session.identity.name : "",
      reason: session.ok ? "user_requested" : session.reason
    });
    const returnTo = url.searchParams.get("returnTo") || "/demand-h5.html";
    const target = new URL("/demand-login.html", "http://localhost");
    target.searchParams.set("returnTo", demandH5ReturnPath(returnTo));
    res.writeHead(302, {
      Location: `${target.pathname}${target.search}`,
      "Cache-Control": "no-store",
      "Set-Cookie": clearDemandH5SessionCookie({ secure: true })
    });
    res.end();
  }

  function applyBugCollectionRuntime(settings) {
    config.modules.modules.bugCollection = {
      enabled: settings.enabled,
      name: settings.name,
      source: settings.source,
      docUrl: settings.docUrl,
      docid: settings.docid,
      docLinkId: settings.docLinkId,
      sheetId: settings.sheetId,
      viewId: settings.viewId,
      keyType: settings.keyType,
      createDoc: settings.createDoc
    };
  }

  async function buildStatus() {
    const moduleStatus = {};
    for (const [name, module] of Object.entries(modules)) {
      if (module && typeof module.getStatus === "function") {
        moduleStatus[name] = await module.getStatus();
      }
    }

    return {
      ok: true,
      app: {
        name: "eazygame-integrated-assistant",
        version: packageInfo.version,
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString()
      },
      config: sanitizedConfigSummary(config),
      robot: robotServer.getStatus(),
      robotDiagnostics: robotDiagnostics && typeof robotDiagnostics.getStatus === "function"
        ? robotDiagnostics.getStatus()
        : { enabled: false },
      monitors: monitorManager.getStatus(),
      notification: notificationCenter.getStatus(),
      wecomAppCallback: wecomAppCallback && typeof wecomAppCallback.getStatus === "function"
        ? wecomAppCallback.getStatus()
        : { enabled: false, configured: false },
      modules: moduleStatus
    };
  }

  async function handleApi(req, res) {
    const url = new URL(req.url, "http://localhost");

    if (wecomAppCallback && typeof wecomAppCallback.matches === "function" && wecomAppCallback.matches(url)) {
      return wecomAppCallback.handleRequest(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, await buildStatus());
      return true;
    }

    if (req.method === "GET" && new Set([
      "/api/dev-progress/h5-session",
      "/api/dev-progress/h5-entry-user"
    ]).has(url.pathname)) {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      logger.info("Demand H5 session identity requested", {
        route: url.pathname,
        sessionId: identity.sessionId,
        userName: identity.name,
        expiresAt: identity.expiresAt
      });
      sendJson(res, 200, {
        ok: true,
        identity: {
          userId: identity.userId,
          name: identity.name,
          source: "signed_session",
          expiresAt: identity.expiresAt
        }
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/dev-progress/h5-entry-policy") {
      const policy = demandH5EntryPolicy();
      logger.info("Demand H5 entry policy requested", {
        entryId: String(req.headers["x-ea-demand-entry-id"] || "").slice(0, 80),
        entrySource: String(req.headers["x-ea-demand-entry-source"] || "").slice(0, 80),
        pageVersion: String(req.headers["x-ea-demand-page-version"] || "").slice(0, 32),
        policyMode: policy.mode,
        oauthReason: policy.oauth.reason,
        hasTestFallback: Boolean(policy.testFallbackName),
        testFallbackNameLength: policy.testFallbackName.length
      });
      sendJson(res, 200, {
        ok: true,
        policy: {
          mode: policy.mode,
          oauthEnabled: policy.oauth.enabled,
          testFallbackName: policy.testFallbackName
        }
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/settings") {
      sendJson(res, 200, getAllSettings({ includeSecrets: showSecretsInAdmin() }), settingsResponseOptions());
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/desktop-tip/status") {
      const status = modules.desktopTip && typeof modules.desktopTip.getStatus === "function"
        ? modules.desktopTip.getStatus()
        : { enabled: false };
      sendJson(res, 200, {
        ok: true,
        desktopTip: status
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/desktop-tip/client-send/options") {
      const client = requireRegisteredDesktopTipClient(req, res, url);
      if (!client) return true;
      const desktopTipStatus = modules.desktopTip && typeof modules.desktopTip.getStatus === "function"
        ? modules.desktopTip.getStatus()
        : {};
      const wecomGroups = modules.desktopTip && typeof modules.desktopTip.getWecomGroupRegistryStatus === "function"
        ? publicClientWecomGroups(modules.desktopTip.getWecomGroupRegistryStatus())
        : { enabled: false, groups: [], groupCount: 0 };
      logger.info("Desktop tip client send options requested", {
        sourceKey: "client_manual_message",
        clientId: maskLogId(client.clientId),
        clientVersion: trimText(client.clientVersion),
        registeredClientCount: Number(desktopTipStatus.clientRegistry && desktopTipStatus.clientRegistry.registeredClientCount || 0),
        wecomGroupCount: Number(wecomGroups.groupCount || 0)
      });
      sendJson(res, 200, {
        ok: true,
        sender: {
          clientId: maskLogId(client.clientId),
          clientVersion: trimText(client.clientVersion) || "unknown",
          source: "registered_desktop_client"
        },
        registeredClientCount: Number(desktopTipStatus.clientRegistry && desktopTipStatus.clientRegistry.registeredClientCount || 0),
        limits: {
          titleMax: 80,
          bodyMax: 1000,
          rateLimitSeconds: Math.ceil(clientManualSendRateLimitMs / 1000)
        },
        wecomGroups
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/desktop-tip/client-send/manual-message") {
      const body = await readRequestBody(req);
      const client = requireRegisteredDesktopTipClient(req, res, url, body);
      if (!client) return true;
      try {
        rejectClientManualMessageForbiddenFields(body);
        validateClientManualMessageContent(body);
        const preparedWecomGroups = prepareDesktopTipManualWecomGroups(body);
        assertClientManualRateLimit(client.clientId);
        const result = modules.desktopTip && typeof modules.desktopTip.createManualMessage === "function"
          ? modules.desktopTip.createManualMessage({
            title: body.title,
            body: body.body || body.content,
            operatorUserId: `client:${client.clientId}`,
            operatorName: "EA 桌面提醒客户端",
            sourceKey: "client_manual_message"
          })
          : { ok: false, message: "EA 桌面提醒客户端发送模块未启用" };
        const wecomGroups = await sendDesktopTipManualWecomGroups({
          body,
          identity: {
            userId: `client:${client.clientId}`,
            name: "EA 桌面提醒客户端"
          },
          desktopResult: result,
          prepared: preparedWecomGroups,
          sourceKey: "client_manual_message"
        });
        logger.info("Desktop tip client manual message API requested", {
          sourceKey: "client_manual_message",
          batchId: result.batchId || "",
          senderClientId: maskLogId(client.clientId),
          senderClientVersion: trimText(client.clientVersion) || "unknown",
          recipientCount: Number(result.recipientCount || 0),
          titleLength: String(body.title || "").trim().length,
          bodyLength: String(body.body || body.content || "").trim().length,
          queued: Number(result.queuedCount || 0),
          failed: Number(result.failedCount || 0),
          wecomGroupEnabled: Boolean(wecomGroups.enabled),
          wecomGroupSuccess: Number(wecomGroups.successCount || 0),
          wecomGroupFailed: Number(wecomGroups.failedCount || 0),
          ok: Boolean(result.ok)
        });
        sendJson(res, result.ok ? 200 : 503, {
          ...result,
          sender: {
            clientId: maskLogId(client.clientId),
            source: "registered_desktop_client"
          },
          wecomGroups
        });
      } catch (error) {
        if (error && error.statusCode === 429) {
          logger.warn("Desktop tip client manual message rate limited", {
            sourceKey: "client_manual_message",
            senderClientId: maskLogId(client.clientId),
            retryAfterSeconds: error.retryAfterSeconds || 0
          });
        }
        throw error;
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/desktop-tip/wecom-groups") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const result = modules.desktopTip && typeof modules.desktopTip.getWecomGroupRegistryStatus === "function"
        ? modules.desktopTip.getWecomGroupRegistryStatus()
        : { enabled: false, groups: [], groupCount: 0 };
      sendJson(res, 200, {
        ok: true,
        wecomGroups: result,
        identity: {
          userId: identity.userId,
          name: identity.name || "",
          source: "signed_session"
        }
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/desktop-tip/client-update/manifest") {
      const result = modules.desktopTip && typeof modules.desktopTip.getClientUpdateManifest === "function"
        ? modules.desktopTip.getClientUpdateManifest()
        : { ok: false, message: "EA 桌面提醒客户端更新模块未启用" };
      sendJson(res, result.ok ? 200 : 503, result);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/desktop-tip/client-update/package") {
      const result = modules.desktopTip && typeof modules.desktopTip.getClientUpdatePackage === "function"
        ? modules.desktopTip.getClientUpdatePackage()
        : { ok: false, message: "EA 桌面提醒客户端更新模块未启用" };
      if (!result.ok) {
        sendJson(res, 503, result);
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": String(result.size),
        "Content-Disposition": `attachment; filename="desktop-tip-client-update.zip"; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
        "Cache-Control": "no-store",
        "X-EA-Desktop-Tip-Version": result.version,
        "X-EA-Desktop-Tip-SHA256": result.sha256
      });
      result.stream.on("error", (error) => {
        logger.warn("Desktop tip client update package stream failed", {
          version: result.version,
          message: error && error.message ? error.message : String(error || "")
        });
        res.destroy(error);
      });
      result.stream.pipe(res);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/desktop-tip/maintenance/config") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const result = modules.desktopTip
        && modules.desktopTip.maintenance
        && typeof modules.desktopTip.maintenance.getConfig === "function"
        ? modules.desktopTip.maintenance.getConfig({
          operatorUserId: identity.userId
        })
        : { ok: false, message: "EA 桌面提醒正式服停服更新模块未启用" };
      const desktopTipStatus = modules.desktopTip && typeof modules.desktopTip.getStatus === "function"
        ? modules.desktopTip.getStatus()
        : {};
      const wecomGroups = modules.desktopTip && typeof modules.desktopTip.getWecomGroupRegistryStatus === "function"
        ? modules.desktopTip.getWecomGroupRegistryStatus()
        : { enabled: false, groups: [], groupCount: 0 };
      sendJson(res, result.ok ? 200 : 503, {
        ...result,
        clientUpdate: desktopTipStatus.clientUpdate || {},
        wecomGroups,
        identity: {
          userId: identity.userId,
          name: identity.name || "",
          source: "signed_session"
        }
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/desktop-tip/manual-message") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const body = await readRequestBody(req);
      const forbiddenTargetFields = [
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
      ].filter((field) => Object.prototype.hasOwnProperty.call(body || {}, field));
      if (forbiddenTargetFields.length > 0) {
        logger.warn("Desktop tip manual message rejected forbidden target fields", {
          sourceKey: "admin_manual_message",
          sessionId: identity.sessionId || "",
          operatorConfigured: Boolean(identity.userId),
          forbiddenFieldCount: forbiddenTargetFields.length
        });
        sendJson(res, 400, {
          ok: false,
          message: "普通桌面消息测试不允许指定接收人、客户端或任意目标参数"
        });
        return true;
      }
      const preparedWecomGroups = prepareDesktopTipManualWecomGroups(body);
      const result = modules.desktopTip && typeof modules.desktopTip.createManualMessage === "function"
        ? modules.desktopTip.createManualMessage({
          title: body.title,
          body: body.body || body.content,
          operatorUserId: identity.userId,
          operatorName: identity.name || ""
        })
        : { ok: false, message: "EA 桌面提醒普通消息测试模块未启用" };
      const wecomGroups = await sendDesktopTipManualWecomGroups({
        body,
        identity,
        desktopResult: result,
        prepared: preparedWecomGroups
      });
      logger.info("Desktop tip manual message API requested", {
        sourceKey: "admin_manual_message",
        batchId: result.batchId || "",
        sessionId: identity.sessionId || "",
        operatorConfigured: Boolean(identity.userId),
        recipientCount: Number(result.recipientCount || 0),
        titleLength: String(body.title || "").trim().length,
        bodyLength: String(body.body || body.content || "").trim().length,
        queued: Number(result.queuedCount || 0),
        failed: Number(result.failedCount || 0),
        wecomGroupEnabled: Boolean(wecomGroups.enabled),
        wecomGroupSuccess: Number(wecomGroups.successCount || 0),
        wecomGroupFailed: Number(wecomGroups.failedCount || 0),
        ok: Boolean(result.ok)
      });
      sendJson(res, result.ok ? 200 : 503, {
        ...result,
        wecomGroups
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/desktop-tip/maintenance/config") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const body = await readRequestBody(req);
      const result = modules.desktopTip
        && modules.desktopTip.maintenance
        && typeof modules.desktopTip.maintenance.updateConfig === "function"
        ? modules.desktopTip.maintenance.updateConfig({
          operatorUserId: identity.userId,
          config: body.config || body
        })
        : { ok: false, message: "EA 桌面提醒正式服停服更新模块未启用" };
      logger.info("Production maintenance config API requested", {
        sourceKey: "production_maintenance",
        operatorConfigured: Boolean(identity.userId),
        sessionId: identity.sessionId || "",
        ok: Boolean(result.ok)
      });
      sendJson(res, result.ok ? 200 : 503, result);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/desktop-tip/maintenance/events") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const result = modules.desktopTip
        && modules.desktopTip.maintenance
        && typeof modules.desktopTip.maintenance.listMaintenances === "function"
        ? modules.desktopTip.maintenance.listMaintenances({
          operatorUserId: identity.userId,
          limit: url.searchParams.get("limit") || ""
        })
        : { ok: false, message: "EA 桌面提醒正式服停服更新模块未启用", events: [] };
      sendJson(res, result.ok ? 200 : 503, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/desktop-tip/maintenance/events") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const body = await readRequestBody(req);
      const result = modules.desktopTip
        && modules.desktopTip.maintenance
        && typeof modules.desktopTip.maintenance.createMaintenance === "function"
        ? modules.desktopTip.maintenance.createMaintenance({
          ...body,
          operatorUserId: identity.userId
        })
        : { ok: false, message: "EA 桌面提醒正式服停服更新模块未启用" };
      logger.info("Production maintenance create API requested", {
        sourceKey: "production_maintenance",
        operatorConfigured: Boolean(identity.userId),
        sessionId: identity.sessionId || "",
        ok: Boolean(result.ok),
        maintenanceId: result.maintenance && result.maintenance.maintenanceId ? result.maintenance.maintenanceId : "",
        recipientCount: result.maintenance && Array.isArray(result.maintenance.recipients) ? result.maintenance.recipients.length : 0
      });
      sendJson(res, result.ok ? 200 : 503, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/desktop-tip/maintenance/stop") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const body = await readRequestBody(req);
      const result = modules.desktopTip
        && modules.desktopTip.maintenance
        && typeof modules.desktopTip.maintenance.setStopped === "function"
        ? modules.desktopTip.maintenance.setStopped({
          ...body,
          operatorUserId: identity.userId
        })
        : { ok: false, message: "EA 桌面提醒正式服停服更新模块未启用" };
      logger.info("Production maintenance stop API requested", {
        sourceKey: "production_maintenance",
        operatorConfigured: Boolean(identity.userId),
        sessionId: identity.sessionId || "",
        ok: Boolean(result.ok),
        skipped: Boolean(result.skipped),
        maintenanceId: body.maintenanceId || ""
      });
      sendJson(res, result.ok ? 200 : 503, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/desktop-tip/maintenance/extend") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const body = await readRequestBody(req);
      const result = modules.desktopTip
        && modules.desktopTip.maintenance
        && typeof modules.desktopTip.maintenance.extendMaintenance === "function"
        ? modules.desktopTip.maintenance.extendMaintenance({
          ...body,
          operatorUserId: identity.userId
        })
        : { ok: false, message: "EA 桌面提醒正式服停服更新模块未启用" };
      logger.info("Production maintenance extend API requested", {
        sourceKey: "production_maintenance",
        operatorConfigured: Boolean(identity.userId),
        sessionId: identity.sessionId || "",
        ok: Boolean(result.ok),
        skipped: Boolean(result.skipped),
        maintenanceId: body.maintenanceId || "",
        extensionMinutes: Number(body.extensionMinutes || body.minutes || 0)
      });
      sendJson(res, result.ok ? 200 : 503, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/desktop-tip/maintenance/complete") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const body = await readRequestBody(req);
      const result = modules.desktopTip
        && modules.desktopTip.maintenance
        && typeof modules.desktopTip.maintenance.completeMaintenance === "function"
        ? modules.desktopTip.maintenance.completeMaintenance({
          ...body,
          operatorUserId: identity.userId
        })
        : { ok: false, message: "EA 桌面提醒正式服停服更新模块未启用" };
      logger.info("Production maintenance complete API requested", {
        sourceKey: "production_maintenance",
        operatorConfigured: Boolean(identity.userId),
        sessionId: identity.sessionId || "",
        ok: Boolean(result.ok),
        skipped: Boolean(result.skipped),
        maintenanceId: body.maintenanceId || ""
      });
      sendJson(res, result.ok ? 200 : 503, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/desktop-tip/maintenance/cancel") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const body = await readRequestBody(req);
      const result = modules.desktopTip
        && modules.desktopTip.maintenance
        && typeof modules.desktopTip.maintenance.cancelMaintenance === "function"
        ? modules.desktopTip.maintenance.cancelMaintenance({
          ...body,
          operatorUserId: identity.userId
        })
        : { ok: false, message: "EA 桌面提醒正式服停服更新模块未启用" };
      logger.info("Production maintenance cancel API requested", {
        sourceKey: "production_maintenance",
        operatorConfigured: Boolean(identity.userId),
        sessionId: identity.sessionId || "",
        ok: Boolean(result.ok),
        skipped: Boolean(result.skipped),
        maintenanceId: body.maintenanceId || ""
      });
      sendJson(res, result.ok ? 200 : 503, result);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/desktop-tip/events") {
      const result = modules.desktopTip && typeof modules.desktopTip.listTips === "function"
        ? modules.desktopTip.listTips({
          targetUserId: url.searchParams.get("userId") || url.searchParams.get("targetUserId") || "",
          clientId: url.searchParams.get("clientId") || "",
          clientVersion: url.searchParams.get("clientVersion") || "",
          limit: url.searchParams.get("limit") || "",
          token: requestDesktopTipToken(req, url)
        })
        : { ok: false, message: "桌面提醒模块未启用", events: [] };
      sendJson(res, result.ok ? 200 : 400, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/desktop-tip/events/ack") {
      const body = await readRequestBody(req);
      const result = modules.desktopTip && typeof modules.desktopTip.ackTip === "function"
        ? modules.desktopTip.ackTip({
          eventId: body.eventId,
          userId: body.userId || body.targetUserId,
          clientId: body.clientId,
          action: body.action,
          token: requestDesktopTipToken(req, url, body)
        })
        : { ok: false, message: "桌面提醒模块未启用" };
      sendJson(res, result.ok ? 200 : 400, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/desktop-tip/test") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const body = await readRequestBody(req);
      const permission = modules.desktopTip
        && modules.desktopTip.maintenance
        && typeof modules.desktopTip.maintenance.getConfig === "function"
        ? modules.desktopTip.maintenance.getConfig({ operatorUserId: identity.userId })
        : { canManage: false };
      if (!permission.canManage) {
        logger.warn("Desktop tip test event rejected by permission", {
          sourceKey: "desktop-tip-test",
          sessionId: identity.sessionId || "",
          operatorConfigured: Boolean(identity.userId),
          role: permission.role || "none"
        });
        sendJson(res, 403, {
          ok: false,
          message: "只有 EA 桌面提醒消息管理员可以发送测试提醒"
        });
        return true;
      }
      const result = modules.desktopTip && typeof modules.desktopTip.createTestTip === "function"
        ? modules.desktopTip.createTestTip(body)
        : { ok: false, message: "桌面提醒模块未启用" };
      logger.info("Desktop tip test event requested", {
        targetUserId: body.targetUserId || body.userId || "",
        sessionId: identity.sessionId || "",
        ok: Boolean(result.ok)
      });
      sendJson(res, result.ok ? 200 : 503, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/watchdog/app-push/test") {
      try {
        const result = modules.watchdog && typeof modules.watchdog.sendAppPushTest === "function"
          ? await modules.watchdog.sendAppPushTest()
          : { ok: false, message: "盯梢自建应用推送模块未就绪" };
        logger.info("Watchdog app push test API requested", {
          ok: Boolean(result.ok),
          targetUserId: result.targetUserId || "",
          channel: result.channel || ""
        });
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (error) {
        const info = errorInfo(error, "盯梢自建应用测试推送失败");
        logger.warn("Watchdog app push test API failed", {
          errcode: info.errcode,
          errmsg: info.errmsg,
          message: info.message
        });
        sendJson(res, 400, {
          ok: false,
          message: info.message,
          errcode: info.errcode || 0
        });
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/watchdog/app-feedback") {
      const taskIdValue = url.searchParams.get("taskId") || "";
      const tokenValue = url.searchParams.get("token") || "";
      const feedbackRef = url.searchParams.get("ref") || "";
      const legacyAccess = Boolean(String(taskIdValue).trim() || String(tokenValue).trim());
      const identity = legacyAccess ? null : requireDemandH5Identity(req, res, url.pathname);
      if (!legacyAccess && !identity) return true;
      const result = modules.watchdog && typeof modules.watchdog.getAppFeedbackTask === "function"
        ? modules.watchdog.getAppFeedbackTask({
          taskId: taskIdValue,
          token: tokenValue,
          ref: feedbackRef,
          assigneeUserId: identity && identity.userId ? identity.userId : ""
        })
        : { ok: false, message: "盯梢应用反馈模块未就绪" };
      logger.info("Watchdog app feedback page requested", {
        accessMode: legacyAccess ? "legacy_token" : "signed_identity",
        taskId: legacyAccess ? taskIdValue : "",
        feedbackRef: legacyAccess ? "" : feedbackRef,
        identityUserId: identity && identity.userId ? identity.userId : "",
        ok: Boolean(result.ok)
      });
      sendJson(res, result.ok ? 200 : (Number(result.statusCode) || 400), result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/watchdog/app-feedback") {
      try {
        const body = await readRequestBody(req);
        const legacyAccess = Boolean(String(body.taskId || "").trim() || String(body.token || "").trim());
        const identity = legacyAccess ? null : requireDemandH5Identity(req, res, url.pathname);
        if (!legacyAccess && !identity) return true;
        const result = modules.watchdog && typeof modules.watchdog.submitAppFeedback === "function"
          ? await modules.watchdog.submitAppFeedback({
            taskId: body.taskId,
            token: body.token,
            ref: body.ref,
            assigneeUserId: identity && identity.userId ? identity.userId : "",
            action: body.action,
            note: body.note
          })
          : { ok: false, message: "盯梢应用反馈模块未就绪" };
        logger.info("Watchdog app feedback submitted", {
          accessMode: legacyAccess ? "legacy_token" : "signed_identity",
          taskId: legacyAccess ? (body.taskId || "") : "",
          feedbackRef: legacyAccess ? "" : (body.ref || ""),
          identityUserId: identity && identity.userId ? identity.userId : "",
          action: body.action || "",
          noteLength: String(body.note || "").trim().length,
          ok: Boolean(result.ok)
        });
        sendJson(res, result.ok ? 200 : (Number(result.statusCode) || 400), result);
      } catch (error) {
        const info = errorInfo(error, "盯梢应用反馈提交失败");
        logger.warn("Watchdog app feedback submission failed", {
          errcode: info.errcode,
          errmsg: info.errmsg,
          message: info.message
        });
        sendJson(res, 400, {
          ok: false,
          message: info.message
        });
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/dev-progress/required-feedback") {
      const result = monitorManager && typeof monitorManager.getPilotAppFeedback === "function"
        ? await monitorManager.getPilotAppFeedback({
          reminderId: url.searchParams.get("reminderId") || "",
          token: url.searchParams.get("token") || "",
          reason: url.searchParams.get("refresh") === "1" ? "manual_refresh" : "page_open"
        })
        : { ok: false, message: "需求必填字段试运行反馈模块未就绪" };
      logger.info("Dev progress pilot feedback page requested", {
        reminderId: url.searchParams.get("reminderId") || "",
        ok: Boolean(result.ok),
        refreshReason: url.searchParams.get("refresh") === "1" ? "manual_refresh" : "page_open"
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/dev-progress/required-summary") {
      const result = monitorManager && typeof monitorManager.getPilotGroupDetail === "function"
        ? monitorManager.getPilotGroupDetail()
        : { ok: false, message: "需求必填字段群详情模块未就绪" };
      logger.info("Dev progress pilot group detail requested", {
        ok: Boolean(result.ok),
        hasTask: Boolean(result.summary && result.summary.task),
        reminderId: result.summary && result.summary.task ? result.summary.task.id : "",
        status: result.summary && result.summary.task ? result.summary.task.status : "",
        activeCount: result.summary ? result.summary.activeCount : 0
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/dev-progress/required-feedback") {
      try {
        const body = await readRequestBody(req);
        const result = monitorManager && typeof monitorManager.submitPilotAppFeedback === "function"
          ? await monitorManager.submitPilotAppFeedback({
            reminderId: body.reminderId,
            token: body.token,
            action: body.action
          })
          : { ok: false, message: "需求必填字段试运行反馈模块未就绪" };
        logger.info("Dev progress pilot feedback submitted", {
          reminderId: body.reminderId || "",
          action: body.action || "",
          ok: Boolean(result.ok)
        });
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (error) {
        const info = errorInfo(error, "需求必填字段试运行反馈提交失败");
        logger.warn("Dev progress pilot feedback submission failed", {
          errcode: info.errcode,
          errmsg: info.errmsg,
          message: info.message
        });
        sendJson(res, 400, {
          ok: false,
          message: info.message
        });
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/demand-collaboration/drafts") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const result = modules.demandCollaboration.listDrafts({
        submitterName: identity.name,
        project: url.searchParams.get("project") || "",
        status: url.searchParams.get("status") || ""
      });
      sendJson(res, 200, {
        ok: result.ok,
        demandCollaboration: result
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/demand-collaboration/todos") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const result = modules.demandCollaboration.listTodoItems({
        userName: identity.name,
        project: url.searchParams.get("project") || ""
      });
      sendJson(res, 200, {
        ok: result.ok,
        demandCollaboration: result
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/demand-collaboration/member-todos") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const result = modules.demandCollaboration.listMemberTodoItems({
        userName: identity.name,
        project: url.searchParams.get("project") || ""
      });
      sendJson(res, 200, {
        ok: result.ok,
        demandCollaboration: result
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/demand-collaboration/drafts") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const body = await readRequestBody(req);
      try {
        const result = modules.demandCollaboration.createDraft({
          ...body,
          submitterName: identity.name,
          source: body.source || "demand-h5"
        });
        sendJson(res, 200, {
          ok: result.ok,
          demandCollaboration: result
        });
      } catch (error) {
        const info = errorInfo(error, "需求草稿创建失败");
        logger.warn("Demand collaboration draft create failed", {
          message: info.message,
          project: body.project || "",
          submitterName: identity.name
        });
        sendJson(res, 400, {
          ok: false,
          message: info.message
        });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/demand-collaboration/leader-supplement") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const body = await readRequestBody(req);
      try {
        const result = modules.demandCollaboration.submitLeaderSupplement({
          draftId: body.draftId,
          taskId: body.taskId,
          userName: identity.name,
          values: body.values || {}
        });
        sendJson(res, 200, {
          ok: result.ok,
          demandCollaboration: result
        });
      } catch (error) {
        const info = errorInfo(error, "组长补充提交失败");
        logger.warn("Demand collaboration leader supplement failed", {
          message: info.message,
          draftId: body.draftId || "",
          taskId: body.taskId || "",
          userName: identity.name
        });
        sendJson(res, 400, {
          ok: false,
          message: info.message
        });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/demand-collaboration/drafts/cleanup-expired") {
      const result = modules.demandCollaboration.cleanupExpiredDrafts();
      sendJson(res, 200, {
        ok: result.ok,
        demandCollaboration: result
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/robot-diagnostics/recent") {
      const limit = Number(url.searchParams.get("limit") || 50);
      const status = url.searchParams.get("status") || "all";
      const result = robotDiagnostics && typeof robotDiagnostics.listRecent === "function"
        ? robotDiagnostics.listRecent({ limit, status })
        : {
          limit,
          replyTraces: [],
          feedbackEvents: [],
          issues: [],
          files: {}
        };
      sendJson(res, 200, {
        ok: true,
        robotDiagnostics: result
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/robot-diagnostics/issues") {
      const limit = Number(url.searchParams.get("limit") || 50);
      const status = url.searchParams.get("status") || "all";
      const issues = robotDiagnostics && typeof robotDiagnostics.listIssues === "function"
        ? robotDiagnostics.listIssues({ limit, status })
        : [];
      sendJson(res, 200, {
        ok: true,
        robotDiagnosticIssues: {
          limit,
          status,
          issues
        }
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/robot-diagnostics/issues/status") {
      const body = await readRequestBody(req);
      const result = robotDiagnostics && typeof robotDiagnostics.updateIssueStatus === "function"
        ? robotDiagnostics.updateIssueStatus({
          issueId: body.issueId,
          status: body.status,
          note: body.note,
          actor: "admin-console"
        })
        : { ok: false, message: "机器人诊断存储未启用" };
      sendJson(res, result.ok ? 200 : 400, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/basic") {
      const body = await readRequestBody(req);
      const basicSettings = updateBasicSettings(body);
      Object.assign(config.app.server, basicSettings.server);
      Object.assign(config.app.runtime, basicSettings.runtime);
      sendJson(res, 200, {
        ok: true,
        basic: basicSettings,
        restartRequired: true
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/robot") {
      const body = await readRequestBody(req);
      const robotSettings = updateRobotSettings(body);
      Object.assign(config.app.robot, {
        enabled: robotSettings.enabled,
        provider: robotSettings.provider,
        botIdEnv: robotSettings.botIdEnv,
        secretEnv: robotSettings.secretEnv,
        welcomeText: robotSettings.welcomeText,
        feedbackCard: robotSettings.feedbackCard,
        outboundTest: robotSettings.outboundTest
      });

      robotServer.stop();
      if (robotSettings.enabled) {
        await robotServer.start();
      }

      sendJson(res, 200, {
        ok: true,
        robot: getRobotSettings({ includeSecrets: showSecretsInAdmin() }),
        applied: true
      }, settingsResponseOptions());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/robot/test-push") {
      const body = await readRequestBody(req);
      const robotSettings = getRobotSettings();
      const saved = robotSettings.outboundTest || {};
      const targetType = typeof body.targetType === "string"
        ? (body.targetType === "group" ? "group" : "user")
        : (saved.targetType || "user");
      const targetId = typeof body.targetId === "string" && body.targetId.trim()
        ? body.targetId.trim()
        : saved.targetId;
      const message = typeof body.message === "string" && body.message.trim()
        ? body.message.trim()
        : saved.message;
      if (!targetId) {
        sendJson(res, 400, { ok: false, message: "主动推送目标不能为空" });
        return true;
      }
      if (!message) {
        sendJson(res, 400, { ok: false, message: "主动推送内容不能为空" });
        return true;
      }

      const updatedRobotSettings = updateRobotOutboundTestSettings({
        targetType,
        targetId,
        message
      });
      Object.assign(config.app.robot, {
        outboundTest: updatedRobotSettings.outboundTest
      });

      try {
        const ack = await robotServer.sendMarkdownMessage(targetId, message);
        logger.info("WeCom smart robot outbound test sent", {
          targetType,
          messageLength: String(message || "").length,
          errcode: ack && ack.errcode
        });
        sendJson(res, 200, {
          ok: true,
          robotPush: {
            targetType,
            targetId,
            messageLength: String(message || "").length,
            sentAt: new Date().toISOString(),
            saved: true,
            ack: {
              errcode: ack && ack.errcode,
              errmsg: ack && ack.errmsg,
              cmd: ack && ack.cmd
            }
          }
        });
      } catch (error) {
        const info = errorInfo(error, "企业微信主动推送失败");
        logger.warn("WeCom smart robot outbound test failed", {
          targetType,
          messageLength: String(message || "").length,
          errcode: info.errcode,
          errmsg: info.errmsg,
          cmd: info.cmd,
          message: info.message
        });
        sendJson(res, 502, {
          ok: false,
          message: `企业微信主动推送失败：${info.message}`,
          robotPush: {
            targetType,
            messageLength: String(message || "").length,
            saved: true,
            error: {
              errcode: info.errcode,
              errmsg: info.errmsg,
              cmd: info.cmd,
              reqId: info.reqId
            }
          }
        });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/robot/test-feedback-card") {
      const body = await readRequestBody(req);
      const robotSettings = getRobotSettings();
      const saved = robotSettings.outboundTest || {};
      const targetType = typeof body.targetType === "string"
        ? (body.targetType === "group" ? "group" : "user")
        : (saved.targetType || "user");
      const targetId = typeof body.targetId === "string" && body.targetId.trim()
        ? body.targetId.trim()
        : saved.targetId;
      if (!targetId) {
        sendJson(res, 400, { ok: false, message: "主动推送目标不能为空" });
        return true;
      }

      const updatedRobotSettings = updateRobotOutboundTestSettings({
        targetType,
        targetId,
        message: typeof body.message === "string" && body.message.trim()
          ? body.message.trim()
          : saved.message || "EA系统主动推送测试。"
      });
      Object.assign(config.app.robot, {
        outboundTest: updatedRobotSettings.outboundTest
      });

      try {
        const result = await robotServer.sendCustomFeedbackCard(targetId);
        const ack = result.ack || {};
        logger.info("WeCom smart robot custom feedback card sent", {
          targetType,
          taskId: result.card && result.card.taskId,
          errcode: ack && ack.errcode
        });
        sendJson(res, 200, {
          ok: true,
          robotFeedbackCard: {
            targetType,
            targetId,
            sentAt: new Date().toISOString(),
            saved: true,
            card: result.card,
            ack: {
              errcode: ack && ack.errcode,
              errmsg: ack && ack.errmsg,
              cmd: ack && ack.cmd
            }
          }
        });
      } catch (error) {
        const info = errorInfo(error, "企业微信自定义反馈卡片发送失败");
        logger.warn("WeCom smart robot custom feedback card failed", {
          targetType,
          errcode: info.errcode,
          errmsg: info.errmsg,
          cmd: info.cmd,
          message: info.message
        });
        sendJson(res, 502, {
          ok: false,
          message: `企业微信自定义反馈卡片发送失败：${info.message}`,
          robotFeedbackCard: {
            targetType,
            saved: true,
            error: {
              errcode: info.errcode,
              errmsg: info.errmsg,
              cmd: info.cmd,
              reqId: info.reqId
            }
          }
        });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/rank") {
      const body = await readRequestBody(req);
      const rankSettings = updateRankSettings(body);
      sendJson(res, 200, {
        ok: true,
        rank: rankSettings,
        restartRequired: true
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/dev-progress") {
      const body = await readRequestBody(req);
      const devProgressSettings = updateDevProgressSettings(body);
      config.modules.modules.devProgress = {
        enabled: devProgressSettings.enabled,
        name: devProgressSettings.name,
        source: devProgressSettings.source,
        docUrl: devProgressSettings.docUrl,
        docid: devProgressSettings.docid,
        sheetId: devProgressSettings.sheetId,
        viewId: devProgressSettings.viewId,
        keyType: devProgressSettings.keyType,
        limit: devProgressSettings.limit,
        cacheMinutes: devProgressSettings.cacheMinutes,
        auth: {
          corpIdEnv: devProgressSettings.auth.corpIdEnv,
          agentIdEnv: devProgressSettings.auth.agentIdEnv,
          secretEnv: devProgressSettings.auth.secretEnv
        },
        fieldMapping: devProgressSettings.fieldMapping,
        personAliases: devProgressSettings.personAliases,
        rules: devProgressSettings.rules
      };
      config.modules.monitors.devProgress = devProgressSettings.monitor;
      sendJson(res, 200, {
        ok: true,
        devProgress: getDevProgressSettings({ includeSecrets: showSecretsInAdmin() }),
        restartRequired: false
      }, settingsResponseOptions());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/bug-collection") {
      const body = await readRequestBody(req);
      const bugCollectionSettings = updateBugCollectionSettings(body);
      applyBugCollectionRuntime(bugCollectionSettings);
      sendJson(res, 200, {
        ok: true,
        bugCollection: getBugCollectionSettings(),
        restartRequired: false
      }, settingsResponseOptions());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/demand-workflow-rules") {
      const body = await readRequestBody(req);
      const rulesSettings = updateDemandWorkflowRulesSettings(body);
      config.demandWorkflowRules = rulesSettings.normalizedRules;
      logger.info("Demand workflow rules settings updated", {
        version: rulesSettings.summary.version,
        stageCount: rulesSettings.summary.stageCount,
        roleCount: rulesSettings.summary.roleCount,
        warningCount: rulesSettings.summary.warningCount
      });
      sendJson(res, 200, {
        ok: true,
        saved: true,
        demandWorkflowRules: getDemandWorkflowRulesSettings(),
        restartRequired: false
      }, settingsResponseOptions());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/bug-collection/create-doc") {
      const body = await readRequestBody(req);
      const savedSettings = updateBugCollectionSettings(body);
      applyBugCollectionRuntime(savedSettings);
      const result = await createBugCollectionDocument(savedSettings);
      let latestSettings = getBugCollectionSettings();

      if (result.ok) {
        latestSettings = updateBugCollectionSettings({
          ...body,
          enabled: savedSettings.enabled,
          docUrl: result.shareUrl || result.docUrl || savedSettings.docUrl,
          docid: result.docid,
          docLinkId: result.docLinkId,
          sheetId: result.sheetId || savedSettings.sheetId,
          viewId: result.viewId || savedSettings.viewId,
          keyType: savedSettings.keyType,
          createDocName: savedSettings.createDoc.docName,
          createDocSpaceId: savedSettings.createDoc.spaceId,
          createDocFatherId: savedSettings.createDoc.fatherId,
          createDocAdminUsersText: savedSettings.createDoc.adminUsers.join("\n"),
          createDocShareAfterCreate: savedSettings.createDoc.shareAfterCreate
        });
        applyBugCollectionRuntime(latestSettings);
      }

      sendJson(res, result.ok ? 200 : 400, {
        ok: result.ok,
        bugCollectionCreate: result,
        bugCollection: latestSettings,
        message: result.message || (result.ok ? "智能表格已创建" : "")
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/bug-collection/setup-test") {
      const result = await setupBugCollectionSheet(getBugCollectionSettings());
      sendJson(res, result.ok ? 200 : 400, {
        ok: result.ok,
        bugCollection: result,
        message: result.message || ""
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/bug-collection/fields") {
      const result = await listBugCollectionFields(getBugCollectionSettings());
      sendJson(res, result.ok ? 200 : 400, {
        ok: result.ok,
        bugCollection: result,
        message: result.message || ""
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/bug-collection/cleanup-fields") {
      const result = await cleanupBugCollectionFields(getBugCollectionSettings());
      sendJson(res, result.ok ? 200 : 400, {
        ok: result.ok,
        bugCollection: result,
        message: result.message || ""
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/bug-collection/migrate-task-ids") {
      const result = await migrateBugCollectionTaskIds(getBugCollectionSettings());
      sendJson(res, result.ok ? 200 : 400, {
        ok: result.ok,
        bugCollection: result,
        message: result.message || ""
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/dev-progress/test-connection") {
      const result = await testDevProgressConnection(getDevProgressSettings());
      sendJson(res, 200, {
        ok: result.ok,
        devProgress: result
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/dev-progress/preview-records") {
      const body = await readRequestBody(req);
      const result = await modules.devProgress.previewRecords({
        limit: body.limit
      });
      sendJson(res, 200, {
        ok: result.ok,
        devProgress: result
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/dev-progress/scan-anomalies") {
      const body = await readRequestBody(req);
      const result = await modules.devProgress.scanAnomalies({
        limit: body.limit
      });
      sendJson(res, 200, {
        ok: result.ok,
        devProgress: result
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/dev-progress/recent-task-interaction") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const body = await readRequestBody(req);
      const result = modules.devProgress.recordRecentTaskInteraction({
        userName: identity.name,
        recordId: body.recordId,
        demandId: body.demandId,
        project: body.project,
        action: body.action
      });
      logger.info("Demand H5 recent task interaction requested", {
        entryId: String(req.headers["x-ea-demand-entry-id"] || "").slice(0, 80),
        pageVersion: String(req.headers["x-ea-demand-page-version"] || "").slice(0, 32),
        sessionId: identity.sessionId,
        userName: identity.name,
        taskId: String(body.demandId || "").slice(0, 160),
        recordId: String(body.recordId || "").slice(0, 160),
        project: String(body.project || "").slice(0, 80),
        action: String(body.action || "").slice(0, 40),
        retainedCount: Number(result.retainedCount || 0),
        ok: Boolean(result.ok)
      });
      sendJson(res, result.ok ? 200 : 400, {
        ok: result.ok,
        devProgress: result,
        message: result.message || ""
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/dev-progress/required-field-items") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const result = await modules.devProgress.listRequiredFieldItems({
        userName: identity.name,
        project: url.searchParams.get("project") || "",
        scope: url.searchParams.get("scope") || "",
        limit: Number(url.searchParams.get("limit") || 4000),
        forceRefresh: url.searchParams.get("forceRefresh") === "1",
        waitForRefresh: url.searchParams.get("waitForRefresh") === "1"
      });
      logger.info("Demand H5 required fields requested", {
        ...h5EntryRequestMeta(req, url, result),
        sessionId: identity.sessionId,
        userName: identity.name,
        scope: String(url.searchParams.get("scope") || "")
      });
      sendJson(res, result.ok ? 200 : 400, {
        ok: result.ok,
        devProgress: result,
        message: result.message || ""
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/dev-progress/person-tasks") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const result = await modules.devProgress.listPersonTaskItems({
        userName: identity.name,
        project: url.searchParams.get("project") || "",
        limit: Number(url.searchParams.get("limit") || 4000),
        forceRefresh: url.searchParams.get("forceRefresh") === "1",
        waitForRefresh: url.searchParams.get("waitForRefresh") === "1"
      });
      logger.info("Demand H5 personal tasks requested", {
        ...h5EntryRequestMeta(req, url, result),
        sessionId: identity.sessionId,
        userName: identity.name
      });
      sendJson(res, result.ok ? 200 : 400, {
        ok: result.ok,
        devProgress: result,
        message: result.message || ""
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/dev-progress/member-tasks") {
      const identity = requireDemandH5Identity(req, res, url.pathname);
      if (!identity) return true;
      const result = await modules.devProgress.listMemberTaskItems({
        userName: identity.name,
        project: url.searchParams.get("project") || "",
        limit: Number(url.searchParams.get("limit") || 4000),
        forceRefresh: url.searchParams.get("forceRefresh") === "1",
        waitForRefresh: url.searchParams.get("waitForRefresh") === "1"
      });
      logger.info("Demand H5 member tasks requested", {
        ...h5EntryRequestMeta(req, url, result),
        sessionId: identity.sessionId,
        userName: identity.name
      });
      sendJson(res, result.ok ? 200 : 400, {
        ok: result.ok,
        devProgress: result,
        message: result.message || ""
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/dev-progress/push-required-fields") {
      const body = await readRequestBody(req);
      const devProgressSettings = getDevProgressSettings();
      const requiredFieldsPush = devProgressSettings.monitor && devProgressSettings.monitor.requiredFieldsPush
        ? devProgressSettings.monitor.requiredFieldsPush
        : {};
      if (requiredFieldsPush.testMode && !String(requiredFieldsPush.testTargetName || "").trim()) {
        throw new Error("必填项测试推送目标不能为空");
      }
      const result = await modules.devProgress.prepareRequiredFieldPush({
        limit: body.limit,
        syncH5MonitorCache: true,
        targetOverride: requiredFieldsPush.testMode
          ? {
            enabled: true,
            targetName: requiredFieldsPush.testTargetName
          }
          : undefined
      });
      const targets = result.push && Array.isArray(result.push.targets) ? result.push.targets : [];
      const sent = [];
      for (const target of targets) {
        try {
          const items = Array.isArray(target.items) ? target.items : [];
          const taskCount = typeof modules.devProgress.countRequiredFieldPushTasks === "function"
            ? modules.devProgress.countRequiredFieldPushTasks(items)
            : Number(target.taskCount || items.length);
          let deliveryType = "markdown";
          let filename = "";
          let ack = null;
          let fileResult = null;
          if (taskCount <= 2) {
            ack = await robotServer.sendMarkdownMessage(target.targetId, target.message);
          } else {
            if (typeof modules.devProgress.exportRequiredFieldPushWorkbook !== "function") {
              throw new Error("开发进度模块还未提供必填项 Excel 导出能力");
            }
            if (!robotServer || typeof robotServer.sendFileMessage !== "function") {
              throw new Error("企业微信机器人还未提供文件发送能力");
            }
            deliveryType = "excel";
            const file = modules.devProgress.exportRequiredFieldPushWorkbook(target.ownerName, items);
            filename = file.filename;
            fileResult = await robotServer.sendFileMessage(target.targetId, file);
          }
          sent.push({
            ownerName: target.ownerName,
            targetConfigured: true,
            targetSource: target.targetSource || "",
            targetOverride: Boolean(target.targetOverride),
            originalOwnerCount: target.originalOwnerCount || 0,
            deliveryType,
            filename,
            issueCount: target.issueCount,
            taskCount: target.taskCount,
            errcode: deliveryType === "excel"
              ? fileResult && fileResult.ack && fileResult.ack.errcode
              : ack && ack.errcode,
            errmsg: deliveryType === "excel"
              ? fileResult && fileResult.ack && fileResult.ack.errmsg
              : ack && ack.errmsg
          });
        } catch (error) {
          const info = errorInfo(error, "必填项缺失推送失败");
          sent.push({
            ownerName: target.ownerName,
            targetConfigured: Boolean(target.targetId),
            targetSource: target.targetSource || "",
            targetOverride: Boolean(target.targetOverride),
            originalOwnerCount: target.originalOwnerCount || 0,
            deliveryType: "unknown",
            filename: "",
            issueCount: target.issueCount,
            taskCount: target.taskCount,
            ok: false,
            errcode: info.errcode,
            errmsg: info.errmsg,
            message: info.message
          });
          logger.warn("Dev progress required field push failed", {
            ownerName: target.ownerName,
            errcode: info.errcode,
            errmsg: info.errmsg,
            message: info.message
          });
        }
      }
      if (result.push) {
        result.push.sent = sent;
        result.push.sentCount = sent.filter((item) => item.errcode === 0 || item.ok !== false).length;
        result.push.failedCount = sent.filter((item) => item.ok === false || (item.errcode !== undefined && item.errcode !== 0)).length;
        result.push.sentMarkdownCount = sent.filter((item) => item.deliveryType === "markdown" && item.ok !== false).length;
        result.push.sentExcelCount = sent.filter((item) => item.deliveryType === "excel" && item.ok !== false).length;
        logger.info("Dev progress required field manual push finished", {
          targetOverride: Boolean(result.push.targetOverride && result.push.targetOverride.enabled),
          targetName: result.push.targetOverride ? result.push.targetOverride.targetName : "",
          targetCount: result.push.targetCount,
          sentCount: result.push.sentCount,
          sentMarkdownCount: result.push.sentMarkdownCount,
          sentExcelCount: result.push.sentExcelCount,
          failedCount: result.push.failedCount,
          issueCount: result.issueCount,
          scannedCount: result.scannedCount,
          targets: sent.map((item) => ({
            ownerName: item.ownerName,
            deliveryType: item.deliveryType,
            filename: item.filename || "",
            issueCount: item.issueCount,
            taskCount: item.taskCount,
            errcode: item.errcode
          }))
        });
      }
      sendJson(res, 200, {
        ok: result.ok,
        devProgress: result
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/feedback/demand-monitor/list") {
      const limit = Number(url.searchParams.get("limit") || 50);
      const result = modules.feedback.list({ limit });
      sendJson(res, 200, {
        ok: result.ok,
        feedback: result
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/feedback/demand-monitor/import") {
      const body = await readRequestBody(req);
      const result = modules.feedback.importText({
        text: body.text || "",
        source: "admin-console",
        sender: {
          source: "admin-console",
          name: body.senderName || "管理台"
        }
      });
      sendJson(res, result.ok ? 200 : 400, {
        ok: result.ok,
        feedback: result,
        message: result.text
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/feedback/demand-monitor/export") {
      const result = modules.feedback.exportMarkdown();
      sendJson(res, 200, {
        ok: result.ok,
        feedback: result
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/notification") {
      const body = await readRequestBody(req);
      const notificationSettings = updateNotificationSettings(body);
      Object.assign(config.modules.notification, {
        enabled: notificationSettings.enabled,
        defaultTarget: notificationSettings.defaultTarget,
        groupWebhookEnv: notificationSettings.groupWebhookEnv,
        appMessage: notificationSettings.appMessage
      });
      sendJson(res, 200, {
        ok: true,
        notification: getAllSettings({ includeSecrets: showSecretsInAdmin() }).notification,
        restartRequired: false
      }, settingsResponseOptions());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/ai") {
      const body = await readRequestBody(req);
      const aiSettings = updateAiSettings(body);
      Object.assign(config.app.ai, {
        enabled: aiSettings.enabled,
        provider: aiSettings.provider,
        baseUrl: aiSettings.baseUrl,
        model: aiSettings.model,
        apiKeyEnv: aiSettings.apiKeyEnv
      });
      sendJson(res, 200, {
        ok: true,
        ai: getAllSettings({ includeSecrets: showSecretsInAdmin() }).ai,
        restartRequired: false
      }, settingsResponseOptions());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/test-message") {
      const body = await readRequestBody(req);
      const testSender = body.sender && typeof body.sender === "object" ? body.sender : {};
      const result = await router.handleMessage({
        text: body.text || "",
        sender: {
          source: testSender.source || "admin-console",
          chatType: testSender.chatType || body.senderChatType || "",
          chatId: testSender.chatId || body.senderChatId || "",
          userId: testSender.userId || body.senderUserId || "",
          name: testSender.name || body.senderName || ""
        },
        raw: body
      });
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/rank/run-once") {
      const result = await modules.rank.runOnce();
      sendJson(res, 200, result);
      return true;
    }

    return false;
  }

  async function requestHandler(req, res) {
    try {
      const routeUrl = new URL(req.url, "http://localhost");
      if (routeUrl.pathname === "/demand-h5-auth") {
        await handleDemandH5Auth(req, res);
        return;
      }
      if (routeUrl.pathname === "/demand-web-login") {
        await handleDemandWebLogin(req, res);
        return;
      }
      if (routeUrl.pathname === "/demand-web-logout") {
        handleDemandWebLogout(req, res);
        return;
      }
      if (req.url.startsWith("/api/")) {
        const handled = await handleApi(req, res);
        if (!handled) {
          sendJson(res, 404, { ok: false, message: "API not found" });
        }
        return;
      }

      const staticUrl = routeUrl;
      if (["/demand-h5.html", "/demand", "/demand/", "/demand-workbench.html", "/demand-login.html"].includes(staticUrl.pathname)) {
        logger.info("Demand H5 static entry requested", {
          path: staticUrl.pathname,
          queryKeys: [...staticUrl.searchParams.keys()].slice(0, 12),
          wecomClient: /wxwork/i.test(String(req.headers["user-agent"] || ""))
        });
      }
      if (!serveStatic(req, res)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
      }
    } catch (error) {
      const info = errorInfo(error, "请求处理失败");
      const statusCode = Number(error.statusCode) >= 400 && Number(error.statusCode) < 600
        ? Number(error.statusCode)
        : 500;
      const logMeta = { message: info.message, url: req.url, statusCode };
      if (statusCode >= 500) {
        logger.error("Admin request failed", logMeta);
      } else {
        logger.warn("Admin request rejected", logMeta);
      }
      sendJson(res, statusCode, { ok: false, message: info.message });
    }
  }

  function start() {
    if (server) {
      return server;
    }

    const tlsOptions = httpsServerOptions();
    const requestListener = (req, res) => {
      requestHandler(req, res);
    };
    server = tlsOptions
      ? https.createServer({ key: tlsOptions.key, cert: tlsOptions.cert }, requestListener)
      : http.createServer(requestListener);

    const host = config.app.server.host;
    const port = config.app.server.port;
    server.listen(port, host, () => {
      const protocol = tlsOptions ? "https" : "http";
      logger.info("Admin console started", {
        url: `${protocol}://${host}:${port}`,
        httpsEnabled: Boolean(tlsOptions),
        certPath: tlsOptions ? path.relative(projectRoot, tlsOptions.certPath) : ""
      });
    });
    if (tlsOptions) {
      startLocalHealthServer(tlsOptions);
    }

    return server;
  }

  function stop() {
    if (server) {
      server.close();
      server = null;
    }
    if (healthServer) {
      healthServer.close();
      healthServer = null;
    }
  }

  return {
    start,
    stop,
    buildStatus
  };
}

module.exports = {
  createAdminServer
};
