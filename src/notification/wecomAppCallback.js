"use strict";

const crypto = require("crypto");

const MAX_CALLBACK_BODY_BYTES = 256 * 1024;
const WECOM_PKCS7_BLOCK_SIZE = 32;

function trimText(value) {
  return String(value || "").trim();
}

function callbackPath(value) {
  const path = trimText(value || "/api/wecom/watchdog-callback") || "/api/wecom/watchdog-callback";
  return path.startsWith("/") ? path : `/${path}`;
}

function xmlValue(xml, name) {
  const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<${escaped}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${escaped}>`).exec(String(xml || ""));
  return trimText(match && (match[1] !== undefined ? match[1] : match[2]));
}

function xmlValues(xml, name) {
  const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`<${escaped}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${escaped}>`, "g");
  const values = [];
  let match;
  while ((match = expression.exec(String(xml || ""))) !== null) {
    const value = trimText(match[1] !== undefined ? match[1] : match[2]);
    if (value) values.push(value);
  }
  return values;
}

function xmlBlocks(xml, name) {
  const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`<${escaped}>([\\s\\S]*?)<\\/${escaped}>`, "g");
  const blocks = [];
  let match;
  while ((match = expression.exec(String(xml || ""))) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function selectedItemsFromXml(xml) {
  return xmlBlocks(xml, "SelectedItem")
    .map((block) => ({
      questionKey: xmlValue(block, "QuestionKey"),
      optionIds: xmlValues(block, "OptionId")
    }))
    .filter((item) => item.questionKey && item.optionIds.length > 0);
}

function signatureFor(values) {
  return crypto.createHash("sha1").update(values.map(trimText).sort().join("")).digest("hex");
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(trimText(left), "utf8");
  const rightBuffer = Buffer.from(trimText(right), "utf8");
  return leftBuffer.length === rightBuffer.length
    && leftBuffer.length > 0
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function decodeAesKey(value) {
  const text = trimText(value);
  if (!/^[A-Za-z0-9+/]{43}$/.test(text)) return null;
  const key = Buffer.from(`${text}=`, "base64");
  return key.length === 32 ? key : null;
}

function removeWeComPkcs7Padding(value) {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length % 16 !== 0) {
    throw new Error("callback_payload_invalid");
  }
  const paddingLength = value[value.length - 1];
  if (paddingLength < 1 || paddingLength > WECOM_PKCS7_BLOCK_SIZE || paddingLength > value.length) {
    throw new Error("callback_payload_padding_invalid");
  }
  const padding = value.subarray(value.length - paddingLength);
  for (const byte of padding) {
    if (byte !== paddingLength) throw new Error("callback_payload_padding_invalid");
  }
  return value.subarray(0, value.length - paddingLength);
}

function decryptWeComPayload(encrypted, aesKey, corpId) {
  const key = decodeAesKey(aesKey);
  const encryptedBuffer = Buffer.from(trimText(encrypted), "base64");
  if (!key || encryptedBuffer.length === 0) throw new Error("callback_payload_invalid");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  // WeCom uses PKCS#7 padding with a 32-byte block size, not Node's AES default of 16.
  decipher.setAutoPadding(false);
  const plain = removeWeComPkcs7Padding(Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]));
  if (plain.length < 20) throw new Error("callback_payload_too_short");
  const messageLength = plain.readUInt32BE(16);
  const messageEnd = 20 + messageLength;
  if (messageLength <= 0 || messageEnd > plain.length) throw new Error("callback_payload_length_invalid");
  const receivedCorpId = plain.subarray(messageEnd).toString("utf8");
  if (corpId && receivedCorpId !== corpId) throw new Error("callback_corp_id_mismatch");
  return plain.subarray(20, messageEnd).toString("utf8");
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_CALLBACK_BODY_BYTES) {
        reject(new Error("callback_body_too_large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text || "");
}

function createWecomAppCallback(options = {}) {
  const appMessage = options.appMessage || {};
  const watchdog = options.watchdog;
  const appNotifier = options.appNotifier;
  const logger = options.logger;
  const nativeCard = appMessage.nativeCard && typeof appMessage.nativeCard === "object" ? appMessage.nativeCard : {};
  const settings = {
    enabled: nativeCard.enabled === true,
    path: callbackPath(nativeCard.callbackPath),
    callbackTokenEnv: trimText(nativeCard.callbackTokenEnv || "WECOM_APP_CALLBACK_TOKEN") || "WECOM_APP_CALLBACK_TOKEN",
    callbackAesKeyEnv: trimText(nativeCard.callbackAesKeyEnv || "WECOM_APP_CALLBACK_AES_KEY") || "WECOM_APP_CALLBACK_AES_KEY",
    corpIdEnv: trimText(appMessage.corpIdEnv || "WECOM_APP_CORP_ID") || "WECOM_APP_CORP_ID"
  };

  function runtimeSettings() {
    const token = trimText(process.env[settings.callbackTokenEnv]);
    const aesKey = trimText(process.env[settings.callbackAesKeyEnv]);
    const corpId = trimText(process.env[settings.corpIdEnv]);
    return {
      token,
      aesKey,
      corpId,
      ready: Boolean(settings.enabled && token && decodeAesKey(aesKey) && corpId)
    };
  }

  function getStatus() {
    const runtime = runtimeSettings();
    return {
      enabled: settings.enabled,
      configured: runtime.ready,
      path: settings.path,
      callbackTokenEnv: settings.callbackTokenEnv,
      callbackAesKeyEnv: settings.callbackAesKeyEnv,
      callbackTokenConfigured: Boolean(runtime.token),
      callbackAesKeyConfigured: Boolean(decodeAesKey(runtime.aesKey)),
      corpIdConfigured: Boolean(runtime.corpId)
    };
  }

  function matches(url) {
    return Boolean(url && url.pathname === settings.path);
  }

  function isValidSignature(url, encrypted, token) {
    const signature = trimText(url.searchParams.get("msg_signature"));
    const timestamp = trimText(url.searchParams.get("timestamp"));
    const nonce = trimText(url.searchParams.get("nonce"));
    return Boolean(signature && timestamp && nonce && encrypted && secureEqual(signature, signatureFor([token, timestamp, nonce, encrypted])));
  }

  async function processTemplateCardEvent(payload) {
    const event = xmlValue(payload, "Event");
    const taskId = xmlValue(payload, "TaskId");
    const eventKey = xmlValue(payload, "EventKey");
    const senderUserId = xmlValue(payload, "FromUserName");
    const responseCode = xmlValue(payload, "ResponseCode");
    const selectedItems = selectedItemsFromXml(payload);
    if (event !== "template_card_event" || !taskId.startsWith("ea_watch_")) {
      if (logger && typeof logger.info === "function") {
        logger.info("WeCom app callback ignored", { event, taskId, eventKey, senderConfigured: Boolean(senderUserId) });
      }
      return;
    }
    if (!watchdog || typeof watchdog.handleTemplateCardEvent !== "function") {
      if (logger && typeof logger.warn === "function") logger.warn("WeCom watchdog app callback unavailable", { taskId, eventKey });
      return;
    }
    const result = await watchdog.handleTemplateCardEvent({ taskId, eventKey, selectedItems }, {
      userId: senderUserId,
      source: "wecom-app-native"
    });
    let cardUpdated = false;
    let requesterNewStateSynced = false;
    let requesterFeedbackCardSynced = false;
    if (
      result && result.handled && result.updateCard && responseCode
      && appNotifier && typeof appNotifier.updateTemplateCard === "function"
      && senderUserId
    ) {
      try {
        const updateResult = await appNotifier.updateTemplateCard({
          responseCode,
          targetUserId: senderUserId,
          templateCard: result.updateCard
        });
        cardUpdated = Boolean(updateResult && updateResult.ok);
      } catch (error) {
        if (logger && typeof logger.warn === "function") {
          logger.warn("WeCom watchdog app card update failed after feedback persisted", {
            taskId,
            eventKey,
            message: error && error.message ? error.message : String(error || "")
          });
        }
      }
    }
    if (
      cardUpdated
      && result && result.syncRequesterNewState
      && watchdog && typeof watchdog.syncAppReminderCardReadState === "function"
    ) {
      try {
        const syncResult = await watchdog.syncAppReminderCardReadState(result.syncRequesterNewState);
        requesterNewStateSynced = Boolean(syncResult && syncResult.ok);
      } catch (error) {
        if (logger && typeof logger.warn === "function") {
          logger.warn("WeCom watchdog requester New state sync failed after assignee card update", {
            taskId,
            eventKey,
            message: error && error.message ? error.message : String(error || "")
          });
        }
      }
    }
    if (
      result && result.syncRequesterFeedbackState
      && watchdog && typeof watchdog.syncAppRequesterFeedbackCardState === "function"
    ) {
      try {
        const syncResult = await watchdog.syncAppRequesterFeedbackCardState(result.syncRequesterFeedbackState);
        requesterFeedbackCardSynced = Boolean(syncResult && syncResult.ok);
      } catch (error) {
        if (logger && typeof logger.warn === "function") {
          logger.warn("WeCom watchdog requester feedback card merge failed after feedback persisted", {
            taskId,
            eventKey,
            message: error && error.message ? error.message : String(error || "")
          });
        }
      }
    }
    if (logger && typeof logger.info === "function") {
      logger.info("WeCom watchdog app card event processed", {
        taskId,
        eventKey,
        senderConfigured: Boolean(senderUserId),
        handled: Boolean(result && result.handled),
        cardUpdated,
        requesterNewStateSynced,
        requesterFeedbackCardSynced,
        responseCodeConfigured: Boolean(responseCode),
        selectedItemCount: selectedItems.length,
        selectedQuestionKeys: selectedItems.map((item) => item.questionKey)
      });
    }
  }

  async function handleRequest(req, res, url) {
    const runtime = runtimeSettings();
    if (!runtime.ready) {
      if (logger && typeof logger.warn === "function") logger.warn("WeCom watchdog app callback rejected because it is not configured", { path: settings.path });
      sendText(res, 503, "callback not configured");
      return true;
    }
    if (req.method === "GET") {
      const encrypted = trimText(url.searchParams.get("echostr"));
      if (!isValidSignature(url, encrypted, runtime.token)) {
        if (logger && typeof logger.warn === "function") logger.warn("WeCom watchdog app callback verification rejected", { path: settings.path, reason: "signature_invalid" });
        sendText(res, 403, "invalid signature");
        return true;
      }
      try {
        const echo = decryptWeComPayload(encrypted, runtime.aesKey, runtime.corpId);
        if (logger && typeof logger.info === "function") logger.info("WeCom watchdog app callback verification passed", { path: settings.path });
        sendText(res, 200, echo);
      } catch (error) {
        if (logger && typeof logger.warn === "function") logger.warn("WeCom watchdog app callback verification rejected", { path: settings.path, reason: error.message || "decrypt_failed" });
        sendText(res, 403, "invalid callback");
      }
      return true;
    }
    if (req.method !== "POST") {
      sendText(res, 405, "method not allowed");
      return true;
    }
    try {
      const body = await readRawBody(req);
      const encrypted = xmlValue(body, "Encrypt");
      if (!isValidSignature(url, encrypted, runtime.token)) {
        if (logger && typeof logger.warn === "function") logger.warn("WeCom watchdog app callback rejected", { path: settings.path, reason: "signature_invalid" });
        sendText(res, 403, "invalid signature");
        return true;
      }
      const payload = decryptWeComPayload(encrypted, runtime.aesKey, runtime.corpId);
      await processTemplateCardEvent(payload);
      sendText(res, 200, "");
    } catch (error) {
      if (logger && typeof logger.warn === "function") logger.warn("WeCom watchdog app callback body rejected", { path: settings.path, reason: error && error.message ? error.message : "body_invalid" });
      sendText(res, 400, "invalid callback");
    }
    return true;
  }

  return { matches, handleRequest, getStatus };
}

module.exports = { createWecomAppCallback };
