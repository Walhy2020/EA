"use strict";

const fs = require("fs");
const path = require("path");
const {
  getDemandWorkflowRulesSettings,
  getDevProgressSettings
} = require("../../config/settingsStore");
const {
  previewDevProgressRecords,
  readDevProgressDocumentInfo,
  readDevProgressFieldDefinitions,
  readDevProgressRecords,
  readDevProgressWorkdayCalendar
} = require("./wecomSmartsheetClient");
const { inspectRequiredFields, scanDevProgressAnomalies } = require("./anomalyScanner");
const {
  resolveWeComUserName,
  resolveWeComUserIdByName
} = require("../../wecom/wecomUserResolver");
const { resolveProjectPath } = require("../../utils/paths");
const { createWorkbookBuffer } = require("../../utils/simpleXlsx");
const {
  fallbackLeaderFilters,
  relatedLeaderNames
} = require("./fallbackLeaderFilter");

const TASK_QUERY_PATTERN = /(?:任务|需求|进度)/;
const SCAN_PAGE_SIZE = 500;
const H5_MONITOR_CACHE_VERSION = 17;
const H5_MONITOR_CACHE_RELATIVE_PATH = "data/dev-progress/h5-monitor-cache.json";
const REQUIRED_FIELD_FALLBACK_VIEWER_NAMES = ["李晶晶"];
const DEFAULT_VERSION_PROJECT_ALIASES = {
  "一骑": "一骑当千",
  "一骑当千": "一骑当千",
  "女王": "女王之刃",
  "QB": "女王之刃",
  "qb": "女王之刃",
  "女王之刃": "女王之刃",
  "高校": "恶魔高校",
  "恶魔高校": "恶魔高校",
  "噬血": "嗜血",
  "噬血狂袭": "嗜血",
  "嗜血": "嗜血",
  "魔王": "魔王",
  "STB": "嗜血",
  "stb": "嗜血"
};
const PERSONAL_TASK_OWNER_ROLES = [
  "frontend",
  "backend",
  "ui",
  "planner",
  "tester",
  "effect",
  "plannerLead",
  "uiLead",
  "effectLead",
  "frontendLead",
  "backendLead",
  "testerLead"
];
const WORKFLOW_OWNER_ROLE_BY_FIELD = {
  "前端开发": "frontend",
  "后端开发": "backend",
  "UI人员": "ui",
  "策划人员": "planner",
  "测试人员": "tester",
  "动效人员": "effect"
};
const LEADER_REQUIRED_FIELD_NAMES = [
  "UI制作交付日期",
  "UI监修完成日期",
  "动效制作交付日期",
  "动效监修完成日期",
  "程序开发交付日期",
  "内网验收/测试完成日期",
  "正式验收/测试完成日期"
];
const LEADER_REQUIRED_FIELD_SET = new Set(LEADER_REQUIRED_FIELD_NAMES);
const LEADER_REQUIRED_FIELDS_BY_LEADER_FIELD = {
  UI组长: ["UI制作交付日期", "UI监修完成日期"],
  动效组长: ["动效制作交付日期", "动效监修完成日期"],
  前端组长: ["程序开发交付日期"],
  后端组长: ["程序开发交付日期"],
  策划组长: ["内网验收/测试完成日期", "正式验收/测试完成日期"],
  测试组长: ["内网验收/测试完成日期", "正式验收/测试完成日期"]
};

function hasChineseText(value) {
  return /[\u4e00-\u9fa5]/.test(String(value || ""));
}

function isSelfPersonName(value) {
  return /^(?:__self__|我|自己|本人|我的)$/.test(String(value || "").trim());
}

function isSelfTaskQuery(text) {
  const rawText = String(text || "").trim();
  return /(?:^|[，,。！？\s])(?:我|我的|自己|本人).*(?:任务|需求|进度)|(?:任务|需求|进度).*(?:我|我的|自己|本人)/.test(rawText);
}

async function resolveSelfPersonName(context, settings, logger) {
  const sender = context && context.sender ? context.sender : {};
  if (sender.name && hasChineseText(sender.name)) {
    return String(sender.name).trim();
  }

  const userId = String(sender.userId || "").trim();
  if (!userId) {
    return "";
  }

  try {
    const resolvedName = await resolveWeComUserName(settings.auth || {}, userId);
    return hasChineseText(resolvedName) ? String(resolvedName || "").trim() : "";
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn("Dev progress self user name resolve failed", {
        hasUserId: Boolean(userId),
        message: error && error.message ? error.message : String(error || "")
      });
    }
  }

  return "";
}

async function extractPersonName(context, task, settings, logger) {
  const text = context && context.text ? context.text : "";
  const params = task && task.params ? task.params : {};
  if (typeof params.personName === "string" && params.personName.trim()) {
    if (isSelfPersonName(params.personName)) {
      return resolveSelfPersonName(context, settings, logger);
    }
    return params.personName.trim();
  }
  if (typeof params.owner === "string" && params.owner.trim()) {
    if (isSelfPersonName(params.owner)) {
      return resolveSelfPersonName(context, settings, logger);
    }
    return params.owner.trim();
  }

  const rawText = String(text || "")
    .trim()
    .replace(/^(?:查一下|查询|看一下|看看|统计|我问)\s*/, "");
  if (isSelfTaskQuery(rawText)) {
    return resolveSelfPersonName(context, settings, logger);
  }

  const patterns = [
    /^([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·._-]{1,15})\s*(?:现在|当前)?(?:有|负责|手上|名下)(?:多少|几条|几项|几个)?(?:个|条|项)?(?:任务|需求|进度)/,
    /^([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·._-]{1,15})\s*(?:多少|几条|几项|几个)(?:个|条|项)?(?:任务|需求|进度)/,
    /^([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·._-]{1,15})的(?:任务|需求|进度)/
  ];
  for (const pattern of patterns) {
    const matched = rawText.match(pattern);
    if (matched && matched[1]) {
      return matched[1].trim();
    }
  }
  return "";
}

function splitPeople(value) {
  return String(value || "")
    .split(/[、,，/\\|;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePersonToken(value) {
  return String(value || "").trim().toLowerCase();
}

function containsAny(text, keywords) {
  const value = String(text || "");
  return (keywords || []).some((keyword) => keyword && value.includes(keyword));
}

function isOnlineStatus(status, rules = {}) {
  const text = String(status || "").trim();
  if (!text || containsAny(text, ["未上线", "不上线", "暂不上线", "无需上线"])) {
    return false;
  }

  const keywords = Array.isArray(rules.onlineStatusKeywords) && rules.onlineStatusKeywords.length > 0
    ? rules.onlineStatusKeywords
    : ["已上线", "上线完成"];
  return containsAny(text, keywords);
}

function isOnlineTask(record, rules = {}) {
  const standard = record.standard || {};
  return isOnlineStatus(standard.status, rules);
}

function filterQueryableRecords(records, rules = {}) {
  const activeRecords = [];
  let excludedOnlineCount = 0;
  for (const record of records || []) {
    if (isOnlineTask(record, rules)) {
      excludedOnlineCount += 1;
      continue;
    }
    activeRecords.push(record);
  }
  return {
    records: activeRecords,
    rawRecordCount: Array.isArray(records) ? records.length : 0,
    excludedOnlineCount
  };
}

function onlineFilterText(filterStats = {}) {
  const count = Number(filterStats.excludedOnlineCount || 0);
  return count > 0 ? `，已排除 ${count} 条已上线任务` : "";
}

function looksLikeUserId(value) {
  return /^[A-Za-z][A-Za-z0-9_.@-]{1,63}$/.test(String(value || "").trim());
}

function normalizeSendTargetName(value) {
  const text = String(value || "")
    .trim()
    .replace(/[，,。！？!?.；;：:]$/g, "");
  if (!text || /^(?:我|自己|本人)$/.test(text)) {
    return "";
  }
  return text;
}

function isSelfSendTarget(value) {
  return /^(?:我|自己|本人)$/.test(String(value || "").trim());
}

function splitSendTargets(value) {
  const text = String(value || "")
    .trim()
    .replace(/[，,。！？!?.；;：:]$/g, "");
  if (!text) {
    return [];
  }

  return text
    .split(/(?:以及|还有|并且|和|及|与|跟|、|,|，|\/|\\|\||;|；|\s+)+/)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function normalizeSendTargets(value) {
  const result = {
    sendToSelf: false,
    targetNames: []
  };

  for (const item of splitSendTargets(value)) {
    if (isSelfSendTarget(item)) {
      result.sendToSelf = true;
      continue;
    }

    const targetName = normalizeSendTargetName(item);
    if (targetName && !result.targetNames.includes(targetName)) {
      result.targetNames.push(targetName);
    }
  }

  return result;
}

function parseVersionExcelSendRequest(text, params = {}) {
  if (params.sendExcel === true) {
    const paramTargetNames = Array.isArray(params.sendTargetNames)
      ? params.sendTargetNames
      : [params.sendTargetName || params.targetName || ""];
    const normalized = normalizeSendTargets(paramTargetNames.filter(Boolean).join("、"));
    const sendToSelf = Boolean(params.sendToSelf) || normalized.sendToSelf;
    const sendToConversation = Boolean(params.sendToConversation) || (!sendToSelf && normalized.targetNames.length === 0);
    return {
      sendExcel: true,
      targetName: normalized.targetNames[0] || "",
      targetNames: normalized.targetNames,
      sendToSelf,
      sendToConversation
    };
  }

  const rawText = String(text || "").trim();
  if (!/(?:发送|发给|发我|给我发|推送|传给|转发|导出)/.test(rawText)) {
    return {
      sendExcel: false,
      targetName: "",
      targetNames: [],
      sendToSelf: false,
      sendToConversation: false
    };
  }

  const targetPatterns = [
    /(?:发送|发|推送|传|转发|导出)(?:Excel|excel|表格|文件|明细)?(?:给|到)\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_.@-]{0,31})/,
    /(?:给|到)\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_.@-]{0,31})\s*(?:发送|发|推送|传|转发|导出)/,
    /(?:发送|发给|传给|推送给|导出给)\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_.@-]{0,31})/
  ];

  let targetSegment = "";
  for (const pattern of targetPatterns) {
    const matched = rawText.match(pattern);
    if (matched && matched[1]) {
      targetSegment = matched[1];
      break;
    }
  }

  const normalized = normalizeSendTargets(targetSegment);
  const explicitSelf = /(?:发我|给我发|发送给我|发给我|传给我|推送给我)/.test(rawText);
  const sendToSelf = explicitSelf || normalized.sendToSelf;
  const sendToConversation = !sendToSelf && normalized.targetNames.length === 0;
  return {
    sendExcel: true,
    targetName: normalized.targetNames[0] || "",
    targetNames: normalized.targetNames,
    sendToSelf,
    sendToConversation
  };
}

function userIdForName(records, targetName) {
  const normalizedTarget = String(targetName || "").trim();
  if (!normalizedTarget) {
    return "";
  }
  if (looksLikeUserId(normalizedTarget)) {
    return normalizedTarget;
  }

  for (const record of records || []) {
    for (const ref of record.userRefs || []) {
      if (String(ref.name || "").trim() === normalizedTarget && ref.userId) {
        return String(ref.userId).trim();
      }
    }
  }
  return "";
}

async function resolveSendTargetUserId(records, targetName, settings, logger) {
  const fromRecords = userIdForName(records, targetName);
  if (fromRecords) {
    return {
      userId: fromRecords,
      source: "dev_progress_records"
    };
  }

  try {
    const fromDirectory = await resolveWeComUserIdByName(settings.auth || {}, targetName);
    return {
      userId: fromDirectory,
      source: fromDirectory ? "wecom_directory" : ""
    };
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn("WeCom user id resolve by name failed", {
        message: error && error.message ? error.message : String(error || "")
      });
    }
    return {
      userId: "",
      source: "",
      errorMessage: error && error.message ? error.message : String(error || "")
    };
  }
}

function isGroupSender(sender = {}) {
  return String(sender.chatType || "").toLowerCase().includes("group") && Boolean(sender.chatId);
}

function conversationTargetLabel(sender = {}) {
  if (isGroupSender(sender)) {
    return "当前群";
  }
  return sender.userId ? "你" : "当前对话";
}

function aliasesForPerson(personName, personAliases) {
  const aliases = personAliases && personAliases[personName] ? personAliases[personName] : [];
  return [personName, ...(Array.isArray(aliases) ? aliases : [aliases])]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function displayNameForPerson(rawName, personAliases) {
  for (const [personName, aliases] of Object.entries(personAliases || {})) {
    const values = Array.isArray(aliases) ? aliases : [aliases];
    if (values.some((alias) => String(alias || "").trim() === rawName)) {
      return personName;
    }
  }
  return rawName;
}

function ownerMatches(value, personName, personAliases = {}) {
  if (!value || !personName) {
    return false;
  }

  const people = splitPeople(value);
  const targets = aliasesForPerson(personName, personAliases);
  const normalizedTargets = targets.map(normalizePersonToken);
  if (people.some((item) => normalizedTargets.includes(normalizePersonToken(item)))) {
    return true;
  }
  const normalizedValue = normalizePersonToken(value);
  return normalizedTargets.some((target) => normalizedValue.includes(target));
}

function matchingOwnerRoles(record, personName, personAliases, options = {}) {
  const owners = record.standard && record.standard.owners ? record.standard.owners : {};
  const allowedRoles = Array.isArray(options.allowedRoles) && options.allowedRoles.length > 0
    ? new Set(options.allowedRoles)
    : null;
  const specificRoles = Object.entries(owners)
    .filter(([role]) => role !== "owner")
    .filter(([role]) => !allowedRoles || allowedRoles.has(role))
    .filter(([, value]) => ownerMatches(value, personName, personAliases))
    .map(([role]) => role);
  if (specificRoles.length > 0) {
    return specificRoles;
  }
  if (allowedRoles && !allowedRoles.has("owner")) {
    return [];
  }
  return ownerMatches(owners.owner, personName, personAliases) ? ["owner"] : [];
}

function summarizePersonTasks(records, personName, personAliases) {
  const matches = records
    .map((record) => ({
      record,
      roles: matchingOwnerRoles(record, personName, personAliases)
    }))
    .filter((item) => item.roles.length > 0);

  const roleCounts = {};
  for (const match of matches) {
    for (const role of match.roles) {
      roleCounts[role] = (roleCounts[role] || 0) + 1;
    }
  }

  return {
    personName,
    total: matches.length,
    scanned: records.length,
    roleCounts,
    records: matches.map((item) => ({
      recordId: item.record.recordId,
      roles: item.roles,
      demandId: item.record.standard.demandId,
      project: item.record.standard.project,
      demand: item.record.standard.demand,
      status: item.record.standard.status
    }))
  };
}

function roleLabel(role) {
  return {
    owner: "负责人",
    frontend: "前端",
    backend: "后端",
    ui: "UI",
    planner: "策划",
    tester: "测试",
    effect: "动效",
    plannerLead: "策划组长",
    uiLead: "UI组长",
    effectLead: "动效组长",
    frontendLead: "前端组长",
    backendLead: "后端组长",
    testerLead: "测试组长"
  }[role] || role;
}

function collectOwnerEntries(record, personAliases = {}) {
  const owners = record.standard && record.standard.owners ? record.standard.owners : {};
  const specificEntries = Object.entries(owners)
    .filter(([role]) => role !== "owner")
    .flatMap(([role, value]) => splitPeople(value).map((personName) => ({
      role,
      personName: displayNameForPerson(personName, personAliases)
    })))
    .filter((entry) => entry.personName);
  if (specificEntries.length > 0) {
    return specificEntries;
  }
  return splitPeople(owners.owner).map((personName) => ({
    role: "owner",
    personName: displayNameForPerson(personName, personAliases)
  }));
}

function summarizePeopleTasks(records, personAliases) {
  const people = new Map();
  records.forEach((record, index) => {
    const recordKey = record.recordId || `row-${index}`;
    const seenInRecord = new Set();
    for (const entry of collectOwnerEntries(record, personAliases)) {
      if (!people.has(entry.personName)) {
        people.set(entry.personName, {
          personName: entry.personName,
          taskKeys: new Set(),
          roleCounts: {}
        });
      }

      const person = people.get(entry.personName);
      if (!seenInRecord.has(entry.personName)) {
        person.taskKeys.add(recordKey);
        seenInRecord.add(entry.personName);
      }
      person.roleCounts[entry.role] = (person.roleCounts[entry.role] || 0) + 1;
    }
  });

  return [...people.values()]
    .map((person) => ({
      personName: person.personName,
      total: person.taskKeys.size,
      roleCounts: person.roleCounts
    }))
    .sort((left, right) => right.total - left.total || left.personName.localeCompare(right.personName, "zh-Hans-CN"));
}

function personTaskCountText(summary, filterStats = {}) {
  const roleParts = Object.entries(summary.roleCounts)
    .map(([role, count]) => `${roleLabel(role)} ${count} 条`);
  const roleText = roleParts.length > 0 ? `；其中${roleParts.join("，")}` : "";
  return `按当前读取到的 ${summary.scanned} 条未上线开发进度记录统计，${summary.personName}有 ${summary.total} 条任务${roleText}。`;
}

function peopleSummaryText(summary, scanned, filterStats = {}) {
  if (summary.length === 0) {
    return `按当前读取到的 ${scanned} 条未上线开发进度记录统计，暂时没有解析到负责人。`;
  }

  const topPeople = summary.slice(0, 20).map((person) => `${person.personName} ${person.total} 条`);
  const suffix = summary.length > 20 ? `；其余 ${summary.length - 20} 人暂未展开` : "";
  return `按当前读取到的 ${scanned} 条未上线开发进度记录统计，有任务的人员共 ${summary.length} 人：${topPeople.join("，")}${suffix}。`;
}

function compactTaskTitle(task = {}) {
  const idText = task.demandId ? `[${task.demandId}] ` : "";
  return `${idText}${task.demand || "未命名需求"}`;
}

function uniqueMerge(values) {
  return [...new Set((values || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function requiredFieldMergeKey(item = {}) {
  const task = item.task || {};
  return String(task.recordId || task.demandId || `${task.project || ""}|${task.demand || ""}`).trim();
}

function h5TaskKey(item = {}) {
  return String(item.recordId || item.demandId || item.demand || item.id || "").trim();
}

function leaderRequiredBlockedTaskKeys(requiredItems = []) {
  const keys = new Set();
  for (const item of requiredItems || []) {
    const missingFields = Array.isArray(item.missingFields) ? item.missingFields : [];
    if (!missingFields.some((fieldName) => LEADER_REQUIRED_FIELD_SET.has(fieldName))) {
      continue;
    }
    const key = h5TaskKey(item);
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

function mergeRequiredFieldItem(items, nextItem) {
  const nextKey = requiredFieldMergeKey(nextItem);
  const existing = nextKey
    ? items.find((item) => requiredFieldMergeKey(item) === nextKey)
    : null;
  if (!existing) {
    items.push({
      ...nextItem,
      missingFields: uniqueMerge(nextItem.missingFields)
    });
    return;
  }

  existing.missingFields = uniqueMerge([
    ...(existing.missingFields || []),
    ...(nextItem.missingFields || [])
  ]);
  existing.originalOwnerName = uniqueMerge([
    existing.originalOwnerName,
    nextItem.originalOwnerName
  ]).join("、");
  existing.isFallbackOwner = Boolean(existing.isFallbackOwner || nextItem.isFallbackOwner);
}

function roleLeaderNameMapFromWorkflowRules(workflowRules = {}) {
  const roles = workflowRules.roles && typeof workflowRules.roles === "object" ? workflowRules.roles : {};
  const map = new Map();
  for (const [roleField, role] of Object.entries(roles)) {
    const leaderField = String(role && role.leaderField ? role.leaderField : "").trim();
    const leaderNames = uniqueMerge(role && Array.isArray(role.leaderNames) ? role.leaderNames : []);
    if (leaderNames.length === 0) {
      continue;
    }
    if (leaderField) {
      map.set(leaderField, leaderNames);
    }
    if (roleField) {
      map.set(roleField, leaderNames);
    }
  }
  return map;
}

function expandRequiredFieldOwnerNames(ownerNames, roleLeaderNameMap) {
  const expanded = [];
  for (const ownerName of ownerNames || []) {
    const name = String(ownerName || "").trim();
    if (!name) {
      continue;
    }
    const leaderNames = roleLeaderNameMap && roleLeaderNameMap.get(name);
    if (Array.isArray(leaderNames) && leaderNames.length > 0) {
      expanded.push(...leaderNames);
      continue;
    }
    expanded.push(name);
  }
  return uniqueMerge(expanded);
}

function leaderRequiredFieldSetForPerson(personName, personAliases = {}, workflowRulesOverride, requiredRuleOverride) {
  const requiredRule = requiredRuleOverride && typeof requiredRuleOverride === "object"
    ? requiredRuleOverride
    : {};
  const fieldRules = Array.isArray(requiredRule.fieldRules) ? requiredRule.fieldRules : [];
  if (fieldRules.length > 0) {
    const leaders = requiredRule.leaders && typeof requiredRule.leaders === "object"
      ? requiredRule.leaders
      : {};
    const isGlobalFallback = requiredFieldFallbackOwners({ rules: { requiredFields: requiredRule } })
      .some((fallbackOwner) => personNameMatches(fallbackOwner, personName, personAliases));
    const result = new Set();
    for (const fieldRule of fieldRules) {
      const leader = leaders[String(fieldRule.leaderRole || "").trim()] || {};
      const fixedLeaderNames = uniqueMerge(Array.isArray(leader.names) ? leader.names : []);
      const fixedLeaderMatches = fixedLeaderNames.some((leaderName) => personNameMatches(
        leaderName,
        personName,
        personAliases
      ));
      if (isGlobalFallback || fixedLeaderMatches || String(leader.sourceField || "").trim()) {
        result.add(String(fieldRule.field || "").trim());
      }
    }
    result.delete("");
    return result;
  }
  const workflowRules = workflowRulesOverride || getDemandWorkflowRulesSettings().normalizedRules || {};
  const roles = workflowRules.roles && typeof workflowRules.roles === "object" ? workflowRules.roles : {};
  const result = new Set();
  for (const role of Object.values(roles)) {
    const leaderField = String(role && role.leaderField ? role.leaderField : "").trim();
    const fields = LEADER_REQUIRED_FIELDS_BY_LEADER_FIELD[leaderField] || [];
    if (fields.length === 0) {
      continue;
    }
    const leaderNames = uniqueMerge(role && Array.isArray(role.leaderNames) ? role.leaderNames : []);
    if (!ownerMatches(leaderNames.join("、"), personName, personAliases)) {
      continue;
    }
    fields.forEach((fieldName) => result.add(fieldName));
  }
  return result;
}

function leaderMemberScopesForPerson(personName, personAliases = {}) {
  const workflowRules = getDemandWorkflowRulesSettings().normalizedRules || {};
  const roles = workflowRules.roles && typeof workflowRules.roles === "object" ? workflowRules.roles : {};
  const scopes = [];
  for (const [assigneeField, role] of Object.entries(roles)) {
    const leaderField = String(role && role.leaderField ? role.leaderField : "").trim();
    const leaderNames = uniqueMerge(role && Array.isArray(role.leaderNames) ? role.leaderNames : []);
    if (!ownerMatches(leaderNames.join("、"), personName, personAliases)) {
      continue;
    }
    const leaderMemberNames = role && typeof role.leaderMemberNames === "object" && !Array.isArray(role.leaderMemberNames)
      ? role.leaderMemberNames
      : {};
    let memberNames = [];
    for (const [leaderName, mappedMemberNames] of Object.entries(leaderMemberNames)) {
      if (personNameMatches(leaderName, personName, personAliases)) {
        memberNames.push(...uniqueMerge(mappedMemberNames));
      }
    }
    if (memberNames.length === 0) {
      memberNames = uniqueMerge(role && Array.isArray(role.memberNames) ? role.memberNames : []);
    }
    scopes.push({
      assigneeField,
      leaderField,
      leaderNames,
      memberNames: uniqueMerge(memberNames),
      role: WORKFLOW_OWNER_ROLE_BY_FIELD[assigneeField] || ""
    });
  }
  return scopes;
}

function memberTaskMatchForLeader(item = {}, scopes = [], personAliases = {}) {
  const owners = item.owners || {};
  const roles = [];
  const memberNames = [];
  const assigneeFields = [];
  const leaderFields = [];
  for (const scope of scopes || []) {
    if (!scope || !scope.role || !Array.isArray(scope.memberNames) || scope.memberNames.length === 0) {
      continue;
    }
    const ownerValue = owners[scope.role] || "";
    if (!ownerValue) {
      continue;
    }
    const matchedMembers = scope.memberNames
      .filter((memberName) => ownerMatches(ownerValue, memberName, personAliases));
    if (matchedMembers.length === 0) {
      continue;
    }
    roles.push(scope.role);
    memberNames.push(...matchedMembers);
    assigneeFields.push(scope.assigneeField);
    if (scope.leaderField) {
      leaderFields.push(scope.leaderField);
    }
  }
  const uniqueRoles = uniqueMerge(roles);
  if (uniqueRoles.length === 0) {
    return null;
  }
  return {
    roles: uniqueRoles,
    memberNames: uniqueMerge(memberNames),
    assigneeFields: uniqueMerge(assigneeFields),
    leaderFields: uniqueMerge(leaderFields)
  };
}

function requiredFieldItemForLeaderScope(item = {}, allowedFieldSet) {
  if (!(allowedFieldSet instanceof Set) || allowedFieldSet.size === 0) {
    // Required-field items are visible only to a configured leader role.
    // A direct legacy rule owner must not grant a regular member access.
    return null;
  }
  const missingFields = Array.isArray(item.missingFields) ? item.missingFields : [];
  const scopedMissingFields = missingFields.filter((fieldName) => allowedFieldSet.has(fieldName));
  if (scopedMissingFields.length === 0) {
    return null;
  }
  return {
    ...item,
    id: `${item.recordId || item.demandId || item.demand || "task"}-${scopedMissingFields.join("|")}`,
    missingFields: scopedMissingFields
  };
}

function requiredFieldItemIsFallback(item = {}) {
  return Boolean(item && (item.isFallbackOwner || item.fallbackOwner || item.ownerType === "fallback"));
}

function requiredFieldFallbackOwner(settings = {}) {
  return requiredFieldFallbackOwners(settings)[0] || "王谦";
}

function requiredFieldFallbackOwners(settings = {}) {
  const requiredFields = settings.rules?.requiredFields || {};
  return uniqueMerge([
    ...(Array.isArray(requiredFields.fallbackOwners) ? requiredFields.fallbackOwners : []),
    ...splitPeople(requiredFields.fallbackOwner || "王谦")
  ]);
}

function requiredFieldFallbackViewerNames(settings = {}) {
  return uniqueMerge([
    ...requiredFieldFallbackOwners(settings),
    ...REQUIRED_FIELD_FALLBACK_VIEWER_NAMES
  ]);
}

function canReadRequiredFieldFallbackScope(settings = {}, userName = "") {
  return requiredFieldFallbackViewerNames(settings).some((viewerName) => personNameMatches(
    viewerName,
    userName,
    settings.personAliases || {}
  ));
}

function requiredFieldItemsOwnerForScope(settings = {}, userName = "", fallbackOnly = false) {
  return fallbackOnly ? requiredFieldFallbackOwner(settings) : String(userName || "").trim();
}

function requiredFieldItemForFallbackScope(item = {}, allowedFieldSet) {
  const missingFields = Array.isArray(item.missingFields) ? item.missingFields : [];
  const fallbackMissingFields = requiredFieldItemIsFallback(item) || !(allowedFieldSet instanceof Set) || allowedFieldSet.size === 0
    ? missingFields
    : missingFields.filter((fieldName) => !allowedFieldSet.has(fieldName));
  if (fallbackMissingFields.length === 0) {
    return null;
  }
  return {
    ...item,
    id: `${item.recordId || item.demandId || item.demand || "task"}-fallback-${fallbackMissingFields.join("|")}`,
    missingFields: fallbackMissingFields,
    ownerType: "fallback"
  };
}

function requiredFieldLeaderViewItems(cache = {}, settings = {}, leaderName = "", projectFilter, workflowRulesOverride) {
  const sourceItems = Array.isArray(cache.requiredItems) ? cache.requiredItems : [];
  const usesFieldRules = Array.isArray(settings.rules?.requiredFields?.fieldRules)
    && settings.rules.requiredFields.fieldRules.length > 0;
  const allowedFieldSet = leaderRequiredFieldSetForPerson(
    leaderName,
    settings.personAliases || {},
    workflowRulesOverride,
    settings.rules && settings.rules.requiredFields
  );
  return sourceItems
    .filter((item) => usesFieldRules || !requiredFieldItemIsFallback(item))
    .filter((item) => personNameMatches(item.ownerName, leaderName, settings.personAliases || {}))
    .filter((item) => projectMatchesFilter(item.project, projectFilter))
    .map((item) => requiredFieldItemForLeaderScope(item, allowedFieldSet))
    .filter(Boolean);
}

function fallbackLeaderViewItems(cache = {}, settings = {}, projectFilter, workflowRulesOverride) {
  const workflowRules = workflowRulesOverride || getDemandWorkflowRulesSettings().normalizedRules || {};
  const roles = workflowRules.roles && typeof workflowRules.roles === "object" ? workflowRules.roles : {};
  const result = [];
  const leaderNames = uniqueMerge(Object.values(roles).flatMap((role) => Array.isArray(role && role.leaderNames) ? role.leaderNames : []));
  for (const leaderName of leaderNames) {
    for (const item of requiredFieldLeaderViewItems(
      cache,
      settings,
      leaderName,
      projectFilter,
      workflowRules
    )) {
      result.push({ ...item, leaderNames: [leaderName] });
    }
  }
  return result;
}

function collectRequiredFieldPushGroups(scanResult, options = {}) {
  const roleLeaderNameMap = options.roleLeaderNameMap instanceof Map ? options.roleLeaderNameMap : new Map();
  const groups = new Map();
  const noOwnerItems = [];
  let skippedNoOwnerCount = 0;
  let roleOwnerExpandedCount = 0;
  for (const anomaly of scanResult.anomalies || []) {
    const task = anomaly.task || {};
    for (const issue of anomaly.issues || []) {
      if (issue.type !== "missing_required_field") {
        continue;
      }
      const originalOwnerNames = Array.isArray(issue.ownerNames) && issue.ownerNames.length > 0
        ? issue.ownerNames
        : splitPeople(issue.owner);
      const ownerNames = expandRequiredFieldOwnerNames(originalOwnerNames, roleLeaderNameMap);
      if (ownerNames.length === 0) {
        skippedNoOwnerCount += 1;
        mergeRequiredFieldItem(noOwnerItems, {
          task,
          demandType: issue.demandType || task.demandType || "",
          status: issue.status || task.status || "",
          originalOwnerName: "未配置责任人",
          missingFields: Array.isArray(issue.missingFields) ? issue.missingFields : []
        });
        continue;
      }
      if (ownerNames.join("、") !== uniqueMerge(originalOwnerNames).join("、")) {
        roleOwnerExpandedCount += 1;
      }

      for (const ownerName of ownerNames) {
        if (!groups.has(ownerName)) {
          groups.set(ownerName, []);
        }
        mergeRequiredFieldItem(groups.get(ownerName), {
          task,
          demandType: issue.demandType || task.demandType || "",
          status: issue.status || task.status || "",
          originalOwnerName: uniqueMerge(originalOwnerNames).join("、"),
          missingFields: Array.isArray(issue.missingFields) ? issue.missingFields : [],
          isFallbackOwner: Boolean(issue.isFallbackOwner)
        });
      }
    }
  }

  return {
    groups,
    noOwnerItems,
    skippedNoOwnerCount,
    roleOwnerExpandedCount
  };
}

function requiredFieldPushMessage(ownerName, items) {
  const rows = items.slice(0, 10).map((item, index) => {
    const task = item.task || {};
    const links = task.links || {};
    const linkText = links.demandLink ? `\n> 需求链接：${links.demandLink}` : "";
    const originalOwnerName = String(item.originalOwnerName || "").trim();
    const originalOwnerText = originalOwnerName && originalOwnerName !== ownerName
      ? `\n> 原责任人：${originalOwnerName}`
      : "";
    return [
      `${index + 1}. ${compactTaskTitle(task)}`,
      `> 项目：${task.project || "-"}`,
      `> 类型/进度：${item.demandType || "-"} / ${item.status || "-"}`,
      `> 缺失字段：${(item.missingFields || []).join("、") || "-"}${originalOwnerText}${linkText}`
    ].join("\n");
  });
  const moreText = items.length > 10 ? `\n\n还有 ${items.length - 10} 条未展开，请到需求总表查看。` : "";
  return [
    "# EA 必填项缺失提醒",
    `${ownerName}，以下需求存在必填项缺失，请推进补充。`,
    "",
    rows.join("\n\n"),
    moreText
    ].filter((line) => line !== "").join("\n");
}

function requiredFieldTargetOverride(scanOptions = {}) {
  const override = scanOptions.targetOverride || {};
  const enabled = override.enabled !== undefined ? Boolean(override.enabled) : Boolean(scanOptions.testMode);
  const targetName = String(
    override.targetName
    || scanOptions.targetName
    || scanOptions.testTargetName
    || ""
  ).trim();
  if (!enabled || !targetName) {
    return null;
  }
  return {
    enabled: true,
    targetName
  };
}

function requiredFieldTaskKey(item = {}) {
  const task = item.task || {};
  return String(task.recordId || task.demandId || task.demand || "").trim();
}

function requiredFieldTaskCount(items) {
  const keys = new Set();
  for (const item of items || []) {
    const key = requiredFieldTaskKey(item);
    if (key) {
      keys.add(key);
    }
  }
  return keys.size;
}

function requiredFieldPushRows(ownerName, items) {
  const rows = [[
    "推送目标",
    "原责任人",
    "项目",
    "需求ID",
    "需求名称",
    "需求类型",
    "需求进度",
    "缺失字段",
    "更新时间",
    "需求链接"
  ]];

  for (const item of items || []) {
    const task = item.task || {};
    const links = task.links || {};
    const dates = task.dates || {};
    rows.push([
      ownerName || "",
      item.originalOwnerName || ownerName || "",
      task.project || "",
      task.demandId || "",
      task.demand || "",
      item.demandType || task.demandType || "",
      item.status || task.status || "",
      Array.isArray(item.missingFields) ? item.missingFields.join("、") : "",
      displayDateValue(dates.updatedAt),
      excelLinkCell(links.demandLink)
    ]);
  }

  return rows;
}

function exportRequiredFieldPushWorkbook(ownerName, items) {
  const exportDir = resolveProjectPath("data/exports/dev-progress");
  fs.mkdirSync(exportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
  const filename = `${safeFilenamePart(ownerName, "必填项")}必填项缺失-${stamp}.xlsx`;
  const filePath = path.join(exportDir, filename);
  fs.writeFileSync(filePath, createWorkbookBuffer(requiredFieldPushRows(ownerName, items), {
    sheetName: "必填项缺失"
  }));
  return {
    path: filePath,
    filename,
    mediaType: "file",
    description: "开发进度必填项缺失明细"
  };
}

function requiredFieldH5Item(ownerName, item, settings = {}, workflowRules = {}) {
  const task = item.task || {};
  const links = task.links || {};
  const dates = task.dates || {};
  const missingFields = Array.isArray(item.missingFields) ? item.missingFields : [];
  const demandId = String(task.demandId || "").trim();
  const tableUrl = demandLinkUrl(settings.docUrl);
  const rowDemandUrl = demandLinkUrl(links.demandLink);
  return {
    id: `${task.recordId || demandId || task.demand || "task"}-${missingFields.join("|")}`,
    ownerName,
    originalOwnerName: item.originalOwnerName || ownerName || "",
    isFallbackOwner: requiredFieldItemIsFallback(item),
    ownerType: requiredFieldItemIsFallback(item) ? "fallback" : "direct",
    leaderNames: relatedLeaderNames(
      task,
      item.originalOwnerName || ownerName || "",
      workflowRules,
      missingFields
    ),
    recordId: task.recordId || "",
    scanIndex: task.scanIndex || 0,
    viewRowNumber: task.viewRowNumber || 0,
    demandId,
    project: task.project || "",
    demand: task.demand || "",
    demandType: item.demandType || task.demandType || "",
    status: item.status || task.status || "",
    missingFields,
    createdAt: displayDateValue(dates.createdAt),
    createdTime: String(dates.createdAt || "").trim(),
    updatedAt: displayDateValue(dates.updatedAt),
    recordUpdatedAt: displayDateValue(dates.recordUpdatedAt),
    recordUpdatedTime: String(dates.recordUpdatedAt || "").trim(),
    demandLink: links.demandLink || "",
    demandLinkUrl: rowDemandUrl,
    demandTableUrl: tableUrl,
    demandUrl: tableUrl,
    groupChat: links.groupChat || ""
  };
}

function personTaskH5Item(record, roles = [], settings = {}) {
  const standard = record.standard || {};
  const dates = standard.dates || {};
  const links = standard.links || {};
  const tableUrl = demandLinkUrl(settings.docUrl);
  const rowDemandUrl = demandLinkUrl(links.demandLink);
  return {
    id: record.recordId || standard.demandId || standard.demand || "",
    recordId: record.recordId || "",
    scanIndex: record.scanIndex || 0,
    viewRowNumber: record.viewRowNumber || 0,
    demandId: standard.demandId || "",
    project: standard.project || "",
    demand: standard.demand || "",
    demandType: standard.demandType || "",
    status: standard.status || "",
    roles,
    roleLabels: roles.map(roleLabel),
    createdAt: displayDateValue(dates.createdAt),
    createdTime: String(dates.createdAt || "").trim(),
    updatedAt: displayDateValue(dates.updatedAt),
    recordUpdatedAt: displayDateValue(dates.recordUpdatedAt),
    recordUpdatedTime: String(dates.recordUpdatedAt || "").trim(),
    demandLink: links.demandLink || "",
    demandLinkUrl: rowDemandUrl,
    demandTableUrl: tableUrl,
    demandUrl: tableUrl,
    groupChat: links.groupChat || ""
  };
}

function personTaskCacheItem(record, settings = {}) {
  const standard = record.standard || {};
  const dates = standard.dates || {};
  const links = standard.links || {};
  const tableUrl = demandLinkUrl(settings.docUrl);
  const rowDemandUrl = demandLinkUrl(links.demandLink);
  return {
    id: record.recordId || standard.demandId || standard.demand || "",
    recordId: record.recordId || "",
    scanIndex: record.scanIndex || 0,
    viewRowNumber: record.viewRowNumber || 0,
    demandId: standard.demandId || "",
    project: standard.project || "",
    demand: standard.demand || "",
    demandType: standard.demandType || "",
    status: standard.status || "",
    owners: standard.owners || {},
    createdAt: displayDateValue(dates.createdAt),
    createdTime: String(dates.createdAt || "").trim(),
    updatedAt: displayDateValue(dates.updatedAt),
    recordUpdatedAt: displayDateValue(dates.recordUpdatedAt),
    recordUpdatedTime: String(dates.recordUpdatedAt || "").trim(),
    demandLink: links.demandLink || "",
    demandLinkUrl: rowDemandUrl,
    demandTableUrl: tableUrl,
    demandUrl: tableUrl,
    groupChat: links.groupChat || ""
  };
}

function publicPersonTaskItemFromCache(item, roles = []) {
  const { owners, ...publicItem } = item || {};
  return {
    ...publicItem,
    roles,
    roleLabels: roles.map(roleLabel)
  };
}

function publicMemberTaskItemFromCache(item, match) {
  return {
    ...publicPersonTaskItemFromCache(item, match.roles),
    source: "dev_progress",
    memberNames: match.memberNames || [],
    assigneeNames: match.memberNames || [],
    assigneeFields: match.assigneeFields || [],
    leaderFields: match.leaderFields || []
  };
}

function timestampMsFromValue(value) {
  const text = String(value || "").trim();
  if (!text) {
    return 0;
  }
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    const ms = text.length === 13 ? numeric : numeric * 1000;
    return Number.isFinite(ms) ? ms : 0;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function h5TaskCreatedTimeMs(item) {
  return timestampMsFromValue(
    item && (item.createdTime || item.createdAt || item.recordCreatedTime || item.recordCreatedAt)
  );
}

function sortH5TaskItems(items) {
  return [...(items || [])].sort((left, right) => {
    const leftCreated = h5TaskCreatedTimeMs(left);
    const rightCreated = h5TaskCreatedTimeMs(right);
    if (leftCreated !== rightCreated) {
      return rightCreated - leftCreated;
    }
    const leftId = String(left.demandId || left.demand || "");
    const rightId = String(right.demandId || right.demand || "");
    return leftId.localeCompare(rightId, "zh-Hans-CN", { numeric: true });
  });
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dateKeyFromDate(date) {
  const year = date.getFullYear();
  if (year < 2000 || year > 2100) {
    return "";
  }
  return `${year}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function monthRange(year, monthIndex, label) {
  return {
    label,
    start: dateKeyFromDate(new Date(year, monthIndex, 1)),
    end: dateKeyFromDate(new Date(year, monthIndex + 1, 0))
  };
}

function dayRange(date, label) {
  const key = dateKeyFromDate(date);
  return {
    label,
    start: key,
    end: key
  };
}

function weekRange(date, label) {
  const day = date.getDay() || 7;
  const start = addDays(date, 1 - day);
  const end = addDays(start, 6);
  return {
    label,
    start: dateKeyFromDate(start),
    end: dateKeyFromDate(end)
  };
}

function quarterRange(date, label, offset = 0) {
  const quarterStartMonth = Math.floor(date.getMonth() / 3) * 3 + offset * 3;
  const start = new Date(date.getFullYear(), quarterStartMonth, 1);
  const end = new Date(date.getFullYear(), quarterStartMonth + 3, 0);
  return {
    label,
    start: dateKeyFromDate(start),
    end: dateKeyFromDate(end)
  };
}

function yearRange(year, label) {
  return {
    label,
    start: dateKeyFromDate(new Date(year, 0, 1)),
    end: dateKeyFromDate(new Date(year, 11, 31))
  };
}

function versionDateFromUpdatedAt(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  const dateMatch = text.match(/(\d{4})[年/.\-](\d{1,2})[月/.\-](\d{1,2})/);
  if (dateMatch) {
    return `${dateMatch[1]}-${pad2(dateMatch[2])}-${pad2(dateMatch[3])}`;
  }

  const compactMatch = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }

  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    const date = new Date(text.length === 13 ? numeric : numeric * 1000);
    if (!Number.isNaN(date.getTime())) {
      return dateKeyFromDate(date);
    }
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return dateKeyFromDate(parsed);
  }

  return "";
}

function normalizeRange(range) {
  if (!range || !range.start || !range.end) {
    return null;
  }
  const start = range.start <= range.end ? range.start : range.end;
  const end = range.start <= range.end ? range.end : range.start;
  return {
    ...range,
    start,
    end
  };
}

function normalizeTimeRangeInput(range) {
  const normalized = normalizeRange(range);
  if (!normalized || !normalized.label || !normalized.start || !normalized.end) {
    return null;
  }
  return normalized;
}

function explicitDateKeysFromText(text, currentYear) {
  const value = String(text || "");
  const keys = [];
  const fullDatePattern = /(\d{4})[年/.\-](\d{1,2})[月/.\-](\d{1,2})日?/g;
  let matched = fullDatePattern.exec(value);
  while (matched) {
    keys.push(dateKeyFromDate(new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]))));
    matched = fullDatePattern.exec(value);
  }

  const chineseDatePattern = /(?:^|[^\d])(\d{1,2})月(\d{1,2})日?/g;
  matched = chineseDatePattern.exec(value);
  while (matched) {
    keys.push(dateKeyFromDate(new Date(currentYear, Number(matched[1]) - 1, Number(matched[2]))));
    matched = chineseDatePattern.exec(value);
  }

  return keys.filter(Boolean);
}

function parseVersionTimeRange(text, now = new Date()) {
  const value = String(text || "").trim();
  if (!value) {
    return null;
  }

  if (/(?:今天|今日)/.test(value)) {
    return dayRange(now, "今天");
  }
  if (/昨天/.test(value)) {
    return dayRange(addDays(now, -1), "昨天");
  }
  if (/(?:本周|这周|这个星期)/.test(value)) {
    return weekRange(now, "本周");
  }
  if (/上周|上个星期/.test(value)) {
    return weekRange(addDays(now, -7), "上周");
  }
  if (/(?:本月|这个月|当月)/.test(value)) {
    return monthRange(now.getFullYear(), now.getMonth(), "本月");
  }
  if (/上月|上个月/.test(value)) {
    return monthRange(now.getFullYear(), now.getMonth() - 1, "上月");
  }
  if (/(?:本季度|这季度|这个季度)/.test(value)) {
    return quarterRange(now, "本季度");
  }
  if (/上季度|上个季度/.test(value)) {
    return quarterRange(now, "上季度", -1);
  }
  if (/(?:今年|本年)/.test(value)) {
    return yearRange(now.getFullYear(), "今年");
  }
  if (/去年/.test(value)) {
    return yearRange(now.getFullYear() - 1, "去年");
  }

  const explicitDates = explicitDateKeysFromText(value, now.getFullYear());
  if (explicitDates.length >= 2) {
    return normalizeRange({
      label: `${explicitDates[0]} 至 ${explicitDates[1]}`,
      start: explicitDates[0],
      end: explicitDates[1]
    });
  }
  if (explicitDates.length === 1) {
    return dayRange(new Date(explicitDates[0]), explicitDates[0]);
  }

  const yearMonth = value.match(/(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*月?/);
  if (yearMonth) {
    const year = Number(yearMonth[1]);
    const month = Number(yearMonth[2]);
    return monthRange(year, month - 1, `${year}-${pad2(month)}`);
  }

  const monthOnly = value.match(/(?:^|[^\d])(\d{1,2})月(?!\d*日)/);
  if (monthOnly) {
    const month = Number(monthOnly[1]);
    return monthRange(now.getFullYear(), month - 1, `${now.getFullYear()}-${pad2(month)}`);
  }

  return null;
}

function filterRecordsByVersionTimeRange(records, timeRange) {
  if (!timeRange) {
    return {
      records,
      excludedByTimeCount: 0
    };
  }

  const filtered = [];
  let excludedByTimeCount = 0;
  for (const record of records || []) {
    const updatedAt = record.standard && record.standard.dates ? record.standard.dates.updatedAt : "";
    const versionDate = versionDateFromUpdatedAt(updatedAt);
    if (versionDate && versionDate >= timeRange.start && versionDate <= timeRange.end) {
      filtered.push(record);
    } else {
      excludedByTimeCount += 1;
    }
  }
  return {
    records: filtered,
    excludedByTimeCount
  };
}

function normalizeProjectMatchText(value) {
  return String(value || "").trim().replace(/\s+/g, "").toLowerCase();
}

function projectAliasEntries(settings = {}) {
  const configuredAliases = settings.versionProjectAliases || settings.projectAliases || {};
  const merged = {
    ...DEFAULT_VERSION_PROJECT_ALIASES,
    ...configuredAliases
  };
  return Object.entries(merged)
    .map(([alias, projectName]) => ({
      alias: String(alias || "").trim(),
      projectName: String(projectName || "").trim()
    }))
    .filter((entry) => entry.alias && entry.projectName)
    .sort((left, right) => right.alias.length - left.alias.length);
}

function resolveProjectAlias(value, settings = {}) {
  const normalizedValue = normalizeProjectMatchText(value);
  if (!normalizedValue) {
    return null;
  }
  return projectAliasEntries(settings).find((entry) => {
    return normalizeProjectMatchText(entry.alias) === normalizedValue
      || normalizeProjectMatchText(entry.projectName) === normalizedValue;
  }) || null;
}

function resolveVersionProjectFilter(text, params = {}, settings = {}) {
  const explicitProject = String(params.projectName || params.project || "").trim();
  if (explicitProject) {
    const aliasEntry = resolveProjectAlias(explicitProject, settings);
    return {
      projectName: aliasEntry ? aliasEntry.projectName : explicitProject,
      matchedAlias: explicitProject,
      source: "params"
    };
  }

  const normalizedText = normalizeProjectMatchText(text);
  if (!normalizedText) {
    return null;
  }

  for (const entry of projectAliasEntries(settings)) {
    if (normalizedText.includes(normalizeProjectMatchText(entry.alias))) {
      return {
        projectName: entry.projectName,
        matchedAlias: entry.alias,
        source: "alias"
      };
    }
  }

  return null;
}

function filterRecordsByProject(records, projectFilter) {
  if (!projectFilter || !projectFilter.projectName) {
    return {
      records,
      excludedByProjectCount: 0
    };
  }

  const targetProject = normalizeProjectMatchText(projectFilter.projectName);
  const filtered = [];
  let excludedByProjectCount = 0;
  for (const record of records || []) {
    const project = normalizeProjectMatchText(record.standard && record.standard.project);
    if (project && (project === targetProject || project.includes(targetProject) || targetProject.includes(project))) {
      filtered.push(record);
    } else {
      excludedByProjectCount += 1;
    }
  }
  return {
    records: filtered,
    excludedByProjectCount
  };
}

function projectMatchesFilter(projectName, projectFilter) {
  if (!projectFilter || !projectFilter.projectName) {
    return true;
  }
  const project = normalizeProjectMatchText(projectName);
  const targetProject = normalizeProjectMatchText(projectFilter.projectName);
  return Boolean(project && targetProject && (
    project === targetProject
    || project.includes(targetProject)
    || targetProject.includes(project)
  ));
}

function personNameMatches(leftName, rightName, personAliases = {}) {
  const left = String(leftName || "").trim();
  const right = String(rightName || "").trim();
  if (!left || !right) {
    return false;
  }
  return ownerMatches(left, right, personAliases) || ownerMatches(right, left, personAliases);
}

function demandLinkUrl(value) {
  const text = String(value || "").trim();
  const matched = text.match(/https?:\/\/[^\s，,；;]+/i);
  return matched ? matched[0] : "";
}

function versionRowsFromRecords(records) {
  const versions = new Map();
  const unversioned = [];
  for (const record of records) {
    const updatedAt = record.standard && record.standard.dates ? record.standard.dates.updatedAt : "";
    const versionDate = versionDateFromUpdatedAt(updatedAt);
    if (!versionDate) {
      unversioned.push(record);
      continue;
    }
    if (!versions.has(versionDate)) {
      versions.set(versionDate, []);
    }
    versions.get(versionDate).push(record);
  }

  const summary = [...versions.entries()]
    .map(([versionDate, items]) => ({
      version: versionDate,
      taskCount: items.length,
      records: items
    }))
    .sort((left, right) => right.version.localeCompare(left.version));

  return {
    versionCount: summary.length,
    scannedCount: records.length,
    unversionedCount: unversioned.length,
    versions: summary,
    unversioned
  };
}

function versionSendEnding(targetLabel) {
  if (!targetLabel) {
    return "Excel 明细已生成。";
  }
  if (/^(?:当前群|当前对话)$/.test(targetLabel)) {
    return `Excel 明细已生成，将发送到${targetLabel}。`;
  }
  return `Excel 明细已生成，将发送给${targetLabel}。`;
}

function versionSummaryText(summary, options = {}) {
  const rangeText = summary.timeRange
    ? `${summary.timeRange.label}（${summary.timeRange.start} 至 ${summary.timeRange.end}）`
    : "全部范围";
  const scopeText = summary.projectFilter && summary.projectFilter.projectName
    ? `${summary.projectFilter.projectName} ${rangeText}`
    : rangeText;
  const excelText = options.sendExcel
    ? versionSendEnding(options.targetLabel || "当前对话")
    : "Excel 明细未发送。";
  const title = "开发进度版本统计";
  if (summary.versionCount === 0) {
    return [
      title,
      `${scopeText}：暂无迭代版本。`
    ].join("\n");
  }

  const versionText = summary.versions
    .slice(0, 8)
    .map((version) => `${version.version} ${version.taskCount} 条`)
    .join("，");
  const more = summary.versions.length > 8 ? `；其余 ${summary.versions.length - 8} 个版本未展开` : "";
  const unversionedText = summary.unversionedCount > 0
    ? `；另有 ${summary.unversionedCount} 条未归版`
    : "";
  return [
    title,
    `${scopeText}：共 ${summary.versionCount} 个版本，${summary.scannedCount} 条未上线任务。${versionText}${more}${unversionedText}。`,
    excelText
  ].join("\n");
}

function ownerValue(record, role) {
  const owners = record.standard && record.standard.owners ? record.standard.owners : {};
  return owners[role] || "";
}

function displayDateValue(value) {
  return versionDateFromUpdatedAt(value) || String(value || "").trim();
}

function excelLinkCell(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const matched = text.match(/https?:\/\/[^\s，,；;]+/i);
  if (!matched) {
    return text;
  }
  return {
    text,
    hyperlink: matched[0]
  };
}

function exportRowsForVersions(summary) {
  const rows = [[
    "版本",
    "更新时间",
    "需求ID",
    "项目",
    "需求名称",
    "需求内容",
    "需求进度",
    "前端开发",
    "后端开发",
    "UI人员",
    "策划人员",
    "测试人员",
    "前端组长",
    "后端组长",
    "开发截止日期",
    "测试截止日期",
    "验收截止日期",
    "实际上线日期",
    "群聊",
    "需求链接",
    "备注"
  ]];

  for (const version of summary.versions) {
    for (const record of version.records) {
      const standard = record.standard || {};
      const dates = standard.dates || {};
      const links = standard.links || {};
      const notes = standard.notes || {};
      rows.push([
        version.version,
        displayDateValue(dates.updatedAt),
        standard.demandId || "",
        standard.project || "",
        standard.demand || "",
        demandContentValue(record),
        standard.status || "",
        ownerValue(record, "frontend"),
        ownerValue(record, "backend"),
        ownerValue(record, "ui"),
        ownerValue(record, "planner"),
        ownerValue(record, "tester"),
        ownerValue(record, "frontendLead"),
        ownerValue(record, "backendLead"),
        dates.devDeadline || "",
        dates.testDeadline || "",
        dates.acceptanceDeadline || "",
        dates.releaseDate || "",
        links.groupChat || "",
        excelLinkCell(links.demandLink),
        notes.remarks || notes.blockers || ""
      ]);
    }
  }

  for (const record of summary.unversioned) {
    const standard = record.standard || {};
    const dates = standard.dates || {};
    const links = standard.links || {};
    const notes = standard.notes || {};
    rows.push([
      "未归版",
      displayDateValue(dates.updatedAt),
      standard.demandId || "",
      standard.project || "",
      standard.demand || "",
      demandContentValue(record),
      standard.status || "",
      ownerValue(record, "frontend"),
      ownerValue(record, "backend"),
      ownerValue(record, "ui"),
      ownerValue(record, "planner"),
      ownerValue(record, "tester"),
      ownerValue(record, "frontendLead"),
      ownerValue(record, "backendLead"),
      dates.devDeadline || "",
      dates.testDeadline || "",
      dates.acceptanceDeadline || "",
      dates.releaseDate || "",
      links.groupChat || "",
      excelLinkCell(links.demandLink),
      notes.remarks || notes.blockers || ""
    ]);
  }

  return rows;
}

function safeFilenamePart(value, fallback) {
  const text = String(value || "").trim() || fallback;
  return text
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, "")
    .slice(0, 40) || fallback;
}

function exportVersionWorkbook(summary) {
  const exportDir = resolveProjectPath("data/exports/dev-progress");
  fs.mkdirSync(exportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
  const projectName = summary.projectFilter && summary.projectFilter.projectName
    ? summary.projectFilter.projectName
    : "全部项目";
  const filename = `${safeFilenamePart(projectName, "全部项目")}版本内容-${stamp}.xlsx`;
  const filePath = path.join(exportDir, filename);
  fs.writeFileSync(filePath, createWorkbookBuffer(exportRowsForVersions(summary)));
  return {
    path: filePath,
    filename,
    mediaType: "file",
    description: "开发进度版本任务明细"
  };
}

function demandContentValue(record) {
  const standard = record.standard || {};
  const mapped = record.mapped || {};
  const fields = record.fields || {};
  return standard.demandContent || mapped.demandContent || fields["需求内容"] || "";
}

function demandDetailStatusValue(record) {
  const standard = record.standard || {};
  return standard.status || standard.progress || "";
}

function sortedDemandDetailRecords(records) {
  return [...(records || [])].sort((left, right) => {
    const leftDates = left.standard && left.standard.dates ? left.standard.dates : {};
    const rightDates = right.standard && right.standard.dates ? right.standard.dates : {};
    const leftDate = versionDateFromUpdatedAt(leftDates.updatedAt);
    const rightDate = versionDateFromUpdatedAt(rightDates.updatedAt);
    if (leftDate !== rightDate) {
      return rightDate.localeCompare(leftDate);
    }
    const leftStandard = left.standard || {};
    const rightStandard = right.standard || {};
    return String(leftStandard.demandId || leftStandard.demand || "").localeCompare(
      String(rightStandard.demandId || rightStandard.demand || ""),
      "zh-Hans-CN",
      { numeric: true }
    );
  });
}

function demandDetailRowsFromRecords(records) {
  const rows = [[
    "更新时间",
    "项目",
    "需求ID",
    "需求名称",
    "需求内容",
    "状态/需求进度",
    "需求链接"
  ]];

  for (const record of sortedDemandDetailRecords(records)) {
    const standard = record.standard || {};
    const dates = standard.dates || {};
    const links = standard.links || {};
    rows.push([
      displayDateValue(dates.updatedAt),
      standard.project || "",
      standard.demandId || "",
      standard.demand || "",
      demandContentValue(record),
      demandDetailStatusValue(record),
      excelLinkCell(links.demandLink)
    ]);
  }
  return rows;
}

function demandDetailSummaryFromRecords(records) {
  const sorted = sortedDemandDetailRecords(records);
  return {
    detailCount: sorted.length,
    records: sorted
  };
}

function demandDetailRangeText(summary) {
  const timeRange = summary.timeRange;
  if (!timeRange) {
    return "全部范围";
  }
  return `${timeRange.label}（${timeRange.start} 至 ${timeRange.end}）`;
}

function demandDetailScopeText(summary) {
  const projectName = summary.projectFilter && summary.projectFilter.projectName
    ? summary.projectFilter.projectName
    : "";
  const rangeText = demandDetailRangeText(summary);
  return projectName ? `${projectName} ${rangeText}` : rangeText;
}

function demandDetailNoDataText(summary) {
  const projectName = summary.projectFilter && summary.projectFilter.projectName
    ? summary.projectFilter.projectName
    : "";
  const timeRange = summary.timeRange;
  if (projectName && timeRange) {
    return `未找到更新时间为${timeRange.label}的${projectName}需求。`;
  }
  return `未找到${demandDetailScopeText(summary)}的需求。`;
}

function demandDetailText(summary, options = {}) {
  const title = "开发进度需求明细";
  if (summary.detailCount === 0) {
    return [
      title,
      demandDetailNoDataText(summary)
    ].join("\n");
  }
  const excelText = options.sendExcel
    ? versionSendEnding(options.targetLabel || "当前对话")
    : "Excel 明细未发送。";
  return [
    title,
    `${demandDetailScopeText(summary)}：命中 ${summary.detailCount} 条需求明细。`,
    excelText
  ].join("\n");
}

function exportDemandDetailWorkbook(summary) {
  const exportDir = resolveProjectPath("data/exports/dev-progress");
  fs.mkdirSync(exportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
  const projectName = summary.projectFilter && summary.projectFilter.projectName
    ? summary.projectFilter.projectName
    : "全部项目";
  const filename = `${safeFilenamePart(projectName, "全部项目")}需求明细-${stamp}.xlsx`;
  const filePath = path.join(exportDir, filename);
  fs.writeFileSync(filePath, createWorkbookBuffer(demandDetailRowsFromRecords(summary.records), {
    sheetName: "需求明细"
  }));
  return {
    path: filePath,
    filename,
    mediaType: "file",
    description: "开发进度需求明细"
  };
}

function h5MonitorCachePath() {
  return resolveProjectPath(H5_MONITOR_CACHE_RELATIVE_PATH);
}

function readH5MonitorCacheFile() {
  const filePath = h5MonitorCachePath();
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    return {
      ok: false,
      version: H5_MONITOR_CACHE_VERSION,
      errorMessage: `H5 监控缓存读取失败：${error.message}`,
      cachePath: H5_MONITOR_CACHE_RELATIVE_PATH
    };
  }
}

function writeH5MonitorCacheFile(cache) {
  const filePath = h5MonitorCachePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function h5CacheTtlMs(settings = {}) {
  const minutes = Number(settings.cacheMinutes || 5);
  return Math.max(60 * 1000, Math.min(minutes > 0 ? minutes * 60 * 1000 : 5 * 60 * 1000, 60 * 60 * 1000));
}

function cacheTimeMs(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}

function h5CacheNeedsSignalCheck(cache, settings) {
  if (!cache || cache.ok === false || !cache.refreshedAt) {
    return true;
  }
  if (cache.version !== H5_MONITOR_CACHE_VERSION) {
    return true;
  }
  const checkedAt = cacheTimeMs(cache.signalCheckedAt || cache.refreshedAt);
  return !checkedAt || Date.now() - checkedAt >= h5CacheTtlMs(settings);
}

function h5CacheMeta(cache, extra = {}) {
  return {
    version: cache && cache.version ? cache.version : H5_MONITOR_CACHE_VERSION,
    path: H5_MONITOR_CACHE_RELATIVE_PATH,
    refreshedAt: cache && cache.refreshedAt ? cache.refreshedAt : "",
    signalCheckedAt: cache && cache.signalCheckedAt ? cache.signalCheckedAt : "",
    signal: cache && cache.signal ? cache.signal : "",
    source: "h5_monitor_cache",
    requiredItemCount: cache && Array.isArray(cache.requiredItems) ? cache.requiredItems.length : 0,
    personTaskItemCount: cache && Array.isArray(cache.personTaskItems) ? cache.personTaskItems.length : 0,
    ...extra
  };
}

function createDevProgressModule(options = {}) {
  const logger = options.logger;
  let h5MonitorCache = null;
  let h5MonitorRefreshPromise = null;

  async function readRecords(readOptions = {}, settings = getDevProgressSettings()) {
    return readDevProgressRecords(settings, readOptions);
  }

  async function getDocumentChangeSignal() {
    const settings = getDevProgressSettings();
    return readDevProgressDocumentInfo(settings);
  }

  function readH5MonitorCache() {
    if (!h5MonitorCache) {
      h5MonitorCache = readH5MonitorCacheFile();
    }
    return h5MonitorCache;
  }

  function saveH5MonitorCache(cache) {
    h5MonitorCache = cache;
    writeH5MonitorCacheFile(cache);
    return cache;
  }

  function scanReadPerf(totalMs, pages = []) {
    const pagePerfs = pages
      .map((page) => page.perf)
      .filter(Boolean);
    const sum = (key) => pagePerfs.reduce((total, perf) => total + Number(perf[key] || 0), 0);
    return {
      totalMs,
      pageCount: pages.length,
      tokenMs: sum("tokenMs"),
      tokenCacheHitCount: pagePerfs.filter((perf) => perf.tokenCacheHit).length,
      fetchRecordsMs: sum("fetchRecordsMs"),
      resolveUserMs: sum("resolveUserMs"),
      normalizeMs: sum("normalizeMs"),
      pages: pages.map((page, index) => ({
        index: index + 1,
        offset: page.offset,
        limit: page.limit,
        recordCount: page.recordCount,
        totalMs: page.perf ? page.perf.totalMs : 0,
        tokenMs: page.perf ? page.perf.tokenMs : 0,
        tokenCacheHit: page.perf ? Boolean(page.perf.tokenCacheHit) : false,
        fetchRecordsMs: page.perf ? page.perf.fetchRecordsMs : 0,
        resolveUserMs: page.perf ? page.perf.resolveUserMs : 0,
        normalizeMs: page.perf ? page.perf.normalizeMs : 0
      }))
    };
  }

  async function readRecordsForScan(settings, scanLimit, readOptions = {}) {
    const readStartedAt = Date.now();
    const recordIds = Array.isArray(readOptions.recordIds)
      ? [...new Set(readOptions.recordIds.map((value) => String(value || "").trim()).filter(Boolean))]
      : [];
    const targetLimit = recordIds.length > 0
      ? recordIds.length
      : Math.max(1, Math.min(Number(scanLimit || 2000), 5000));
    const records = [];
    let offset = 0;
    let fieldsUsed = [];
    let userNameResolvedCount = 0;
    const pages = [];

    while (records.length < targetLimit) {
      const pageLimit = Math.min(SCAN_PAGE_SIZE, targetLimit - records.length);
      const page = await readRecords({
        limit: pageLimit,
        offset,
        recordIds,
        forceLookupMetadataRefresh: Boolean(readOptions.forceLookupMetadataRefresh && offset === 0)
      }, settings);
      if (!page.ok) {
        return {
          ...page,
          records,
          pages
        };
      }

      fieldsUsed = page.fieldsUsed || fieldsUsed;
      userNameResolvedCount += Number(page.userNameResolvedCount || 0);
      pages.push({
        offset,
        limit: page.limit,
        recordCount: page.recordCount,
        perf: page.perf || null
      });
      const positionedRecords = page.records.map((record, index) => ({
        ...record,
        scanIndex: offset + index + 1,
        viewRowNumber: offset + index + 2
      }));
      records.push(...positionedRecords);

      if (recordIds.length > 0 || page.recordCount < pageLimit || page.recordCount === 0) {
        break;
      }
      offset += pageLimit;
    }

    return {
      ok: true,
      status: "ok",
      limit: targetLimit,
      recordCount: records.length,
      fieldsUsed,
      userNameResolvedCount,
      pages,
      perf: scanReadPerf(Date.now() - readStartedAt, pages),
      records
    };
  }

  async function previewRecords(readOptions = {}) {
    const result = await previewDevProgressRecords(getDevProgressSettings(), readOptions);
    if (logger && result.ok) {
      logger.info("Dev progress records preview loaded", {
        recordCount: result.recordCount,
        fieldCount: result.fieldsUsed.length
      });
    }
    return result;
  }

  async function countByPerson(personName, readOptions = {}) {
    const settings = getDevProgressSettings();
    const result = await readRecords({
      limit: 500,
      ...readOptions
    }, settings);
    if (!result.ok) {
      return {
        ok: false,
        module: "devProgress",
        text: `开发进度记录读取失败：${result.errcode || ""} ${result.errmsg || result.message || ""}`.trim(),
        data: result
      };
    }

    const filterStats = filterQueryableRecords(result.records, settings.rules || {});
    const summary = summarizePersonTasks(filterStats.records, personName, settings.personAliases || {});
    return {
      ok: true,
      module: "devProgress",
      action: "person_task_count",
      text: personTaskCountText(summary, filterStats),
      data: {
        summary,
        filter: {
          rawRecordCount: filterStats.rawRecordCount,
          excludedOnlineCount: filterStats.excludedOnlineCount
        },
        readLimit: result.limit,
        fieldsUsed: result.fieldsUsed
      }
    };
  }

  async function summarizePeople(readOptions = {}) {
    const settings = getDevProgressSettings();
    const result = await readRecords({
      limit: 500,
      ...readOptions
    }, settings);
    if (!result.ok) {
      return {
        ok: false,
        module: "devProgress",
        text: `开发进度记录读取失败：${result.errcode || ""} ${result.errmsg || result.message || ""}`.trim(),
        data: result
      };
    }

    const filterStats = filterQueryableRecords(result.records, settings.rules || {});
    const summary = summarizePeopleTasks(filterStats.records, settings.personAliases || {});
    return {
      ok: true,
      module: "devProgress",
      action: "people_task_summary",
      text: peopleSummaryText(summary, filterStats.records.length, filterStats),
      data: {
        summary,
        filter: {
          rawRecordCount: filterStats.rawRecordCount,
          excludedOnlineCount: filterStats.excludedOnlineCount
        },
        readLimit: result.limit,
        fieldsUsed: result.fieldsUsed
      }
    };
  }

  function scanReadMeta(result) {
    return {
      limit: result.limit,
      recordCount: result.recordCount,
      userNameResolvedCount: result.userNameResolvedCount || 0,
      pageCount: result.pages ? result.pages.length : 1,
      pages: result.pages || [],
      fieldsUsed: result.fieldsUsed,
      perf: result.perf || null
    };
  }

  async function runAnomalyScan(scanOptions = {}) {
    const totalStartedAt = Date.now();
    const settings = getDevProgressSettings();
    const rules = settings.rules || {};
    const readStartedAt = Date.now();
    const result = await readRecordsForScan(settings, scanOptions.limit || rules.scanLimit || 2000, scanOptions);
    const readMs = Date.now() - readStartedAt;
    if (!result.ok) {
      const perf = {
        totalMs: Date.now() - totalStartedAt,
        readMs,
        analyzeMs: 0,
        read: result.perf || null
      };
      return {
        settings,
        rules,
        readResult: result,
        scanResult: {
          ok: false,
          module: "devProgress",
          text: `开发进度记录读取失败：${result.errcode || ""} ${result.errmsg || result.message || ""}`.trim(),
          perf,
          data: result
        }
      };
    }

    const fieldSchemaStartedAt = Date.now();
    let fieldSchema = {
      ok: false,
      status: "not_checked",
      fields: [],
      fieldTitles: []
    };
    try {
      fieldSchema = await readDevProgressFieldDefinitions(settings);
    } catch (error) {
      fieldSchema = {
        ok: false,
        status: "field_schema_error",
        message: error && error.message ? error.message : String(error || ""),
        fields: [],
        fieldTitles: []
      };
    }
    const fieldSchemaMs = Date.now() - fieldSchemaStartedAt;
    const configuredFieldRules = rules.requiredFields && Array.isArray(rules.requiredFields.fieldRules)
      ? rules.requiredFields.fieldRules
      : [];
    if (!fieldSchema.ok) {
      const perf = {
        totalMs: Date.now() - totalStartedAt,
        readMs,
        fieldSchemaMs,
        calendarMs: 0,
        analyzeMs: 0,
        read: result.perf || null,
        fieldSchema: {
          ok: false,
          status: fieldSchema.status || "field_schema_unavailable",
          fieldCount: 0,
          unavailableRequiredFields: []
        }
      };
      if (logger && typeof logger.warn === "function") {
        logger.warn("Dev progress demand sheet field schema unavailable, abort scan", {
          ruleSource: rules.requiredFields && rules.requiredFields.source || "",
          ruleSourceVersion: rules.requiredFields && rules.requiredFields.sourceVersion || "",
          configuredRuleCount: configuredFieldRules.length,
          status: fieldSchema.status || "field_schema_unavailable",
          message: fieldSchema.message || fieldSchema.errmsg || "",
          perf
        });
      }
      return {
        settings,
        rules,
        readResult: result,
        scanResult: {
          ok: false,
          module: "devProgress",
          code: "field_schema_unavailable",
          text: `需求总表列结构读取失败：${fieldSchema.errcode || ""} ${fieldSchema.errmsg || fieldSchema.message || ""}`.trim(),
          perf,
          data: fieldSchema
        }
      };
    }
    const availableFieldTitleSet = fieldSchema.ok ? new Set(fieldSchema.fieldTitles || []) : null;
    const unavailableRequiredFields = availableFieldTitleSet
      ? uniqueMerge(configuredFieldRules
        .map((rule) => String(rule.field || "").trim())
        .filter((fieldName) => fieldName && !availableFieldTitleSet.has(fieldName)))
      : [];
    if (logger && typeof logger.warn === "function" && unavailableRequiredFields.length > 0) {
      logger.warn("Dev progress rule fields missing from demand sheet", {
        ruleSource: rules.requiredFields && rules.requiredFields.source || "",
        ruleSourceVersion: rules.requiredFields && rules.requiredFields.sourceVersion || "",
        configuredRuleCount: configuredFieldRules.length,
        availableSheetFieldCount: fieldSchema.fieldTitles.length,
        unavailableRuleCount: unavailableRequiredFields.length,
        unavailableFields: unavailableRequiredFields
      });
    }

    const calendarStartedAt = Date.now();
    let workdayCalendar = {
      ok: false,
      status: "not_required",
      dates: [],
      dateCount: 0,
      cacheHit: false
    };
    const requiredRule = rules.requiredFields || {};
    const usesWorkdayCalendar = Array.isArray(requiredRule.fieldRules) && requiredRule.fieldRules.some((fieldRule) => (
      Array.isArray(fieldRule.validations)
      && fieldRule.validations.some((validation) => validation.type === "workdayNotAfter")
    ));
    if (usesWorkdayCalendar) {
      try {
        workdayCalendar = await readDevProgressWorkdayCalendar(settings);
      } catch (error) {
        workdayCalendar = {
          ok: false,
          status: "workday_calendar_error",
          message: error && error.message ? error.message : String(error || ""),
          dates: [],
          dateCount: 0,
          cacheHit: false
        };
      }
    }
    const calendarMs = Date.now() - calendarStartedAt;
    if (usesWorkdayCalendar && !workdayCalendar.ok && logger && typeof logger.warn === "function") {
      logger.warn("Dev progress workday calendar unavailable", {
        status: workdayCalendar.status,
        message: workdayCalendar.message || workdayCalendar.errmsg || "",
        sheetName: requiredRule.calendar && requiredRule.calendar.sheetName || "工作日",
        calendarMs
      });
    }

    const analyzeStartedAt = Date.now();
    const scanResult = scanDevProgressAnomalies(result.records, rules, {
      focusDemandIds: scanOptions.focusDemandIds,
      today: scanOptions.today,
      workdayDates: workdayCalendar.dates || [],
      availableFieldTitles: availableFieldTitleSet || undefined
    });
    const analyzeMs = Date.now() - analyzeStartedAt;
    const perf = {
      totalMs: Date.now() - totalStartedAt,
      readMs,
      fieldSchemaMs,
      calendarMs,
      analyzeMs,
      read: result.perf || null,
      fieldSchema: {
        ok: Boolean(fieldSchema.ok),
        status: fieldSchema.status || "",
        fieldCount: Array.isArray(fieldSchema.fieldTitles) ? fieldSchema.fieldTitles.length : 0,
        unavailableRequiredFields
      },
      workdayCalendar: {
        ok: Boolean(workdayCalendar.ok),
        status: workdayCalendar.status || "",
        dateCount: Number(workdayCalendar.dateCount || 0),
        firstDate: workdayCalendar.firstDate || "",
        lastDate: workdayCalendar.lastDate || "",
        cacheHit: Boolean(workdayCalendar.cacheHit)
      }
    };
    if (logger && typeof logger.info === "function") {
      logger.info("Dev progress anomaly scan perf", {
        limit: result.limit,
        scannedCount: scanResult.scannedCount,
        anomalyCount: scanResult.anomalyCount,
        ruleSourceVersion: scanResult.rules.requiredFieldRuleSourceVersion,
        configuredRuleCount: scanResult.rules.requiredFieldRuleCount,
        availableRuleCount: scanResult.rules.requiredFieldAvailableRuleCount,
        unavailableRuleCount: scanResult.rules.requiredFieldUnavailableRuleCount,
        unavailableFields: scanResult.rules.requiredFieldUnavailableFields,
        workdayCalendarStatus: workdayCalendar.status || "",
        workdayDateCount: Number(workdayCalendar.dateCount || 0),
        perf
      });
    }

    return {
      settings,
      rules,
      readResult: result,
      scanResult: {
        ...scanResult,
        perf
      }
    };
  }

  function buildH5MonitorCacheFromScan(settings, rules, readResult, scanResult, signalInfo, refreshReason) {
    const workflowRules = getDemandWorkflowRulesSettings().normalizedRules;
    const fallbackFilters = fallbackLeaderFilters(workflowRules);
    const grouped = collectRequiredFieldPushGroups(scanResult, {
      roleLeaderNameMap: roleLeaderNameMapFromWorkflowRules(workflowRules)
    });
    const requiredItems = [];
    for (const [ownerName, items] of grouped.groups.entries()) {
      for (const item of items || []) {
        requiredItems.push(requiredFieldH5Item(ownerName, item, settings, workflowRules));
      }
    }

    const filterStats = filterQueryableRecords(readResult.records, rules);
    const personTaskItems = filterStats.records.map((record) => personTaskCacheItem(record, settings));
    const now = new Date().toISOString();
    return {
      ok: true,
      version: H5_MONITOR_CACHE_VERSION,
      module: "devProgress",
      action: "h5_monitor_cache",
      source: {
        docUrl: settings.docUrl || "",
        docid: settings.docid || "",
        sheetId: settings.sheetId || "",
        viewId: settings.viewId || ""
      },
      signal: signalInfo && signalInfo.signal ? signalInfo.signal : "",
      modifyTime: signalInfo && signalInfo.modifyTime ? signalInfo.modifyTime : "",
      signalCheckedAt: now,
      refreshedAt: now,
      refreshReason,
      fallbackLeaderFilters: fallbackFilters,
      requiredItems: sortH5TaskItems(requiredItems),
      personTaskItems: sortH5TaskItems(personTaskItems),
      stats: {
        requiredItemCount: requiredItems.length,
        personTaskItemCount: personTaskItems.length,
        rawRecordCount: filterStats.rawRecordCount,
        activeRecordCount: filterStats.records.length,
        excludedOnlineCount: filterStats.excludedOnlineCount,
        skippedNoOwnerCount: grouped.skippedNoOwnerCount,
        roleOwnerExpandedCount: grouped.roleOwnerExpandedCount,
        fallbackLeaderFilterCount: fallbackFilters.length
      },
      read: scanReadMeta(readResult),
      generatedAt: now
    };
  }

  async function refreshH5MonitorCache(refreshOptions = {}) {
    if (h5MonitorRefreshPromise) {
      return h5MonitorRefreshPromise;
    }

    h5MonitorRefreshPromise = (async () => {
      const settings = getDevProgressSettings();
      const existing = readH5MonitorCache();
      const force = Boolean(refreshOptions.force);
      const limit = refreshOptions.limit || (settings.rules && settings.rules.scanLimit) || 4000;
      const signalInfo = await getDocumentChangeSignal();
      const checkedAt = new Date().toISOString();
      if (!signalInfo.ok) {
        if (existing && existing.ok !== false) {
          const staleCache = {
            ...existing,
            signalCheckedAt: checkedAt,
            lastSignalError: signalInfo.message || signalInfo.errmsg || "文档变更信号读取失败"
          };
          saveH5MonitorCache(staleCache);
          if (logger && typeof logger.warn === "function") {
            logger.warn("Dev progress H5 cache signal check failed, keep stale cache", {
              message: staleCache.lastSignalError,
              cachePath: H5_MONITOR_CACHE_RELATIVE_PATH
            });
          }
          return {
            ...staleCache,
            cacheMeta: h5CacheMeta(staleCache, { stale: true, signalError: staleCache.lastSignalError })
          };
        }
        return {
          ok: false,
          module: "devProgress",
          action: "h5_monitor_cache",
          message: signalInfo.message || signalInfo.errmsg || "文档变更信号读取失败",
          signal: signalInfo
        };
      }

      if (!force && existing && existing.ok !== false && existing.signal && existing.signal === signalInfo.signal) {
        const unchangedCache = {
          ...existing,
          signalCheckedAt: checkedAt,
          lastSignalError: ""
        };
        saveH5MonitorCache(unchangedCache);
        if (logger && typeof logger.info === "function") {
          logger.info("Dev progress H5 cache signal unchanged", {
            signal: signalInfo.signal,
            cachePath: H5_MONITOR_CACHE_RELATIVE_PATH
          });
        }
        return {
          ...unchangedCache,
          cacheMeta: h5CacheMeta(unchangedCache, { signalUnchanged: true })
        };
      }

      const scan = await runAnomalyScan({ limit });
      if (!scan.scanResult.ok) {
        if (existing && existing.ok !== false) {
          const staleCache = {
            ...existing,
            signalCheckedAt: checkedAt,
            lastRefreshError: scan.scanResult.text || scan.scanResult.message || "H5 监控缓存刷新失败"
          };
          saveH5MonitorCache(staleCache);
          if (logger && typeof logger.warn === "function") {
            logger.warn("Dev progress H5 cache refresh failed, keep stale cache", {
              message: staleCache.lastRefreshError,
              cachePath: H5_MONITOR_CACHE_RELATIVE_PATH
            });
          }
          return {
            ...staleCache,
            cacheMeta: h5CacheMeta(staleCache, { stale: true, refreshError: staleCache.lastRefreshError })
          };
        }
        return {
          ok: false,
          module: "devProgress",
          action: "h5_monitor_cache",
          message: scan.scanResult.text || scan.scanResult.message || "H5 监控缓存刷新失败",
          data: scan.scanResult
        };
      }

      const nextCache = buildH5MonitorCacheFromScan(
        scan.settings,
        scan.rules,
        scan.readResult,
        scan.scanResult,
        signalInfo,
        existing && existing.signal ? "signal_changed" : "cache_empty"
      );
      saveH5MonitorCache(nextCache);
      if (logger && typeof logger.info === "function") {
        logger.info("Dev progress H5 cache refreshed", {
          requiredItemCount: nextCache.stats.requiredItemCount,
          personTaskItemCount: nextCache.stats.personTaskItemCount,
          signal: nextCache.signal,
          cachePath: H5_MONITOR_CACHE_RELATIVE_PATH
        });
      }
      return {
        ...nextCache,
        cacheMeta: h5CacheMeta(nextCache, { refreshed: true })
      };
    })().finally(() => {
      h5MonitorRefreshPromise = null;
    });

    return h5MonitorRefreshPromise;
  }

  function scheduleH5MonitorCacheRefresh(options = {}) {
    refreshH5MonitorCache(options).catch((error) => {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Dev progress H5 cache background refresh failed", {
          message: error && error.message ? error.message : String(error || ""),
          cachePath: H5_MONITOR_CACHE_RELATIVE_PATH
        });
      }
    });
  }

  async function getH5MonitorCacheSnapshot(options = {}) {
    const settings = getDevProgressSettings();
    let cache = readH5MonitorCache();
    const force = Boolean(options.forceRefresh);
    const versionMismatch = Boolean(cache && cache.version !== H5_MONITOR_CACHE_VERSION);
    const needsRefresh = force || h5CacheNeedsSignalCheck(cache, settings);
    if (needsRefresh) {
      if (!cache || cache.ok === false || force || options.waitForRefresh || versionMismatch) {
        cache = await refreshH5MonitorCache({
          force: force || versionMismatch || !cache || cache.ok === false,
          limit: options.limit
        });
      } else {
        scheduleH5MonitorCacheRefresh({
          force: false,
          limit: options.limit
        });
      }
    }

    if (!cache || cache.ok === false) {
      return {
        ok: false,
        module: "devProgress",
        action: "h5_monitor_cache",
        message: cache && cache.errorMessage ? cache.errorMessage : "H5 监控缓存尚未生成"
      };
    }

    return {
      ...cache,
      cacheMeta: h5CacheMeta(cache, {
        refreshInProgress: Boolean(h5MonitorRefreshPromise),
        needsRefresh
      })
    };
  }

  async function scanAnomalies(scanOptions = {}) {
    const { settings, readResult, scanResult } = await runAnomalyScan(scanOptions);
    if (!scanResult.ok) {
      return scanResult;
    }

    return {
      ...scanResult,
      module: "devProgress",
      source: {
        docUrl: settings.docUrl || "",
        docid: settings.docid || "",
        sheetId: settings.sheetId || "",
        viewId: settings.viewId || ""
      },
      read: scanReadMeta(readResult)
    };
  }

  async function prepareRequiredFieldPush(scanOptions = {}) {
    const { settings, readResult, scanResult } = await runAnomalyScan(scanOptions);
    if (!scanResult.ok) {
      return scanResult;
    }

    const workflowRules = getDemandWorkflowRulesSettings().normalizedRules;
    const traceRequest = scanOptions.requiredFieldTrace && typeof scanOptions.requiredFieldTrace === "object"
      ? scanOptions.requiredFieldTrace
      : null;
    const traceRecordId = String(traceRequest && traceRequest.recordId || "").trim();
    const traceDemandId = String(traceRequest && traceRequest.demandId || "").trim();
    const traceRecords = traceRequest && traceRecordId && traceDemandId
      ? readResult.records.filter((record) => (
        String(record && record.recordId || "").trim() === traceRecordId
        && String(record && record.standard && record.standard.demandId || "").trim() === traceDemandId
      ))
      : [];
    const requiredFieldTrace = traceRequest ? {
      recordId: traceRecordId,
      demandId: traceDemandId,
      matchedRecordCount: traceRecords.length,
      records: traceRecords.map((record) => ({
        recordId: record.recordId,
        demandId: record.standard && record.standard.demandId || "",
        fieldDecisions: (() => {
          const seenFieldNames = new Set();
          return inspectRequiredFields(record, settings.rules || {}).filter((decision) => {
            if (seenFieldNames.has(decision.fieldName)) {
              return false;
            }
            seenFieldNames.add(decision.fieldName);
            return true;
          }).map((decision) => ({
          fieldName: decision.fieldName,
          rawValueType: decision.rawValueType,
          valueSource: decision.valueSource,
          normalizedValue: decision.normalizedValue,
            missing: decision.missing,
            reason: decision.reason
          }));
        })()
      }))
    } : null;
    const grouped = collectRequiredFieldPushGroups(scanResult, {
      roleLeaderNameMap: roleLeaderNameMapFromWorkflowRules(workflowRules)
    });
    const targetOverride = requiredFieldTargetOverride(scanOptions);
    const usesFieldRules = Array.isArray(settings.rules?.requiredFields?.fieldRules)
      && settings.rules.requiredFields.fieldRules.length > 0;
    const targets = [];
    const unresolved = [];
    const responsibilityTargets = [];
    const responsibilityUnresolved = [];

    for (const [ownerName, items] of grouped.groups.entries()) {
      const leaderRequiredFieldSet = leaderRequiredFieldSetForPerson(
        ownerName,
        settings.personAliases || {},
        undefined,
        settings.rules && settings.rules.requiredFields
      );
      const isFallbackOwner = requiredFieldFallbackOwners(settings).some((fallbackOwner) => personNameMatches(
        fallbackOwner,
        ownerName,
        settings.personAliases || {}
      ));
      const scopedItems = [];
      for (const item of items) {
        if (usesFieldRules && !requiredFieldItemIsFallback(item)) {
          mergeRequiredFieldItem(scopedItems, item);
        } else if (usesFieldRules || !requiredFieldItemIsFallback(item)) {
          const leaderItem = requiredFieldItemForLeaderScope(item, leaderRequiredFieldSet);
          if (leaderItem) {
            mergeRequiredFieldItem(scopedItems, leaderItem);
          }
        }
        if (isFallbackOwner) {
          const fallbackItem = requiredFieldItemForFallbackScope(item, leaderRequiredFieldSet);
          if (fallbackItem) {
            mergeRequiredFieldItem(scopedItems, fallbackItem);
          }
        }
      }
      if (scopedItems.length === 0) {
        if (logger && typeof logger.info === "function") {
          logger.info("Dev progress required-field recipient skipped", {
            ownerName,
            reason: isFallbackOwner ? "no_visible_fallback_fields" : "not_configured_leader_or_no_matching_fields",
            sourceItemCount: items.length,
            leaderRequiredFieldCount: leaderRequiredFieldSet.size,
            fallbackOwner: isFallbackOwner
          });
        }
        continue;
      }
      const resolved = await resolveSendTargetUserId(readResult.records, ownerName, settings, logger);
      if (!resolved.userId) {
        responsibilityUnresolved.push({
          ownerName,
          issueCount: scopedItems.length,
          errorMessage: resolved.errorMessage || ""
        });
        continue;
      }

      responsibilityTargets.push({
        ownerName,
        targetId: resolved.userId,
        targetSource: resolved.source || "",
        issueCount: scopedItems.length,
        taskCount: requiredFieldTaskCount(scopedItems),
        items: scopedItems,
        message: requiredFieldPushMessage(ownerName, scopedItems)
      });
    }

    if (targetOverride) {
      const items = [];
      for (const [ownerName, ownerItems] of grouped.groups.entries()) {
        for (const item of ownerItems) {
          items.push({
            ...item,
            originalOwnerName: ownerName
          });
        }
      }
      for (const item of grouped.noOwnerItems || []) {
        items.push({
          ...item,
          originalOwnerName: item.originalOwnerName || "未配置责任人"
        });
      }

      const resolved = await resolveSendTargetUserId(readResult.records, targetOverride.targetName, settings, logger);
      if (!resolved.userId) {
        unresolved.push({
          ownerName: targetOverride.targetName,
          issueCount: items.length,
          errorMessage: resolved.errorMessage || "",
          targetOverride: true
        });
      } else if (items.length > 0) {
        targets.push({
          ownerName: targetOverride.targetName,
          targetId: resolved.userId,
          targetSource: resolved.source || "",
          targetOverride: true,
          originalOwnerCount: grouped.groups.size,
          issueCount: items.length,
          taskCount: requiredFieldTaskCount(items),
          items,
          message: requiredFieldPushMessage(targetOverride.targetName, items)
        });
      }

      return {
        ...scanResult,
        module: "devProgress",
        action: "required_field_push",
        read: scanReadMeta(readResult),
        push: {
          targetCount: targets.length,
          unresolvedCount: unresolved.length,
          skippedNoOwnerCount: grouped.skippedNoOwnerCount,
          noOwnerItemCount: grouped.noOwnerItems.length,
          roleOwnerExpandedCount: grouped.roleOwnerExpandedCount,
          targetOverride,
          originalOwnerCount: grouped.groups.size,
          responsibilityTargets,
          responsibilityUnresolved,
          targets,
          unresolved
        },
        requiredFieldTrace
      };
    }

    targets.push(...responsibilityTargets);
    unresolved.push(...responsibilityUnresolved);

    return {
      ...scanResult,
      module: "devProgress",
      action: "required_field_push",
      read: scanReadMeta(readResult),
      push: {
        targetCount: targets.length,
        unresolvedCount: unresolved.length,
        skippedNoOwnerCount: grouped.skippedNoOwnerCount,
        roleOwnerExpandedCount: grouped.roleOwnerExpandedCount,
        responsibilityTargets,
        responsibilityUnresolved,
        targets,
        unresolved
      },
      requiredFieldTrace
    };
  }

  async function listRequiredFieldItems(readOptions = {}) {
    const settings = getDevProgressSettings();
    const userName = String(readOptions.userName || "").trim();
    if (!userName) {
      return {
        ok: false,
        module: "devProgress",
        action: "required_field_items",
        message: "userName 不能为空"
      };
    }

    const cache = await getH5MonitorCacheSnapshot({
      limit: readOptions.limit,
      forceRefresh: readOptions.forceRefresh,
      waitForRefresh: readOptions.waitForRefresh
    });
    if (!cache.ok) {
      return cache;
    }

    const projectName = String(readOptions.project || readOptions.projectName || "").trim();
    const projectFilter = projectName ? resolveVersionProjectFilter("", { projectName }, settings) : null;
    const scope = String(readOptions.scope || "").trim().toLowerCase();
    const fallbackOnly = scope === "fallback";
    const canReadFallbackScope = fallbackOnly
      ? canReadRequiredFieldFallbackScope(settings, userName)
      : true;
    if (fallbackOnly && !canReadFallbackScope) {
      return {
        ok: true,
        module: "devProgress",
        action: "required_field_items",
        userName,
        project: projectName,
        scope: "fallback",
        total: 0,
        items: [],
        cache: cache.cacheMeta || h5CacheMeta(cache),
        read: cache.read || null,
        generatedAt: cache.generatedAt || new Date().toISOString()
      };
    }
    const itemsOwnerName = requiredFieldItemsOwnerForScope(settings, userName, fallbackOnly);
    const ownerItems = (Array.isArray(cache.requiredItems) ? cache.requiredItems : [])
      .filter((item) => personNameMatches(item.ownerName, itemsOwnerName, settings.personAliases || {}))
      .filter((item) => projectMatchesFilter(item.project, projectFilter))
      .filter((item) => fallbackOnly ? true : !requiredFieldItemIsFallback(item));
    const leaderRequiredFieldSet = leaderRequiredFieldSetForPerson(
      userName,
      settings.personAliases || {},
      undefined,
      settings.rules && settings.rules.requiredFields
    );
    const fallbackLeaderItems = fallbackOnly
      ? fallbackLeaderViewItems(cache, settings, projectFilter)
      : [];
    const fallbackResidualItems = fallbackOnly
      ? ownerItems
        .map((item) => requiredFieldItemForFallbackScope(item, leaderRequiredFieldSet))
        .filter(Boolean)
        .map((item) => ({ ...item, leaderNames: [] }))
      : [];
    const leaderItems = fallbackOnly
      ? []
      : requiredFieldLeaderViewItems(cache, settings, userName, projectFilter);
    const directOwnerItems = fallbackOnly ? [] : ownerItems;
    const items = fallbackOnly
      ? [...fallbackLeaderItems, ...fallbackResidualItems]
      : [...directOwnerItems, ...leaderItems].reduce((result, item) => {
        mergeRequiredFieldItem(result, item);
        return result;
      }, []);

    if (logger && typeof logger.info === "function") {
      logger.info("Dev progress required-field access evaluated", {
        userName,
        itemsOwnerName,
        scope: fallbackOnly ? "fallback" : "field",
        project: projectName || "all",
        sourceItemCount: ownerItems.length,
        visibleItemCount: items.length,
        leaderRequiredFieldCount: leaderRequiredFieldSet.size,
        deniedNonLeader: !fallbackOnly && leaderRequiredFieldSet.size === 0,
        fallbackViewer: fallbackOnly && canReadFallbackScope,
        fallbackViewerCount: fallbackOnly ? requiredFieldFallbackViewerNames(settings).length : 0,
        fallbackLeaderFilterCount: fallbackOnly && Array.isArray(cache.fallbackLeaderFilters)
          ? cache.fallbackLeaderFilters.length
          : 0,
        fallbackLeaderScopedItemCount: fallbackLeaderItems.length,
        fallbackResidualItemCount: fallbackResidualItems.length,
        visibilitySource: fallbackOnly ? "requiredFieldLeaderViewItems+fallbackResidual" : "requiredFieldLeaderViewItems"
      });
    }

    return {
      ok: true,
      module: "devProgress",
      action: "required_field_items",
      userName,
      project: projectName,
      scope: fallbackOnly ? "fallback" : "field",
      total: items.length,
      items: sortH5TaskItems(items),
      leaderFilters: fallbackOnly && Array.isArray(cache.fallbackLeaderFilters)
        ? cache.fallbackLeaderFilters
        : [],
      cache: cache.cacheMeta || h5CacheMeta(cache),
      read: cache.read || null,
      generatedAt: cache.generatedAt || new Date().toISOString()
    };
  }

  async function listPersonTaskItems(readOptions = {}) {
    const settings = getDevProgressSettings();
    const userName = String(readOptions.userName || "").trim();
    if (!userName) {
      return {
        ok: false,
        module: "devProgress",
        action: "person_task_items",
        message: "userName 不能为空"
      };
    }

    const cache = await getH5MonitorCacheSnapshot({
      limit: readOptions.limit,
      forceRefresh: readOptions.forceRefresh,
      waitForRefresh: readOptions.waitForRefresh
    });
    if (!cache.ok) {
      return cache;
    }

    const projectName = String(readOptions.project || readOptions.projectName || "").trim();
    const projectFilter = projectName ? resolveVersionProjectFilter("", { projectName }, settings) : null;
    let excludedByProjectCount = 0;
    let excludedByLeaderRequiredCount = 0;
    const leaderBlockedTaskKeys = leaderRequiredBlockedTaskKeys(cache.requiredItems);
    const personTaskItems = (Array.isArray(cache.personTaskItems) ? cache.personTaskItems : [])
      .filter((item) => {
        const matched = projectMatchesFilter(item.project, projectFilter);
        if (!matched) {
          excludedByProjectCount += 1;
        }
        return matched;
      })
      .filter((item) => {
        const key = h5TaskKey(item);
        const blocked = key && leaderBlockedTaskKeys.has(key);
        if (blocked) {
          excludedByLeaderRequiredCount += 1;
        }
        return !blocked;
      })
      .map((item) => ({
        item,
        roles: matchingOwnerRoles({ standard: { owners: item.owners || {} } }, userName, settings.personAliases || {}, {
          allowedRoles: PERSONAL_TASK_OWNER_ROLES
        })
      }))
      .filter((item) => item.roles.length > 0)
      .map((item) => publicPersonTaskItemFromCache(item.item, item.roles));
    const items = sortH5TaskItems(personTaskItems);

    return {
      ok: true,
      module: "devProgress",
      action: "person_task_items",
      userName,
      project: projectName,
      total: items.length,
      items,
      filter: {
        rawRecordCount: cache.stats ? cache.stats.rawRecordCount : 0,
        excludedOnlineCount: cache.stats ? cache.stats.excludedOnlineCount : 0,
        excludedByProjectCount,
        excludedByLeaderRequiredCount,
        personTaskCount: personTaskItems.length,
        leaderBlockedTaskCount: leaderBlockedTaskKeys.size
      },
      cache: cache.cacheMeta || h5CacheMeta(cache),
      read: cache.read || null,
      generatedAt: cache.generatedAt || new Date().toISOString()
    };
  }

  async function listMemberTaskItems(readOptions = {}) {
    const settings = getDevProgressSettings();
    const userName = String(readOptions.userName || "").trim();
    if (!userName) {
      return {
        ok: false,
        module: "devProgress",
        action: "member_task_items",
        message: "userName 不能为空"
      };
    }

    const leaderRoles = leaderMemberScopesForPerson(userName, settings.personAliases || {});
    const cache = await getH5MonitorCacheSnapshot({
      limit: readOptions.limit,
      forceRefresh: readOptions.forceRefresh,
      waitForRefresh: readOptions.waitForRefresh
    });
    if (!cache.ok) {
      return cache;
    }

    const projectName = String(readOptions.project || readOptions.projectName || "").trim();
    const projectFilter = projectName ? resolveVersionProjectFilter("", { projectName }, settings) : null;
    let excludedByProjectCount = 0;
    let excludedByLeaderRequiredCount = 0;
    let skippedNoMemberCount = 0;
    const leaderBlockedTaskKeys = leaderRequiredBlockedTaskKeys(cache.requiredItems);
    const memberTaskItems = (Array.isArray(cache.personTaskItems) ? cache.personTaskItems : [])
      .filter((item) => {
        const matched = projectMatchesFilter(item.project, projectFilter);
        if (!matched) {
          excludedByProjectCount += 1;
        }
        return matched;
      })
      .filter((item) => {
        const key = h5TaskKey(item);
        const blocked = key && leaderBlockedTaskKeys.has(key);
        if (blocked) {
          excludedByLeaderRequiredCount += 1;
        }
        return !blocked;
      })
      .map((item) => {
        const match = memberTaskMatchForLeader(item, leaderRoles, settings.personAliases || {});
        if (!match) {
          skippedNoMemberCount += 1;
          return null;
        }
        return publicMemberTaskItemFromCache(item, match);
      })
      .filter(Boolean);
    const items = sortH5TaskItems(memberTaskItems);

    return {
      ok: true,
      module: "devProgress",
      action: "member_task_items",
      userName,
      project: projectName,
      total: items.length,
      items,
      leaderRoles: leaderRoles.map((role) => ({
        assigneeField: role.assigneeField,
        leaderField: role.leaderField,
        leaderNames: role.leaderNames,
        memberNames: role.memberNames,
        role: role.role
      })),
      filter: {
        rawRecordCount: cache.stats ? cache.stats.rawRecordCount : 0,
        excludedOnlineCount: cache.stats ? cache.stats.excludedOnlineCount : 0,
        excludedByProjectCount,
        excludedByLeaderRequiredCount,
        skippedNoMemberCount,
        memberTaskCount: memberTaskItems.length,
        leaderBlockedTaskCount: leaderBlockedTaskKeys.size
      },
      cache: cache.cacheMeta || h5CacheMeta(cache),
      read: cache.read || null,
      generatedAt: cache.generatedAt || new Date().toISOString()
    };
  }

  async function resolveExcelSendTargets(sendRequest, records, settings, sender) {
    const targets = [];
    const unresolvedTargetNames = [];
    const resolveErrors = [];
    for (const targetName of sendRequest.targetNames || []) {
      const resolved = await resolveSendTargetUserId(records, targetName, settings, logger);
      if (!resolved.userId) {
        unresolvedTargetNames.push(targetName);
        if (resolved.errorMessage) {
          resolveErrors.push(resolved.errorMessage);
        }
        continue;
      }
      targets.push({
        targetId: resolved.userId,
        targetLabel: targetName,
        targetSource: resolved.source
      });
    }

    if (unresolvedTargetNames.length > 0) {
      return {
        ok: false,
        reason: "unresolved_targets",
        targets,
        unresolvedTargetNames,
        resolveErrors
      };
    }

    if (sendRequest.sendToSelf || targets.length === 0) {
      if (sendRequest.sendToSelf && !sender.userId) {
        return {
          ok: false,
          reason: "self_target_missing",
          targets
        };
      }
      targets.push({
        targetId: sendRequest.sendToSelf ? sender.userId : "",
        targetLabel: sendRequest.sendToSelf ? "你" : conversationTargetLabel(sender),
        targetSource: sendRequest.sendToSelf ? "sender" : "conversation"
      });
    }

    return {
      ok: true,
      targets
    };
  }

  async function summarizeDemandDetails(readOptions = {}) {
    const settings = getDevProgressSettings();
    const rules = settings.rules || {};
    const sender = readOptions.sender || {};
    const params = {
      ...(readOptions.params || {}),
      sendExcel: true
    };
    if (params.sendToSelf !== true && !Array.isArray(params.sendTargetNames) && !params.sendTargetName && !params.targetName) {
      params.sendToConversation = true;
    }
    const timeRange = normalizeTimeRangeInput(readOptions.timeRange)
      || normalizeTimeRangeInput(params.timeRange)
      || parseVersionTimeRange(readOptions.text || "")
      || dayRange(new Date(), "今天");
    const sendRequest = parseVersionExcelSendRequest(readOptions.text || "", params);
    const result = await readRecordsForScan(settings, readOptions.limit || rules.detailScanLimit || rules.versionScanLimit || 5000);
    if (!result.ok) {
      return {
        ok: false,
        module: "devProgress",
        action: "demand_detail",
        text: `开发进度记录读取失败：${result.errcode || ""} ${result.errmsg || result.message || ""}`.trim(),
        data: result
      };
    }

    const timeStats = filterRecordsByVersionTimeRange(result.records, timeRange);
    const projectFilter = resolveVersionProjectFilter(readOptions.text || "", params, settings);
    const projectStats = filterRecordsByProject(timeStats.records, projectFilter);
    const summary = demandDetailSummaryFromRecords(projectStats.records);
    summary.rawScannedCount = Array.isArray(result.records) ? result.records.length : 0;
    summary.excludedByTimeCount = timeStats.excludedByTimeCount;
    summary.excludedByProjectCount = projectStats.excludedByProjectCount;
    summary.timeRange = timeRange;
    summary.projectFilter = projectFilter;

    let file = null;
    let files = [];
    let targets = [];
    if (sendRequest.sendExcel && summary.detailCount > 0) {
      const resolvedTargets = await resolveExcelSendTargets(sendRequest, result.records, settings, sender);
      if (!resolvedTargets.ok && resolvedTargets.reason === "unresolved_targets") {
        const errorText = resolvedTargets.resolveErrors.length > 0
          ? `\n通讯录查询提示：${resolvedTargets.resolveErrors[0]}`
          : "";
        return {
          ok: false,
          module: "devProgress",
          action: "demand_detail",
          text: `${demandDetailText(summary)}\n我没能识别“${resolvedTargets.unresolvedTargetNames.join("、")}”对应的企业微信账号。请确认姓名和企业微信通讯录一致，或让管理员给当前应用开通讯录读取权限。${errorText}`,
          data: {
            summary: {
              detailCount: summary.detailCount,
              rawScannedCount: summary.rawScannedCount,
              excludedByTimeCount: summary.excludedByTimeCount,
              excludedByProjectCount: summary.excludedByProjectCount,
              timeRange: summary.timeRange,
              projectFilter: summary.projectFilter
            },
            sendRequest: {
              sendExcel: true,
              targetName: sendRequest.targetName || "",
              targetNames: sendRequest.targetNames || [],
              sendToSelf: sendRequest.sendToSelf,
              sendToConversation: sendRequest.sendToConversation,
              targetResolved: false,
              unresolvedTargetNames: resolvedTargets.unresolvedTargetNames
            }
          }
        };
      }

      if (!resolvedTargets.ok && resolvedTargets.reason === "self_target_missing") {
        return {
          ok: false,
          module: "devProgress",
          action: "demand_detail",
          text: `${demandDetailText(summary)}\n我没识别到你的企业微信账号，暂时不能按“发送给我”私发。请让管理员检查机器人事件里的发送人账号。`,
          data: {
            sendRequest: {
              sendExcel: true,
              sendToSelf: true,
              targetResolved: false
            }
          }
        };
      }

      targets = resolvedTargets.targets;
      file = exportDemandDetailWorkbook(summary);
      files = targets.map((target) => ({
        ...file,
        targetId: target.targetId,
        targetLabel: target.targetLabel,
        targetSource: target.targetSource || ""
      }));
    }

    const targetLabel = targets.length > 0
      ? targets.map((target) => target.targetLabel).join("、")
      : "";

    return {
      ok: true,
      module: "devProgress",
      action: "demand_detail",
      text: demandDetailText(summary, {
        sendExcel: sendRequest.sendExcel && summary.detailCount > 0,
        targetLabel
      }),
      files,
      data: {
        summary: {
          detailCount: summary.detailCount,
          rawScannedCount: summary.rawScannedCount,
          excludedByTimeCount: summary.excludedByTimeCount,
          excludedByProjectCount: summary.excludedByProjectCount,
          timeRange: summary.timeRange,
          projectFilter: summary.projectFilter
        },
        canSendExcel: summary.detailCount > 0,
        exportFile: file ? {
          path: file.path,
          filename: file.filename
        } : null,
        sendRequest: {
          sendExcel: sendRequest.sendExcel && summary.detailCount > 0,
          targetName: sendRequest.targetName || "",
          targetNames: sendRequest.targetNames || [],
          sendToSelf: sendRequest.sendToSelf,
          sendToConversation: sendRequest.sendToConversation,
          targetResolved: true,
          targetLabels: targets.map((target) => target.targetLabel),
          targetLabel
        },
        read: {
          limit: result.limit,
          recordCount: result.recordCount,
          pageCount: result.pages ? result.pages.length : 1
        }
      }
    };
  }

  async function summarizeVersions(readOptions = {}) {
    const settings = getDevProgressSettings();
    const rules = settings.rules || {};
    const sender = readOptions.sender || {};
    const timeRange = normalizeTimeRangeInput(readOptions.timeRange) || parseVersionTimeRange(readOptions.text || "");
    const sendRequest = parseVersionExcelSendRequest(readOptions.text || "", readOptions.params || {});
    const result = await readRecordsForScan(settings, readOptions.limit || rules.versionScanLimit || 5000);
    if (!result.ok) {
      return {
        ok: false,
        module: "devProgress",
        action: "version_summary",
        text: `开发进度记录读取失败：${result.errcode || ""} ${result.errmsg || result.message || ""}`.trim(),
        data: result
      };
    }

    const filterStats = filterQueryableRecords(result.records, rules);
    const timeStats = filterRecordsByVersionTimeRange(filterStats.records, timeRange);
    const projectFilter = resolveVersionProjectFilter(readOptions.text || "", readOptions.params || {}, settings);
    const projectStats = filterRecordsByProject(timeStats.records, projectFilter);
    const summary = versionRowsFromRecords(projectStats.records);
    summary.rawScannedCount = filterStats.rawRecordCount;
    summary.excludedOnlineCount = filterStats.excludedOnlineCount;
    summary.excludedByTimeCount = timeStats.excludedByTimeCount;
    summary.excludedByProjectCount = projectStats.excludedByProjectCount;
    summary.timeRange = timeRange;
    summary.projectFilter = projectFilter;

    let file = null;
    let files = [];
    let targets = [];
    if (sendRequest.sendExcel && summary.versionCount > 0) {
      const unresolvedTargetNames = [];
      const resolveErrors = [];
      for (const targetName of sendRequest.targetNames || []) {
        const resolved = await resolveSendTargetUserId(result.records, targetName, settings, logger);
        if (!resolved.userId) {
          unresolvedTargetNames.push(targetName);
          if (resolved.errorMessage) {
            resolveErrors.push(resolved.errorMessage);
          }
          continue;
        }
        targets.push({
          targetId: resolved.userId,
          targetLabel: targetName,
          targetSource: resolved.source
        });
      }

      if (unresolvedTargetNames.length > 0) {
        const errorText = resolveErrors.length > 0
          ? `\n通讯录查询提示：${resolveErrors[0]}`
          : "";
        return {
          ok: false,
          module: "devProgress",
          action: "version_summary",
          text: `${versionSummaryText(summary)}\n我没能识别“${unresolvedTargetNames.join("、")}”对应的企业微信账号。请确认姓名和企业微信通讯录一致，或让管理员给当前应用开通讯录读取权限。${errorText}`,
          data: {
            summary: {
              versionCount: summary.versionCount,
              scannedCount: summary.scannedCount,
              rawScannedCount: summary.rawScannedCount,
              excludedOnlineCount: summary.excludedOnlineCount,
              excludedByTimeCount: summary.excludedByTimeCount,
              excludedByProjectCount: summary.excludedByProjectCount,
              timeRange: summary.timeRange,
              projectFilter: summary.projectFilter,
              unversionedCount: summary.unversionedCount
            },
            sendRequest: {
              sendExcel: true,
              targetName: sendRequest.targetName || "",
              targetNames: sendRequest.targetNames || [],
              sendToSelf: sendRequest.sendToSelf,
              sendToConversation: sendRequest.sendToConversation,
              targetResolved: false,
              unresolvedTargetNames
            }
          }
        };
      }

      if (sendRequest.sendToSelf || targets.length === 0) {
        if (sendRequest.sendToSelf && !sender.userId) {
          return {
            ok: false,
            module: "devProgress",
            action: "version_summary",
            text: `${versionSummaryText(summary)}\n我没识别到你的企业微信账号，暂时不能按“发送给我”私发。请让管理员检查机器人事件里的发送人账号。`,
            data: {
              sendRequest: {
                sendExcel: true,
                sendToSelf: true,
                targetResolved: false
              }
            }
          };
        }
        targets.push({
          targetId: sendRequest.sendToSelf ? sender.userId : "",
          targetLabel: sendRequest.sendToSelf ? "你" : conversationTargetLabel(sender),
          targetSource: sendRequest.sendToSelf ? "sender" : "conversation"
        });
      }

      file = exportVersionWorkbook(summary);
      files = targets.map((target) => ({
        ...file,
        targetId: target.targetId,
        targetLabel: target.targetLabel,
        targetSource: target.targetSource || ""
      }));
    }

    const targetLabel = targets.length > 0
      ? targets.map((target) => target.targetLabel).join("、")
      : "";

    return {
      ok: true,
      module: "devProgress",
      action: "version_summary",
      text: versionSummaryText(summary, {
        sendExcel: sendRequest.sendExcel,
        targetLabel
      }),
      files,
      data: {
        summary: {
          versionCount: summary.versionCount,
          scannedCount: summary.scannedCount,
          rawScannedCount: summary.rawScannedCount,
          excludedOnlineCount: summary.excludedOnlineCount,
          excludedByTimeCount: summary.excludedByTimeCount,
          excludedByProjectCount: summary.excludedByProjectCount,
          timeRange: summary.timeRange,
          projectFilter: summary.projectFilter,
          unversionedCount: summary.unversionedCount,
          versions: summary.versions.map((version) => ({
            version: version.version,
            taskCount: version.taskCount
          }))
        },
        canSendExcel: summary.versionCount > 0,
        exportFile: file ? {
          path: file.path,
          filename: file.filename
        } : null,
        sendRequest: {
          sendExcel: sendRequest.sendExcel && summary.versionCount > 0,
          targetName: sendRequest.targetName || "",
          targetNames: sendRequest.targetNames || [],
          sendToSelf: sendRequest.sendToSelf,
          sendToConversation: sendRequest.sendToConversation,
          targetResolved: true,
          targetLabels: targets.map((target) => target.targetLabel),
          targetLabel
        },
        read: {
          limit: result.limit,
          recordCount: result.recordCount,
          pageCount: result.pages ? result.pages.length : 1
        }
      }
    };
  }

  async function handle(context = {}) {
    const task = context.route && context.route.task ? context.route.task : {};
    const action = String((task && task.action) || context.intent || "").toLowerCase();
    if (action.includes("demand_detail")) {
      return summarizeDemandDetails({
        text: context.text,
        timeRange: task.params && task.params.timeRange ? task.params.timeRange : null,
        params: task.params || {},
        sender: context.sender || {}
      });
    }

    if (action.includes("version_summary") || /版本/.test(context.text || "")) {
      return summarizeVersions({
        text: context.text,
        timeRange: task.params && task.params.timeRange ? task.params.timeRange : null,
        params: task.params || {},
        sender: context.sender || {}
      });
    }

    if (action.includes("required_field_push")) {
      return prepareRequiredFieldPush();
    }

    if (action.includes("people_task_summary")) {
      return summarizePeople();
    }

    const settings = getDevProgressSettings();
    const personName = await extractPersonName(context, task, settings, logger);
    if (personName && (action.includes("person_task_count") || TASK_QUERY_PATTERN.test(context.text))) {
      return countByPerson(personName);
    }

    return {
      ok: false,
      module: "devProgress",
      text: context.sender && context.sender.userId
        ? "我还没有解析到你的中文姓名，暂时不能按“我”查询任务。你可以直接问：刘宇有几条任务？"
        : "开发进度模块已能读取智能表格记录。你可以问：刘宇有几条任务？"
    };
  }

  async function getStatus() {
    const settings = getDevProgressSettings();
    return {
      enabled: Boolean(settings.enabled),
      source: settings.source,
      ready: Boolean(settings.ready),
      sheetIdConfigured: Boolean(settings.sheetId),
      fieldMappingCount: Object.values(settings.fieldMapping || {}).filter(Boolean).length,
      monitor: settings.monitor
    };
  }

  return {
    name: "devProgress",
    handle,
    countByPerson,
    summarizePeople,
    summarizeVersions,
    summarizeDemandDetails,
    scanAnomalies,
    prepareRequiredFieldPush,
    listRequiredFieldItems,
    listPersonTaskItems,
    listMemberTaskItems,
    getDocumentChangeSignal,
    formatRequiredFieldPushMessage: requiredFieldPushMessage,
    exportRequiredFieldPushWorkbook,
    countRequiredFieldPushTasks: requiredFieldTaskCount,
    readRecords,
    previewRecords,
    getStatus
  };
}

module.exports = {
  createDevProgressModule,
  __test: {
    requiredFieldItemForLeaderScope,
    requiredFieldLeaderViewItems,
    fallbackLeaderViewItems,
    leaderRequiredFieldSetForPerson,
    canReadRequiredFieldFallbackScope,
    requiredFieldFallbackViewerNames,
    requiredFieldItemsOwnerForScope
  }
};
