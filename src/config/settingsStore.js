"use strict";

const fs = require("fs");
const path = require("path");
const { projectRoot } = require("../utils/paths");

const envPath = path.join(projectRoot, ".env");
const appConfigPath = path.join(projectRoot, "config", "app.config.json");
const appConfigExamplePath = path.join(projectRoot, "config", "app.config.example.json");
const modulesConfigPath = path.join(projectRoot, "config", "modules.config.json");
const modulesConfigExamplePath = path.join(projectRoot, "config", "modules.config.example.json");
const devProgressConfigPath = path.join(projectRoot, "config", "dev-progress.config.json");
const devProgressConfigExamplePath = path.join(projectRoot, "config", "dev-progress.config.example.json");
const demandWorkflowRulesPath = path.join(projectRoot, "config", "demand-workflow.rules.json");
const demandWorkflowRulesExamplePath = path.join(projectRoot, "config", "demand-workflow.rules.example.json");
const {
  normalizeDemandWorkflowRules,
  summarizeDemandWorkflowRules
} = require("../modules/demandWorkflow/rulesConfig");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function ensureAppConfig() {
  if (!fs.existsSync(appConfigPath)) {
    fs.copyFileSync(appConfigExamplePath, appConfigPath);
  }
  return readJson(appConfigPath);
}

function ensureModulesConfig() {
  if (!fs.existsSync(modulesConfigPath)) {
    fs.copyFileSync(modulesConfigExamplePath, modulesConfigPath);
  }
  return readJson(modulesConfigPath);
}

function hasLegacyDevProgressDetails(modulesConfig) {
  const legacy = modulesConfig && modulesConfig.modules && modulesConfig.modules.devProgress;
  if (!legacy || typeof legacy !== "object") {
    return false;
  }

  return Boolean(
    legacy.docUrl ||
    legacy.docid ||
    legacy.sheetId ||
    legacy.viewId ||
    legacy.fieldMapping ||
    legacy.rules ||
    legacy.personAliases
  );
}

function ensureDemandWorkflowRulesConfig() {
  if (!fs.existsSync(demandWorkflowRulesPath)) {
    fs.copyFileSync(demandWorkflowRulesExamplePath, demandWorkflowRulesPath);
  }
  return readJson(demandWorkflowRulesPath);
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const index = trimmed.indexOf("=");
  if (index <= 0) {
    return null;
  }

  return {
    key: trimmed.slice(0, index).trim(),
    value: trimmed.slice(index + 1)
  };
}

function readEnvValues() {
  const result = {};
  if (!fs.existsSync(envPath)) {
    return result;
  }

  const lines = fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const line of lines) {
    const entry = parseEnvLine(line);
    if (entry) {
      result[entry.key] = entry.value;
    }
  }
  return result;
}

function setEnvValues(updates) {
  const lines = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)
    : [];
  const remaining = { ...updates };
  const nextLines = lines.map((line) => {
    const entry = parseEnvLine(line);
    if (!entry || !Object.prototype.hasOwnProperty.call(remaining, entry.key)) {
      return line;
    }

    const value = remaining[entry.key];
    delete remaining[entry.key];
    return `${entry.key}=${value}`;
  });

  for (const [key, value] of Object.entries(remaining)) {
    nextLines.push(`${key}=${value}`);
  }

  const tempPath = `${envPath}.tmp`;
  fs.writeFileSync(tempPath, `${nextLines.filter((line, index) => line !== "" || index < nextLines.length - 1).join("\r\n")}\r\n`, "utf8");
  fs.renameSync(tempPath, envPath);
}

function secretValue(env, envName, directValue = "") {
  return env[envName] || process.env[envName] || directValue || "";
}

function getRobotSettings(options = {}) {
  const appConfig = fs.existsSync(appConfigPath) ? readJson(appConfigPath) : readJson(appConfigExamplePath);
  const env = readEnvValues();
  const robot = appConfig.robot || {};
  const outboundTest = robot.outboundTest || {};
  const feedbackCard = robot.feedbackCard || {};
  const botIdEnv = robot.botIdEnv || "WECOM_SMART_BOT_ID";
  const secretEnv = robot.secretEnv || "WECOM_SMART_BOT_SECRET";

  return {
    enabled: Boolean(robot.enabled),
    provider: robot.provider || "wecom-smart-bot",
    botIdEnv,
    secretEnv,
    botIdConfigured: Boolean(secretValue(env, botIdEnv, robot.botId)),
    secretConfigured: Boolean(secretValue(env, secretEnv, robot.secret)),
    botId: options.includeSecrets ? secretValue(env, botIdEnv, robot.botId) : "",
    secret: options.includeSecrets ? secretValue(env, secretEnv, robot.secret) : "",
    welcomeText: robot.welcomeText || "",
    feedbackCard: {
      mode: ["disabled", "private_only", "all_chats"].includes(feedbackCard.mode)
        ? feedbackCard.mode
        : "private_only",
      cooldownMinutes: Number.isFinite(Number(feedbackCard.cooldownMinutes))
        ? Math.max(0, Number(feedbackCard.cooldownMinutes))
        : 10
    },
    outboundTest: {
      targetType: outboundTest.targetType === "group" ? "group" : "user",
      targetId: outboundTest.targetId || "",
      message: outboundTest.message || "EA系统主动推送测试。"
    }
  };
}

function getBasicSettings() {
  const appConfig = fs.existsSync(appConfigPath) ? readJson(appConfigPath) : readJson(appConfigExamplePath);
  return {
    server: {
      host: appConfig.server && appConfig.server.host ? appConfig.server.host : "127.0.0.1",
      port: Number(appConfig.server && appConfig.server.port ? appConfig.server.port : 39200)
    },
    runtime: {
      name: appConfig.runtime && appConfig.runtime.name ? appConfig.runtime.name : "Win10 company host",
      logLevel: appConfig.runtime && appConfig.runtime.logLevel ? appConfig.runtime.logLevel : "info"
    }
  };
}

function getAiSettings(options = {}) {
  const appConfig = fs.existsSync(appConfigPath) ? readJson(appConfigPath) : readJson(appConfigExamplePath);
  const env = readEnvValues();
  const ai = appConfig.ai || {};
  const providers = normalizeAiProviders(ai);
  const provider = providers[ai.provider] ? ai.provider : "deepseek";
  const current = providers[provider];
  return {
    enabled: Boolean(ai.enabled),
    provider,
    providers: Object.fromEntries(Object.entries(providers).map(([key, value]) => [
      key,
      {
        label: value.label,
        baseUrl: value.baseUrl,
        model: value.model,
        apiKeyEnv: value.apiKeyEnv,
        apiKeyConfigured: Boolean(secretValue(env, value.apiKeyEnv)),
        apiKey: options.includeSecrets ? secretValue(env, value.apiKeyEnv) : ""
      }
    ])),
    baseUrl: current.baseUrl,
    model: current.model,
    apiKeyEnv: current.apiKeyEnv,
    apiKeyConfigured: Boolean(secretValue(env, current.apiKeyEnv, ai.apiKey)),
    apiKey: options.includeSecrets ? secretValue(env, current.apiKeyEnv, ai.apiKey) : ""
  };
}

function normalizeAiProviders(ai) {
  const providers = ai.providers || {};
  const deepseek = providers.deepseek || {};
  const openaiCompatible = providers["openai-compatible"] || {};
  const customCompatible = providers["custom-compatible"] || {};

  return {
    deepseek: {
      label: deepseek.label || "DeepSeek",
      baseUrl: deepseek.baseUrl || ai.baseUrl || "https://api.deepseek.com",
      model: deepseek.model || ai.model || "deepseek-v4-flash",
      apiKeyEnv: deepseek.apiKeyEnv || ai.apiKeyEnv || "DEEPSEEK_API_KEY"
    },
    "openai-compatible": {
      label: openaiCompatible.label || "OpenAI 兼容",
      baseUrl: openaiCompatible.baseUrl || "https://api.openai.com",
      model: openaiCompatible.model || "gpt-4o-mini",
      apiKeyEnv: openaiCompatible.apiKeyEnv || "OPENAI_API_KEY"
    },
    "custom-compatible": {
      label: customCompatible.label || "自定义兼容接口",
      baseUrl: customCompatible.baseUrl || "",
      model: customCompatible.model || "",
      apiKeyEnv: customCompatible.apiKeyEnv || "LLM_CUSTOM_API_KEY"
    }
  };
}

function defaultDevProgressConfig() {
  return {
    enabled: false,
    name: "开发进度监控",
    source: "wecom-smartsheet",
    docUrl: "",
    docid: "",
    sheetId: "",
    viewId: "",
    keyType: "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    limit: 100,
    cacheMinutes: 5,
    auth: {
      corpIdEnv: "WECOM_DOC_CORP_ID",
      agentIdEnv: "WECOM_DOC_AGENT_ID",
      secretEnv: "WECOM_DOC_SECRET"
    },
    fieldMapping: {
      demandId: "",
      project: "",
      demand: "",
      demandContent: "",
      demandType: "",
      owner: "",
      status: "",
      progress: "",
      planDate: "",
      blockers: "",
      updatedAt: "",
      remarks: "",
      frontendOwner: "",
      backendOwner: "",
      frontendRemaining: "",
      backendRemaining: "",
      uiOwner: "",
      plannerOwner: "",
      testerOwner: "",
      effectOwner: "",
      plannerLead: "",
      uiLead: "",
      effectLead: "",
      frontendLead: "",
      backendLead: "",
      testerLead: "",
      devDeadline: "",
      testDeadline: "",
      acceptanceDeadline: "",
      releaseDate: "",
      groupChat: "",
      demandLink: ""
    },
    personAliases: {},
    rules: {
      scanLimit: 2000,
      scanStartDate: "",
      excludedProjects: [],
      completedStatusKeywords: ["完成", "已上线", "已验收", "结束"],
      onlineStatusKeywords: ["已上线", "上线完成"],
      ignoredStatusKeywords: ["取消", "暂停", "暂缓", "废弃", "不做"],
      overdue: {
        enabled: true
      },
      stale: {
        enabled: false,
        days: 3
      },
      remainingNearDeadline: {
        enabled: true,
        days: 2,
        minimum: 0
      },
      missingOwner: {
        enabled: false,
        requiredRoles: ["planner"]
      },
      requiredFields: {
        enabled: false,
        cumulative: true,
        items: []
      }
    }
  };
}

function defaultBugCollectionConfig() {
  return {
    enabled: false,
    name: "需求和 Bug 收集",
    source: "wecom-smartsheet",
    docUrl: "",
    docid: "",
    docLinkId: "",
    sheetId: "",
    viewId: "",
    keyType: "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    createDoc: {
      docName: "EA需求和Bug收集",
      spaceId: "",
      fatherId: "",
      adminUsers: [],
      shareAfterCreate: true
    },
    auth: {
      corpIdEnv: "WECOM_DOC_CORP_ID",
      agentIdEnv: "WECOM_DOC_AGENT_ID",
      secretEnv: "WECOM_DOC_SECRET"
    },
    fieldMapping: {
      taskId: "任务ID",
      issueType: "类型",
      title: "标题",
      description: "描述",
      screenshot: "截图",
      submitter: "提交人",
      createdAt: "创建时间",
      updatedAt: "更新时间"
    }
  };
}

function normalizePersonAliases(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const result = {};
  for (const [name, value] of Object.entries(input)) {
    const personName = String(name || "").trim();
    if (!personName) {
      continue;
    }

    const aliases = Array.isArray(value) ? value : String(value || "").split(/[、,，/\\|;；\s]+/);
    const normalizedAliases = [...new Set(aliases.map((item) => String(item || "").trim()).filter(Boolean))];
    if (normalizedAliases.length > 0) {
      result[personName] = normalizedAliases;
    }
  }
  return result;
}

function parsePersonAliasesText(text) {
  const result = {};
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const personName = trimmed.slice(0, separatorIndex).trim();
    const aliases = trimmed.slice(separatorIndex + 1)
      .split(/[、,，/\\|;；\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (personName && aliases.length > 0) {
      result[personName] = [...new Set(aliases)];
    }
  }
  return result;
}

function parseListText(text, fallback = []) {
  if (Array.isArray(text)) {
    return text.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof text !== "string") {
    return fallback;
  }
  const result = text
    .split(/[\r\n,，、|;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return result.length > 0 ? result : fallback;
}

function normalizeRequiredFieldNames(value) {
  if (typeof value === "string") {
    return [...new Set(value
      .split(/[\r\n,，、|;；\s]+/)
      .map((item) => item.trim())
      .filter(Boolean))];
  }
  return [...new Set(parseListText(value, []))];
}

function normalizeRequiredRuleOwner(rule) {
  const value = rule.owner !== undefined
    ? rule.owner
    : (rule.ownerName !== undefined
      ? rule.ownerName
      : (rule.responsiblePerson !== undefined ? rule.responsiblePerson : rule["负责人"]));
  if (Array.isArray(value)) {
    return parseListText(value, []).join("、");
  }
  return String(value || "").trim();
}

function normalizeRequiredFieldFilterValues(value) {
  return normalizeRequiredFieldNames(value);
}

function normalizeRequiredFieldFilterWhen(input) {
  const current = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const when = {};

  const demandTypes = normalizeRequiredFieldFilterValues(current.demandTypes);
  if (demandTypes.length > 0) {
    when.demandTypes = demandTypes;
  }

  const statuses = normalizeRequiredFieldFilterValues(current.statuses);
  if (statuses.length > 0) {
    when.statuses = statuses;
  }

  const rawFieldValues = current.fieldValues || current.fieldEquals || {};
  const fieldValues = {};
  if (rawFieldValues && typeof rawFieldValues === "object" && !Array.isArray(rawFieldValues)) {
    for (const [fieldName, expectedValues] of Object.entries(rawFieldValues)) {
      const normalizedFieldName = String(fieldName || "").trim();
      const normalizedValues = normalizeRequiredFieldFilterValues(expectedValues);
      if (normalizedFieldName && normalizedValues.length > 0) {
        fieldValues[normalizedFieldName] = normalizedValues;
      }
    }
  }
  if (Object.keys(fieldValues).length > 0) {
    when.fieldValues = fieldValues;
  }

  return when;
}

function normalizeRequiredFieldFilters(value) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((item) => {
      const filter = item && typeof item === "object" ? item : {};
      const when = normalizeRequiredFieldFilterWhen(filter.when || filter);
      const owners = normalizeRequiredFieldNames(filter.owners || filter.ownerNames || filter.owner);
      const fields = normalizeRequiredFieldNames(filter.fields || filter.requiredFields);
      return {
        title: String(filter.title || "").trim(),
        when,
        owners,
        fields
      };
    })
    .filter((filter) => filter.fields.length > 0 && (
      filter.owners.length > 0
      || Object.keys(filter.when).length > 0
    ));
}

function readProjectRuleFile(relativePath) {
  const normalizedPath = String(relativePath || "").trim().replace(/\\/g, "/");
  if (!normalizedPath || path.isAbsolute(normalizedPath)) {
    throw new Error("需求监控规则文件必须使用项目内相对路径");
  }
  const resolvedPath = path.resolve(projectRoot, normalizedPath);
  const relativeToProject = path.relative(projectRoot, resolvedPath);
  if (!relativeToProject || relativeToProject.startsWith("..") || path.isAbsolute(relativeToProject)) {
    throw new Error("需求监控规则文件必须位于 EA 项目目录内");
  }
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`需求监控规则文件不存在：${normalizedPath}`);
  }
  return {
    relativePath: normalizedPath,
    value: readJson(resolvedPath)
  };
}

function normalizeRuleCondition(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const nestedConditions = (conditions) => (Array.isArray(conditions) ? conditions : [])
    .map(normalizeRuleCondition)
    .filter((condition) => condition.field || condition.any.length > 0 || condition.all.length > 0);
  return {
    field: String(input.field || "").trim(),
    equals: normalizeRequiredFieldNames(input.equals),
    notEquals: normalizeRequiredFieldNames(input.notEquals),
    requireSourceValue: input.requireSourceValue !== false,
    any: nestedConditions(input.any),
    all: nestedConditions(input.all)
  };
}

function normalizeDeadlineField(value) {
  if (typeof value === "string") {
    return { field: value.trim(), transform: "" };
  }
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    field: String(input.field || "").trim(),
    transform: String(input.transform || "").trim()
  };
}

function normalizeFieldValidation(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const base = input.base && typeof input.base === "object" && !Array.isArray(input.base)
    ? input.base
    : {};
  const maximum = input.maximum === undefined || input.maximum === null || input.maximum === ""
    ? null
    : Number(input.maximum);
  return {
    type: String(input.type || "").trim(),
    startStatus: String(input.startStatus || "").trim(),
    endStatus: String(input.endStatus || "").trim(),
    values: normalizeRequiredFieldNames(input.values),
    maximum: Number.isFinite(maximum) ? maximum : null,
    amountField: String(input.amountField || "").trim(),
    base: {
      type: String(base.type || "").trim(),
      field: String(base.field || "").trim()
    },
    deadlineFields: (Array.isArray(input.deadlineFields) ? input.deadlineFields : [])
      .map(normalizeDeadlineField)
      .filter((item) => item.field)
  };
}

function normalizeFieldMonitorRules(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => {
      const input = item && typeof item === "object" && !Array.isArray(item) ? item : {};
      return {
        field: String(input.field || "").trim(),
        startStatus: String(input.startStatus || "").trim(),
        endStatus: String(input.endStatus || "").trim(),
        monitorGroups: normalizeRequiredFieldNames(input.monitorGroups),
        required: Boolean(input.required),
        excludedDemandTypes: normalizeRequiredFieldNames(input.excludedDemandTypes),
        when: normalizeRuleCondition(input.when),
        leaderRole: String(input.leaderRole || "").trim(),
        memberFields: normalizeRequiredFieldNames(input.memberFields),
        validations: (Array.isArray(input.validations) ? input.validations : [])
          .map(normalizeFieldValidation)
          .filter((validation) => validation.type)
      };
    })
    .filter((item) => item.field && item.startStatus);
}

function normalizeRequiredFieldStatusGroups(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(input)
    .map(([groupName, statuses]) => [
      String(groupName || "").trim(),
      normalizeRequiredFieldNames(statuses)
    ])
    .filter(([groupName, statuses]) => groupName && statuses.length > 0));
}

function normalizeRuleLeaders(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(input)
    .map(([roleName, roleValue]) => {
      const role = roleValue && typeof roleValue === "object" && !Array.isArray(roleValue) ? roleValue : {};
      return [String(roleName || "").trim(), {
        names: normalizeRequiredFieldNames(role.names),
        sourceField: String(role.sourceField || "").trim()
      }];
    })
    .filter(([roleName]) => roleName));
}

function defaultRequiredFieldsRules() {
  return {
    enabled: false,
    mode: "legacyMatrix",
    ruleFile: "",
    cumulative: true,
    fallbackOwner: "王谦",
    fallbackOwners: ["王谦"],
    fieldFilters: [],
    items: [],
    version: "",
    source: "",
    sourceVersion: "",
    stageInclusive: true,
    statusSequence: [],
    statusGroups: {},
    excludedDemandTypes: [],
    calendar: {
      sheetName: "工作日",
      dateField: "日期",
      cacheMinutes: 15
    },
    leaders: {},
    fieldRules: []
  };
}

function normalizeRequiredFieldsRules(input, baseRule = defaultRequiredFieldsRules()) {
  const original = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const configuredRuleFile = String(original.ruleFile || baseRule.ruleFile || "").trim();
  const loadedRuleFile = configuredRuleFile ? readProjectRuleFile(configuredRuleFile) : null;
  const current = loadedRuleFile
    ? {
      ...loadedRuleFile.value,
      enabled: original.enabled !== undefined ? Boolean(original.enabled) : Boolean(loadedRuleFile.value.enabled),
      ruleFile: loadedRuleFile.relativePath
    }
    : original;
  const sourceItems = Array.isArray(input)
    ? input
    : (Array.isArray(current.items) ? current.items : []);
  const items = sourceItems
    .map((item) => {
      const rule = item && typeof item === "object" ? item : {};
      return {
        demandType: String(rule.demandType || "").trim(),
        status: String(rule.status || "").trim(),
        owner: normalizeRequiredRuleOwner(rule),
        requiredFields: normalizeRequiredFieldNames(rule.requiredFields)
      };
    })
    .filter((item) => item.demandType && item.status && item.requiredFields.length > 0);

  const calendar = current.calendar && typeof current.calendar === "object" && !Array.isArray(current.calendar)
    ? current.calendar
    : {};
  const fieldRules = normalizeFieldMonitorRules(current.fieldRules);
  const fallbackOwners = normalizeRequiredFieldNames(
    current.fallbackOwners !== undefined
      ? current.fallbackOwners
      : (current.fallbackOwner || baseRule.fallbackOwners || baseRule.fallbackOwner || "王谦")
  );
  return {
    enabled: current.enabled !== undefined ? Boolean(current.enabled) : Boolean(baseRule.enabled),
    mode: fieldRules.length > 0 ? "fieldRulesV2" : String(current.mode || baseRule.mode || "legacyMatrix").trim(),
    ruleFile: configuredRuleFile,
    cumulative: current.cumulative !== undefined ? Boolean(current.cumulative) : baseRule.cumulative !== false,
    fallbackOwner: fallbackOwners[0] || "王谦",
    fallbackOwners,
    fieldFilters: normalizeRequiredFieldFilters(current.fieldFilters || baseRule.fieldFilters),
    items,
    version: String(current.version || "").trim(),
    source: String(current.source || "").trim(),
    sourceVersion: String(current.sourceVersion || "").trim(),
    stageInclusive: current.stageInclusive !== false,
    statusSequence: normalizeRequiredFieldNames(current.statusSequence),
    statusGroups: normalizeRequiredFieldStatusGroups(current.statusGroups),
    excludedDemandTypes: normalizeRequiredFieldNames(current.excludedDemandTypes),
    calendar: {
      sheetName: String(calendar.sheetName || "工作日").trim(),
      dateField: String(calendar.dateField || "日期").trim(),
      cacheMinutes: Math.max(1, Number(calendar.cacheMinutes || 15))
    },
    leaders: normalizeRuleLeaders(current.leaders),
    fieldRules
  };
}

function parseRequiredFieldsRulesText(text, fallback = defaultRequiredFieldsRules()) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return normalizeRequiredFieldsRules(fallback, defaultRequiredFieldsRules());
  }

  try {
    const parsed = JSON.parse(trimmed);
    const candidate = Array.isArray(parsed)
      ? { ...fallback, items: parsed }
      : parsed;
    return normalizeRequiredFieldsRules(candidate, fallback);
  } catch (error) {
    throw new Error(`监控字段必填规则 JSON 格式错误：${error.message}`);
  }
}

function normalizeDevProgressRules(input, baseRules = defaultDevProgressConfig().rules) {
  const current = input && typeof input === "object" ? input : {};
  const stale = current.stale || {};
  const remainingNearDeadline = current.remainingNearDeadline || {};
  const missingOwner = current.missingOwner || {};
  const scanLimit = Number(current.scanLimit || baseRules.scanLimit || 2000);
  const staleDays = Number(stale.days || baseRules.stale.days || 3);
  const nearDeadlineDays = Number(remainingNearDeadline.days || baseRules.remainingNearDeadline.days || 2);
  const remainingMinimum = Number(
    remainingNearDeadline.minimum !== undefined
      ? remainingNearDeadline.minimum
      : baseRules.remainingNearDeadline.minimum
  );

  return {
    scanLimit: Number.isFinite(scanLimit) ? Math.max(1, Math.min(scanLimit, 5000)) : 2000,
    scanStartDate: typeof current.scanStartDate === "string"
      ? current.scanStartDate.trim()
      : (typeof baseRules.scanStartDate === "string" ? baseRules.scanStartDate.trim() : ""),
    excludedProjects: parseListText(current.excludedProjects, baseRules.excludedProjects || []),
    completedStatusKeywords: parseListText(current.completedStatusKeywords, baseRules.completedStatusKeywords),
    onlineStatusKeywords: parseListText(current.onlineStatusKeywords, baseRules.onlineStatusKeywords || ["已上线", "上线完成"]),
    ignoredStatusKeywords: parseListText(current.ignoredStatusKeywords, baseRules.ignoredStatusKeywords),
    overdue: {
      enabled: current.overdue && current.overdue.enabled !== undefined
        ? Boolean(current.overdue.enabled)
        : Boolean(baseRules.overdue.enabled)
    },
    stale: {
      enabled: stale.enabled !== undefined ? Boolean(stale.enabled) : Boolean(baseRules.stale.enabled),
      days: Number.isFinite(staleDays) ? Math.max(1, staleDays) : 3
    },
    remainingNearDeadline: {
      enabled: remainingNearDeadline.enabled !== undefined
        ? Boolean(remainingNearDeadline.enabled)
        : Boolean(baseRules.remainingNearDeadline.enabled),
      days: Number.isFinite(nearDeadlineDays) ? Math.max(0, nearDeadlineDays) : 2,
      minimum: Number.isFinite(remainingMinimum) ? Math.max(0, remainingMinimum) : 0
    },
    missingOwner: {
      enabled: missingOwner.enabled !== undefined ? Boolean(missingOwner.enabled) : Boolean(baseRules.missingOwner.enabled),
      requiredRoles: parseListText(missingOwner.requiredRoles, baseRules.missingOwner.requiredRoles)
    },
    requiredFields: normalizeRequiredFieldsRules(current.requiredFields, baseRules.requiredFields || defaultRequiredFieldsRules())
  };
}

function normalizeDevProgressConfig(modulesConfig) {
  const base = defaultDevProgressConfig();
  const modules = modulesConfig.modules || {};
  const current = modules.devProgress || modulesConfig || {};
  const auth = current.auth || {};
  const fieldMapping = current.fieldMapping || {};

  return {
    ...base,
    ...current,
    auth: {
      ...base.auth,
      ...auth
    },
    fieldMapping: {
      ...base.fieldMapping,
      ...fieldMapping
    },
    personAliases: normalizePersonAliases(current.personAliases || base.personAliases),
    rules: normalizeDevProgressRules(current.rules, base.rules)
  };
}

function buildDevProgressConfigFromModules(modulesConfig) {
  const devProgress = normalizeDevProgressConfig(modulesConfig || {});
  const monitor = normalizeDevProgressMonitor(modulesConfig || {});
  return {
    ...devProgress,
    monitor
  };
}

function readDevProgressConfig() {
  if (fs.existsSync(devProgressConfigPath)) {
    return readJson(devProgressConfigPath);
  }

  const modulesConfig = fs.existsSync(modulesConfigPath)
    ? readJson(modulesConfigPath)
    : (fs.existsSync(modulesConfigExamplePath) ? readJson(modulesConfigExamplePath) : {});

  if (hasLegacyDevProgressDetails(modulesConfig)) {
    return buildDevProgressConfigFromModules(modulesConfig);
  }

  if (fs.existsSync(devProgressConfigExamplePath)) {
    return readJson(devProgressConfigExamplePath);
  }

  return buildDevProgressConfigFromModules(modulesConfig);
}

function ensureDevProgressConfig() {
  const config = readDevProgressConfig();
  if (!fs.existsSync(devProgressConfigPath)) {
    writeJsonAtomic(devProgressConfigPath, config);
  }
  return config;
}

function normalizeBugCollectionConfig(modulesConfig) {
  const base = defaultBugCollectionConfig();
  const modules = modulesConfig.modules || {};
  const current = modules.bugCollection || {};
  const auth = current.auth || {};
  const fieldMapping = current.fieldMapping || {};
  const createDoc = current.createDoc || {};
  return {
    ...base,
    ...current,
    createDoc: {
      ...base.createDoc,
      ...createDoc,
      adminUsers: parseListText(createDoc.adminUsers, base.createDoc.adminUsers),
      shareAfterCreate: createDoc.shareAfterCreate !== undefined ? Boolean(createDoc.shareAfterCreate) : true
    },
    auth: {
      ...base.auth,
      ...auth
    },
    fieldMapping: {
      ...base.fieldMapping,
      ...fieldMapping
    }
  };
}

function normalizeDevProgressMonitor(modulesConfig) {
  const monitor = modulesConfig.monitors && modulesConfig.monitors.devProgress
    ? modulesConfig.monitors.devProgress
    : (modulesConfig.monitor || {});
  const requiredFieldsPush = monitor.requiredFieldsPush || {};
  const groupCard = requiredFieldsPush.groupCard || {};
  const pilot = requiredFieldsPush.pilot || {};
  const changeDetection = monitor.changeDetection || {};
  return {
    enabled: Boolean(monitor.enabled),
    mode: monitor.mode || "poll-wecom-smartsheet",
    intervalMinutes: Number(monitor.intervalMinutes || 1),
    notifyThroughCenter: monitor.notifyThroughCenter !== undefined ? Boolean(monitor.notifyThroughCenter) : true,
    changeDetection: {
      enabled: changeDetection.enabled !== undefined ? Boolean(changeDetection.enabled) : true,
      quietMinutes: Number(changeDetection.quietMinutes || 3),
      minScanIntervalMinutes: Number(changeDetection.minScanIntervalMinutes || 5),
      scanOnFirstRun: Boolean(changeDetection.scanOnFirstRun),
      scanOnSignalError: changeDetection.scanOnSignalError !== undefined ? Boolean(changeDetection.scanOnSignalError) : true
    },
    requiredFieldsPush: {
      enabled: requiredFieldsPush.enabled !== undefined ? Boolean(requiredFieldsPush.enabled) : true,
      cooldownMinutes: Number(requiredFieldsPush.cooldownMinutes || 1440),
      scanLimit: Number(requiredFieldsPush.scanLimit || 2000),
      maxTargetsPerTick: Number(requiredFieldsPush.maxTargetsPerTick || 20),
      runOnStart: Boolean(requiredFieldsPush.runOnStart),
      testMode: Boolean(requiredFieldsPush.testMode),
      testTargetName: typeof requiredFieldsPush.testTargetName === "string"
        ? requiredFieldsPush.testTargetName.trim()
        : "",
      testVerifyDelaySeconds: Math.max(1, Number(requiredFieldsPush.testVerifyDelaySeconds || 30)),
      testNextTaskDelaySeconds: Math.max(1, Number(requiredFieldsPush.testNextTaskDelaySeconds || 600)),
      groupCard: {
        enabled: groupCard.enabled !== undefined ? Boolean(groupCard.enabled) : true,
        maxCardsPerTick: Number(groupCard.maxCardsPerTick || 1),
        remindMinutes: Number(groupCard.remindMinutes || 30)
      },
      pilot: {
        enabled: Boolean(pilot.enabled),
        targetName: typeof pilot.targetName === "string" ? pilot.targetName.trim() : "",
        remindMinutes: Number(pilot.remindMinutes || 30),
        summaryMinutes: Number(pilot.summaryMinutes || 60),
        maxActiveTasks: Math.max(1, Number(pilot.maxActiveTasks || 1)),
        focusDemandIds: Array.isArray(pilot.focusDemandIds)
          ? pilot.focusDemandIds.map((item) => String(item || "").trim()).filter(Boolean)
          : []
      }
    }
  };
}

function extractSmartSheetUrlParts(docUrl) {
  if (typeof docUrl !== "string" || !docUrl.trim()) {
    return {};
  }

  try {
    const url = new URL(docUrl.trim());
    const parts = url.pathname.split("/").filter(Boolean);
    const typeIndex = parts.findIndex((part) => part === "smartsheet" || part === "sheet");
    return {
      docid: typeIndex >= 0 && parts[typeIndex + 1] ? parts[typeIndex + 1] : "",
      tabId: url.searchParams.get("tab") || "",
      viewId: url.searchParams.get("viewId") || ""
    };
  } catch (error) {
    return {};
  }
}

function getRankSettings() {
  const modulesConfig = fs.existsSync(modulesConfigPath) ? readJson(modulesConfigPath) : readJson(modulesConfigExamplePath);
  const rank = modulesConfig.modules && modulesConfig.modules.rank ? modulesConfig.modules.rank : {};
  const monitor = modulesConfig.monitors && modulesConfig.monitors.rank ? modulesConfig.monitors.rank : {};
  return {
    enabled: Boolean(rank.enabled),
    name: rank.name || "小游戏榜单监控模块",
    pathEnv: rank.pathEnv || "",
    path: rank.path || "src/modules/rank/embedded-wx-mini-rank-monitor",
    configPath: rank.configPath || "config/rank.config.json",
    statePath: rank.statePath || "data/rank/state.json",
    historyPath: rank.historyPath || "data/rank/history/rank_history.csv",
    configFile: rank.configFile || "config.json",
    historyCsv: rank.historyCsv || "data/history/rank_history.csv",
    monitor: {
      enabled: Boolean(monitor.enabled),
      intervalMinutes: Number(monitor.intervalMinutes || 60),
      notifyThroughCenter: Boolean(monitor.notifyThroughCenter)
    }
  };
}

function getDevProgressSettings(options = {}) {
  const env = readEnvValues();
  const devProgressConfig = readDevProgressConfig();
  const devProgress = normalizeDevProgressConfig(devProgressConfig);
  const monitor = normalizeDevProgressMonitor(devProgressConfig);
  const corpIdEnv = devProgress.auth.corpIdEnv;
  const agentIdEnv = devProgress.auth.agentIdEnv;
  const secretEnv = devProgress.auth.secretEnv;

  return {
    enabled: Boolean(devProgress.enabled),
    name: devProgress.name || "开发进度监控",
    source: devProgress.source || "wecom-smartsheet",
    docUrl: devProgress.docUrl || "",
    docid: devProgress.docid || "",
    sheetId: devProgress.sheetId || "",
    viewId: devProgress.viewId || "",
    keyType: devProgress.keyType || "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    limit: Number(devProgress.limit || 100),
    cacheMinutes: Number(devProgress.cacheMinutes || 5),
    auth: {
      corpIdEnv,
      agentIdEnv,
      secretEnv,
      corpIdConfigured: Boolean(secretValue(env, corpIdEnv)),
      agentIdConfigured: Boolean(secretValue(env, agentIdEnv)),
      secretConfigured: Boolean(secretValue(env, secretEnv)),
      corpId: options.includeSecrets ? secretValue(env, corpIdEnv) : "",
      agentId: options.includeSecrets ? secretValue(env, agentIdEnv) : "",
      secret: options.includeSecrets ? secretValue(env, secretEnv) : ""
    },
    fieldMapping: devProgress.fieldMapping,
    personAliases: devProgress.personAliases,
    rules: devProgress.rules,
    monitor,
    ready: Boolean(
      (devProgress.docid || devProgress.docUrl) &&
      devProgress.sheetId &&
      secretValue(env, corpIdEnv) &&
      secretValue(env, secretEnv)
    )
  };
}

function getBugCollectionSettings() {
  const modulesConfig = fs.existsSync(modulesConfigPath) ? readJson(modulesConfigPath) : readJson(modulesConfigExamplePath);
  const env = readEnvValues();
  const bugCollection = normalizeBugCollectionConfig(modulesConfig);
  const corpIdEnv = bugCollection.auth.corpIdEnv;
  const agentIdEnv = bugCollection.auth.agentIdEnv;
  const secretEnv = bugCollection.auth.secretEnv;

  return {
    enabled: Boolean(bugCollection.enabled),
    name: bugCollection.name || "需求和 Bug 收集",
    source: bugCollection.source || "wecom-smartsheet",
    docUrl: bugCollection.docUrl || "",
    docid: bugCollection.docid || "",
    docLinkId: bugCollection.docLinkId || "",
    sheetId: bugCollection.sheetId || "",
    viewId: bugCollection.viewId || "",
    keyType: bugCollection.keyType || "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    auth: {
      corpIdEnv,
      agentIdEnv,
      secretEnv,
      corpIdConfigured: Boolean(secretValue(env, corpIdEnv)),
      agentIdConfigured: Boolean(secretValue(env, agentIdEnv)),
      secretConfigured: Boolean(secretValue(env, secretEnv))
    },
    createDoc: {
      docName: bugCollection.createDoc.docName || "EA需求和Bug收集",
      spaceId: bugCollection.createDoc.spaceId || "",
      fatherId: bugCollection.createDoc.fatherId || "",
      adminUsers: parseListText(bugCollection.createDoc.adminUsers, []),
      shareAfterCreate: bugCollection.createDoc.shareAfterCreate !== false
    },
    fieldMapping: bugCollection.fieldMapping,
    ready: Boolean(
      bugCollection.docid &&
      bugCollection.sheetId &&
      secretValue(env, corpIdEnv) &&
      secretValue(env, secretEnv)
    )
  };
}

function getNotificationSettings(options = {}) {
  const modulesConfig = fs.existsSync(modulesConfigPath) ? readJson(modulesConfigPath) : readJson(modulesConfigExamplePath);
  const env = readEnvValues();
  const notification = modulesConfig.notification || {};
  const appMessage = notification.appMessage || {};
  const groupWebhookEnv = notification.groupWebhookEnv || "WECOM_GROUP_WEBHOOK_URL";
  const corpIdEnv = appMessage.corpIdEnv || "WECOM_APP_CORP_ID";
  const agentIdEnv = appMessage.agentIdEnv || "WECOM_APP_AGENT_ID";
  const secretEnv = appMessage.secretEnv || "WECOM_APP_SECRET";
  const toUserEnv = appMessage.toUserEnv || "WECOM_APP_TO_USER";

  return {
    enabled: Boolean(notification.enabled),
    defaultTarget: notification.defaultTarget || "group",
    groupWebhookEnv,
    groupWebhookConfigured: Boolean(secretValue(env, groupWebhookEnv)),
    groupWebhook: options.includeSecrets ? secretValue(env, groupWebhookEnv) : "",
    appMessage: {
      corpIdEnv,
      agentIdEnv,
      secretEnv,
      toUserEnv,
      corpIdConfigured: Boolean(secretValue(env, corpIdEnv)),
      agentIdConfigured: Boolean(secretValue(env, agentIdEnv)),
      secretConfigured: Boolean(secretValue(env, secretEnv)),
      corpId: options.includeSecrets ? secretValue(env, corpIdEnv) : "",
      agentId: options.includeSecrets ? secretValue(env, agentIdEnv) : "",
      secret: options.includeSecrets ? secretValue(env, secretEnv) : "",
      toUser: secretValue(env, toUserEnv)
    }
  };
}

function getFutureModuleSettings() {
  const modulesConfig = fs.existsSync(modulesConfigPath) ? readJson(modulesConfigPath) : readJson(modulesConfigExamplePath);
  const modules = modulesConfig.modules || {};
  return {
    devProgress: { enabled: Boolean(modules.devProgress && modules.devProgress.enabled) },
    bugCollection: { enabled: Boolean(modules.bugCollection && modules.bugCollection.enabled) },
    activity: { enabled: Boolean(modules.activity && modules.activity.enabled) },
    history: { enabled: Boolean(modules.history && modules.history.enabled) },
    admin: { enabled: false }
  };
}

function getDemandWorkflowRulesSettings() {
  const rules = fs.existsSync(demandWorkflowRulesPath)
    ? readJson(demandWorkflowRulesPath)
    : readJson(demandWorkflowRulesExamplePath);
  const normalizedRules = normalizeDemandWorkflowRules(rules);
  return {
    rawText: JSON.stringify(rules, null, 2),
    rules,
    summary: summarizeDemandWorkflowRules(normalizedRules),
    normalizedRules
  };
}

function getAllSettings(options = {}) {
  return {
    ok: true,
    basic: getBasicSettings(),
    robot: getRobotSettings(options),
    rank: getRankSettings(),
    devProgress: getDevProgressSettings(options),
    bugCollection: getBugCollectionSettings(),
    notification: getNotificationSettings(options),
    ai: getAiSettings(options),
    demandWorkflowRules: getDemandWorkflowRulesSettings(),
    future: getFutureModuleSettings()
  };
}

function updateBasicSettings(payload) {
  const appConfig = ensureAppConfig();
  appConfig.server = appConfig.server || {};
  appConfig.runtime = appConfig.runtime || {};
  if (typeof payload.host === "string" && payload.host.trim()) {
    appConfig.server.host = payload.host.trim();
  }
  if (payload.port !== undefined) {
    const port = Number(payload.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("端口必须是 1 到 65535 之间的数字");
    }
    appConfig.server.port = port;
  }
  if (typeof payload.runtimeName === "string" && payload.runtimeName.trim()) {
    appConfig.runtime.name = payload.runtimeName.trim();
  }
  if (typeof payload.logLevel === "string" && ["debug", "info", "warn", "error"].includes(payload.logLevel)) {
    appConfig.runtime.logLevel = payload.logLevel;
  }
  writeJsonAtomic(appConfigPath, appConfig);
  return getBasicSettings();
}

function updateAiSettings(payload) {
  const appConfig = ensureAppConfig();
  appConfig.ai = appConfig.ai || {};
  const providers = normalizeAiProviders(appConfig.ai);
  const provider = providers[payload.provider] ? payload.provider : "deepseek";
  const current = providers[provider];

  appConfig.ai.enabled = Boolean(payload.enabled);
  appConfig.ai.provider = provider;
  appConfig.ai.providers = providers;
  if (typeof payload.baseUrl === "string" && payload.baseUrl.trim()) {
    current.baseUrl = payload.baseUrl.trim();
  }
  if (typeof payload.model === "string" && payload.model.trim()) {
    current.model = payload.model.trim();
  }
  appConfig.ai.providers[provider] = current;
  appConfig.ai.baseUrl = current.baseUrl;
  appConfig.ai.model = current.model;
  appConfig.ai.apiKeyEnv = current.apiKeyEnv;

  if (typeof payload.apiKey === "string" && payload.apiKey.trim()) {
    setEnvValues({ [current.apiKeyEnv]: payload.apiKey.trim() });
    process.env[current.apiKeyEnv] = payload.apiKey.trim();
  }

  writeJsonAtomic(appConfigPath, appConfig);
  return getAiSettings();
}

function updateRankSettings(payload) {
  const modulesConfig = ensureModulesConfig();
  modulesConfig.modules = modulesConfig.modules || {};
  modulesConfig.modules.rank = modulesConfig.modules.rank || {};
  modulesConfig.monitors = modulesConfig.monitors || {};
  modulesConfig.monitors.rank = modulesConfig.monitors.rank || {};

  modulesConfig.modules.rank.enabled = Boolean(payload.enabled);
  if (typeof payload.path === "string" && payload.path.trim()) {
    modulesConfig.modules.rank.path = payload.path.trim();
  }
  modulesConfig.modules.rank.pathEnv = modulesConfig.modules.rank.pathEnv || "";
  modulesConfig.modules.rank.configPath = modulesConfig.modules.rank.configPath || "config/rank.config.json";
  modulesConfig.modules.rank.statePath = modulesConfig.modules.rank.statePath || "data/rank/state.json";
  modulesConfig.modules.rank.historyPath = modulesConfig.modules.rank.historyPath || "data/rank/history/rank_history.csv";
  modulesConfig.monitors.rank.enabled = Boolean(payload.monitorEnabled);
  if (payload.intervalMinutes !== undefined) {
    const interval = Number(payload.intervalMinutes);
    if (!Number.isFinite(interval) || interval < 1) {
      throw new Error("扫描间隔必须大于 0");
    }
    modulesConfig.monitors.rank.intervalMinutes = interval;
  }

  writeJsonAtomic(modulesConfigPath, modulesConfig);
  return getRankSettings();
}

function updateDevProgressSettings(payload) {
  const modulesConfig = ensureModulesConfig();
  modulesConfig.modules = modulesConfig.modules || {};
  modulesConfig.monitors = modulesConfig.monitors || {};
  const currentConfig = ensureDevProgressConfig();
  const current = normalizeDevProgressConfig(currentConfig);
  const monitor = normalizeDevProgressMonitor(currentConfig);
  const incomingDocUrl = typeof payload.docUrl === "string" ? payload.docUrl.trim() : current.docUrl;
  const urlParts = extractSmartSheetUrlParts(incomingDocUrl);
  const docUrlChanged = Boolean(incomingDocUrl && incomingDocUrl !== current.docUrl);
  const payloadDocid = typeof payload.docid === "string" ? payload.docid.trim() : "";
  const payloadSheetId = typeof payload.sheetId === "string" ? payload.sheetId.trim() : "";
  const payloadViewId = typeof payload.viewId === "string" ? payload.viewId.trim() : "";
  const requiredFieldsRule = parseRequiredFieldsRulesText(payload.requiredFieldsRulesText, current.rules.requiredFields);
  requiredFieldsRule.enabled = Boolean(payload.ruleRequiredFieldsEnabled);
  const currentRequiredFieldsPush = monitor.requiredFieldsPush || {};
  const requiredFieldsPushScanLimit = Number(
    payload.requiredFieldsPushScanLimit || payload.ruleScanLimit || currentRequiredFieldsPush.scanLimit || 2000
  );
  const requiredFieldsPush = {
    ...currentRequiredFieldsPush,
    enabled: payload.requiredFieldsPushEnabled !== undefined
      ? Boolean(payload.requiredFieldsPushEnabled)
      : currentRequiredFieldsPush.enabled !== false,
    scanLimit: Number.isFinite(requiredFieldsPushScanLimit)
      ? requiredFieldsPushScanLimit
      : Number(currentRequiredFieldsPush.scanLimit || 2000),
    testMode: payload.requiredFieldsPushTestMode !== undefined
      ? Boolean(payload.requiredFieldsPushTestMode)
      : Boolean(currentRequiredFieldsPush.testMode),
    testTargetName: typeof payload.requiredFieldsPushTestTargetName === "string"
      ? payload.requiredFieldsPushTestTargetName.trim()
      : String(currentRequiredFieldsPush.testTargetName || "").trim(),
    testVerifyDelaySeconds: Math.max(1, Number(currentRequiredFieldsPush.testVerifyDelaySeconds || 30)),
    testNextTaskDelaySeconds: Math.max(1, Number(currentRequiredFieldsPush.testNextTaskDelaySeconds || 600)),
    groupCard: {
      ...(currentRequiredFieldsPush.groupCard || {}),
      enabled: currentRequiredFieldsPush.groupCard && currentRequiredFieldsPush.groupCard.enabled !== undefined
        ? Boolean(currentRequiredFieldsPush.groupCard.enabled)
        : true,
      maxCardsPerTick: Number(currentRequiredFieldsPush.groupCard && currentRequiredFieldsPush.groupCard.maxCardsPerTick
        ? currentRequiredFieldsPush.groupCard.maxCardsPerTick
        : 1),
      remindMinutes: Number(currentRequiredFieldsPush.groupCard && currentRequiredFieldsPush.groupCard.remindMinutes
        ? currentRequiredFieldsPush.groupCard.remindMinutes
        : 30)
    },
    pilot: {
      ...(currentRequiredFieldsPush.pilot || {}),
      enabled: Boolean(currentRequiredFieldsPush.pilot && currentRequiredFieldsPush.pilot.enabled),
      targetName: String(currentRequiredFieldsPush.pilot && currentRequiredFieldsPush.pilot.targetName || "").trim(),
      remindMinutes: Number(currentRequiredFieldsPush.pilot && currentRequiredFieldsPush.pilot.remindMinutes || 30),
      summaryMinutes: Number(currentRequiredFieldsPush.pilot && currentRequiredFieldsPush.pilot.summaryMinutes || 60),
      maxActiveTasks: Math.max(1, Number(currentRequiredFieldsPush.pilot && currentRequiredFieldsPush.pilot.maxActiveTasks || 1)),
      focusDemandIds: Array.isArray(currentRequiredFieldsPush.pilot && currentRequiredFieldsPush.pilot.focusDemandIds)
        ? currentRequiredFieldsPush.pilot.focusDemandIds.map((item) => String(item || "").trim()).filter(Boolean)
        : []
    }
  };

  const nextDevProgress = {
    ...current,
    enabled: Boolean(payload.enabled),
    source: "wecom-smartsheet",
    docUrl: incomingDocUrl,
    docid: payloadDocid || current.docid,
    sheetId: docUrlChanged && urlParts.tabId ? urlParts.tabId : (payloadSheetId || urlParts.tabId || current.sheetId),
    viewId: docUrlChanged && urlParts.viewId ? urlParts.viewId : (payloadViewId || urlParts.viewId || current.viewId),
    keyType: payload.keyType || current.keyType || "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    limit: Number(payload.limit || current.limit || 100),
    cacheMinutes: Number(payload.cacheMinutes || current.cacheMinutes || 5),
    auth: current.auth,
    fieldMapping: {
      demandId: typeof payload.demandIdField === "string" ? payload.demandIdField.trim() : current.fieldMapping.demandId,
      project: typeof payload.projectField === "string" ? payload.projectField.trim() : current.fieldMapping.project,
      demand: typeof payload.demandField === "string" ? payload.demandField.trim() : current.fieldMapping.demand,
      demandContent: typeof payload.demandContentField === "string" ? payload.demandContentField.trim() : current.fieldMapping.demandContent,
      demandType: typeof payload.demandTypeField === "string" ? payload.demandTypeField.trim() : current.fieldMapping.demandType,
      owner: typeof payload.ownerField === "string" ? payload.ownerField.trim() : current.fieldMapping.owner,
      status: typeof payload.statusField === "string" ? payload.statusField.trim() : current.fieldMapping.status,
      progress: typeof payload.progressField === "string" ? payload.progressField.trim() : current.fieldMapping.progress,
      planDate: typeof payload.planDateField === "string" ? payload.planDateField.trim() : current.fieldMapping.planDate,
      blockers: typeof payload.blockersField === "string" ? payload.blockersField.trim() : current.fieldMapping.blockers,
      updatedAt: typeof payload.updatedAtField === "string" ? payload.updatedAtField.trim() : current.fieldMapping.updatedAt,
      remarks: typeof payload.remarksField === "string" ? payload.remarksField.trim() : current.fieldMapping.remarks,
      frontendOwner: typeof payload.frontendOwnerField === "string" ? payload.frontendOwnerField.trim() : current.fieldMapping.frontendOwner,
      backendOwner: typeof payload.backendOwnerField === "string" ? payload.backendOwnerField.trim() : current.fieldMapping.backendOwner,
      frontendRemaining: typeof payload.frontendRemainingField === "string" ? payload.frontendRemainingField.trim() : current.fieldMapping.frontendRemaining,
      backendRemaining: typeof payload.backendRemainingField === "string" ? payload.backendRemainingField.trim() : current.fieldMapping.backendRemaining,
      uiOwner: typeof payload.uiOwnerField === "string" ? payload.uiOwnerField.trim() : current.fieldMapping.uiOwner,
      plannerOwner: typeof payload.plannerOwnerField === "string" ? payload.plannerOwnerField.trim() : current.fieldMapping.plannerOwner,
      testerOwner: typeof payload.testerOwnerField === "string" ? payload.testerOwnerField.trim() : current.fieldMapping.testerOwner,
      effectOwner: typeof payload.effectOwnerField === "string" ? payload.effectOwnerField.trim() : current.fieldMapping.effectOwner,
      plannerLead: typeof payload.plannerLeadField === "string" ? payload.plannerLeadField.trim() : current.fieldMapping.plannerLead,
      uiLead: typeof payload.uiLeadField === "string" ? payload.uiLeadField.trim() : current.fieldMapping.uiLead,
      effectLead: typeof payload.effectLeadField === "string" ? payload.effectLeadField.trim() : current.fieldMapping.effectLead,
      frontendLead: typeof payload.frontendLeadField === "string" ? payload.frontendLeadField.trim() : current.fieldMapping.frontendLead,
      backendLead: typeof payload.backendLeadField === "string" ? payload.backendLeadField.trim() : current.fieldMapping.backendLead,
      testerLead: typeof payload.testerLeadField === "string" ? payload.testerLeadField.trim() : current.fieldMapping.testerLead,
      devDeadline: typeof payload.devDeadlineField === "string" ? payload.devDeadlineField.trim() : current.fieldMapping.devDeadline,
      testDeadline: typeof payload.testDeadlineField === "string" ? payload.testDeadlineField.trim() : current.fieldMapping.testDeadline,
      acceptanceDeadline: typeof payload.acceptanceDeadlineField === "string" ? payload.acceptanceDeadlineField.trim() : current.fieldMapping.acceptanceDeadline,
      releaseDate: typeof payload.releaseDateField === "string" ? payload.releaseDateField.trim() : current.fieldMapping.releaseDate,
      groupChat: typeof payload.groupChatField === "string" ? payload.groupChatField.trim() : current.fieldMapping.groupChat,
      demandLink: typeof payload.demandLinkField === "string" ? payload.demandLinkField.trim() : current.fieldMapping.demandLink
    },
    personAliases: typeof payload.personAliasesText === "string"
      ? parsePersonAliasesText(payload.personAliasesText)
      : normalizePersonAliases(current.personAliases),
    rules: normalizeDevProgressRules({
      scanLimit: payload.ruleScanLimit,
      scanStartDate: typeof payload.ruleScanStartDate === "string"
        ? payload.ruleScanStartDate.trim()
        : current.rules.scanStartDate,
      excludedProjects: payload.excludedProjectsText !== undefined
        ? parseListText(payload.excludedProjectsText, current.rules.excludedProjects)
        : current.rules.excludedProjects,
      completedStatusKeywords: parseListText(payload.completedStatusKeywordsText, current.rules.completedStatusKeywords),
      ignoredStatusKeywords: parseListText(payload.ignoredStatusKeywordsText, current.rules.ignoredStatusKeywords),
      overdue: {
        enabled: payload.ruleOverdueEnabled
      },
      stale: {
        enabled: payload.ruleStaleEnabled,
        days: payload.ruleStaleDays
      },
      remainingNearDeadline: {
        enabled: payload.ruleRemainingEnabled,
        days: payload.ruleRemainingDays,
        minimum: payload.ruleRemainingMinimum
      },
      missingOwner: {
        enabled: payload.ruleMissingOwnerEnabled,
        requiredRoles: parseListText(payload.requiredOwnerRolesText, current.rules.missingOwner.requiredRoles)
      },
      requiredFields: requiredFieldsRule
    }, current.rules)
  };

  const nextMonitor = {
    ...monitor,
    enabled: Boolean(payload.monitorEnabled),
    intervalMinutes: Number(payload.monitorIntervalMinutes || monitor.intervalMinutes || 1),
    notifyThroughCenter: Boolean(payload.notifyThroughCenter),
    changeDetection: {
      ...(monitor.changeDetection || {}),
      enabled: monitor.changeDetection && monitor.changeDetection.enabled !== undefined
        ? Boolean(monitor.changeDetection.enabled)
        : true,
      quietMinutes: Number(monitor.changeDetection && monitor.changeDetection.quietMinutes
        ? monitor.changeDetection.quietMinutes
        : 3),
      minScanIntervalMinutes: Number(monitor.changeDetection && monitor.changeDetection.minScanIntervalMinutes
        ? monitor.changeDetection.minScanIntervalMinutes
        : 5),
      scanOnFirstRun: Boolean(monitor.changeDetection && monitor.changeDetection.scanOnFirstRun),
      scanOnSignalError: monitor.changeDetection && monitor.changeDetection.scanOnSignalError !== undefined
        ? Boolean(monitor.changeDetection.scanOnSignalError)
        : true
    },
    requiredFieldsPush
  };

  if (!Number.isFinite(nextDevProgress.limit) || nextDevProgress.limit < 1) {
    throw new Error("读取记录数必须大于 0");
  }
  if (!Number.isFinite(nextDevProgress.cacheMinutes) || nextDevProgress.cacheMinutes < 0) {
    throw new Error("缓存分钟数不能小于 0");
  }
  if (!Number.isFinite(nextMonitor.intervalMinutes) || nextMonitor.intervalMinutes < 1) {
    throw new Error("监控间隔必须大于 0");
  }
  const savedChangeDetection = nextMonitor.changeDetection || {};
  if (!Number.isFinite(savedChangeDetection.quietMinutes) || savedChangeDetection.quietMinutes < 1) {
    throw new Error("需求总表变更静默时间必须大于 0");
  }
  if (!Number.isFinite(savedChangeDetection.minScanIntervalMinutes) || savedChangeDetection.minScanIntervalMinutes < 1) {
    throw new Error("需求总表完整扫描最小间隔必须大于 0");
  }
  const savedRequiredFieldsPush = nextMonitor.requiredFieldsPush || {};
  if (!Number.isFinite(savedRequiredFieldsPush.cooldownMinutes) || savedRequiredFieldsPush.cooldownMinutes < 1) {
    throw new Error("必填项推送冷却时间必须大于 0");
  }
  if (!Number.isFinite(savedRequiredFieldsPush.scanLimit) || savedRequiredFieldsPush.scanLimit < 1) {
    throw new Error("必填项推送扫描上限必须大于 0");
  }
  if (!Number.isFinite(savedRequiredFieldsPush.maxTargetsPerTick) || savedRequiredFieldsPush.maxTargetsPerTick < 1) {
    throw new Error("单次必填项推送人数上限必须大于 0");
  }
  if (savedRequiredFieldsPush.testMode && !String(savedRequiredFieldsPush.testTargetName || "").trim()) {
    throw new Error("必填项测试推送目标不能为空");
  }
  if (!Number.isFinite(savedRequiredFieldsPush.testVerifyDelaySeconds) || savedRequiredFieldsPush.testVerifyDelaySeconds < 1) {
    throw new Error("测试模式复核秒数必须大于 0");
  }
  if (!Number.isFinite(savedRequiredFieldsPush.testNextTaskDelaySeconds) || savedRequiredFieldsPush.testNextTaskDelaySeconds < 1) {
    throw new Error("测试模式下一任务秒数必须大于 0");
  }
  if (!Number.isFinite(nextDevProgress.rules.scanLimit) || nextDevProgress.rules.scanLimit < 1) {
    throw new Error("异常扫描上限必须大于 0");
  }

  const envUpdates = {};
  if (typeof payload.corpId === "string" && payload.corpId.trim()) {
    envUpdates[current.auth.corpIdEnv] = payload.corpId.trim();
  }
  if (typeof payload.agentId === "string" && payload.agentId.trim()) {
    envUpdates[current.auth.agentIdEnv] = payload.agentId.trim();
  }
  if (typeof payload.secret === "string" && payload.secret.trim()) {
    envUpdates[current.auth.secretEnv] = payload.secret.trim();
  }

  if (Object.keys(envUpdates).length > 0) {
    setEnvValues(envUpdates);
    Object.assign(process.env, envUpdates);
  }

  const nextConfig = {
    ...nextDevProgress,
    monitor: nextMonitor
  };
  writeJsonAtomic(devProgressConfigPath, nextConfig);

  modulesConfig.modules.devProgress = {
    enabled: Boolean(nextConfig.enabled),
    name: nextConfig.name || "开发进度监控",
    source: nextConfig.source || "wecom-smartsheet",
    configPath: "config/dev-progress.config.json"
  };
  if (modulesConfig.monitors) {
    delete modulesConfig.monitors.devProgress;
  }
  writeJsonAtomic(modulesConfigPath, modulesConfig);
  return getDevProgressSettings();
}

function updateBugCollectionSettings(payload) {
  const modulesConfig = ensureModulesConfig();
  modulesConfig.modules = modulesConfig.modules || {};
  const current = normalizeBugCollectionConfig(modulesConfig);
  const hasPayloadKey = (key) => Object.prototype.hasOwnProperty.call(payload, key);
  const incomingDocUrl = hasPayloadKey("docUrl") && typeof payload.docUrl === "string"
    ? payload.docUrl.trim()
    : current.docUrl;
  const urlParts = extractSmartSheetUrlParts(incomingDocUrl);
  const payloadDocid = hasPayloadKey("docid") && typeof payload.docid === "string" ? payload.docid.trim() : current.docid;
  const payloadDocLinkId = hasPayloadKey("docLinkId") && typeof payload.docLinkId === "string" ? payload.docLinkId.trim() : current.docLinkId;
  const payloadSheetId = hasPayloadKey("sheetId") && typeof payload.sheetId === "string" ? payload.sheetId.trim() : current.sheetId;
  const payloadViewId = hasPayloadKey("viewId") && typeof payload.viewId === "string" ? payload.viewId.trim() : current.viewId;
  const currentCreateDoc = current.createDoc || defaultBugCollectionConfig().createDoc;
  const createDoc = {
    docName: hasPayloadKey("createDocName") && typeof payload.createDocName === "string"
      ? (payload.createDocName.trim() || currentCreateDoc.docName || "EA需求和Bug收集")
      : (currentCreateDoc.docName || "EA需求和Bug收集"),
    spaceId: hasPayloadKey("createDocSpaceId") && typeof payload.createDocSpaceId === "string"
      ? payload.createDocSpaceId.trim()
      : (currentCreateDoc.spaceId || ""),
    fatherId: hasPayloadKey("createDocFatherId") && typeof payload.createDocFatherId === "string"
      ? payload.createDocFatherId.trim()
      : (currentCreateDoc.fatherId || ""),
    adminUsers: hasPayloadKey("createDocAdminUsersText")
      ? parseListText(payload.createDocAdminUsersText, [])
      : parseListText(currentCreateDoc.adminUsers, []),
    shareAfterCreate: hasPayloadKey("createDocShareAfterCreate")
      ? Boolean(payload.createDocShareAfterCreate)
      : currentCreateDoc.shareAfterCreate !== false
  };

  modulesConfig.modules.bugCollection = {
    ...current,
    enabled: Boolean(payload.enabled),
    name: current.name || "需求和 Bug 收集",
    source: "wecom-smartsheet",
    docUrl: incomingDocUrl,
    docid: payloadDocid,
    docLinkId: urlParts.docid || payloadDocLinkId,
    sheetId: urlParts.tabId || payloadSheetId,
    viewId: urlParts.viewId || payloadViewId,
    keyType: payload.keyType || current.keyType || "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    createDoc,
    auth: current.auth,
    fieldMapping: current.fieldMapping
  };

  writeJsonAtomic(modulesConfigPath, modulesConfig);
  return getBugCollectionSettings();
}

function updateNotificationSettings(payload) {
  const modulesConfig = ensureModulesConfig();
  modulesConfig.notification = modulesConfig.notification || {};
  modulesConfig.notification.enabled = Boolean(payload.enabled);
  modulesConfig.notification.defaultTarget = payload.defaultTarget || "group";
  modulesConfig.notification.groupWebhookEnv = modulesConfig.notification.groupWebhookEnv || "WECOM_GROUP_WEBHOOK_URL";
  modulesConfig.notification.appMessage = modulesConfig.notification.appMessage || {};
  modulesConfig.notification.appMessage.corpIdEnv = modulesConfig.notification.appMessage.corpIdEnv || "WECOM_APP_CORP_ID";
  modulesConfig.notification.appMessage.agentIdEnv = modulesConfig.notification.appMessage.agentIdEnv || "WECOM_APP_AGENT_ID";
  modulesConfig.notification.appMessage.secretEnv = modulesConfig.notification.appMessage.secretEnv || "WECOM_APP_SECRET";
  modulesConfig.notification.appMessage.toUserEnv = modulesConfig.notification.appMessage.toUserEnv || "WECOM_APP_TO_USER";

  const envUpdates = {};
  if (typeof payload.groupWebhook === "string" && payload.groupWebhook.trim()) {
    envUpdates[modulesConfig.notification.groupWebhookEnv] = payload.groupWebhook.trim();
  }
  if (typeof payload.corpId === "string" && payload.corpId.trim()) {
    envUpdates[modulesConfig.notification.appMessage.corpIdEnv] = payload.corpId.trim();
  }
  if (typeof payload.agentId === "string" && payload.agentId.trim()) {
    envUpdates[modulesConfig.notification.appMessage.agentIdEnv] = payload.agentId.trim();
  }
  if (typeof payload.secret === "string" && payload.secret.trim()) {
    envUpdates[modulesConfig.notification.appMessage.secretEnv] = payload.secret.trim();
  }
  if (typeof payload.toUser === "string") {
    envUpdates[modulesConfig.notification.appMessage.toUserEnv] = payload.toUser.trim();
  }

  if (Object.keys(envUpdates).length > 0) {
    setEnvValues(envUpdates);
    Object.assign(process.env, envUpdates);
  }

  writeJsonAtomic(modulesConfigPath, modulesConfig);
  return getNotificationSettings();
}

function updateRobotSettings(payload) {
  const appConfig = ensureAppConfig();
  appConfig.robot = appConfig.robot || {};
  appConfig.robot.enabled = Boolean(payload.enabled);
  appConfig.robot.provider = "wecom-smart-bot";
  appConfig.robot.botIdEnv = appConfig.robot.botIdEnv || "WECOM_SMART_BOT_ID";
  appConfig.robot.secretEnv = appConfig.robot.secretEnv || "WECOM_SMART_BOT_SECRET";
  if (typeof payload.welcomeText === "string") {
    appConfig.robot.welcomeText = payload.welcomeText.trim();
  }
  appConfig.robot.feedbackCard = appConfig.robot.feedbackCard || {};
  if (typeof payload.feedbackCardMode === "string") {
    appConfig.robot.feedbackCard.mode = ["disabled", "private_only", "all_chats"].includes(payload.feedbackCardMode)
      ? payload.feedbackCardMode
      : "private_only";
  }
  if (payload.feedbackCardCooldownMinutes !== undefined) {
    const cooldownMinutes = Number(payload.feedbackCardCooldownMinutes);
    appConfig.robot.feedbackCard.cooldownMinutes = Number.isFinite(cooldownMinutes)
      ? Math.max(0, Math.min(1440, cooldownMinutes))
      : 10;
  }
  appConfig.robot.outboundTest = appConfig.robot.outboundTest || {};
  if (typeof payload.outboundTargetType === "string") {
    appConfig.robot.outboundTest.targetType = payload.outboundTargetType === "group" ? "group" : "user";
  }
  if (typeof payload.outboundTargetId === "string") {
    appConfig.robot.outboundTest.targetId = payload.outboundTargetId.trim();
  }
  if (typeof payload.outboundMessage === "string") {
    appConfig.robot.outboundTest.message = payload.outboundMessage.trim() || "EA系统主动推送测试。";
  }

  const envUpdates = {};
  if (typeof payload.botId === "string" && payload.botId.trim()) {
    envUpdates[appConfig.robot.botIdEnv] = payload.botId.trim();
    process.env[appConfig.robot.botIdEnv] = payload.botId.trim();
  }
  if (typeof payload.secret === "string" && payload.secret.trim()) {
    envUpdates[appConfig.robot.secretEnv] = payload.secret.trim();
    process.env[appConfig.robot.secretEnv] = payload.secret.trim();
  }

  writeJsonAtomic(appConfigPath, appConfig);
  if (Object.keys(envUpdates).length > 0) {
    setEnvValues(envUpdates);
  }

  return getRobotSettings();
}

function updateRobotOutboundTestSettings(payload) {
  const appConfig = ensureAppConfig();
  appConfig.robot = appConfig.robot || {};
  appConfig.robot.outboundTest = appConfig.robot.outboundTest || {};

  if (typeof payload.targetType === "string") {
    appConfig.robot.outboundTest.targetType = payload.targetType === "group" ? "group" : "user";
  }
  if (typeof payload.targetId === "string" && payload.targetId.trim()) {
    appConfig.robot.outboundTest.targetId = payload.targetId.trim();
  }
  if (typeof payload.message === "string" && payload.message.trim()) {
    appConfig.robot.outboundTest.message = payload.message.trim();
  }

  writeJsonAtomic(appConfigPath, appConfig);
  return getRobotSettings();
}

function updateDemandWorkflowRulesSettings(payload) {
  const rawText = typeof payload.rulesText === "string" ? payload.rulesText.trim() : "";
  if (!rawText) {
    throw new Error("需求工作流规则 JSON 不能为空");
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`需求工作流规则 JSON 格式错误：${error.message}`);
  }

  normalizeDemandWorkflowRules(parsed);
  ensureDemandWorkflowRulesConfig();
  writeJsonAtomic(demandWorkflowRulesPath, parsed);
  return getDemandWorkflowRulesSettings();
}

module.exports = {
  getAllSettings,
  getBasicSettings,
  getAiSettings,
  getRankSettings,
  getDevProgressSettings,
  getBugCollectionSettings,
  getDemandWorkflowRulesSettings,
  getNotificationSettings,
  getRobotSettings,
  updateBasicSettings,
  updateAiSettings,
  updateRankSettings,
  updateDevProgressSettings,
  updateBugCollectionSettings,
  updateDemandWorkflowRulesSettings,
  updateNotificationSettings,
  updateRobotSettings,
  updateRobotOutboundTestSettings
};
