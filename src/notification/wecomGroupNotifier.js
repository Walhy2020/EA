"use strict";

const { postJson } = require("./httpJson");

function createWecomGroupNotifier(options) {
  const webhookUrl = process.env[options.webhookEnv || "WECOM_GROUP_WEBHOOK_URL"];

  async function send(text) {
    if (!webhookUrl) {
      return {
        ok: false,
        skipped: true,
        reason: "group webhook is not configured"
      };
    }

    const result = await postJson(webhookUrl, {
      msgtype: "text",
      text: {
        content: text
      }
    });

    return {
      ok: true,
      channel: "wecom-group",
      result
    };
  }

  return { send };
}

module.exports = {
  createWecomGroupNotifier
};
