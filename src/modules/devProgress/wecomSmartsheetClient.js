"use strict";

const https = require("https");

const USER_NAME_CACHE_MS = 12 * 60 * 60 * 1000;
const ACCESS_TOKEN_SAFE_WINDOW_MS = 5 * 60 * 1000;
const MAX_PROBE_FIELD_NAMES = 500;
const LOOKUP_RESOLVER_CACHE_MS = 15 * 60 * 1000;
const WORKDAY_CALENDAR_MAX_RECORDS = 5000;
const userNameCache = new Map();
const accessTokenCache = new Map();
const lookupResolverCache = new Map();
const workdayCalendarCache = new Map();

function requestJson(method, url, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const request = https.request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          const data = text ? JSON.parse(text) : {};
          resolve({ statusCode: response.statusCode, data });
        } catch (error) {
          reject(new Error(`企业微信返回了非 JSON 响应，HTTP ${response.statusCode}`));
        }
      });
    });

    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function getEnvValue(envName) {
  return envName ? (process.env[envName] || "") : "";
}

function missingRequired(settings) {
  const auth = settings.auth || {};
  const missing = [];
  if (!getEnvValue(auth.corpIdEnv)) {
    missing.push("CorpID");
  }
  if (!getEnvValue(auth.secretEnv)) {
    missing.push("应用 Secret");
  }
  if (!settings.docid) {
    missing.push("docid");
  }
  if (!settings.sheetId) {
    missing.push("sheetId");
  }
  return missing;
}

function missingDocumentInfoRequired(settings) {
  const auth = settings.auth || {};
  const missing = [];
  if (!getEnvValue(auth.corpIdEnv)) {
    missing.push("CorpID");
  }
  if (!getEnvValue(auth.secretEnv)) {
    missing.push("应用 Secret");
  }
  if (!settings.docid) {
    missing.push("docid");
  }
  return missing;
}

async function getAccessTokenInfo(settings) {
  const startedAt = Date.now();
  const auth = settings.auth || {};
  const corpId = getEnvValue(auth.corpIdEnv);
  const secret = getEnvValue(auth.secretEnv);
  const cacheKey = [auth.corpIdEnv || "", auth.secretEnv || "", corpId, secret].join("\n");
  const cached = accessTokenCache.get(cacheKey);
  if (cached && cached.accessToken && Date.now() < cached.expiresAt - ACCESS_TOKEN_SAFE_WINDOW_MS) {
    return {
      accessToken: cached.accessToken,
      cacheHit: true,
      elapsedMs: Date.now() - startedAt
    };
  }

  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
  const { data } = await requestJson("GET", url);
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`获取企业微信 access_token 失败：${data.errcode || "unknown"} ${data.errmsg || ""}`.trim());
  }
  const expiresInSeconds = Math.max(60, Number(data.expires_in || 7200));
  accessTokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: Date.now() + expiresInSeconds * 1000
  });
  return {
    accessToken: data.access_token,
    cacheHit: false,
    elapsedMs: Date.now() - startedAt
  };
}

async function getAccessToken(settings) {
  const tokenInfo = await getAccessTokenInfo(settings);
  return tokenInfo.accessToken;
}

async function postWeDoc(path, accessToken, payload) {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/wedoc/${path}?access_token=${encodeURIComponent(accessToken)}`;
  const { data } = await requestJson("POST", url, payload);
  return data;
}

async function getWeComUser(accessToken, userId) {
  const cached = userNameCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < USER_NAME_CACHE_MS) {
    return cached.name;
  }

  const url = `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${encodeURIComponent(accessToken)}&userid=${encodeURIComponent(userId)}`;
  const { data } = await requestJson("GET", url);
  const name = data.errcode === 0 && data.name ? String(data.name).trim() : "";
  userNameCache.set(userId, {
    name: name || userId,
    cachedAt: Date.now()
  });
  return name || userId;
}

function fieldTitle(field) {
  if (!field || typeof field !== "object") {
    return "";
  }
  return field.title || field.field_title || field.fieldTitle || field.name || field.field_name || "";
}

function fieldId(field) {
  if (!field || typeof field !== "object") {
    return "";
  }
  return String(field.field_id || field.fieldId || field.id || "").trim();
}

function fieldType(field) {
  if (!field || typeof field !== "object") {
    return "";
  }
  return String(field.field_type || field.fieldType || field.type || "").trim();
}

function collectFieldDefinitions(value, result = []) {
  if (!value || typeof value !== "object") {
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFieldDefinitions(item, result);
    }
    return result;
  }

  const title = fieldTitle(value);
  const id = fieldId(value);
  if (title && id && !result.some((item) => item.fieldId === id)) {
    result.push({
      fieldId: id,
      title,
      type: fieldType(value),
      raw: value
    });
  }
  for (const key of ["fields", "field_list", "fieldList", "items", "data"]) {
    if (value[key]) {
      collectFieldDefinitions(value[key], result);
    }
  }
  return result;
}

function collectFieldNames(value, result = []) {
  if (!value || result.length >= MAX_PROBE_FIELD_NAMES) {
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFieldNames(item, result);
      if (result.length >= MAX_PROBE_FIELD_NAMES) {
        break;
      }
    }
    return result;
  }
  if (typeof value !== "object") {
    return result;
  }

  const title = fieldTitle(value);
  if (title && !result.includes(title)) {
    result.push(title);
  }

  for (const key of ["fields", "field_list", "fieldList", "items", "data"]) {
    if (value[key]) {
      collectFieldNames(value[key], result);
      if (result.length >= MAX_PROBE_FIELD_NAMES) {
        break;
      }
    }
  }
  return result;
}

function countRecords(response) {
  if (!response || typeof response !== "object") {
    return 0;
  }
  if (Array.isArray(response.records)) {
    return response.records.length;
  }
  if (response.data && Array.isArray(response.data.records)) {
    return response.data.records.length;
  }
  if (response.record_list && Array.isArray(response.record_list)) {
    return response.record_list.length;
  }
  return 0;
}

function uniqueNonEmpty(values) {
  return [...new Set(values
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function collectRecords(response) {
  if (!response || typeof response !== "object") {
    return [];
  }
  if (Array.isArray(response.records)) {
    return response.records;
  }
  if (response.data && Array.isArray(response.data.records)) {
    return response.data.records;
  }
  if (Array.isArray(response.record_list)) {
    return response.record_list;
  }
  if (response.data && Array.isArray(response.data.record_list)) {
    return response.data.record_list;
  }
  return [];
}

function recordId(record) {
  if (!record || typeof record !== "object") {
    return "";
  }
  return record.record_id || record.recordId || record.id || "";
}

function recordMetaValue(record, keys) {
  if (!record || typeof record !== "object") {
    return "";
  }
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
      return String(record[key]).trim();
    }
  }
  if (record.data && typeof record.data === "object") {
    return recordMetaValue(record.data, keys);
  }
  return "";
}

function normalizeRecordMeta(record) {
  return {
    createTime: recordMetaValue(record, ["create_time", "created_at", "createTime", "createdAt"]),
    updateTime: recordMetaValue(record, ["update_time", "updated_at", "updateTime", "updatedAt"]),
    creatorName: recordMetaValue(record, ["creator_name", "creatorName"]),
    updaterName: recordMetaValue(record, ["updater_name", "updaterName"])
  };
}

function recordValues(record) {
  if (!record || typeof record !== "object") {
    return {};
  }

  for (const key of ["values", "fields", "field_values", "fieldValues", "cell_values", "cellValues"]) {
    if (record[key] && typeof record[key] === "object" && !Array.isArray(record[key])) {
      return record[key];
    }
  }

  if (record.data && typeof record.data === "object") {
    return recordValues(record.data);
  }

  const metadataKeys = new Set([
    "record_id",
    "recordId",
    "id",
    "create_time",
    "update_time",
    "created_at",
    "updated_at",
    "creator_name",
    "updater_name"
  ]);
  return Object.fromEntries(Object.entries(record).filter(([key]) => !metadataKeys.has(key)));
}

function collectTextFragments(value, result = [], options = {}) {
  if (value === null || value === undefined || value === "") {
    return result;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    result.push(String(value));
    return result;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextFragments(item, result, options);
    }
    return result;
  }

  if (typeof value !== "object") {
    return result;
  }

  if (value.user_id !== undefined) {
    const userId = String(value.user_id || "").trim();
    if (userId) {
      result.push(options.userNameMap && options.userNameMap[userId] ? options.userNameMap[userId] : userId);
      return result;
    }
  }

  for (const key of [
    "text",
    "title",
    "name",
    "username",
    "userName",
    "display_name",
    "displayName",
    "userid",
    "user_id",
    "url",
    "link"
  ]) {
    if (typeof value[key] === "string" || typeof value[key] === "number" || typeof value[key] === "boolean") {
      result.push(String(value[key]));
    }
  }

  for (const key of ["value", "values", "items", "content", "contents", "text_list", "textList"]) {
    if (value[key] !== undefined) {
      collectTextFragments(value[key], result, options);
    }
  }

  return result;
}

function cellText(value, options = {}) {
  return uniqueNonEmpty(collectTextFragments(value, [], options)).join("、");
}

function normalizeFieldValues(values, options = {}) {
  return Object.fromEntries(Object.entries(values || {}).map(([fieldName, value]) => [
    fieldName,
    cellText(value, options)
  ]));
}

function fieldValueType(value) {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function mappedFieldTitles(settings) {
  const mapping = settings.fieldMapping || {};
  return uniqueNonEmpty([
    ...Object.values(mapping),
    ...requiredFieldTitles(settings)
  ]);
}

function requiredFieldTitles(settings) {
  const mapping = settings.fieldMapping || {};
  const rule = settings.rules && settings.rules.requiredFields ? settings.rules.requiredFields : {};
  const items = Array.isArray(rule.items) ? rule.items : [];
  const titles = [];
  for (const item of items) {
    const requiredFields = item && Array.isArray(item.requiredFields) ? item.requiredFields : [];
    for (const fieldName of requiredFields) {
      const keyOrTitle = String(fieldName || "").trim();
      if (keyOrTitle) {
        titles.push(mapping[keyOrTitle] || keyOrTitle);
      }
    }
  }
  for (const fieldRule of Array.isArray(rule.fieldRules) ? rule.fieldRules : []) {
    titles.push(fieldRule.field);
    titles.push(...(Array.isArray(fieldRule.memberFields) ? fieldRule.memberFields : []));
    if (fieldRule.when && fieldRule.when.field) {
      titles.push(fieldRule.when.field);
    }
    for (const validation of Array.isArray(fieldRule.validations) ? fieldRule.validations : []) {
      titles.push(validation.amountField);
      if (validation.base && validation.base.field) {
        titles.push(validation.base.field);
      }
      for (const deadline of Array.isArray(validation.deadlineFields) ? validation.deadlineFields : []) {
        titles.push(typeof deadline === "string" ? deadline : deadline && deadline.field);
      }
    }
  }
  for (const leader of Object.values(rule.leaders && typeof rule.leaders === "object" ? rule.leaders : {})) {
    if (leader && leader.sourceField) {
      titles.push(leader.sourceField);
    }
  }
  return uniqueNonEmpty(titles);
}

function collectUserIds(value, result = []) {
  if (value === null || value === undefined || value === "") {
    return result;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUserIds(item, result);
    }
    return result;
  }

  if (typeof value !== "object") {
    return result;
  }

  if (value.user_id !== undefined) {
    const userId = String(value.user_id || "").trim();
    if (userId && !result.includes(userId)) {
      result.push(userId);
    }
    return result;
  }

  for (const key of ["value", "values", "items", "content", "contents", "text_list", "textList"]) {
    if (value[key] !== undefined) {
      collectUserIds(value[key], result);
    }
  }
  return result;
}

function personFieldTitles(settings) {
  const mapping = settings.fieldMapping || {};
  return uniqueNonEmpty([
    mapping.owner,
    mapping.frontendOwner,
    mapping.backendOwner,
    mapping.uiOwner,
    mapping.plannerOwner,
    mapping.testerOwner,
    mapping.effectOwner,
    mapping.plannerLead,
    mapping.uiLead,
    mapping.effectLead,
    mapping.frontendLead,
    mapping.backendLead,
    mapping.testerLead
  ]);
}

async function resolveRecordUserNames(records, settings, accessToken) {
  const titles = new Set(personFieldTitles(settings));
  if (titles.size === 0) {
    return {};
  }

  const userIds = [];
  for (const record of records) {
    const values = recordValues(record);
    for (const [fieldName, value] of Object.entries(values)) {
      if (titles.has(fieldName)) {
        collectUserIds(value, userIds);
      }
    }
  }

  const result = {};
  for (const userId of userIds) {
    result[userId] = await getWeComUser(accessToken, userId);
  }
  return result;
}

function collectRecordUserRefs(record, settings, userNameMap = {}) {
  const titles = new Set(personFieldTitles(settings));
  if (titles.size === 0) {
    return [];
  }

  const userIds = [];
  const values = recordValues(record);
  for (const [fieldName, value] of Object.entries(values)) {
    if (titles.has(fieldName)) {
      collectUserIds(value, userIds);
    }
  }

  return userIds.map((userId) => ({
    userId,
    name: userNameMap[userId] || userId
  }));
}

function normalizeRecord(record, settings, userNameMap = {}, options = {}) {
  const mapping = settings.fieldMapping || {};
  const sourceFields = recordValues(record);
  const fields = normalizeFieldValues(sourceFields, { userNameMap });
  const fieldValueTypes = Object.fromEntries(Object.entries(sourceFields).map(([fieldName, value]) => [
    fieldName,
    fieldValueType(value)
  ]));
  const mapped = {};
  const meta = normalizeRecordMeta(record);

  for (const [key, fieldName] of Object.entries(mapping)) {
    mapped[key] = fieldName ? (fields[fieldName] || "") : "";
  }

  const status = mapped.status || mapped.progress || "";
  const normalized = {
    recordId: recordId(record),
    mapped,
    standard: {
      demandId: mapped.demandId || "",
      project: mapped.project || "",
      demand: mapped.demand || "",
      demandContent: mapped.demandContent || fields["需求内容"] || "",
      demandType: mapped.demandType || "",
      status,
      progress: mapped.progress || status,
      owners: {
        owner: mapped.owner || mapped.frontendOwner || mapped.backendOwner || mapped.uiOwner || "",
        frontend: mapped.frontendOwner || "",
        backend: mapped.backendOwner || "",
        ui: mapped.uiOwner || "",
        planner: mapped.plannerOwner || "",
        tester: mapped.testerOwner || "",
        effect: mapped.effectOwner || "",
        plannerLead: mapped.plannerLead || "",
        uiLead: mapped.uiLead || "",
        effectLead: mapped.effectLead || "",
        frontendLead: mapped.frontendLead || "",
        backendLead: mapped.backendLead || "",
        testerLead: mapped.testerLead || ""
      },
      dates: {
        createdAt: meta.createTime || "",
        plan: mapped.planDate || mapped.devDeadline || "",
        devDeadline: mapped.devDeadline || "",
        testDeadline: mapped.testDeadline || "",
        acceptanceDeadline: mapped.acceptanceDeadline || "",
        releaseDate: mapped.releaseDate || "",
        updatedAt: mapped.updatedAt || "",
        recordUpdatedAt: meta.updateTime || ""
      },
      notes: {
        blockers: mapped.blockers || "",
        remarks: mapped.remarks || ""
      },
      links: {
        groupChat: mapped.groupChat || "",
        demandLink: mapped.demandLink || ""
      }
    },
    meta,
    fields,
    fieldValueTypes,
    fieldValueSources: options.fieldValueSources && typeof options.fieldValueSources === "object"
      ? options.fieldValueSources
      : {},
    userRefs: collectRecordUserRefs(record, settings, userNameMap)
  };
  if (options.includeRawFieldValues) {
    normalized.rawFields = sourceFields;
  }
  return normalized;
}

function smartsheetDiagnosis(fields, records, settings) {
  const errcodes = [fields && fields.errcode, records && records.errcode].filter((value) => value !== undefined);
  if (errcodes.includes(2022001)) {
    return {
      code: "sub_sheet_not_found",
      message: "文档基础信息已读取成功，但当前 sheetId 在智能表格中找不到。请确认 sheetId 是企业微信智能表格 API 需要的子表 ID；如果刚重新粘贴链接，请保存后确认 sheetId 是否已从 URL 的 tab 参数自动刷新。",
      currentSheetId: settings.sheetId || "",
      currentViewId: settings.viewId || ""
    };
  }

  if (!fields.ok && !records.ok) {
    return {
      code: "smartsheet_probe_failed",
      message: "文档可访问，但字段和记录接口都不可用。需要检查子表 ID、智能表格 API 权限或该应用是否有访问此智能表格的权限。",
      currentSheetId: settings.sheetId || "",
      currentViewId: settings.viewId || ""
    };
  }

  return undefined;
}

async function probeFields(settings, accessToken) {
  const payload = {
    docid: settings.docid,
    sheet_id: settings.sheetId
  };
  const data = await postWeDoc("smartsheet/get_fields", accessToken, payload);
  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    total: data.total,
    hasMore: Boolean(data.has_more),
    next: data.next,
    fieldNames: data.errcode === 0 ? collectFieldNames(data) : []
  };
}

async function probeRecords(settings, accessToken) {
  const payload = {
    docid: settings.docid,
    sheet_id: settings.sheetId,
    record_ids: [],
    key_type: settings.keyType || "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    field_titles: [],
    field_ids: [],
    sort: [],
    offset: 0,
    limit: 1
  };
  const data = await postWeDoc("smartsheet/get_records", accessToken, payload);
  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    sampleRecordCount: data.errcode === 0 ? countRecords(data) : 0
  };
}

async function fetchRecords(settings, accessToken, options = {}) {
  const fieldTitles = Array.isArray(options.fieldTitles)
    ? uniqueNonEmpty(options.fieldTitles)
    : mappedFieldTitles(settings);
  const requestedLimit = options.limit !== undefined ? Number(options.limit) : Number(settings.limit || 100);
  const limit = Math.max(1, Math.min(requestedLimit || 100, 500));
  const offset = Math.max(0, Number(options.offset || 0));
  const recordIds = Array.isArray(options.recordIds) ? uniqueNonEmpty(options.recordIds) : [];
  const payload = {
    docid: settings.docid,
    sheet_id: settings.sheetId,
    record_ids: recordIds,
    key_type: settings.keyType || "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    field_titles: fieldTitles,
    field_ids: [],
    sort: [],
    offset,
    limit
  };

  if (settings.viewId) {
    payload.view_id = settings.viewId;
  }

  return postWeDoc("smartsheet/get_records", accessToken, payload);
}

async function fetchRecordsByFieldIds(settings, accessToken, sheetId, fieldIds, options = {}) {
  const data = await postWeDoc("smartsheet/get_records", accessToken, {
    docid: settings.docid,
    sheet_id: sheetId,
    record_ids: [],
    key_type: "CELL_VALUE_KEY_TYPE_FIELD_ID",
    field_titles: [],
    field_ids: uniqueNonEmpty(fieldIds),
    sort: [],
    offset: Math.max(0, Number(options.offset || 0)),
    limit: Math.max(1, Math.min(Number(options.limit || 500), 500))
  });
  return data.errcode === 0 ? collectRecords(data) : [];
}

function calendarDateLabel(value) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (!text) {
    return "";
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    const millis = numeric > 1000000000000 ? numeric : numeric * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
  }
  const match = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  return match
    ? `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`
    : "";
}

function smartsheetName(sheet = {}) {
  return String(sheet.sheet_name || sheet.sheetName || sheet.name || sheet.title || "").trim();
}

function smartsheetId(sheet = {}) {
  return String(sheet.sheet_id || sheet.sheetId || sheet.id || "").trim();
}

async function readDevProgressWorkdayCalendar(settings, options = {}) {
  const requiredRule = settings.rules && settings.rules.requiredFields
    ? settings.rules.requiredFields
    : {};
  const calendar = requiredRule.calendar || {};
  const sheetName = String(options.sheetName || calendar.sheetName || "工作日").trim();
  const dateField = String(options.dateField || calendar.dateField || "日期").trim();
  const cacheMinutes = Math.max(1, Number(options.cacheMinutes || calendar.cacheMinutes || 15));
  const cacheKey = [settings.docid || "", sheetName, dateField].join("|");
  const cached = workdayCalendarCache.get(cacheKey);
  if (!options.forceRefresh && cached && Date.now() - cached.cachedAt < cacheMinutes * 60 * 1000) {
    return { ...cached.value, cacheHit: true };
  }

  const missing = missingDocumentInfoRequired(settings);
  if (missing.length > 0) {
    return {
      ok: false,
      status: "incomplete",
      message: `缺少配置：${missing.join("、")}`,
      dates: [],
      cacheHit: false
    };
  }

  const accessToken = await getAccessToken(settings);
  const sheetsData = await postWeDoc("smartsheet/get_sheet", accessToken, { docid: settings.docid });
  if (sheetsData.errcode !== 0) {
    return {
      ok: false,
      status: "sheet_list_unavailable",
      errcode: sheetsData.errcode,
      errmsg: sheetsData.errmsg,
      dates: [],
      cacheHit: false
    };
  }
  const targetSheet = (Array.isArray(sheetsData.sheet_list) ? sheetsData.sheet_list : [])
    .find((sheet) => smartsheetName(sheet) === sheetName);
  const sheetId = smartsheetId(targetSheet);
  if (!sheetId) {
    return {
      ok: false,
      status: "workday_sheet_not_found",
      message: `未找到工作日子表：${sheetName}`,
      sheetName,
      dates: [],
      cacheHit: false
    };
  }

  const fieldsData = await postWeDoc("smartsheet/get_fields", accessToken, {
    docid: settings.docid,
    sheet_id: sheetId
  });
  const fieldDefinitions = fieldsData.errcode === 0 ? collectFieldDefinitions(fieldsData) : [];
  if (!fieldDefinitions.some((field) => field.title === dateField)) {
    return {
      ok: false,
      status: "workday_date_field_not_found",
      message: `工作日子表缺少日期字段：${dateField}`,
      sheetName,
      sheetId,
      dates: [],
      cacheHit: false
    };
  }

  const records = [];
  let offset = 0;
  while (records.length < WORKDAY_CALENDAR_MAX_RECORDS) {
    const pageLimit = Math.min(500, WORKDAY_CALENDAR_MAX_RECORDS - records.length);
    const data = await postWeDoc("smartsheet/get_records", accessToken, {
      docid: settings.docid,
      sheet_id: sheetId,
      record_ids: [],
      key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
      field_titles: [dateField],
      field_ids: [],
      sort: [],
      offset,
      limit: pageLimit
    });
    if (data.errcode !== 0) {
      return {
        ok: false,
        status: "workday_records_unavailable",
        errcode: data.errcode,
        errmsg: data.errmsg,
        sheetName,
        sheetId,
        dates: [],
        cacheHit: false
      };
    }
    const pageRecords = collectRecords(data);
    records.push(...pageRecords);
    if (pageRecords.length < pageLimit && !data.has_more) {
      break;
    }
    offset += pageRecords.length;
    if (pageRecords.length === 0) {
      break;
    }
  }

  const dates = uniqueNonEmpty(records.map((record) => calendarDateLabel(recordValues(record)[dateField])))
    .sort();
  const value = {
    ok: dates.length > 0,
    status: dates.length > 0 ? "ok" : "workday_dates_empty",
    message: dates.length > 0 ? "" : "工作日子表没有可用日期",
    sheetName,
    sheetId,
    dateField,
    recordCount: records.length,
    dateCount: dates.length,
    firstDate: dates[0] || "",
    lastDate: dates[dates.length - 1] || "",
    dates,
    cacheHit: false
  };
  if (value.ok) {
    workdayCalendarCache.set(cacheKey, { cachedAt: Date.now(), value });
  }
  return value;
}

function lookupOwnerPairs(settings) {
  const mapping = settings.fieldMapping || {};
  return [
    ["frontendLead", "frontendOwner"],
    ["backendLead", "backendOwner"],
    ["uiLead", "uiOwner"],
    ["effectLead", "effectOwner"],
    ["plannerLead", "plannerOwner"],
    ["testerLead", "testerOwner"]
  ].map(([leadKey, ownerKey]) => ({
    leadTitle: String(mapping[leadKey] || "").trim(),
    ownerTitle: String(mapping[ownerKey] || "").trim()
  })).filter((item) => item.leadTitle && item.ownerTitle);
}

async function buildLookupResolver(settings, accessToken) {
  const currentFieldsData = await postWeDoc("smartsheet/get_fields", accessToken, {
    docid: settings.docid,
    sheet_id: settings.sheetId
  });
  if (currentFieldsData.errcode !== 0) {
    return { lookups: new Map(), sourceUserIds: [], source: "metadata_unavailable" };
  }

  const pairsByLeadTitle = new Map(lookupOwnerPairs(settings).map((item) => [item.leadTitle, item]));
  const lookupFields = collectFieldDefinitions(currentFieldsData)
    .filter((field) => field.type === "FIELD_TYPE_LOOKUP" && pairsByLeadTitle.has(field.title))
    .map((field) => ({
      ...field,
      ownerTitle: pairsByLeadTitle.get(field.title).ownerTitle,
      lookupFieldId: String(field.raw && field.raw.property_lookup && field.raw.property_lookup.lookup_field_id || "").trim()
    }))
    .filter((field) => field.lookupFieldId);
  if (lookupFields.length === 0) {
    return { lookups: new Map(), sourceUserIds: [], source: "no_supported_lookup" };
  }

  const sheetsData = await postWeDoc("smartsheet/get_sheet", accessToken, { docid: settings.docid });
  const sheets = Array.isArray(sheetsData.sheet_list) ? sheetsData.sheet_list : [];
  const sourceByLookupFieldId = new Map();
  const wantedLookupIds = new Set(lookupFields.map((field) => field.lookupFieldId));
  for (const sheet of sheets) {
    const sheetId = String(sheet.sheet_id || sheet.sheetId || sheet.id || "").trim();
    if (!sheetId || sheetId === settings.sheetId) {
      continue;
    }
    const fieldsData = await postWeDoc("smartsheet/get_fields", accessToken, {
      docid: settings.docid,
      sheet_id: sheetId
    });
    if (fieldsData.errcode !== 0) {
      continue;
    }
    const fields = collectFieldDefinitions(fieldsData);
    for (const field of fields) {
      if (wantedLookupIds.has(field.fieldId)) {
        sourceByLookupFieldId.set(field.fieldId, { sheetId, fields, valueField: field });
      }
    }
  }

  const lookups = new Map();
  const sourceUserIds = [];
  for (const lookup of lookupFields) {
    const source = sourceByLookupFieldId.get(lookup.lookupFieldId);
    if (!source || source.valueField.type !== "FIELD_TYPE_USER") {
      continue;
    }
    const memberField = source.fields.find((field) => field.type === "FIELD_TYPE_USER" && field.fieldId !== source.valueField.fieldId);
    const roleField = source.fields.find((field) => /SELECT/.test(field.type));
    if (!memberField || !roleField) {
      continue;
    }
    const sourceRecords = await fetchRecordsByFieldIds(settings, accessToken, source.sheetId, [
      memberField.fieldId,
      roleField.fieldId,
      source.valueField.fieldId
    ]);
    const valuesByOwner = new Map();
    for (const sourceRecord of sourceRecords) {
      const values = recordValues(sourceRecord);
      const roleText = cellText(values[roleField.fieldId]);
      if (roleText !== lookup.ownerTitle) {
        continue;
      }
      const members = collectUserIds(values[memberField.fieldId]);
      const leaders = collectUserIds(values[source.valueField.fieldId]);
      if (members.length === 0 || leaders.length === 0) {
        continue;
      }
      for (const memberId of members) {
        valuesByOwner.set(memberId, values[source.valueField.fieldId]);
      }
      for (const leaderId of leaders) {
        if (!sourceUserIds.includes(leaderId)) sourceUserIds.push(leaderId);
      }
    }
    lookups.set(lookup.title, {
      fieldId: lookup.fieldId,
      fieldType: lookup.type,
      ownerTitle: lookup.ownerTitle,
      lookupFieldId: lookup.lookupFieldId,
      sourceSheetId: source.sheetId,
      sourceValueFieldId: source.valueField.fieldId,
      valuesByOwner
    });
  }
  return { lookups, sourceUserIds, source: "lookup_people_mapping" };
}

async function getLookupResolver(settings, accessToken, options = {}) {
  const cacheKey = `${settings.docid || ""}\u001f${settings.sheetId || ""}`;
  const cached = lookupResolverCache.get(cacheKey);
  if (!options.forceLookupMetadataRefresh && cached && Date.now() - cached.cachedAt < LOOKUP_RESOLVER_CACHE_MS) {
    return { ...cached.value, cacheHit: true };
  }
  const value = await buildLookupResolver(settings, accessToken);
  lookupResolverCache.set(cacheKey, { cachedAt: Date.now(), value });
  return { ...value, cacheHit: false };
}

async function readDevProgressFieldDefinitions(settings) {
  const missing = missingRequired(settings);
  if (missing.length > 0) {
    return {
      ok: false,
      status: "incomplete",
      message: `缺少配置：${missing.join("、")}`,
      missing,
      fields: [],
      fieldTitles: []
    };
  }

  const tokenInfo = await getAccessTokenInfo(settings);
  const data = await postWeDoc("smartsheet/get_fields", tokenInfo.accessToken, {
    docid: settings.docid,
    sheet_id: settings.sheetId
  });
  const fields = data.errcode === 0
    ? collectFieldDefinitions(data).map((field) => ({
      fieldId: field.fieldId,
      title: field.title,
      type: field.type
    }))
    : [];
  return {
    ok: data.errcode === 0,
    status: data.errcode === 0 ? "ok" : "fields_unavailable",
    errcode: data.errcode,
    errmsg: data.errmsg,
    fields,
    fieldTitles: uniqueNonEmpty(fields.map((field) => field.title)),
    tokenCacheHit: tokenInfo.cacheHit
  };
}

function applyLookupFallbacks(rawRecords, resolver, userNameMap) {
  const sourcesByRecordId = new Map();
  for (const record of rawRecords) {
    const values = recordValues(record);
    const sources = {};
    for (const [fieldTitle, lookup] of resolver.lookups || []) {
      if (values[fieldTitle] !== null && values[fieldTitle] !== undefined && values[fieldTitle] !== "") {
        continue;
      }
      const ownerText = cellText(values[lookup.ownerTitle], { userNameMap });
      if (ownerText === "-") {
        values[fieldTitle] = "-";
        sources[fieldTitle] = {
          source: "lookup_owner_placeholder",
          fieldId: lookup.fieldId,
          fieldType: lookup.fieldType,
          lookupFieldId: lookup.lookupFieldId,
          sourceSheetId: lookup.sourceSheetId,
          ownerField: lookup.ownerTitle
        };
        continue;
      }
      const ownerIds = collectUserIds(values[lookup.ownerTitle]);
      for (const ownerId of ownerIds) {
        const leaderValue = lookup.valuesByOwner.get(ownerId);
        if (!leaderValue) {
          continue;
        }
        values[fieldTitle] = leaderValue;
        sources[fieldTitle] = {
          source: "lookup_people_mapping",
          fieldId: lookup.fieldId,
          fieldType: lookup.fieldType,
          lookupFieldId: lookup.lookupFieldId,
          sourceSheetId: lookup.sourceSheetId,
          ownerField: lookup.ownerTitle
        };
        break;
      }
    }
    sourcesByRecordId.set(recordId(record), sources);
  }
  return sourcesByRecordId;
}

async function readDevProgressRecords(settings, options = {}) {
  const perfStartedAt = Date.now();
  const missing = missingRequired(settings);
  if (missing.length > 0) {
    return {
      ok: false,
      status: "incomplete",
      message: `缺少配置：${missing.join("、")}`,
      missing,
      records: []
    };
  }

  const tokenInfo = await getAccessTokenInfo(settings);
  const accessToken = tokenInfo.accessToken;
  const fetchStartedAt = Date.now();
  const data = await fetchRecords(settings, accessToken, options);
  const fetchRecordsMs = Date.now() - fetchStartedAt;
  const ok = data.errcode === 0;
  const rawRecords = ok ? collectRecords(data) : [];
  const lookupStartedAt = Date.now();
  const lookupResolver = ok ? await getLookupResolver(settings, accessToken, options) : { lookups: new Map(), sourceUserIds: [], source: "records_unavailable", cacheHit: false };
  const resolveUserStartedAt = Date.now();
  const userNameMap = ok ? await resolveRecordUserNames(rawRecords, settings, accessToken) : {};
  for (const userId of lookupResolver.sourceUserIds || []) {
    userNameMap[userId] = await getWeComUser(accessToken, userId);
  }
  const lookupValueSources = applyLookupFallbacks(rawRecords, lookupResolver, userNameMap);
  const resolveUserMs = Date.now() - resolveUserStartedAt;
  const normalizeStartedAt = Date.now();
  const records = rawRecords.map((record) => normalizeRecord(record, settings, userNameMap, {
    includeRawFieldValues: Boolean(options.includeRawFieldValues),
    fieldValueSources: lookupValueSources.get(recordId(record)) || {}
  }));
  const normalizeMs = Date.now() - normalizeStartedAt;
  const requestedLimit = options.limit !== undefined ? Number(options.limit) : Number(settings.limit || 100);
  return {
    ok,
    status: ok ? "ok" : "records_unavailable",
    errcode: data.errcode,
    errmsg: data.errmsg,
    sheetId: settings.sheetId,
    viewId: settings.viewId || "",
    offset: Math.max(0, Number(options.offset || 0)),
    limit: Math.max(1, Math.min(requestedLimit || 100, 500)),
    fieldsUsed: Array.isArray(options.fieldTitles) ? uniqueNonEmpty(options.fieldTitles) : mappedFieldTitles(settings),
    userNameResolvedCount: Object.keys(userNameMap).filter((userId) => userNameMap[userId] && userNameMap[userId] !== userId).length,
    recordCount: records.length,
    perf: {
      totalMs: Date.now() - perfStartedAt,
      tokenMs: tokenInfo.elapsedMs,
      tokenCacheHit: tokenInfo.cacheHit,
      fetchRecordsMs,
      resolveUserMs,
      lookupResolveMs: Date.now() - lookupStartedAt,
      lookupResolverCacheHit: Boolean(lookupResolver.cacheHit),
      lookupResolverSource: lookupResolver.source || "",
      normalizeMs,
      rawRecordCount: rawRecords.length
    },
    records
  };
}

async function previewDevProgressRecords(settings, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 5), 20));
  const result = await readDevProgressRecords(settings, { ...options, limit });
  return {
    ok: result.ok,
    status: result.status,
    errcode: result.errcode,
    errmsg: result.errmsg,
    sheetId: result.sheetId,
    viewId: result.viewId,
    offset: result.offset,
    limit: result.limit,
    fieldsUsed: result.fieldsUsed,
    userNameResolvedCount: result.userNameResolvedCount,
    recordCount: result.recordCount,
    records: result.records.map((record) => ({
      recordId: record.recordId,
      standard: record.standard,
      mappedFilledKeys: Object.entries(record.mapped)
        .filter(([, value]) => Boolean(value))
        .map(([key]) => key),
      sourceFieldCount: Object.keys(record.fields).length
    }))
  };
}

async function testDevProgressConnection(settings) {
  const missing = missingRequired(settings);
  if (missing.length > 0) {
    return {
      ok: false,
      status: "incomplete",
      message: `缺少配置：${missing.join("、")}`,
      missing
    };
  }

  const accessToken = await getAccessToken(settings);
  const docInfo = await postWeDoc("get_doc_base_info", accessToken, {
    docid: settings.docid
  });
  if (docInfo.errcode !== 0) {
    const invalidDocid = docInfo.errcode === 301085;
    return {
      ok: false,
      status: "doc_unavailable",
      message: `文档基础信息读取失败：${docInfo.errcode} ${docInfo.errmsg || ""}`.trim(),
      diagnosis: invalidDocid ? {
        code: "invalid_docid",
        message: "当前 docid 不是企业微信文档 API 可用的 docid。共享链接路径中的 s3_/e3_ 标识不能直接当作 API docid；请保留此前能读到文档基础信息的长 docid，只用链接自动刷新 sheetId/viewId。"
      } : undefined
    };
  }

  const fields = await probeFields(settings, accessToken).catch((error) => ({
    ok: false,
    message: error.message,
    fieldNames: []
  }));
  const records = await probeRecords(settings, accessToken).catch((error) => ({
    ok: false,
    message: error.message,
    sampleRecordCount: 0
  }));

  return {
    ok: Boolean(fields.ok || records.ok),
    status: fields.ok || records.ok ? "ok" : "smartsheet_unavailable",
    diagnosis: smartsheetDiagnosis(fields, records, settings),
    doc: {
      docid: settings.docid,
      docName: docInfo.doc_base_info && docInfo.doc_base_info.doc_name ? docInfo.doc_base_info.doc_name : "",
      docType: docInfo.doc_base_info && docInfo.doc_base_info.doc_type ? docInfo.doc_base_info.doc_type : "",
      modifyTime: docInfo.doc_base_info && docInfo.doc_base_info.modify_time ? docInfo.doc_base_info.modify_time : ""
    },
    smartsheet: {
      sheetId: settings.sheetId,
      viewId: settings.viewId || "",
      fields,
      records
    }
  };
}

async function readDevProgressDocumentInfo(settings) {
  const missing = missingDocumentInfoRequired(settings);
  if (missing.length > 0) {
    return {
      ok: false,
      status: "incomplete",
      message: `缺少配置：${missing.join("、")}`,
      missing
    };
  }

  const accessToken = await getAccessToken(settings);
  const docInfo = await postWeDoc("get_doc_base_info", accessToken, {
    docid: settings.docid
  });
  if (docInfo.errcode !== 0) {
    return {
      ok: false,
      status: "doc_unavailable",
      errcode: docInfo.errcode,
      errmsg: docInfo.errmsg || "",
      message: `文档基础信息读取失败：${docInfo.errcode} ${docInfo.errmsg || ""}`.trim()
    };
  }

  const doc = docInfo.doc_base_info || {};
  const modifyTime = doc.modify_time !== undefined && doc.modify_time !== null ? String(doc.modify_time) : "";
  const docName = doc.doc_name ? String(doc.doc_name) : "";
  const docType = doc.doc_type !== undefined && doc.doc_type !== null ? String(doc.doc_type) : "";
  return {
    ok: true,
    status: "ok",
    docid: settings.docid,
    docName,
    docType,
    modifyTime,
    signal: [settings.docid, settings.sheetId || "", settings.viewId || "", modifyTime].join("|")
  };
}

module.exports = {
  applyLookupFallbacks,
  normalizeDevProgressRecord: normalizeRecord,
  previewDevProgressRecords,
  readDevProgressRecords,
  readDevProgressDocumentInfo,
  readDevProgressFieldDefinitions,
  readDevProgressWorkdayCalendar,
  testDevProgressConnection
};
