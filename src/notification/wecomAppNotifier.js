"use strict";

const { getJson, postJson } = require("./httpJson");

function trimText(value) {
  return String(value || "").trim();
}

function normalizeUserList(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item || "").split(/[|,，;；\s]+/))
    .map(trimText)
    .filter(Boolean)
    .join("|");
}

function createWeComError(prefix, result) {
  const error = new Error(`${prefix} ${Number(result && result.errcode) || -1}: ${trimText(result && result.errmsg) || "unknown"}`);
  error.errcode = Number(result && result.errcode);
  error.errmsg = trimText(result && result.errmsg);
  return error;
}

function createWecomAppNotifier(options) {
  const appMessage = options.appMessage || {};
  const logger = options.logger;
  const corpIdEnv = appMessage.corpIdEnv || "WECOM_APP_CORP_ID";
  const agentIdEnv = appMessage.agentIdEnv || "WECOM_APP_AGENT_ID";
  const secretEnv = appMessage.secretEnv || "WECOM_APP_SECRET";
  const toUserEnv = appMessage.toUserEnv || "WECOM_APP_TO_USER";
  let cachedToken = "";
  let cachedTokenExpiresAt = 0;

  function nativeCardSettings() {
    const nativeCard = appMessage.nativeCard && typeof appMessage.nativeCard === "object"
      ? appMessage.nativeCard
      : {};
    return {
      enabled: nativeCard.enabled === true,
      callbackPath: trimText(nativeCard.callbackPath || "/api/wecom/watchdog-callback") || "/api/wecom/watchdog-callback",
      callbackTokenEnv: trimText(nativeCard.callbackTokenEnv || "WECOM_APP_CALLBACK_TOKEN") || "WECOM_APP_CALLBACK_TOKEN",
      callbackAesKeyEnv: trimText(nativeCard.callbackAesKeyEnv || "WECOM_APP_CALLBACK_AES_KEY") || "WECOM_APP_CALLBACK_AES_KEY"
    };
  }

  function credentials() {
    return {
      corpId: trimText(process.env[corpIdEnv]),
      agentId: Number(process.env[agentIdEnv]),
      secret: trimText(process.env[secretEnv]),
      defaultToUser: normalizeUserList(process.env[toUserEnv])
    };
  }

  function hasCredentials() {
    const value = credentials();
    return Boolean(value.corpId && Number.isInteger(value.agentId) && value.agentId > 0 && value.secret);
  }

  function nativeCardStatus() {
    const settings = nativeCardSettings();
    const callbackToken = trimText(process.env[settings.callbackTokenEnv]);
    const callbackAesKey = trimText(process.env[settings.callbackAesKeyEnv]);
    const callbackAesKeyValid = /^[A-Za-z0-9+/]{43}$/.test(callbackAesKey);
    return {
      enabled: settings.enabled,
      callbackPath: settings.callbackPath,
      callbackTokenEnv: settings.callbackTokenEnv,
      callbackAesKeyEnv: settings.callbackAesKeyEnv,
      callbackTokenConfigured: Boolean(callbackToken),
      callbackAesKeyConfigured: callbackAesKeyValid,
      ready: Boolean(settings.enabled && hasCredentials() && callbackToken && callbackAesKeyValid)
    };
  }

  async function getAccessToken() {
    const value = credentials();
    if (!value.corpId || !value.secret) {
      throw new Error("企业微信自建应用企业 ID 或密钥未配置");
    }
    if (cachedToken && cachedTokenExpiresAt > Date.now() + 60 * 1000) {
      return cachedToken;
    }
    const result = await getJson(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(value.corpId)}&corpsecret=${encodeURIComponent(value.secret)}`
    );
    if (Number(result && result.errcode) !== 0 || !result.access_token) {
      throw createWeComError("企业微信自建应用凭证获取失败", result);
    }
    cachedToken = result.access_token;
    cachedTokenExpiresAt = Date.now() + Math.max(60, Number(result.expires_in) || 7200) * 1000;
    return cachedToken;
  }

  function sendInput(message, options = {}) {
    if (message && typeof message === "object" && !Array.isArray(message)) {
      return {
        messageType: trimText(message.messageType || message.msgType || "text").toLowerCase(),
        text: trimText(message.text || message.content),
        toUser: normalizeUserList(message.toUser || message.targetUserId || message.userId || options.toUser),
        purpose: trimText(message.purpose || options.purpose),
        title: trimText(message.title),
        description: trimText(message.description),
        url: trimText(message.url),
        buttonText: trimText(message.buttonText || message.btntxt),
        templateCard: message.templateCard && typeof message.templateCard === "object" ? message.templateCard : null
      };
    }
    return {
      messageType: "text",
      text: trimText(message),
      toUser: normalizeUserList(options.toUser || options.targetUserId || options.userId),
      purpose: trimText(options.purpose),
      title: "",
      description: "",
      url: "",
      buttonText: "",
      templateCard: null
    };
  }

  async function send(message, options = {}) {
    const input = sendInput(message, options);
    const value = credentials();
    const toUser = input.toUser || value.defaultToUser;
    if (!hasCredentials()) {
      return {
        ok: false,
        skipped: true,
        reason: "企业微信自建应用凭证未配置完整"
      };
    }
    if (!toUser) {
      return {
        ok: false,
        skipped: true,
        reason: "企业微信自建应用缺少接收成员"
      };
    }
    const messageType = ["textcard", "template_card"].includes(input.messageType)
      ? input.messageType
      : "text";
    if (messageType === "text" && !input.text) {
      return {
        ok: false,
        skipped: true,
        reason: "企业微信自建应用消息内容不能为空"
      };
    }
    if (messageType === "textcard" && (!input.title || !input.description || !input.url)) {
      return {
        ok: false,
        skipped: true,
        reason: "企业微信自建应用任务卡缺少标题、内容或反馈地址"
      };
    }
    if (messageType === "template_card" && !input.templateCard) {
      return {
        ok: false,
        skipped: true,
        reason: "企业微信自建应用模板卡片内容不能为空"
      };
    }
    if (messageType === "template_card" && !nativeCardStatus().ready) {
      return {
        ok: false,
        skipped: true,
        reason: "企业微信自建应用原生卡片回调未配置完成"
      };
    }

    const accessToken = await getAccessToken();
    const payload = {
      touser: toUser,
      msgtype: messageType,
      agentid: value.agentId,
      safe: 0
    };
    if (messageType === "textcard") {
      payload.textcard = {
        title: input.title,
        description: input.description,
        url: input.url,
        btntxt: input.buttonText || "反馈进度"
      };
    } else {
      if (messageType === "template_card") {
        payload.template_card = input.templateCard;
      } else {
        payload.text = { content: input.text };
      }
    }
    const result = await postJson(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`,
      payload
    );
    if (Number(result && result.errcode) !== 0) {
      throw createWeComError("企业微信自建应用消息发送失败", result);
    }
    if (trimText(result.invaliduser) || trimText(result.unlicenseduser)) {
      const error = new Error(`企业微信自建应用存在不可送达成员：invaliduser=${trimText(result.invaliduser)} unlicenseduser=${trimText(result.unlicenseduser)}`);
      error.errcode = 0;
      error.invaliduser = trimText(result.invaliduser);
      error.unlicenseduser = trimText(result.unlicenseduser);
      throw error;
    }
    if (logger && typeof logger.info === "function") {
      logger.info("WeCom app message sent", {
        channel: "wecom-app",
        purpose: input.purpose || "notification",
        recipientCount: toUser.split("|").filter(Boolean).length,
        messageType,
        textLength: (input.text || input.description || "").length,
        agentId: value.agentId,
        msgid: trimText(result.msgid)
      });
    }
    return {
      ok: true,
      channel: "wecom-app",
      messageType,
      msgid: trimText(result.msgid),
      result
    };
  }

  async function updateTemplateCard(options = {}) {
    const value = credentials();
    const responseCode = trimText(options.responseCode);
    const toUser = normalizeUserList(options.targetUserId || options.userId || options.toUser);
    const templateCard = options.templateCard && typeof options.templateCard === "object" ? options.templateCard : null;
    if (!hasCredentials()) {
      return { ok: false, skipped: true, reason: "企业微信自建应用凭证未配置完整" };
    }
    if (!responseCode || !templateCard || !toUser) {
      return { ok: false, skipped: true, reason: "更新自建应用模板卡片缺少响应码、卡片或接收成员" };
    }
    const accessToken = await getAccessToken();
    const result = await postJson(
      `https://qyapi.weixin.qq.com/cgi-bin/message/update_template_card?access_token=${encodeURIComponent(accessToken)}`,
      {
        userids: toUser.split("|").filter(Boolean),
        agentid: value.agentId,
        response_code: responseCode,
        template_card: templateCard
      }
    );
    if (Number(result && result.errcode) !== 0) {
      throw createWeComError("企业微信自建应用模板卡片更新失败", result);
    }
    if (logger && typeof logger.info === "function") {
      logger.info("WeCom app template card updated", {
        recipientCount: toUser.split("|").filter(Boolean).length,
        agentId: value.agentId
      });
    }
    return { ok: true, channel: "wecom-app", result };
  }

  function getStatus() {
    const value = credentials();
    return {
      channel: "wecom-app",
      configured: hasCredentials(),
      corpIdEnv,
      agentIdEnv,
      secretEnv,
      toUserEnv,
      defaultTargetConfigured: Boolean(value.defaultToUser),
      tokenCached: Boolean(cachedToken && cachedTokenExpiresAt > Date.now()),
      nativeCard: nativeCardStatus()
    };
  }

  return { send, updateTemplateCard, getStatus };
}

module.exports = {
  createWecomAppNotifier
};
