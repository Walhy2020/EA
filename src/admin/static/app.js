"use strict";

const state = {
  status: null,
  settings: null,
  robotDiagnostics: null,
  desktopTipIdentity: null,
  desktopTipRegisteredClientCount: 0,
  desktopTipWecomGroups: [],
  desktopTipManualCanSend: false,
  desktopTipManualSending: false,
  activeTab: "basic"
};

const devProgressFieldInputs = {
  demandId: "devProgressDemandIdFieldInput",
  project: "devProgressProjectFieldInput",
  demand: "devProgressDemandFieldInput",
  demandContent: "devProgressDemandContentFieldInput",
  demandType: "devProgressDemandTypeFieldInput",
  owner: "devProgressOwnerFieldInput",
  status: "devProgressStatusFieldInput",
  progress: "devProgressProgressFieldInput",
  planDate: "devProgressPlanDateFieldInput",
  blockers: "devProgressBlockersFieldInput",
  updatedAt: "devProgressUpdatedAtFieldInput",
  remarks: "devProgressRemarksFieldInput",
  frontendOwner: "devProgressFrontendOwnerFieldInput",
  backendOwner: "devProgressBackendOwnerFieldInput",
  frontendRemaining: "devProgressFrontendRemainingFieldInput",
  backendRemaining: "devProgressBackendRemainingFieldInput",
  uiOwner: "devProgressUiOwnerFieldInput",
  plannerOwner: "devProgressPlannerOwnerFieldInput",
  testerOwner: "devProgressTesterOwnerFieldInput",
  frontendLead: "devProgressFrontendLeadFieldInput",
  backendLead: "devProgressBackendLeadFieldInput",
  devDeadline: "devProgressDevDeadlineFieldInput",
  testDeadline: "devProgressTestDeadlineFieldInput",
  acceptanceDeadline: "devProgressAcceptanceDeadlineFieldInput",
  releaseDate: "devProgressReleaseDateFieldInput",
  groupChat: "devProgressGroupChatFieldInput",
  demandLink: "devProgressDemandLinkFieldInput"
};

const devProgressFieldSuggestions = {
  demandId: "需求Id",
  project: "项目",
  demand: "需求名称",
  demandContent: "需求内容",
  demandType: "需求类型",
  owner: "前端开发",
  status: "需求进度",
  progress: "需求进度",
  planDate: "开发截止日期",
  blockers: "程序备注",
  updatedAt: "更新时间",
  remarks: "备注",
  frontendOwner: "前端开发",
  backendOwner: "后端开发",
  frontendRemaining: "前端剩余",
  backendRemaining: "后端剩余",
  uiOwner: "UI人员",
  plannerOwner: "策划负责人",
  testerOwner: "测试人员",
  frontendLead: "前端组长",
  backendLead: "后端组长",
  devDeadline: "开发截止日期",
  testDeadline: "测试截止日期",
  acceptanceDeadline: "验收截止日期",
  releaseDate: "实际上线日期",
  groupChat: "群聊",
  demandLink: "需求链接"
};

function $(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  $(id).textContent = value;
}

function personAliasesToText(personAliases) {
  if (!personAliases || typeof personAliases !== "object") {
    return "";
  }

  return Object.entries(personAliases)
    .map(([name, aliases]) => {
      const values = Array.isArray(aliases) ? aliases : [aliases];
      return `${name}=${values.filter(Boolean).join(",")}`;
    })
    .join("\n");
}

function listToText(values) {
  return Array.isArray(values) ? values.join("，") : "";
}

function parseListInput(value) {
  return String(value || "")
    .split(/[\r\n,，、|;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || `HTTP ${response.status}`);
  }
  return data;
}

function saveMessage(result, defaultText = "已保存") {
  return result && result.restartRequired ? `${defaultText}，重启后生效` : defaultText;
}

function renderRankList(rows) {
  const list = $("rankTopList");
  list.innerHTML = "";

  if (!rows || rows.length === 0) {
    list.textContent = "还没有读取到榜单历史。";
    return;
  }

  for (const row of rows) {
    const item = document.createElement("div");
    const number = document.createElement("div");
    const textWrap = document.createElement("div");
    const name = document.createElement("div");
    const meta = document.createElement("div");

    item.className = "rank-item";
    number.className = "rank-number";
    name.className = "rank-name";
    meta.className = "rank-meta";
    number.textContent = row.ranking || "-";
    name.textContent = row.appName || "-";
    meta.textContent = row.publisherName || "";
    textWrap.appendChild(name);
    textWrap.appendChild(meta);
    item.appendChild(number);
    item.appendChild(textWrap);
    list.appendChild(item);
  }
}

function renderStatus(status) {
  state.status = status;
  const rank = status.modules.rank || {};
  const rankFiles = rank.files || {};
  const robot = status.robot || {};
  const feedbackProbe = robot.feedbackProbe || {};
  const customFeedbackCardProbe = robot.customFeedbackCardProbe || {};

  $("healthBadge").classList.toggle("error", !status.ok);
  setText("healthBadge", status.ok ? "运行中" : "异常");
  setText("versionBadge", status.app && status.app.version ? `v${status.app.version}` : "v-");
  setText("serverValue", `${status.config.server.host}:${status.config.server.port}`);
  setText("robotValue", robot.enabled ? "已启用" : "未启用");
  setText("notifyValue", status.notification.enabled ? "已启用" : "未启用");
  setText("rankValue", rankFiles.monitor && rankFiles.botHelper ? "可调用" : "文件缺失");
  setText("configBox", JSON.stringify(status.config, null, 2));
  setText("robotFeedbackProbeBox", JSON.stringify({
    nativeThumbs: {
      replyFeedbackAttached: Boolean(feedbackProbe.replyFeedbackAttached),
      eventCount: feedbackProbe.eventCount || 0,
      lastReplyAt: feedbackProbe.lastReplyAt || "",
      lastReplyFeedbackId: feedbackProbe.lastReplyFeedbackId || "",
      lastEvent: feedbackProbe.lastEvent || null
    },
    customCard: {
      sentCount: customFeedbackCardProbe.sentCount || 0,
      eventCount: customFeedbackCardProbe.eventCount || 0,
      lastTaskId: customFeedbackCardProbe.lastTaskId || "",
      lastSentAt: customFeedbackCardProbe.lastSentAt || "",
      lastEvent: customFeedbackCardProbe.lastEvent || null
    }
  }, null, 2));
  renderRankList(rank.latestTop || []);
  applyDesktopTipStatusToControls(status);
}

function shortDiagnosticText(value, maxLength = 180) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function renderDiagnosticList(containerId, rows, renderer, emptyText) {
  const list = $(containerId);
  list.innerHTML = "";

  if (!Array.isArray(rows) || rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "feedback-empty";
    empty.textContent = emptyText;
    list.appendChild(empty);
    return;
  }

  for (const row of rows) {
    const rendered = renderer(row);
    const item = document.createElement("div");
    const header = document.createElement("div");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const body = document.createElement("p");

    item.className = "feedback-item";
    header.className = "feedback-item-header";
    title.textContent = rendered.title || "-";
    meta.textContent = rendered.meta || "";
    body.textContent = rendered.body || "";
    header.appendChild(title);
    header.appendChild(meta);
    item.appendChild(header);
    item.appendChild(body);
    list.appendChild(item);
  }
}

function issueStatusLabel(status) {
  const labels = {
    open: "未处理",
    analyzing: "已分析",
    fixed: "已修复",
    ignored: "忽略"
  };
  return labels[status] || status || "未处理";
}

function senderLabel(sender) {
  const safeSender = sender || {};
  return safeSender.name || safeSender.userId || safeSender.targetId || "-";
}

function createIssueStatusButton(issue, status) {
  const button = document.createElement("button");
  button.className = "secondary-button diagnostic-status-button";
  button.type = "button";
  button.dataset.issueId = issue.id;
  button.dataset.issueStatus = status;
  button.textContent = issueStatusLabel(status);
  button.disabled = issue.status === status;
  return button;
}

function correctionText(issue) {
  const correction = issue.correction || {};
  if (correction.status === "waiting") {
    return `等待同事补充，过期时间：${correction.expiresAt || "-"}`;
  }
  if (correction.status === "received") {
    return correction.text || "-";
  }
  if (correction.status === "canceled") {
    return "同事已取消补充";
  }
  return "-";
}

function renderRobotDiagnosticIssues(issues) {
  const list = $("robotDiagnosticsIssueList");
  list.innerHTML = "";

  if (!Array.isArray(issues) || issues.length === 0) {
    const empty = document.createElement("div");
    empty.className = "feedback-empty";
    empty.textContent = "还没有诊断问题单。用户点踩或点击负向反馈卡片后会自动生成。";
    list.appendChild(empty);
    return;
  }

  for (const issue of issues) {
    const item = document.createElement("div");
    const header = document.createElement("div");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const body = document.createElement("p");
    const actions = document.createElement("div");
    const trace = issue.linkedTrace || {};
    const message = trace.message || {};
    const reply = trace.reply || {};

    item.className = "feedback-item diagnostic-issue";
    header.className = "feedback-item-header";
    actions.className = "diagnostic-issue-actions";
    title.textContent = `${issue.title || "诊断问题"} · ${issueStatusLabel(issue.status)}`;
    meta.textContent = issue.updatedAt || issue.createdAt || "";
    body.textContent = [
      `issueId: ${issue.id || "-"}`,
      `traceId: ${issue.source && issue.source.traceId ? issue.source.traceId : "-"}`,
      `反馈人: ${senderLabel(issue.sender)}`,
      `原因: ${issue.reason || "-"}`,
      `纠正意图: ${correctionText(issue)}`,
      `问题: ${shortDiagnosticText(message.text || "")}`,
      `回复: ${shortDiagnosticText(reply.text || "")}`
    ].join("\n");

    for (const status of ["open", "analyzing", "fixed", "ignored"]) {
      actions.appendChild(createIssueStatusButton(issue, status));
    }

    header.appendChild(title);
    header.appendChild(meta);
    item.appendChild(header);
    item.appendChild(body);
    item.appendChild(actions);
    list.appendChild(item);
  }
}

function renderRobotDiagnostics(payload) {
  const diagnostics = payload && payload.robotDiagnostics ? payload.robotDiagnostics : payload || {};
  state.robotDiagnostics = diagnostics;
  const replyTraces = diagnostics.replyTraces || [];
  const feedbackEvents = diagnostics.feedbackEvents || [];
  const issues = diagnostics.issues || [];

  setText("robotDiagnosticsSummaryBox", JSON.stringify({
    limit: diagnostics.limit || 0,
    issueCount: issues.length,
    replyTraceCount: replyTraces.length,
    feedbackEventCount: feedbackEvents.length,
    files: diagnostics.files || {}
  }, null, 2));

  renderRobotDiagnosticIssues(issues);

  renderDiagnosticList("robotDiagnosticsTraceList", replyTraces, (row) => {
    const route = row.result && row.result.route ? row.result.route : {};
    const moduleName = route.module || row.channel || "机器人回复";
    const action = route.action ? ` / ${route.action}` : "";
    const message = row.message || {};
    const reply = row.reply || {};
    return {
      title: `${moduleName}${action}`,
      meta: row.repliedAt || row.sentAt || row.savedAt || "",
      body: [
        `traceId: ${row.traceId || row.feedbackId || "-"}`,
        `提问人: ${senderLabel(row.sender)}`,
        `问题: ${shortDiagnosticText(message.text || "")}`,
        `回复: ${shortDiagnosticText(reply.text || "")}`
      ].join("\n")
    };
  }, "还没有机器人回复诊断记录。");

  renderDiagnosticList("robotDiagnosticsFeedbackList", feedbackEvents, (row) => {
    const feedback = row.feedback || {};
    const label = feedback.label || feedback.eventKey || row.kind || "反馈事件";
    return {
      title: label,
      meta: row.receivedAt || row.savedAt || "",
      body: [
        `类型: ${row.kind || "-"}`,
        `traceId: ${row.traceId || row.feedbackId || row.taskId || "-"}`,
        `反馈人: ${senderLabel(row.sender)}`,
        `事件值: ${feedback.type || feedback.eventKey || "-"}`
      ].join("\n")
    };
  }, "还没有赞踩或自定义反馈事件。");
}

async function updateRobotDiagnosticIssueStatus(issueId, status) {
  await requestJson("/api/robot-diagnostics/issues/status", {
    method: "POST",
    body: JSON.stringify({ issueId, status })
  });
  await loadRobotDiagnostics();
}

function renderSettings(settings) {
  state.settings = settings;

  const basic = settings.basic || {};
  const server = basic.server || {};
  const runtime = basic.runtime || {};
  $("serverHostInput").value = server.host || "127.0.0.1";
  $("serverPortInput").value = server.port || 39200;
  $("runtimeNameInput").value = runtime.name || "";
  $("logLevelInput").value = runtime.logLevel || "info";

  const robot = settings.robot || {};
  $("robotEnabledInput").checked = Boolean(robot.enabled);
  $("welcomeTextInput").value = robot.welcomeText || "";
  $("robotFeedbackCardModeInput").value = robot.feedbackCard && robot.feedbackCard.mode
    ? robot.feedbackCard.mode
    : "private_only";
  $("robotFeedbackCardCooldownInput").value = robot.feedbackCard && robot.feedbackCard.cooldownMinutes !== undefined
    ? robot.feedbackCard.cooldownMinutes
    : 10;
  $("botIdInput").value = robot.botId || "";
  $("botSecretInput").value = robot.secret || "";
  const outboundTest = robot.outboundTest || {};
  $("robotOutboundTargetTypeInput").value = outboundTest.targetType || "user";
  $("robotOutboundTargetIdInput").value = outboundTest.targetId || "";
  $("robotOutboundMessageInput").value = outboundTest.message || "EA系统主动推送测试。";
  const robotConfigured = robot.botIdConfigured && robot.secretConfigured;
  $("robotConfigBadge").classList.toggle("error", !robotConfigured);
  $("robotConfigBadge").textContent = robotConfigured ? "已配置" : "未完整";

  const rank = settings.rank || {};
  const monitor = rank.monitor || {};
  $("rankEnabledInput").checked = Boolean(rank.enabled);
  $("rankPathInput").value = rank.path || "src/modules/rank/embedded-wx-mini-rank-monitor";
  $("rankMonitorEnabledInput").checked = Boolean(monitor.enabled);
  $("rankMonitorIntervalInput").value = monitor.intervalMinutes || 60;

  renderDevProgressSettings(settings.devProgress || {});
  renderDemandWorkflowRulesSettings(settings.demandWorkflowRules || {});
  renderBugCollectionSettings(settings.bugCollection || {});

  const notification = settings.notification || {};
  const appMessage = notification.appMessage || {};
  $("notificationEnabledInput").checked = Boolean(notification.enabled);
  $("notificationDefaultTargetInput").value = notification.defaultTarget || "group";
  $("groupWebhookInput").value = notification.groupWebhook || "";
  $("appCorpIdInput").value = appMessage.corpId || "";
  $("appAgentIdInput").value = appMessage.agentId || "";
  $("appSecretInput").value = appMessage.secret || "";
  $("appToUserInput").value = appMessage.toUser || "";

  const ai = settings.ai || {};
  renderAiProviderOptions(ai);
  $("aiEnabledInput").checked = Boolean(ai.enabled);
  $("aiProviderInput").value = ai.provider || "deepseek";
  $("aiBaseUrlInput").value = ai.baseUrl || "https://api.deepseek.com";
  $("aiModelInput").value = ai.model || "deepseek-v4-flash";
  $("aiApiKeyInput").value = ai.apiKey || "";
  updateAiKeyState();
}

function renderDevProgressSettings(devProgress) {
  const auth = devProgress.auth || {};
  const monitor = devProgress.monitor || {};
  const fields = devProgress.fieldMapping || {};
  const rules = devProgress.rules || {};
  const staleRule = rules.stale || {};
  const remainingRule = rules.remainingNearDeadline || {};
  const missingOwnerRule = rules.missingOwner || {};
  const requiredFieldsRule = rules.requiredFields || {};
  const ready = Boolean(devProgress.ready);

  $("devProgressEnabledInput").checked = Boolean(devProgress.enabled);
  $("devProgressDocUrlInput").value = devProgress.docUrl || "";
  $("devProgressDocIdInput").value = devProgress.docid || "";
  $("devProgressSheetIdInput").value = devProgress.sheetId || "";
  $("devProgressViewIdInput").value = devProgress.viewId || "";
  $("devProgressKeyTypeInput").value = devProgress.keyType || "CELL_VALUE_KEY_TYPE_FIELD_TITLE";
  $("devProgressCorpIdInput").value = auth.corpId || "";
  $("devProgressAgentIdInput").value = auth.agentId || "";
  $("devProgressSecretInput").value = auth.secret || "";
  $("devProgressLimitInput").value = devProgress.limit || 100;
  $("devProgressMonitorEnabledInput").checked = Boolean(monitor.enabled);
  $("devProgressMonitorIntervalInput").value = monitor.intervalMinutes || 10;
  $("devProgressNotifyInput").checked = monitor.notifyThroughCenter !== false;
  $("devProgressCacheMinutesInput").value = devProgress.cacheMinutes || 5;
  $("devProgressDemandIdFieldInput").value = fields.demandId || "";
  $("devProgressProjectFieldInput").value = fields.project || "";
  $("devProgressDemandFieldInput").value = fields.demand || "";
  $("devProgressDemandContentFieldInput").value = fields.demandContent || "";
  $("devProgressDemandTypeFieldInput").value = fields.demandType || "";
  $("devProgressOwnerFieldInput").value = fields.owner || "";
  $("devProgressStatusFieldInput").value = fields.status || "";
  $("devProgressProgressFieldInput").value = fields.progress || "";
  $("devProgressPlanDateFieldInput").value = fields.planDate || "";
  $("devProgressBlockersFieldInput").value = fields.blockers || "";
  $("devProgressUpdatedAtFieldInput").value = fields.updatedAt || "";
  $("devProgressRemarksFieldInput").value = fields.remarks || "";
  $("devProgressFrontendOwnerFieldInput").value = fields.frontendOwner || "";
  $("devProgressBackendOwnerFieldInput").value = fields.backendOwner || "";
  $("devProgressFrontendRemainingFieldInput").value = fields.frontendRemaining || "";
  $("devProgressBackendRemainingFieldInput").value = fields.backendRemaining || "";
  $("devProgressUiOwnerFieldInput").value = fields.uiOwner || "";
  $("devProgressPlannerOwnerFieldInput").value = fields.plannerOwner || "";
  $("devProgressTesterOwnerFieldInput").value = fields.testerOwner || "";
  $("devProgressFrontendLeadFieldInput").value = fields.frontendLead || "";
  $("devProgressBackendLeadFieldInput").value = fields.backendLead || "";
  $("devProgressDevDeadlineFieldInput").value = fields.devDeadline || "";
  $("devProgressTestDeadlineFieldInput").value = fields.testDeadline || "";
  $("devProgressAcceptanceDeadlineFieldInput").value = fields.acceptanceDeadline || "";
  $("devProgressReleaseDateFieldInput").value = fields.releaseDate || "";
  $("devProgressGroupChatFieldInput").value = fields.groupChat || "";
  $("devProgressDemandLinkFieldInput").value = fields.demandLink || "";
  $("devProgressPersonAliasesInput").value = personAliasesToText(devProgress.personAliases);
  $("devProgressRuleScanLimitInput").value = rules.scanLimit || 2000;
  $("devProgressScanStartDateInput").value = rules.scanStartDate || "";
  $("devProgressExcludedProjectsInput").value = listToText(rules.excludedProjects);
  $("devProgressCompletedKeywordsInput").value = listToText(rules.completedStatusKeywords);
  $("devProgressIgnoredKeywordsInput").value = listToText(rules.ignoredStatusKeywords);
  const pushConfig = monitor.requiredFieldsPush || {};
  $("devProgressRequiredFieldsPushEnabledInput").checked = pushConfig.enabled !== false;
  $("devProgressRequiredFieldsPushTestModeInput").checked = false;
  $("devProgressRequiredFieldsPushTestTargetInput").value = "";
  const pushTargetText = pushConfig.enabled === false
    ? "自动推送已关闭，扫描不推送"
    : "扫描并推送必填项缺失";
  $("devProgressScanAnomaliesBtn").textContent = "仅扫描异常任务（不推送）";
  $("devProgressPushRequiredFieldsBtn").textContent = pushTargetText;
  $("devProgressRuleOverdueInput").checked = !(rules.overdue && rules.overdue.enabled === false);
  $("devProgressRuleStaleInput").checked = Boolean(staleRule.enabled);
  $("devProgressRuleStaleDaysInput").value = staleRule.days || 3;
  $("devProgressRuleRemainingInput").checked = !(remainingRule.enabled === false);
  $("devProgressRuleRemainingDaysInput").value = remainingRule.days || 2;
  $("devProgressRuleRemainingMinimumInput").value = remainingRule.minimum || 0;
  $("devProgressRuleMissingOwnerInput").checked = Boolean(missingOwnerRule.enabled);
  $("devProgressRequiredOwnerRolesInput").value = listToText(missingOwnerRule.requiredRoles);
  $("devProgressRuleRequiredFieldsInput").checked = Boolean(requiredFieldsRule.enabled);
  $("devProgressRequiredFieldsRulesInput").value = JSON.stringify(
    requiredFieldsRule.ruleFile
      ? { ruleFile: requiredFieldsRule.ruleFile }
      : {
        cumulative: requiredFieldsRule.cumulative !== false,
        items: Array.isArray(requiredFieldsRule.items) ? requiredFieldsRule.items : []
      },
    null,
    2
  );

  $("devProgressConfigBadge").classList.toggle("error", !ready);
  $("devProgressConfigBadge").textContent = ready ? "可测试" : "未完整";
  $("devProgressCorpIdInput").placeholder = auth.corpIdConfigured ? "已配置" : "请输入企业 ID";
  $("devProgressAgentIdInput").placeholder = auth.agentIdConfigured ? "已配置" : "请输入 AgentId";
  $("devProgressSecretInput").placeholder = auth.secretConfigured ? "已配置" : "请输入应用 Secret";
}

function renderDemandWorkflowRulesSettings(demandWorkflowRules) {
  const summary = demandWorkflowRules.summary || {};
  const rawText = demandWorkflowRules.rawText || JSON.stringify(demandWorkflowRules.rules || {}, null, 2);
  const warningCount = Number(summary.warningCount || 0);

  $("demandWorkflowRulesJsonInput").value = rawText;
  $("demandWorkflowRulesVersionBadge").textContent = summary.version ? `v${summary.version}` : "v-";
  $("demandWorkflowRulesStatusBadge").classList.toggle("error", warningCount > 0);
  $("demandWorkflowRulesStatusBadge").textContent = warningCount > 0 ? `${warningCount} 个警告` : "可保存";
  $("demandWorkflowRulesSummaryBox").textContent = JSON.stringify(summary, null, 2);
}

function renderBugCollectionSettings(bugCollection) {
  const ready = Boolean(bugCollection.ready);
  const createDoc = bugCollection.createDoc || {};
  $("bugCollectionEnabledInput").checked = Boolean(bugCollection.enabled);
  $("bugCollectionDocUrlInput").value = bugCollection.docUrl || "";
  $("bugCollectionDocIdInput").value = bugCollection.docid || "";
  $("bugCollectionDocLinkIdInput").value = bugCollection.docLinkId || "";
  $("bugCollectionSheetIdInput").value = bugCollection.sheetId || "";
  $("bugCollectionViewIdInput").value = bugCollection.viewId || "";
  $("bugCollectionKeyTypeInput").value = bugCollection.keyType || "CELL_VALUE_KEY_TYPE_FIELD_TITLE";
  $("bugCollectionCreateDocNameInput").value = createDoc.docName || "EA需求和Bug收集";
  $("bugCollectionCreateSpaceIdInput").value = createDoc.spaceId || "";
  $("bugCollectionCreateFatherIdInput").value = createDoc.fatherId || "";
  $("bugCollectionCreateAdminUsersInput").value = Array.isArray(createDoc.adminUsers) ? createDoc.adminUsers.join("\n") : "";
  $("bugCollectionCreateShareInput").checked = createDoc.shareAfterCreate !== false;
  $("bugCollectionConfigBadge").classList.toggle("error", !ready);
  $("bugCollectionConfigBadge").textContent = ready ? "已配置" : "未配置";
}

function renderAiProviderOptions(ai) {
  const select = $("aiProviderInput");
  select.innerHTML = "";
  const providers = ai.providers || {};
  for (const [key, provider] of Object.entries(providers)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = provider.label || key;
    select.appendChild(option);
  }
}

function updateAiFieldsForProvider() {
  if (!state.settings || !state.settings.ai) {
    return;
  }

  const providerKey = $("aiProviderInput").value;
  const provider = state.settings.ai.providers && state.settings.ai.providers[providerKey];
  if (!provider) {
    return;
  }

  $("aiBaseUrlInput").value = provider.baseUrl || "";
  $("aiModelInput").value = provider.model || "";
  $("aiApiKeyInput").value = provider.apiKey || "";
  updateAiKeyState();
}

function updateAiKeyState() {
  if (!state.settings || !state.settings.ai) {
    return;
  }

  const providerKey = $("aiProviderInput").value;
  const provider = state.settings.ai.providers && state.settings.ai.providers[providerKey];
  const configured = Boolean(provider && provider.apiKeyConfigured);
  $("aiConfigBadge").classList.toggle("error", !configured);
  $("aiConfigBadge").textContent = configured ? "API Key 已配置" : "API Key 未配置";
  $("aiApiKeyInput").placeholder = configured ? "已配置" : "请输入 API Key";
}

function parseSmartSheetUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return {};
  }

  try {
    const url = new URL(text);
    const parts = url.pathname.split("/").filter(Boolean);
    const typeIndex = parts.findIndex((part) => part === "smartsheet" || part === "sheet");
    return {
      docid: typeIndex >= 0 && parts[typeIndex + 1] ? parts[typeIndex + 1] : "",
      sheetId: url.searchParams.get("tab") || "",
      viewId: url.searchParams.get("viewId") || ""
    };
  } catch (error) {
    return {};
  }
}

function applyDevProgressUrlParts() {
  const parts = parseSmartSheetUrl($("devProgressDocUrlInput").value);
  if (parts.sheetId) {
    $("devProgressSheetIdInput").value = parts.sheetId;
  }
  if (parts.viewId) {
    $("devProgressViewIdInput").value = parts.viewId;
  }
}

function applyBugCollectionUrlParts() {
  const parts = parseSmartSheetUrl($("bugCollectionDocUrlInput").value);
  if (parts.docid) {
    $("bugCollectionDocLinkIdInput").value = parts.docid;
  }
  if (parts.sheetId) {
    $("bugCollectionSheetIdInput").value = parts.sheetId;
  }
  if (parts.viewId) {
    $("bugCollectionViewIdInput").value = parts.viewId;
  }
}

function applyDevProgressFieldSuggestions(fieldNames) {
  const available = new Set(Array.isArray(fieldNames) ? fieldNames : []);
  let filled = 0;
  for (const [key, fieldName] of Object.entries(devProgressFieldSuggestions)) {
    const inputId = devProgressFieldInputs[key];
    if (!inputId || !$(inputId) || $(inputId).value.trim() || !available.has(fieldName)) {
      continue;
    }
    $(inputId).value = fieldName;
    filled += 1;
  }
  return filled;
}

async function loadStatus() {
  const status = await requestJson("/api/status");
  renderStatus(status);
}

async function loadSettings() {
  const settings = await requestJson("/api/settings");
  renderSettings(settings);
}

async function loadRobotDiagnostics() {
  const result = await requestJson("/api/robot-diagnostics/recent?limit=50");
  renderRobotDiagnostics(result);
}

async function refreshAll() {
  await Promise.all([loadStatus(), loadSettings(), loadRobotDiagnostics()]);
}

function openSettings() {
  $("dashboardView").classList.add("hidden");
  $("settingsView").classList.remove("hidden");
  switchTab(state.activeTab);
}

function openDashboard() {
  $("settingsView").classList.add("hidden");
  $("dashboardView").classList.remove("hidden");
}

function switchTab(tabName) {
  state.activeTab = tabName;
  for (const button of document.querySelectorAll(".tab-button")) {
    button.classList.toggle("active", button.dataset.tab === tabName);
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    panel.classList.toggle("active", panel.id === `tab-${tabName}`);
  }
}

async function sendTestMessage(event) {
  event.preventDefault();
  const text = $("messageInput").value.trim();
  if (!text) {
    return;
  }

  setText("replyBox", "处理中...");
  try {
    const result = await requestJson("/api/test-message", {
      method: "POST",
      body: JSON.stringify({ text })
    });
    setText("replyBox", result.text || JSON.stringify(result, null, 2));
  } catch (error) {
    setText("replyBox", `失败：${error.message}`);
  }
}

async function runRankOnce() {
  $("runRankBtn").disabled = true;
  setText("replyBox", "正在触发榜单模块扫描...");
  try {
    const result = await requestJson("/api/rank/run-once", {
      method: "POST",
      body: JSON.stringify({})
    });
    setText("replyBox", JSON.stringify(result, null, 2));
    await loadStatus();
  } catch (error) {
    setText("replyBox", `失败：${error.message}`);
  } finally {
    $("runRankBtn").disabled = false;
  }
}

async function saveBasicSettings(event) {
  event.preventDefault();
  setText("basicSaveStatus", "保存中...");
  try {
    const result = await requestJson("/api/settings/basic", {
      method: "POST",
      body: JSON.stringify({
        host: $("serverHostInput").value.trim(),
        port: Number($("serverPortInput").value),
        runtimeName: $("runtimeNameInput").value.trim(),
        logLevel: $("logLevelInput").value
      })
    });
    if (state.settings) {
      state.settings.basic = result.basic;
      renderSettings(state.settings);
    }
    await loadStatus();
    setText("basicSaveStatus", saveMessage(result));
  } catch (error) {
    setText("basicSaveStatus", `失败：${error.message}`);
  }
}

async function saveRobotSettings(event) {
  event.preventDefault();
  setText("robotSaveStatus", "保存中...");
  try {
    const result = await requestJson("/api/settings/robot", {
      method: "POST",
      body: JSON.stringify({
        enabled: $("robotEnabledInput").checked,
        botId: $("botIdInput").value.trim(),
        secret: $("botSecretInput").value.trim(),
        welcomeText: $("welcomeTextInput").value.trim(),
        feedbackCardMode: $("robotFeedbackCardModeInput").value,
        feedbackCardCooldownMinutes: Number($("robotFeedbackCardCooldownInput").value),
        outboundTargetType: $("robotOutboundTargetTypeInput").value,
        outboundTargetId: $("robotOutboundTargetIdInput").value.trim(),
        outboundMessage: $("robotOutboundMessageInput").value.trim()
      })
    });
    if (state.settings) {
      state.settings.robot = result.robot;
      renderSettings(state.settings);
    }
    await loadStatus();
    setText("robotSaveStatus", "已保存并应用");
  } catch (error) {
    setText("robotSaveStatus", `失败：${error.message}`);
  }
}

async function testRobotPush() {
  $("robotPushTestBtn").disabled = true;
  setText("robotPushTestStatus", "发送中...");
  setText("robotPushTestResult", "发送中...");
  try {
    const result = await requestJson("/api/robot/test-push", {
      method: "POST",
      body: JSON.stringify({
        targetType: $("robotOutboundTargetTypeInput").value,
        targetId: $("robotOutboundTargetIdInput").value.trim(),
        message: $("robotOutboundMessageInput").value.trim()
      })
    });
    setText("robotPushTestStatus", result.robotPush && result.robotPush.saved ? "已保存并发送" : "已发送");
    setText("robotPushTestResult", JSON.stringify(result.robotPush, null, 2));
  } catch (error) {
    setText("robotPushTestStatus", `失败：${error.message}`);
    setText("robotPushTestResult", `失败：${error.message}`);
  } finally {
    $("robotPushTestBtn").disabled = false;
  }
}

async function testRobotFeedbackCard() {
  $("robotFeedbackCardTestBtn").disabled = true;
  setText("robotPushTestStatus", "发送卡片中...");
  setText("robotPushTestResult", "发送卡片中...");
  try {
    const result = await requestJson("/api/robot/test-feedback-card", {
      method: "POST",
      body: JSON.stringify({
        targetType: $("robotOutboundTargetTypeInput").value,
        targetId: $("robotOutboundTargetIdInput").value.trim(),
        message: $("robotOutboundMessageInput").value.trim()
      })
    });
    setText("robotPushTestStatus", "自定义反馈卡片已发送");
    setText("robotPushTestResult", JSON.stringify(result.robotFeedbackCard, null, 2));
    await loadStatus();
    await loadRobotDiagnostics();
  } catch (error) {
    setText("robotPushTestStatus", `失败：${error.message}`);
    setText("robotPushTestResult", `失败：${error.message}`);
  } finally {
    $("robotFeedbackCardTestBtn").disabled = false;
  }
}

async function saveRankSettings(event) {
  event.preventDefault();
  setText("rankSaveStatus", "保存中...");
  try {
    const result = await requestJson("/api/settings/rank", {
      method: "POST",
      body: JSON.stringify({
        enabled: $("rankEnabledInput").checked,
        path: $("rankPathInput").value.trim(),
        monitorEnabled: $("rankMonitorEnabledInput").checked,
        intervalMinutes: Number($("rankMonitorIntervalInput").value)
      })
    });
    if (state.settings) {
      state.settings.rank = result.rank;
      renderSettings(state.settings);
    }
    setText("rankSaveStatus", saveMessage(result));
  } catch (error) {
    setText("rankSaveStatus", `失败：${error.message}`);
  }
}

async function saveDevProgressSettings(event) {
  event.preventDefault();
  applyDevProgressUrlParts();
  setText("devProgressSaveStatus", "保存中...");
  try {
    const result = await requestJson("/api/settings/dev-progress", {
      method: "POST",
      body: JSON.stringify({
        enabled: $("devProgressEnabledInput").checked,
        docUrl: $("devProgressDocUrlInput").value.trim(),
        docid: $("devProgressDocIdInput").value.trim(),
        sheetId: $("devProgressSheetIdInput").value.trim(),
        viewId: $("devProgressViewIdInput").value.trim(),
        keyType: $("devProgressKeyTypeInput").value,
        corpId: $("devProgressCorpIdInput").value.trim(),
        agentId: $("devProgressAgentIdInput").value.trim(),
        secret: $("devProgressSecretInput").value.trim(),
        limit: Number($("devProgressLimitInput").value),
        monitorEnabled: $("devProgressMonitorEnabledInput").checked,
        monitorIntervalMinutes: Number($("devProgressMonitorIntervalInput").value),
        notifyThroughCenter: $("devProgressNotifyInput").checked,
        cacheMinutes: Number($("devProgressCacheMinutesInput").value),
        demandIdField: $("devProgressDemandIdFieldInput").value.trim(),
        projectField: $("devProgressProjectFieldInput").value.trim(),
        demandField: $("devProgressDemandFieldInput").value.trim(),
        demandContentField: $("devProgressDemandContentFieldInput").value.trim(),
        demandTypeField: $("devProgressDemandTypeFieldInput").value.trim(),
        ownerField: $("devProgressOwnerFieldInput").value.trim(),
        statusField: $("devProgressStatusFieldInput").value.trim(),
        progressField: $("devProgressProgressFieldInput").value.trim(),
        planDateField: $("devProgressPlanDateFieldInput").value.trim(),
        blockersField: $("devProgressBlockersFieldInput").value.trim(),
        updatedAtField: $("devProgressUpdatedAtFieldInput").value.trim(),
        remarksField: $("devProgressRemarksFieldInput").value.trim(),
        frontendOwnerField: $("devProgressFrontendOwnerFieldInput").value.trim(),
        backendOwnerField: $("devProgressBackendOwnerFieldInput").value.trim(),
        frontendRemainingField: $("devProgressFrontendRemainingFieldInput").value.trim(),
        backendRemainingField: $("devProgressBackendRemainingFieldInput").value.trim(),
        uiOwnerField: $("devProgressUiOwnerFieldInput").value.trim(),
        plannerOwnerField: $("devProgressPlannerOwnerFieldInput").value.trim(),
        testerOwnerField: $("devProgressTesterOwnerFieldInput").value.trim(),
        frontendLeadField: $("devProgressFrontendLeadFieldInput").value.trim(),
        backendLeadField: $("devProgressBackendLeadFieldInput").value.trim(),
        devDeadlineField: $("devProgressDevDeadlineFieldInput").value.trim(),
        testDeadlineField: $("devProgressTestDeadlineFieldInput").value.trim(),
        acceptanceDeadlineField: $("devProgressAcceptanceDeadlineFieldInput").value.trim(),
        releaseDateField: $("devProgressReleaseDateFieldInput").value.trim(),
        groupChatField: $("devProgressGroupChatFieldInput").value.trim(),
        demandLinkField: $("devProgressDemandLinkFieldInput").value.trim(),
        personAliasesText: $("devProgressPersonAliasesInput").value,
        ruleScanLimit: Number($("devProgressRuleScanLimitInput").value),
        ruleScanStartDate: $("devProgressScanStartDateInput").value.trim(),
        excludedProjectsText: $("devProgressExcludedProjectsInput").value,
        completedStatusKeywordsText: $("devProgressCompletedKeywordsInput").value,
        ignoredStatusKeywordsText: $("devProgressIgnoredKeywordsInput").value,
        ruleOverdueEnabled: $("devProgressRuleOverdueInput").checked,
        ruleStaleEnabled: $("devProgressRuleStaleInput").checked,
        ruleStaleDays: Number($("devProgressRuleStaleDaysInput").value),
        ruleRemainingEnabled: $("devProgressRuleRemainingInput").checked,
        ruleRemainingDays: Number($("devProgressRuleRemainingDaysInput").value),
        ruleRemainingMinimum: Number($("devProgressRuleRemainingMinimumInput").value),
        ruleMissingOwnerEnabled: $("devProgressRuleMissingOwnerInput").checked,
        requiredOwnerRolesText: $("devProgressRequiredOwnerRolesInput").value,
        ruleRequiredFieldsEnabled: $("devProgressRuleRequiredFieldsInput").checked,
        requiredFieldsRulesText: $("devProgressRequiredFieldsRulesInput").value,
        requiredFieldsPushEnabled: $("devProgressRequiredFieldsPushEnabledInput").checked,
        requiredFieldsPushScanLimit: Number($("devProgressRuleScanLimitInput").value),
        requiredFieldsPushTestMode: false,
        requiredFieldsPushTestTargetName: ""
      })
    });
    if (state.settings) {
      state.settings.devProgress = result.devProgress;
      renderSettings(state.settings);
    }
    await loadStatus();
    setText("devProgressSaveStatus", saveMessage(result));
  } catch (error) {
    setText("devProgressSaveStatus", `失败：${error.message}`);
  }
}

async function testDevProgressConnection() {
  $("devProgressTestBtn").disabled = true;
  setText("devProgressTestResult", "测试中...");
  try {
    const result = await requestJson("/api/dev-progress/test-connection", {
      method: "POST",
      body: JSON.stringify({})
    });
    setText("devProgressTestResult", JSON.stringify(result.devProgress, null, 2));
    const fieldNames = result.devProgress &&
      result.devProgress.smartsheet &&
      result.devProgress.smartsheet.fields
      ? result.devProgress.smartsheet.fields.fieldNames
      : [];
    const filled = applyDevProgressFieldSuggestions(fieldNames);
    if (filled > 0) {
      setText("devProgressSaveStatus", `已自动补齐 ${filled} 个字段映射，请保存开发进度配置`);
    }
  } catch (error) {
    setText("devProgressTestResult", `失败：${error.message}`);
  } finally {
    $("devProgressTestBtn").disabled = false;
  }
}

async function previewDevProgressRecords() {
  $("devProgressPreviewBtn").disabled = true;
  setText("devProgressPreviewResult", "读取中...");
  try {
    const result = await requestJson("/api/dev-progress/preview-records", {
      method: "POST",
      body: JSON.stringify({ limit: 5 })
    });
    setText("devProgressPreviewResult", JSON.stringify(result.devProgress, null, 2));
  } catch (error) {
    setText("devProgressPreviewResult", `失败：${error.message}`);
  } finally {
    $("devProgressPreviewBtn").disabled = false;
  }
}

async function scanDevProgressAnomalies() {
  $("devProgressScanAnomaliesBtn").disabled = true;
  setText("devProgressAnomalyResult", "仅扫描中，不会推送消息...");
  try {
    const result = await requestJson("/api/dev-progress/scan-anomalies", {
      method: "POST",
      body: JSON.stringify({ limit: Number($("devProgressRuleScanLimitInput").value) || 2000 })
    });
    setText("devProgressAnomalyResult", JSON.stringify(result.devProgress, null, 2));
  } catch (error) {
    setText("devProgressAnomalyResult", `失败：${error.message}`);
  } finally {
    $("devProgressScanAnomaliesBtn").disabled = false;
  }
}

async function pushDevProgressRequiredFields() {
  $("devProgressPushRequiredFieldsBtn").disabled = true;
  const pushText = $("devProgressPushRequiredFieldsBtn").textContent || "扫描并推送必填项缺失";
  setText("devProgressAnomalyResult", `正在${pushText}...`);
  try {
    const result = await requestJson("/api/dev-progress/push-required-fields", {
      method: "POST",
      body: JSON.stringify({ limit: Number($("devProgressRuleScanLimitInput").value) || 2000 })
    });
    setText("devProgressAnomalyResult", JSON.stringify(result.devProgress, null, 2));
  } catch (error) {
    setText("devProgressAnomalyResult", `失败：${error.message}`);
  } finally {
    $("devProgressPushRequiredFieldsBtn").disabled = false;
  }
}

async function saveDemandWorkflowRulesSettings(event) {
  event.preventDefault();
  setText("demandWorkflowRulesSaveStatus", "保存中...");
  try {
    const rulesText = $("demandWorkflowRulesJsonInput").value.trim();
    JSON.parse(rulesText);
    const result = await requestJson("/api/settings/demand-workflow-rules", {
      method: "POST",
      body: JSON.stringify({ rulesText })
    });
    if (state.settings) {
      state.settings.demandWorkflowRules = result.demandWorkflowRules;
      renderSettings(state.settings);
    }
    await loadStatus();
    setText("demandWorkflowRulesSaveStatus", saveMessage(result));
  } catch (error) {
    setText("demandWorkflowRulesSaveStatus", `失败：${error.message}`);
  }
}

async function saveBugCollectionSettings(event) {
  event.preventDefault();
  applyBugCollectionUrlParts();
  setText("bugCollectionSaveStatus", "保存中...");
  try {
    const result = await requestJson("/api/settings/bug-collection", {
      method: "POST",
      body: JSON.stringify(bugCollectionPayload())
    });
    if (state.settings) {
      state.settings.bugCollection = result.bugCollection;
      renderSettings(state.settings);
    }
    await loadStatus();
    setText("bugCollectionSaveStatus", saveMessage(result));
  } catch (error) {
    setText("bugCollectionSaveStatus", `失败：${error.message}`);
  }
}

function bugCollectionPayload() {
  return {
    enabled: $("bugCollectionEnabledInput").checked,
    docUrl: $("bugCollectionDocUrlInput").value.trim(),
    docid: $("bugCollectionDocIdInput").value.trim(),
    docLinkId: $("bugCollectionDocLinkIdInput").value.trim(),
    sheetId: $("bugCollectionSheetIdInput").value.trim(),
    viewId: $("bugCollectionViewIdInput").value.trim(),
    keyType: $("bugCollectionKeyTypeInput").value,
    createDocName: $("bugCollectionCreateDocNameInput").value.trim(),
    createDocSpaceId: $("bugCollectionCreateSpaceIdInput").value.trim(),
    createDocFatherId: $("bugCollectionCreateFatherIdInput").value.trim(),
    createDocAdminUsersText: $("bugCollectionCreateAdminUsersInput").value,
    createDocShareAfterCreate: $("bugCollectionCreateShareInput").checked
  };
}

async function createBugCollectionDoc() {
  applyBugCollectionUrlParts();
  $("bugCollectionCreateDocBtn").disabled = true;
  $("bugCollectionSetupTestBtn").disabled = true;
  setText("bugCollectionSaveStatus", "创建中...");
  setText("bugCollectionTestResult", "创建中...");
  try {
    const createResult = await requestJson("/api/bug-collection/create-doc", {
      method: "POST",
      body: JSON.stringify(bugCollectionPayload())
    });
    if (state.settings) {
      state.settings.bugCollection = createResult.bugCollection;
      renderSettings(state.settings);
    }
    await loadStatus();
    setText("bugCollectionSaveStatus", "智能表格已创建，正在初始化...");
    const setupResult = await requestJson("/api/bug-collection/setup-test", {
      method: "POST",
      body: JSON.stringify({})
    });
    setText("bugCollectionSaveStatus", "智能表格已创建，字段和测试记录已写入");
    setText("bugCollectionTestResult", JSON.stringify({
      create: {
        status: createResult.bugCollectionCreate.status,
        docidConfigured: Boolean(createResult.bugCollection && createResult.bugCollection.docid),
        sheetId: createResult.bugCollection && createResult.bugCollection.sheetId,
        shareUrlCreated: Boolean(createResult.bugCollectionCreate.share && createResult.bugCollectionCreate.share.shareUrlCreated),
        sheetCount: createResult.bugCollectionCreate.sheets && Array.isArray(createResult.bugCollectionCreate.sheets.sheetList)
          ? createResult.bugCollectionCreate.sheets.sheetList.length
          : 0
      },
      setup: setupResult.bugCollection
    }, null, 2));
  } catch (error) {
    setText("bugCollectionSaveStatus", `失败：${error.message}`);
    setText("bugCollectionTestResult", `失败：${error.message}`);
  } finally {
    $("bugCollectionCreateDocBtn").disabled = false;
    $("bugCollectionSetupTestBtn").disabled = false;
  }
}

async function setupBugCollectionTest() {
  $("bugCollectionSetupTestBtn").disabled = true;
  setText("bugCollectionSaveStatus", "测试中...");
  setText("bugCollectionTestResult", "测试中...");
  try {
    const result = await requestJson("/api/bug-collection/setup-test", {
      method: "POST",
      body: JSON.stringify({})
    });
    setText("bugCollectionSaveStatus", "字段和测试记录已写入");
    setText("bugCollectionTestResult", JSON.stringify(result.bugCollection, null, 2));
  } catch (error) {
    setText("bugCollectionSaveStatus", `失败：${error.message}`);
    setText("bugCollectionTestResult", `失败：${error.message}`);
  } finally {
    $("bugCollectionSetupTestBtn").disabled = false;
  }
}

async function cleanupBugCollectionFields() {
  $("bugCollectionCleanupFieldsBtn").disabled = true;
  setText("bugCollectionSaveStatus", "清理中...");
  setText("bugCollectionTestResult", "清理中...");
  try {
    const result = await requestJson("/api/bug-collection/cleanup-fields", {
      method: "POST",
      body: JSON.stringify({})
    });
    setText("bugCollectionSaveStatus", "多余列已删除");
    setText("bugCollectionTestResult", JSON.stringify(result.bugCollection, null, 2));
  } catch (error) {
    setText("bugCollectionSaveStatus", `失败：${error.message}`);
    setText("bugCollectionTestResult", `失败：${error.message}`);
  } finally {
    $("bugCollectionCleanupFieldsBtn").disabled = false;
  }
}

async function migrateBugCollectionTaskIds() {
  $("bugCollectionMigrateTaskIdsBtn").disabled = true;
  setText("bugCollectionSaveStatus", "补齐任务ID中...");
  setText("bugCollectionTestResult", "补齐任务ID中...");
  try {
    const result = await requestJson("/api/bug-collection/migrate-task-ids", {
      method: "POST",
      body: JSON.stringify({})
    });
    setText("bugCollectionSaveStatus", `任务ID已补齐：更新 ${result.bugCollection.updatedCount || 0} 条`);
    setText("bugCollectionTestResult", JSON.stringify(result.bugCollection, null, 2));
  } catch (error) {
    setText("bugCollectionSaveStatus", `失败：${error.message}`);
    setText("bugCollectionTestResult", `失败：${error.message}`);
  } finally {
    $("bugCollectionMigrateTaskIdsBtn").disabled = false;
  }
}

async function saveNotificationSettings(event) {
  event.preventDefault();
  setText("notificationSaveStatus", "保存中...");
  try {
    const result = await requestJson("/api/settings/notification", {
      method: "POST",
      body: JSON.stringify({
        enabled: $("notificationEnabledInput").checked,
        defaultTarget: $("notificationDefaultTargetInput").value,
        groupWebhook: $("groupWebhookInput").value.trim(),
        corpId: $("appCorpIdInput").value.trim(),
        agentId: $("appAgentIdInput").value.trim(),
        secret: $("appSecretInput").value.trim(),
        toUser: $("appToUserInput").value.trim()
      })
    });
    if (state.settings) {
      state.settings.notification = result.notification;
      renderSettings(state.settings);
    }
    await loadStatus();
    setText("notificationSaveStatus", saveMessage(result));
  } catch (error) {
    setText("notificationSaveStatus", `失败：${error.message}`);
  }
}

async function saveAiSettings(event) {
  event.preventDefault();
  setText("aiSaveStatus", "保存中...");
  try {
    const result = await requestJson("/api/settings/ai", {
      method: "POST",
      body: JSON.stringify({
        enabled: $("aiEnabledInput").checked,
        provider: $("aiProviderInput").value,
        baseUrl: $("aiBaseUrlInput").value.trim(),
        model: $("aiModelInput").value.trim(),
        apiKey: $("aiApiKeyInput").value.trim()
      })
    });
    if (state.settings) {
      state.settings.ai = result.ai;
      renderSettings(state.settings);
    }
    await loadStatus();
    setText("aiSaveStatus", saveMessage(result));
  } catch (error) {
    setText("aiSaveStatus", `失败：${error.message}`);
  }
}

function parseDesktopTipMinutes(text) {
  return parseListInput(text)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function desktopTipLocalToIso(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function desktopTipConfigPayload() {
  let recipientGroups = {};
  const groupText = $("desktopTipGroupsInput").value.trim();
  if (groupText) {
    recipientGroups = JSON.parse(groupText);
  }
  return {
    enabled: $("desktopTipPmEnabledInput").checked,
    messageAdmins: parseListInput($("desktopTipAdminsInput").value),
    authorizedSenders: parseListInput($("desktopTipSendersInput").value),
    recipientUsers: parseListInput($("desktopTipRecipientsInput").value),
    recipientGroups,
    defaultRecipientGroupId: $("desktopTipDefaultGroupInput").value.trim(),
    countdownMinutes: parseDesktopTipMinutes($("desktopTipCountdownInput").value),
    deliveryChannels: ["desktop_tip"]
  };
}

function renderDesktopTipIdentity(identity) {
  state.desktopTipIdentity = identity || null;
  if (identity && identity.userId) {
    $("desktopTipIdentityInput").value = `${identity.name || identity.userId}（${identity.userId}）`;
    $("desktopTipLoginBtn").classList.add("hidden");
    return;
  }
  state.desktopTipManualCanSend = false;
  $("desktopTipIdentityInput").value = "未登录";
  $("desktopTipRoleBadge").textContent = "未登录";
  $("desktopTipRoleBadge").classList.add("error");
  $("desktopTipLoginBtn").classList.remove("hidden");
  updateDesktopTipManualMessageControls(state.desktopTipRegisteredClientCount, false);
}

async function loadDesktopTipIdentity() {
  try {
    const result = await requestJson("/api/dev-progress/h5-session");
    renderDesktopTipIdentity(result.identity || null);
    return result.identity || null;
  } catch (error) {
    renderDesktopTipIdentity(null);
    setText("desktopTipStatusText", "请先使用企业微信扫码登录，再读取 EA 桌面提醒配置");
    return null;
  }
}

async function ensureDesktopTipIdentity() {
  if (state.desktopTipIdentity && state.desktopTipIdentity.userId) {
    return state.desktopTipIdentity;
  }
  return loadDesktopTipIdentity();
}

async function initializeDesktopTipPanel() {
  const identity = await loadDesktopTipIdentity();
  if (!identity) {
    return null;
  }
  try {
    await loadDesktopTipMaintenance({ identity });
  } catch (error) {
    state.desktopTipManualCanSend = false;
    updateDesktopTipManualMessageControls(state.desktopTipRegisteredClientCount, false);
    setText("desktopTipStatusText", `EA 桌面提醒配置读取失败：${error.message}`);
    setText("desktopTipManualStatus", `配置读取失败：${error.message}`);
  }
  return identity;
}

function openDesktopTipLogin() {
  window.location.href = "/demand-login.html?returnTo=/";
}

function setDesktopTipConfigEditable(canManage) {
  [
    "desktopTipPmEnabledInput",
    "desktopTipAdminsInput",
    "desktopTipSendersInput",
    "desktopTipRecipientsInput",
    "desktopTipGroupsInput",
    "desktopTipDefaultGroupInput",
    "desktopTipCountdownInput"
  ].forEach((id) => {
    if ($(id)) {
      $(id).disabled = !canManage;
    }
  });
  const saveButton = document.querySelector("#desktopTipConfigForm button[type='submit']");
  if (saveButton) {
    saveButton.disabled = !canManage;
  }
}

function desktopTipRegisteredStatus(payload) {
  return payload && payload.registeredReceivers ? payload.registeredReceivers : {};
}

function resolveDesktopTipRegisteredClientCount(payload, fallback) {
  const candidates = [
    payload && payload.registeredReceivers && payload.registeredReceivers.registeredClientCount,
    payload && payload.clientRegistry && payload.clientRegistry.registeredClientCount,
    payload && payload.productionMaintenance
      && payload.productionMaintenance.registeredReceivers
      && payload.productionMaintenance.registeredReceivers.registeredClientCount,
    payload && payload.modules
      && payload.modules.desktopTip
      && payload.modules.desktopTip.clientRegistry
      && payload.modules.desktopTip.clientRegistry.registeredClientCount,
    payload && payload.modules
      && payload.modules.desktopTip
      && payload.modules.desktopTip.productionMaintenance
      && payload.modules.desktopTip.productionMaintenance.registeredReceivers
      && payload.modules.desktopTip.productionMaintenance.registeredReceivers.registeredClientCount
  ];
  for (const value of candidates) {
    if (value === 0 || value) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) {
        return Math.floor(number);
      }
    }
  }
  const fallbackNumber = Number(fallback || 0);
  return Number.isFinite(fallbackNumber) && fallbackNumber >= 0 ? Math.floor(fallbackNumber) : 0;
}

function updateDesktopTipManualMessageControls(registeredClientCount, canSend) {
  state.desktopTipRegisteredClientCount = Number(registeredClientCount || 0);
  const scopeText = `全部已登记客户端（${state.desktopTipRegisteredClientCount}台）`;
  if ($("desktopTipManualScopeBadge")) {
    $("desktopTipManualScopeBadge").textContent = scopeText;
    $("desktopTipManualScopeBadge").classList.toggle("error", state.desktopTipRegisteredClientCount <= 0);
  }
  if ($("desktopTipManualScopeInput")) {
    $("desktopTipManualScopeInput").value = scopeText;
  }
  if ($("desktopTipManualSubmitBtn")) {
    $("desktopTipManualSubmitBtn").disabled = state.desktopTipManualSending || !canSend || state.desktopTipRegisteredClientCount <= 0;
  }
  updateDesktopTipManualWecomControls(canSend);
  if ($("desktopTipManualStatus")) {
    if (!canSend) {
      setText("desktopTipManualStatus", "请先使用企业微信扫码登录后再发送普通桌面消息");
    } else if (state.desktopTipRegisteredClientCount <= 0) {
      setText("desktopTipManualStatus", "当前没有已登记桌面客户端，请先启动 EA 桌面提醒并成功连接一次，无需登录");
    } else {
      setText("desktopTipManualStatus", `可发送到 ${state.desktopTipRegisteredClientCount} 台已登记客户端`);
    }
  }
}

function renderDesktopTipWecomGroups(payload) {
  const registry = payload && payload.wecomGroupRegistry
    ? payload.wecomGroupRegistry
    : (payload && payload.wecomGroups ? payload.wecomGroups : payload);
  const groups = registry && Array.isArray(registry.groups) ? registry.groups : [];
  state.desktopTipWecomGroups = groups;
  const select = $("desktopTipManualWecomGroupSelect");
  if (select) {
    select.innerHTML = groups.map((group) => {
      const groupId = String(group.groupId || "").replace(/"/g, "&quot;");
      const label = String(group.displayName || group.groupId || "未命名群")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<option value="${groupId}">${label}</option>`;
    }).join("");
  }
  updateDesktopTipManualWecomControls(state.desktopTipManualCanSend);
}

function updateDesktopTipManualWecomControls(canSend) {
  const enabledInput = $("desktopTipManualWecomEnabledInput");
  const groupSelect = $("desktopTipManualWecomGroupSelect");
  const mentionModeInput = $("desktopTipManualWecomMentionModeInput");
  const groups = state.desktopTipWecomGroups || [];
  const enabled = Boolean(enabledInput && enabledInput.checked);
  if (enabledInput) {
    enabledInput.disabled = !canSend || groups.length <= 0;
  }
  if (groupSelect) {
    groupSelect.disabled = !canSend || !enabled || groups.length <= 0;
  }
  if (mentionModeInput) {
    mentionModeInput.disabled = !canSend || !enabled || groups.length <= 0;
  }
  if ($("desktopTipManualWecomStatus")) {
    if (groups.length <= 0) {
      setText("desktopTipManualWecomStatus", "暂无已绑定群；请先在目标群发送：@1号机器人 绑定M04通知群");
    } else if (!enabled) {
      setText("desktopTipManualWecomStatus", `已绑定 ${groups.length} 个群；默认不发送群通知`);
    } else {
      setText("desktopTipManualWecomStatus", "已启用群通知，请选择一个或多个已绑定群；@所有人强提醒效果以企业微信智能机器人支持为准");
    }
  }
}

function selectedDesktopTipWecomGroupTargets() {
  const enabledInput = $("desktopTipManualWecomEnabledInput");
  if (!enabledInput || !enabledInput.checked) {
    return { enabled: false, targets: [] };
  }
  const select = $("desktopTipManualWecomGroupSelect");
  const selected = select && select.selectedOptions
    ? Array.from(select.selectedOptions).map((option) => option.value).filter(Boolean)
    : [];
  const mentionMode = $("desktopTipManualWecomMentionModeInput") && $("desktopTipManualWecomMentionModeInput").value === "all"
    ? "all"
    : "none";
  return {
    enabled: true,
    targets: selected.map((groupId) => ({ groupId, mentionMode }))
  };
}

function applyDesktopTipStatusToControls(status) {
  const registeredClientCount = resolveDesktopTipRegisteredClientCount(status, state.desktopTipRegisteredClientCount);
  if ($("desktopTipRegisteredUserBadge")) {
    $("desktopTipRegisteredUserBadge").textContent = `已登记 ${registeredClientCount} 台客户端`;
    $("desktopTipRegisteredUserBadge").classList.toggle("error", registeredClientCount <= 0);
  }
  const desktopTip = status && status.modules ? status.modules.desktopTip || {} : {};
  renderDesktopTipWecomGroups(desktopTip);
  if ($("desktopTipVersionBadge") && desktopTip.version) {
    $("desktopTipVersionBadge").textContent = `v${desktopTip.version}`;
  }
  if ($("desktopTipUpdateBadge") && desktopTip.clientUpdate) {
    $("desktopTipUpdateBadge").textContent = desktopTip.clientUpdate.packageReady
      ? `可更新客户端 v${desktopTip.clientUpdate.version}`
      : "客户端更新包未就绪";
    $("desktopTipUpdateBadge").classList.toggle("error", !desktopTip.clientUpdate.packageReady);
  }
  updateDesktopTipManualMessageControls(
    registeredClientCount,
    Boolean(state.desktopTipManualCanSend)
  );
}

function renderDesktopTipConfig(payload) {
  const config = payload && payload.config ? payload.config : {};
  if (payload && payload.identity) {
    renderDesktopTipIdentity(payload.identity);
  }
  const registered = desktopTipRegisteredStatus(payload);
  const registeredClientCount = resolveDesktopTipRegisteredClientCount({ registeredReceivers: registered }, state.desktopTipRegisteredClientCount);
  const canSendDesktopTip = Boolean(payload && (payload.canManage || payload.canSend));
  state.desktopTipManualCanSend = canSendDesktopTip;
  $("desktopTipRoleBadge").textContent = payload && payload.role ? payload.role : "none";
  $("desktopTipAccessModeBadge").textContent = payload && payload.accessMode === "all_signed_in"
    ? "测试阶段：登录用户可发送"
    : "按角色授权";
  $("desktopTipRegisteredUserBadge").textContent = `已登记 ${registeredClientCount} 台客户端`;
  $("desktopTipRegisteredUserBadge").classList.toggle("error", registeredClientCount <= 0);
  const clientUpdate = payload && payload.clientUpdate ? payload.clientUpdate : {};
  renderDesktopTipWecomGroups(payload && payload.wecomGroups ? payload.wecomGroups : {});
  $("desktopTipUpdateBadge").textContent = clientUpdate.packageReady
    ? `可更新客户端 v${clientUpdate.version}`
    : "客户端更新包未就绪";
  $("desktopTipUpdateBadge").classList.toggle("error", !clientUpdate.packageReady);
  $("desktopTipRoleBadge").classList.toggle("error", !(payload && (payload.canManage || payload.canSend)));
  $("desktopTipVersionBadge").textContent = config.version ? `v${config.version}` : "v0.3.2";
  setDesktopTipConfigEditable(Boolean(payload && payload.canManage));
  updateDesktopTipManualMessageControls(registeredClientCount, canSendDesktopTip);
  if (!payload || !(payload.canManage || payload.canSend)) {
    setText("desktopTipStatusText", "当前登录人没有管理或发送权限");
    return;
  }
  $("desktopTipPmEnabledInput").checked = config.enabled !== false;
  $("desktopTipAdminsInput").value = listToText(config.messageAdmins || []).replace(/，/g, "\n");
  $("desktopTipSendersInput").value = listToText(config.authorizedSenders || []).replace(/，/g, "\n");
  $("desktopTipRecipientsInput").value = listToText(config.recipientUsers || []).replace(/，/g, "\n");
  $("desktopTipGroupsInput").value = JSON.stringify(config.recipientGroups || {}, null, 2);
  $("desktopTipDefaultGroupInput").value = config.defaultRecipientGroupId || "";
  $("desktopTipCountdownInput").value = Array.isArray(config.countdownMinutes) ? config.countdownMinutes.join(",") : "30,10,5,1";
  $("desktopTipEventGroupInput").value = "all_registered_clients";
  $("desktopTipCreateSubmitBtn").disabled = registeredClientCount <= 0;
  setText(
    "desktopTipStatusText",
    registeredClientCount <= 0
      ? "当前没有已登记桌面客户端，请先启动 EA 桌面提醒并成功连接一次，无需登录"
      : (payload.accessMode === "all_signed_in"
        ? `测试阶段：所有已登录用户均可发送；将投递给 ${registeredClientCount} 台已登记桌面客户端`
        : (payload.canManage ? "已读取，可管理配置和事件" : "已读取，可创建和推进事件"))
  );
  setText("desktopTipConfigSaveStatus", payload.canManage ? "" : "测试阶段普通用户不可修改配置；发送不依赖管理员配置");
}

function renderDesktopTipEvents(payload) {
  const events = payload && Array.isArray(payload.events) ? payload.events : [];
  $("desktopTipEventCountBadge").textContent = String(events.length);
  const active = events.find((item) => ["scheduled", "stopped", "extended"].includes(item.status));
  if (active && !$("desktopTipMaintenanceIdInput").value.trim()) {
    $("desktopTipMaintenanceIdInput").value = active.maintenanceId;
  }
  const summary = events.map((item) => ({
    maintenanceId: item.maintenanceId,
    title: item.title,
    serverName: item.serverName,
    status: item.statusLabel || item.status,
    scheduledStopAt: item.scheduledStopAt,
    expectedResumeAt: item.expectedResumeAt,
    currentRevision: item.currentRevision,
    recipients: Array.isArray(item.recipients) ? item.recipients.length : 0,
    totalExtensionMinutes: item.totalExtensionMinutes || 0,
    reason: item.reason || "",
    statusHistory: item.statusHistory || [],
    sendHistory: (item.sendHistory || []).map((entry) => ({
      messageType: entry.messageType,
      sequence: entry.sequence,
      channel: entry.channel,
      queuedAt: entry.queuedAt,
      skipped: Boolean(entry.skipped)
    }))
  }));
  setText("desktopTipEventsBox", JSON.stringify(summary, null, 2));
}

async function sendDesktopTipManualMessage(event) {
  event.preventDefault();
  if (state.desktopTipManualSending) {
    return;
  }
  const identity = await ensureDesktopTipIdentity();
  if (!identity) {
    setText("desktopTipManualStatus", "请先登录");
    return;
  }
  const registeredCount = Number(state.desktopTipRegisteredClientCount || 0);
  if (registeredCount <= 0) {
    setText("desktopTipManualStatus", "当前没有已登记桌面客户端，请先启动 EA 桌面提醒并成功连接一次，无需登录");
    return;
  }
  const title = $("desktopTipManualTitleInput").value.trim();
  const body = $("desktopTipManualBodyInput").value.trim();
  if (!title || !body) {
    setText("desktopTipManualStatus", "消息标题和消息内容不能为空");
    return;
  }
  const wecomGroups = selectedDesktopTipWecomGroupTargets();
  if (wecomGroups.enabled && wecomGroups.targets.length <= 0) {
    setText("desktopTipManualStatus", "已勾选企业微信群通知，请至少选择 1 个已绑定群");
    return;
  }
  state.desktopTipManualSending = true;
  updateDesktopTipManualMessageControls(registeredCount, state.desktopTipManualCanSend);
  setText("desktopTipManualStatus", "发送中...");
  try {
    const result = await requestJson("/api/desktop-tip/manual-message", {
      method: "POST",
      body: JSON.stringify({
        title,
        body,
        wecomGroups
      })
    });
    const groupResult = result.wecomGroups || {};
    const groupMessage = groupResult.enabled
      ? `；群成功 ${groupResult.successCount || 0}/${groupResult.requestedCount || 0}，失败 ${groupResult.failedCount || 0}`
      : "";
    const failedGroups = groupResult.enabled && Array.isArray(groupResult.results)
      ? groupResult.results.filter((item) => !item.ok).map((item) => `${item.displayName || item.groupId}：${item.message || item.errmsg || item.errcode || "发送失败"}`).join("；")
      : "";
    const successMessage = `已排队 ${result.queuedCount || 0}/${result.recipientCount || 0} 台${groupMessage}，批次 ${result.batchId || ""}${failedGroups ? `；失败群：${failedGroups}` : ""}`;
    setText("desktopTipManualStatus", successMessage);
    await loadDesktopTipMaintenance();
    setText("desktopTipManualStatus", successMessage);
  } catch (error) {
    setText("desktopTipManualStatus", `失败：${error.message}`);
  } finally {
    state.desktopTipManualSending = false;
    if ($("desktopTipManualSubmitBtn")) {
      $("desktopTipManualSubmitBtn").disabled = !state.desktopTipManualCanSend || Number(state.desktopTipRegisteredClientCount || 0) <= 0;
    }
  }
}

async function loadDesktopTipMaintenance(options = {}) {
  const identity = options.identity || await ensureDesktopTipIdentity();
  if (!identity) {
    return;
  }
  setText("desktopTipStatusText", "读取中...");
  const config = await requestJson("/api/desktop-tip/maintenance/config");
  renderDesktopTipConfig(config);
  if (config.canManage || config.canSend) {
    await loadDesktopTipEvents();
  }
}

async function loadDesktopTipEvents() {
  const identity = await ensureDesktopTipIdentity();
  if (!identity) {
    return;
  }
  const result = await requestJson("/api/desktop-tip/maintenance/events?limit=30");
  renderDesktopTipEvents(result);
}

async function saveDesktopTipConfig(event) {
  event.preventDefault();
  const identity = await ensureDesktopTipIdentity();
  if (!identity) {
    setText("desktopTipConfigSaveStatus", "请先登录");
    return;
  }
  if (!window.confirm("确认保存 EA 桌面提醒权限配置？")) {
    return;
  }
  setText("desktopTipConfigSaveStatus", "保存中...");
  try {
    const result = await requestJson("/api/desktop-tip/maintenance/config", {
      method: "POST",
      body: JSON.stringify({
        config: desktopTipConfigPayload()
      })
    });
    renderDesktopTipConfig(result);
    setText("desktopTipConfigSaveStatus", "已保存");
  } catch (error) {
    setText("desktopTipConfigSaveStatus", `失败：${error.message}`);
  }
}

async function createDesktopTipMaintenance(event) {
  event.preventDefault();
  const identity = await ensureDesktopTipIdentity();
  if (!identity) {
    setText("desktopTipCreateStatus", "请先登录");
    return;
  }
  const registeredText = $("desktopTipRegisteredUserBadge").textContent || "";
  const registeredCount = Number((registeredText.match(/\d+/) || [0])[0]);
  if (registeredCount <= 0) {
    setText("desktopTipCreateStatus", "当前没有已登记桌面客户端，请先启动 EA 桌面提醒并成功连接一次，无需登录");
    return;
  }
  if (!window.confirm("确认新建正式服停服更新事件？服务端会按节点生成 EA 桌面提醒。")) {
    return;
  }
  setText("desktopTipCreateStatus", "创建中...");
  try {
    const result = await requestJson("/api/desktop-tip/maintenance/events", {
      method: "POST",
      body: JSON.stringify({
        title: $("desktopTipEventTitleInput").value.trim(),
        serverName: $("desktopTipServerNameInput").value.trim() || "正式服",
        scheduledStopAt: desktopTipLocalToIso($("desktopTipStopAtInput").value),
        expectedResumeAt: desktopTipLocalToIso($("desktopTipResumeAtInput").value),
        recipientScope: "all_registered_clients",
        recipientGroupId: "all_registered_clients",
        countdownMinutes: parseDesktopTipMinutes($("desktopTipEventCountdownInput").value)
      })
    });
    $("desktopTipMaintenanceIdInput").value = result.maintenance.maintenanceId;
    setText("desktopTipCreateStatus", "已创建");
    await loadDesktopTipEvents();
  } catch (error) {
    setText("desktopTipCreateStatus", `失败：${error.message}`);
  }
}

async function postDesktopTipAction(pathname, payload, confirmText) {
  const identity = await ensureDesktopTipIdentity();
  if (!identity) {
    setText("desktopTipActionStatus", "请先登录");
    return;
  }
  const maintenanceId = $("desktopTipMaintenanceIdInput").value.trim();
  if (!maintenanceId) {
    setText("desktopTipActionStatus", "请先填写 maintenanceId");
    return;
  }
  if (!window.confirm(confirmText)) {
    return;
  }
  setText("desktopTipActionStatus", "提交中...");
  try {
    const result = await requestJson(pathname, {
      method: "POST",
      body: JSON.stringify({
        maintenanceId,
        idempotencyKey: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        ...payload
      })
    });
    setText("desktopTipActionStatus", result.skipped ? `已跳过：${result.reason}` : "已提交");
    await loadDesktopTipEvents();
  } catch (error) {
    setText("desktopTipActionStatus", `失败：${error.message}`);
  }
}

function stopDesktopTipMaintenance() {
  postDesktopTipAction("/api/desktop-tip/maintenance/stop", {}, "确认将该维护事件手动推进为“已停服”？");
}

function extendDesktopTipMaintenance() {
  postDesktopTipAction(
    "/api/desktop-tip/maintenance/extend",
    {
      extensionMinutes: Number($("desktopTipExtendMinutesInput").value),
      reason: $("desktopTipActionReasonInput").value.trim()
    },
    "确认延长本次正式服停服？"
  );
}

function completeDesktopTipMaintenance() {
  postDesktopTipAction("/api/desktop-tip/maintenance/complete", {}, "确认正式服更新完成并结束该事件？");
}

function cancelDesktopTipMaintenance() {
  postDesktopTipAction(
    "/api/desktop-tip/maintenance/cancel",
    {
      reason: $("desktopTipActionReasonInput").value.trim()
    },
    "确认取消这个尚未开始的维护事件？"
  );
}

window.addEventListener("DOMContentLoaded", () => {
  $("settingsBtn").addEventListener("click", openSettings);
  $("backToDashboardBtn").addEventListener("click", openDashboard);
  $("refreshBtn").addEventListener("click", refreshAll);
  $("testForm").addEventListener("submit", sendTestMessage);
  $("runRankBtn").addEventListener("click", runRankOnce);
  $("basicConfigForm").addEventListener("submit", saveBasicSettings);
  $("robotConfigForm").addEventListener("submit", saveRobotSettings);
  $("robotPushTestBtn").addEventListener("click", testRobotPush);
  $("robotFeedbackCardTestBtn").addEventListener("click", testRobotFeedbackCard);
  $("robotDiagnosticsRefreshBtn").addEventListener("click", loadRobotDiagnostics);
  $("robotDiagnosticsIssueList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-issue-id][data-issue-status]");
    if (!button) {
      return;
    }
    button.disabled = true;
    updateRobotDiagnosticIssueStatus(button.dataset.issueId, button.dataset.issueStatus).catch((error) => {
      setText("robotDiagnosticsSummaryBox", `状态更新失败：${error.message}`);
    });
  });
  $("rankConfigForm").addEventListener("submit", saveRankSettings);
  $("devProgressConfigForm").addEventListener("submit", saveDevProgressSettings);
  $("demandWorkflowRulesForm").addEventListener("submit", saveDemandWorkflowRulesSettings);
  $("devProgressDocUrlInput").addEventListener("change", applyDevProgressUrlParts);
  $("devProgressDocUrlInput").addEventListener("blur", applyDevProgressUrlParts);
  $("devProgressTestBtn").addEventListener("click", testDevProgressConnection);
  $("devProgressPreviewBtn").addEventListener("click", previewDevProgressRecords);
  $("devProgressScanAnomaliesBtn").addEventListener("click", scanDevProgressAnomalies);
  $("devProgressPushRequiredFieldsBtn").addEventListener("click", pushDevProgressRequiredFields);
  $("bugCollectionConfigForm").addEventListener("submit", saveBugCollectionSettings);
  $("bugCollectionCreateDocBtn").addEventListener("click", createBugCollectionDoc);
  $("bugCollectionSetupTestBtn").addEventListener("click", setupBugCollectionTest);
  $("bugCollectionMigrateTaskIdsBtn").addEventListener("click", migrateBugCollectionTaskIds);
  $("bugCollectionCleanupFieldsBtn").addEventListener("click", cleanupBugCollectionFields);
  $("bugCollectionDocUrlInput").addEventListener("change", applyBugCollectionUrlParts);
  $("bugCollectionDocUrlInput").addEventListener("blur", applyBugCollectionUrlParts);
  $("desktopTipLoadBtn").addEventListener("click", () => loadDesktopTipMaintenance().catch((error) => {
    setText("desktopTipStatusText", `失败：${error.message}`);
  }));
  $("desktopTipLoginBtn").addEventListener("click", openDesktopTipLogin);
  $("desktopTipManualMessageForm").addEventListener("submit", sendDesktopTipManualMessage);
  $("desktopTipManualWecomEnabledInput").addEventListener("change", () => updateDesktopTipManualWecomControls(state.desktopTipManualCanSend));
  $("desktopTipConfigForm").addEventListener("submit", saveDesktopTipConfig);
  $("desktopTipCreateForm").addEventListener("submit", createDesktopTipMaintenance);
  $("desktopTipRefreshEventsBtn").addEventListener("click", () => loadDesktopTipEvents().catch((error) => {
    setText("desktopTipActionStatus", `失败：${error.message}`);
  }));
  $("desktopTipStopBtn").addEventListener("click", stopDesktopTipMaintenance);
  $("desktopTipExtendBtn").addEventListener("click", extendDesktopTipMaintenance);
  $("desktopTipCompleteBtn").addEventListener("click", completeDesktopTipMaintenance);
  $("desktopTipCancelBtn").addEventListener("click", cancelDesktopTipMaintenance);
  $("notificationConfigForm").addEventListener("submit", saveNotificationSettings);
  $("aiConfigForm").addEventListener("submit", saveAiSettings);
  $("aiProviderInput").addEventListener("change", updateAiFieldsForProvider);
  for (const button of document.querySelectorAll(".tab-button")) {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  }

  refreshAll().catch((error) => {
    $("healthBadge").classList.add("error");
    setText("healthBadge", "异常");
    setText("configBox", error.message);
  });
  initializeDesktopTipPanel().catch((error) => {
    setText("desktopTipStatusText", `EA 桌面提醒初始化失败：${error.message}`);
  });
});
