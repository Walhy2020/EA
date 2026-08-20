"use strict";

const { createDraftStore } = require("./draftStore");

function trimSlash(value) {
  return String(value || "").replace(/\/+$/g, "");
}

function normalizePath(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "/demand-h5.html";
  }
  return text.startsWith("/") ? text : `/${text}`;
}

function resolveEntryUrl(moduleConfig = {}, appConfig = {}) {
  const explicitUrl = String(moduleConfig.entryUrl || "").trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  const baseUrl = String(moduleConfig.publicBaseUrl || appConfig.publicBaseUrl || "").trim();
  if (baseUrl) {
    return `${trimSlash(baseUrl)}${normalizePath(moduleConfig.entryPath)}`;
  }

  const server = appConfig.server || {};
  const host = String(moduleConfig.publicHost || server.host || "127.0.0.1").trim();
  const port = Number(moduleConfig.publicPort || server.port || 39200);
  const visibleHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${visibleHost}:${port}${normalizePath(moduleConfig.entryPath)}`;
}

function urlHost(urlText) {
  try {
    return new URL(urlText).host;
  } catch (_) {
    return "";
  }
}

function createDemandCollaborationModule(options = {}) {
  const moduleConfig = options.moduleConfig || {};
  const appConfig = options.appConfig || {};
  const workflowRules = options.workflowRules || {};
  const logger = options.logger;
  const draftStore = createDraftStore({ moduleConfig, workflowRules, logger });

  function handle(context = {}) {
    const enabled = moduleConfig.enabled !== false;
    if (!enabled) {
      return {
        ok: false,
        text: "需求协作入口当前未启用。"
      };
    }

    const entryUrl = resolveEntryUrl(moduleConfig, appConfig);
    const displayName = moduleConfig.displayName || moduleConfig.name || "需求协作";
    const sender = context.sender || {};

    if (logger && typeof logger.info === "function") {
      logger.info("Demand collaboration entry requested", {
        action: "open_entry",
        displayName,
        entryHost: urlHost(entryUrl),
        senderSource: sender.source || "",
        chatType: sender.chatType || "",
        hasUserId: Boolean(sender.userId),
        hasChatId: Boolean(sender.chatId)
      });
    }

    return {
      ok: true,
      text: [
        `${displayName}入口：`,
        `[打开${displayName}](${entryUrl})`,
        "",
        `地址：${entryUrl}`,
        "如果手机打不开，请先确认手机已连接公司内网或 VPN。"
      ].join("\n"),
      data: {
        displayName,
        entryUrl,
        version: moduleConfig.version || "0.1.0"
      }
    };
  }

  return {
    name: "demandCollaboration",
    handle,
    createDraft: draftStore.createDraft,
    listDrafts: draftStore.listDrafts,
    listTodoItems: draftStore.listTodoItems,
    listMemberTodoItems: draftStore.listMemberTodoItems,
    submitLeaderSupplement: draftStore.submitLeaderSupplement,
    cleanupExpiredDrafts: draftStore.cleanupExpired,
    getStatus: draftStore.getStatus
  };
}

module.exports = {
  createDemandCollaborationModule,
  resolveEntryUrl
};
