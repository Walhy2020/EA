"use strict";

const { createWecomGroupNotifier } = require("./wecomGroupNotifier");
const { createWecomAppNotifier } = require("./wecomAppNotifier");

function createNotificationCenter(options) {
  const config = options.config || {};
  const logger = options.logger;
  const groupNotifier = createWecomGroupNotifier({
    webhookEnv: config.groupWebhookEnv
  });
  const appNotifier = createWecomAppNotifier({
    appMessage: config.appMessage || {}
  });

  async function send(message, target = config.defaultTarget || "group") {
    if (!config.enabled) {
      return {
        ok: false,
        skipped: true,
        reason: "notification center is disabled"
      };
    }

    const channels = target === "app" ? [appNotifier] : target === "both" ? [groupNotifier, appNotifier] : [groupNotifier];
    const results = [];
    for (const channel of channels) {
      try {
        results.push(await channel.send(message));
      } catch (error) {
        logger.error("Notification send failed", { message: error.message });
        results.push({ ok: false, error: error.message });
      }
    }

    return {
      ok: results.some((result) => result.ok),
      results
    };
  }

  function getStatus() {
    return {
      enabled: Boolean(config.enabled),
      defaultTarget: config.defaultTarget || "group",
      groupWebhookConfigured: Boolean(process.env[config.groupWebhookEnv || "WECOM_GROUP_WEBHOOK_URL"]),
      appMessageConfigured: Boolean(
        process.env[(config.appMessage || {}).corpIdEnv || "WECOM_APP_CORP_ID"] &&
        process.env[(config.appMessage || {}).agentIdEnv || "WECOM_APP_AGENT_ID"] &&
        process.env[(config.appMessage || {}).secretEnv || "WECOM_APP_SECRET"] &&
        process.env[(config.appMessage || {}).toUserEnv || "WECOM_APP_TO_USER"]
      )
    };
  }

  return {
    send,
    getStatus
  };
}

module.exports = {
  createNotificationCenter
};
