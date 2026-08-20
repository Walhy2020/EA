"use strict";

const https = require("https");
const { formatLocalMinute } = require("../../utils/localDateTime");

const REQUIRED_FIELD_KEYS = [
  "taskId",
  "issueType",
  "title",
  "description",
  "screenshot",
  "submitter",
  "createdAt",
  "updatedAt",
  "status"
];

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
    missing.push("API docid");
  }
  if (!settings.sheetId) {
    missing.push("sheetId");
  }
  return missing;
}

function missingCreateRequired(settings) {
  const auth = settings.auth || {};
  const missing = [];
  if (!getEnvValue(auth.corpIdEnv)) {
    missing.push("CorpID");
  }
  if (!getEnvValue(auth.secretEnv)) {
    missing.push("应用 Secret");
  }
  return missing;
}

async function getAccessToken(settings) {
  const auth = settings.auth || {};
  const corpId = getEnvValue(auth.corpIdEnv);
  const secret = getEnvValue(auth.secretEnv);
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
  const { data } = await requestJson("GET", url);
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`获取企业微信 access_token 失败：${data.errcode || "unknown"} ${data.errmsg || ""}`.trim());
  }
  return data.access_token;
}

async function postWeDoc(path, accessToken, payload) {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/wedoc/${path}?access_token=${encodeURIComponent(accessToken)}`;
  const { data } = await requestJson("POST", url, payload);
  return data;
}

function documentLocator(settings) {
  return { docid: settings.docid };
}

function parseSmartSheetUrlParts(docUrl) {
  if (typeof docUrl !== "string" || !docUrl.trim()) {
    return {};
  }

  try {
    const url = new URL(docUrl.trim());
    const parts = url.pathname.split("/").filter(Boolean);
    const typeIndex = parts.findIndex((part) => part === "smartsheet" || part === "sheet");
    return {
      docLinkId: typeIndex >= 0 && parts[typeIndex + 1] ? parts[typeIndex + 1] : "",
      sheetId: url.searchParams.get("tab") || "",
      viewId: url.searchParams.get("viewId") || ""
    };
  } catch (error) {
    return {};
  }
}

function fieldTitle(field) {
  if (!field || typeof field !== "object") {
    return "";
  }
  return field.title || field.field_title || field.fieldTitle || field.name || field.field_name || "";
}

function fieldIdOf(field) {
  if (!field || typeof field !== "object") {
    return "";
  }
  return field.field_id || field.fieldId || field.id || "";
}

function collectFields(value, result = []) {
  if (!value || result.length >= 200) {
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFields(item, result);
    }
    return result;
  }
  if (typeof value !== "object") {
    return result;
  }

  const title = fieldTitle(value);
  const fieldId = fieldIdOf(value);
  if (title && fieldId && !result.some((item) => item.fieldId === fieldId)) {
    result.push({
      fieldId,
      title,
      type: value.field_type || value.fieldType || value.type || ""
    });
  }

  for (const key of ["fields", "field_list", "fieldList", "items", "data"]) {
    if (value[key]) {
      collectFields(value[key], result);
    }
  }
  return result;
}

function collectFieldNames(value, result = []) {
  if (!value || result.length >= 200) {
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFieldNames(item, result);
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
    }
  }
  return result;
}

function sheetIdOf(sheet) {
  if (!sheet || typeof sheet !== "object") {
    return "";
  }
  return sheet.sheet_id || sheet.sheetId || sheet.id || "";
}

function sheetTitleOf(sheet) {
  if (!sheet || typeof sheet !== "object") {
    return "";
  }
  return sheet.title || sheet.name || sheet.sheet_title || sheet.sheetTitle || "";
}

function sheetTypeOf(sheet) {
  if (!sheet || typeof sheet !== "object") {
    return "";
  }
  return sheet.type || sheet.sheet_type || sheet.sheetType || "";
}

function collectSheets(value, result = []) {
  if (!value || result.length >= 100) {
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSheets(item, result);
    }
    return result;
  }
  if (typeof value !== "object") {
    return result;
  }

  const sheetId = sheetIdOf(value);
  if (sheetId && !result.some((item) => item.sheetId === sheetId)) {
    result.push({
      sheetId,
      title: sheetTitleOf(value),
      type: sheetTypeOf(value)
    });
  }

  for (const key of ["sheet_list", "sheetList", "sheets", "items", "data"]) {
    if (value[key]) {
      collectSheets(value[key], result);
    }
  }
  return result;
}

function firstSmartSheet(sheetList) {
  return sheetList.find((sheet) => String(sheet.type || "").toLowerCase() === "smartsheet") || sheetList[0] || null;
}

function requiredFieldNames(settings) {
  const mapping = settings.fieldMapping || {};
  return REQUIRED_FIELD_KEYS
    .map((key) => mapping[key])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function textCell(value) {
  return [{
    type: "text",
    text: String(value || "")
  }];
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

function recordIdOf(record) {
  if (!record || typeof record !== "object") {
    return "";
  }
  return record.record_id || record.recordId || record.id || "";
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

  const metadataKeys = new Set(["record_id", "recordId", "id", "created_at", "updated_at"]);
  return Object.fromEntries(Object.entries(record).filter(([key]) => !metadataKeys.has(key)));
}

function cellText(value, result = []) {
  if (value === null || value === undefined || value === "") {
    return result;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    result.push(String(value));
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      cellText(item, result);
    }
    return result;
  }
  if (typeof value !== "object") {
    return result;
  }
  for (const key of ["text", "title", "name", "value"]) {
    if (typeof value[key] === "string" || typeof value[key] === "number" || typeof value[key] === "boolean") {
      result.push(String(value[key]));
    }
  }
  return result;
}

function normalizeTaskId(value) {
  const text = cellText(value).join("").trim();
  if (!/^\d{1,5}$/.test(text)) {
    return "";
  }
  return text.padStart(5, "0");
}

function formatTaskId(number) {
  return String(Math.max(0, Number(number || 0))).padStart(5, "0");
}

function issueRecordValues(settings, input = {}) {
  const mapping = settings.fieldMapping || {};
  const createdAt = input.createdAt || input.now || formatLocalMinute();
  const recordValues = {
    taskId: input.taskId || "",
    issueType: input.issueType || "需求",
    title: input.title || "",
    description: input.description || "",
    screenshot: input.screenshot || "",
    submitter: input.submitter || "",
    createdAt,
    updatedAt: input.updatedAt || "",
    status: input.status || "未处理"
  };
  const values = {};
  for (const key of REQUIRED_FIELD_KEYS) {
    if (mapping[key]) {
      values[mapping[key]] = textCell(recordValues[key]);
    }
  }
  return values;
}

async function fetchBugCollectionRecords(settings, accessToken, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 500), 500));
  const offset = Math.max(0, Number(options.offset || 0));
  const payload = {
    ...documentLocator(settings),
    sheet_id: settings.sheetId,
    record_ids: [],
    key_type: settings.keyType || "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    field_titles: Array.isArray(options.fieldTitles) ? options.fieldTitles : [],
    field_ids: [],
    sort: [],
    offset,
    limit
  };

  if (settings.viewId && options.useView !== false) {
    payload.view_id = settings.viewId;
  }

  return postWeDoc("smartsheet/get_records", accessToken, payload);
}

async function readAllBugCollectionRecords(settings, accessToken, options = {}) {
  const pageSize = Math.max(1, Math.min(Number(options.pageSize || 500), 500));
  const maxRecords = Math.max(1, Math.min(Number(options.maxRecords || 5000), 5000));
  const records = [];
  let offset = 0;

  while (records.length < maxRecords) {
    const data = await fetchBugCollectionRecords(settings, accessToken, {
      fieldTitles: options.fieldTitles,
      offset,
      limit: Math.min(pageSize, maxRecords - records.length),
      useView: options.useView
    });
    if (data.errcode !== 0) {
      return {
        ok: false,
        errcode: data.errcode,
        errmsg: data.errmsg,
        records,
        raw: data
      };
    }

    const pageRecords = collectRecords(data);
    records.push(...pageRecords);
    if (pageRecords.length < pageSize || pageRecords.length === 0) {
      break;
    }
    offset += pageSize;
  }

  return {
    ok: true,
    errcode: 0,
    errmsg: "ok",
    records,
    truncated: records.length >= maxRecords
  };
}

async function updateBugCollectionRecords(settings, accessToken, records) {
  if (!records || records.length === 0) {
    return {
      ok: true,
      skipped: true,
      errcode: 0,
      errmsg: "no records to update",
      updatedCount: 0
    };
  }

  let updatedCount = 0;
  const chunks = [];
  for (let index = 0; index < records.length; index += 100) {
    chunks.push(records.slice(index, index + 100));
  }

  for (const chunk of chunks) {
    const data = await postWeDoc("smartsheet/update_records", accessToken, {
      ...documentLocator(settings),
      sheet_id: settings.sheetId,
      key_type: settings.keyType || "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
      records: chunk
    });
    if (data.errcode !== 0) {
      return {
        ok: false,
        errcode: data.errcode,
        errmsg: data.errmsg,
        updatedCount,
        raw: data
      };
    }
    updatedCount += chunk.length;
  }

  return {
    ok: true,
    errcode: 0,
    errmsg: "ok",
    updatedCount
  };
}

async function nextBugCollectionTaskId(settings, accessToken) {
  const taskIdField = settings.fieldMapping && settings.fieldMapping.taskId
    ? settings.fieldMapping.taskId
    : "任务ID";
  const result = await readAllBugCollectionRecords(settings, accessToken, {
    fieldTitles: [taskIdField],
    maxRecords: 5000,
    useView: false
  });
  if (!result.ok) {
    throw new Error(`读取任务ID失败：${result.errcode || ""} ${result.errmsg || ""}`.trim());
  }

  let maxId = 0;
  for (const record of result.records) {
    const values = recordValues(record);
    const normalized = normalizeTaskId(values[taskIdField]);
    if (normalized) {
      maxId = Math.max(maxId, Number(normalized));
    }
  }
  return formatTaskId(maxId + 1);
}

async function getFields(settings, accessToken) {
  const data = await postWeDoc("smartsheet/get_fields", accessToken, {
    ...documentLocator(settings),
    sheet_id: settings.sheetId
  });
  const fields = data.errcode === 0 ? collectFields(data) : [];
  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    fields,
    fieldNames: data.errcode === 0 ? collectFieldNames(data) : [],
    raw: data
  };
}

async function getSheets(settings, accessToken) {
  const data = await postWeDoc("smartsheet/get_sheet", accessToken, documentLocator(settings));
  const sheetList = data.errcode === 0 ? collectSheets(data) : [];
  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    sheetList,
    raw: data
  };
}

async function addFields(settings, accessToken, fieldNames) {
  if (!fieldNames || fieldNames.length === 0) {
    return {
      ok: true,
      skipped: true,
      errcode: 0,
      errmsg: "no missing fields",
      addedFieldNames: []
    };
  }

  const data = await postWeDoc("smartsheet/add_fields", accessToken, {
    ...documentLocator(settings),
    sheet_id: settings.sheetId,
    fields: fieldNames.map((fieldName) => ({
      field_title: fieldName,
      field_type: "FIELD_TYPE_TEXT"
    }))
  });
  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    addedFieldNames: data.errcode === 0 ? fieldNames : [],
    raw: data
  };
}

async function deleteFields(settings, accessToken, fieldIds) {
  if (!fieldIds || fieldIds.length === 0) {
    return {
      ok: true,
      skipped: true,
      errcode: 0,
      errmsg: "no extra fields",
      deletedFieldIds: []
    };
  }

  const data = await postWeDoc("smartsheet/delete_fields", accessToken, {
    ...documentLocator(settings),
    sheet_id: settings.sheetId,
    field_ids: fieldIds
  });
  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    deletedFieldIds: data.errcode === 0 ? fieldIds : [],
    raw: data
  };
}

async function createDocument(settings, accessToken) {
  const createDoc = settings.createDoc || {};
  const payload = {
    doc_type: 10,
    doc_name: createDoc.docName || "EA需求和Bug收集"
  };
  if (createDoc.spaceId) {
    payload.spaceid = createDoc.spaceId;
  }
  if (createDoc.fatherId) {
    payload.fatherid = createDoc.fatherId;
  }
  if (Array.isArray(createDoc.adminUsers) && createDoc.adminUsers.length > 0) {
    payload.admin_users = createDoc.adminUsers;
  }

  const data = await postWeDoc("create_doc", accessToken, payload);
  return {
    ok: data.errcode === 0 && Boolean(data.docid),
    errcode: data.errcode,
    errmsg: data.errmsg,
    docid: data.docid || "",
    docUrl: data.url || "",
    raw: data
  };
}

async function shareDocument(docid, accessToken) {
  const data = await postWeDoc("doc_share", accessToken, { docid });
  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    shareUrl: data.share_url || "",
    raw: data
  };
}

async function addTestRecord(settings, accessToken) {
  const now = formatLocalMinute();
  const taskId = await nextBugCollectionTaskId(settings, accessToken);
  const values = issueRecordValues(settings, {
    taskId,
    issueType: "需求",
    title: "EA测试-需求和Bug收集",
    description: "这是一条 EA 系统写入测试记录，可以删除。",
    screenshot: "",
    submitter: "EA系统",
    createdAt: now,
    updatedAt: ""
  });

  const data = await postWeDoc("smartsheet/add_records", accessToken, {
    ...documentLocator(settings),
    sheet_id: settings.sheetId,
    key_type: settings.keyType || "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    records: [{
      values
    }]
  });
  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    raw: data
  };
}

async function ensureRequiredFields(settings, accessToken) {
  const fieldsBefore = await getFields(settings, accessToken);
  if (!fieldsBefore.ok) {
    return {
      ok: false,
      status: "fields_unavailable",
      message: `读取字段失败：${fieldsBefore.errcode || ""} ${fieldsBefore.errmsg || ""}`.trim(),
      fields: fieldsBefore
    };
  }

  const expectedFieldNames = requiredFieldNames(settings);
  const missingFieldNames = expectedFieldNames.filter((fieldName) => !fieldsBefore.fieldNames.includes(fieldName));
  const addFieldsResult = await addFields(settings, accessToken, missingFieldNames);
  if (!addFieldsResult.ok) {
    return {
      ok: false,
      status: "add_fields_failed",
      message: `添加字段失败：${addFieldsResult.errcode || ""} ${addFieldsResult.errmsg || ""}`.trim(),
      fieldsBefore,
      addFields: addFieldsResult
    };
  }

  return {
    ok: true,
    status: "ok",
    addedFieldNames: addFieldsResult.addedFieldNames || []
  };
}

async function addIssueRecord(settings, input = {}) {
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
  const ensureFieldsResult = await ensureRequiredFields(settings, accessToken);
  if (!ensureFieldsResult.ok) {
    return ensureFieldsResult;
  }
  const taskId = input.taskId || await nextBugCollectionTaskId(settings, accessToken);
  const values = issueRecordValues(settings, {
    ...input,
    taskId
  });
  const data = await postWeDoc("smartsheet/add_records", accessToken, {
    ...documentLocator(settings),
    sheet_id: settings.sheetId,
    key_type: settings.keyType || "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    records: [{
      values
    }]
  });
  return {
    ok: data.errcode === 0,
    status: data.errcode === 0 ? "ok" : "add_record_failed",
    errcode: data.errcode,
    errmsg: data.errmsg,
    taskId: data.errcode === 0 ? taskId : "",
    message: data.errcode === 0 ? "" : `添加记录失败：${data.errcode || ""} ${data.errmsg || ""}`.trim(),
    raw: data
  };
}

async function migrateBugCollectionTaskIds(settings) {
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
  const ensureFieldsResult = await ensureRequiredFields(settings, accessToken);
  if (!ensureFieldsResult.ok) {
    return ensureFieldsResult;
  }

  const taskIdField = settings.fieldMapping && settings.fieldMapping.taskId
    ? settings.fieldMapping.taskId
    : "任务ID";
  const recordsResult = await readAllBugCollectionRecords(settings, accessToken, {
    fieldTitles: [taskIdField],
    maxRecords: 5000,
    useView: false
  });
  if (!recordsResult.ok) {
    return {
      ok: false,
      status: "records_unavailable",
      message: `读取记录失败：${recordsResult.errcode || ""} ${recordsResult.errmsg || ""}`.trim(),
      records: recordsResult
    };
  }

  const usedIds = new Set();
  const assignments = [];
  let highestId = 0;
  for (const record of recordsResult.records) {
    const values = recordValues(record);
    const normalized = normalizeTaskId(values[taskIdField]);
    if (normalized && !usedIds.has(normalized)) {
      usedIds.add(normalized);
      highestId = Math.max(highestId, Number(normalized));
      assignments.push({
        record,
        current: normalized,
        assigned: normalized,
        preserve: true
      });
      continue;
    }

    assignments.push({
      record,
      current: normalized,
      assigned: "",
      preserve: false
    });
  }

  let nextId = highestId + 1;
  const updates = [];
  for (const assignment of assignments) {
    if (!assignment.preserve) {
      let candidate = formatTaskId(nextId);
      while (usedIds.has(candidate)) {
        nextId += 1;
        candidate = formatTaskId(nextId);
      }
      usedIds.add(candidate);
      assignment.assigned = candidate;
      nextId += 1;
    }

    if (assignment.current !== assignment.assigned) {
      const recordId = recordIdOf(assignment.record);
      if (recordId) {
        updates.push({
          record_id: recordId,
          values: {
            [taskIdField]: textCell(assignment.assigned)
          }
        });
      }
    }
  }

  const updateResult = await updateBugCollectionRecords(settings, accessToken, updates);
  if (!updateResult.ok) {
    return {
      ok: false,
      status: "update_records_failed",
      message: `更新任务ID失败：${updateResult.errcode || ""} ${updateResult.errmsg || ""}`.trim(),
      scannedCount: recordsResult.records.length,
      plannedUpdateCount: updates.length,
      updateRecords: updateResult
    };
  }

  const fieldsAfter = await getFields(settings, accessToken);
  const fieldNames = fieldsAfter.ok ? fieldsAfter.fieldNames : [];
  return {
    ok: true,
    status: "ok",
    taskIdField,
    taskIdColumnFirst: fieldNames[0] === taskIdField,
    firstFieldName: fieldNames[0] || "",
    scannedCount: recordsResult.records.length,
    preservedCount: assignments.filter((item) => item.preserve).length,
    updatedCount: updateResult.updatedCount,
    highestTaskId: usedIds.size > 0 ? formatTaskId(nextId - 1) : "",
    truncated: Boolean(recordsResult.truncated),
    addedFieldNames: ensureFieldsResult.addedFieldNames || [],
    columnOrderNote: fieldNames[0] === taskIdField
      ? ""
      : "企业微信智能表格 API 未提供稳定的列移动参数；如果任务ID没有显示在最左侧，需要在共享文档里手动拖到最左侧。"
  };
}

async function createBugCollectionDocument(settings) {
  const missing = missingCreateRequired(settings);
  if (missing.length > 0) {
    return {
      ok: false,
      status: "incomplete",
      message: `缺少配置：${missing.join("、")}`,
      missing
    };
  }

  const accessToken = await getAccessToken(settings);
  const created = await createDocument(settings, accessToken);
  if (!created.ok) {
    return {
      ok: false,
      status: "create_doc_failed",
      message: `创建智能表格失败：${created.errcode || ""} ${created.errmsg || ""}`.trim(),
      createDoc: created
    };
  }

  const docUrlParts = parseSmartSheetUrlParts(created.docUrl);
  const createdSettings = {
    ...settings,
    docid: created.docid
  };
  const sheets = await getSheets(createdSettings, accessToken);
  const smartSheet = firstSmartSheet(sheets.sheetList);
  const share = settings.createDoc && settings.createDoc.shareAfterCreate === false
    ? { ok: true, skipped: true, errcode: 0, errmsg: "share skipped", shareUrl: "" }
    : await shareDocument(created.docid, accessToken);
  const shareUrlParts = parseSmartSheetUrlParts(share.shareUrl);

  return {
    ok: true,
    status: "created",
    docid: created.docid,
    docUrl: created.docUrl,
    shareUrl: share.shareUrl || "",
    docLinkId: shareUrlParts.docLinkId || docUrlParts.docLinkId || "",
    sheetId: docUrlParts.sheetId || (smartSheet && smartSheet.sheetId) || "",
    viewId: docUrlParts.viewId || shareUrlParts.viewId || "",
    sheet: smartSheet || null,
    sheets: {
      ok: sheets.ok,
      errcode: sheets.errcode,
      errmsg: sheets.errmsg,
      sheetList: sheets.sheetList
    },
    share: {
      ok: share.ok,
      skipped: Boolean(share.skipped),
      errcode: share.errcode,
      errmsg: share.errmsg,
      shareUrlCreated: Boolean(share.shareUrl)
    }
  };
}

async function setupBugCollectionSheet(settings) {
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
  const fieldsBefore = await getFields(settings, accessToken);
  if (!fieldsBefore.ok) {
    return {
      ok: false,
      status: "fields_unavailable",
      message: `读取字段失败：${fieldsBefore.errcode || ""} ${fieldsBefore.errmsg || ""}`.trim(),
      fields: fieldsBefore
    };
  }

  const expectedFieldNames = requiredFieldNames(settings);
  const missingFieldNames = expectedFieldNames.filter((fieldName) => !fieldsBefore.fieldNames.includes(fieldName));
  const addFieldsResult = await addFields(settings, accessToken, missingFieldNames);
  if (!addFieldsResult.ok) {
    return {
      ok: false,
      status: "add_fields_failed",
      message: `添加字段失败：${addFieldsResult.errcode || ""} ${addFieldsResult.errmsg || ""}`.trim(),
      fieldsBefore,
      addFields: addFieldsResult
    };
  }

  const addRecordResult = await addTestRecord(settings, accessToken);
  if (!addRecordResult.ok) {
    return {
      ok: false,
      status: "add_record_failed",
      message: `添加测试记录失败：${addRecordResult.errcode || ""} ${addRecordResult.errmsg || ""}`.trim(),
      fieldsBefore,
      addFields: addFieldsResult,
      addRecord: addRecordResult
    };
  }

  return {
    ok: true,
    status: "ok",
    expectedFieldNames,
    existingFieldNames: fieldsBefore.fieldNames,
    missingFieldNames,
    addedFieldNames: addFieldsResult.addedFieldNames || [],
    addRecord: {
      ok: true,
      errcode: addRecordResult.errcode,
      errmsg: addRecordResult.errmsg
    }
  };
}

async function listBugCollectionFields(settings) {
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
  const fields = await getFields(settings, accessToken);
  if (!fields.ok) {
    return {
      ok: false,
      status: "fields_unavailable",
      message: `读取字段失败：${fields.errcode || ""} ${fields.errmsg || ""}`.trim(),
      fields
    };
  }

  return {
    ok: true,
    status: "ok",
    fieldNames: fields.fieldNames,
    fields: fields.fields.map((field) => ({
      title: field.title,
      type: field.type
    }))
  };
}

async function cleanupBugCollectionFields(settings) {
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
  const fieldsBefore = await getFields(settings, accessToken);
  if (!fieldsBefore.ok) {
    return {
      ok: false,
      status: "fields_unavailable",
      message: `读取字段失败：${fieldsBefore.errcode || ""} ${fieldsBefore.errmsg || ""}`.trim(),
      fields: fieldsBefore
    };
  }

  const expectedFieldNames = requiredFieldNames(settings);
  const expected = new Set(expectedFieldNames);
  const extraFields = fieldsBefore.fields.filter((field) => !expected.has(field.title));
  const fieldIdsToDelete = extraFields.map((field) => field.fieldId).filter(Boolean);
  const missingIdFields = extraFields.filter((field) => !field.fieldId).map((field) => field.title);

  const deleteResult = await deleteFields(settings, accessToken, fieldIdsToDelete);
  if (!deleteResult.ok) {
    return {
      ok: false,
      status: "delete_fields_failed",
      message: `删除多余列失败：${deleteResult.errcode || ""} ${deleteResult.errmsg || ""}`.trim(),
      expectedFieldNames,
      existingFieldNames: fieldsBefore.fieldNames,
      extraFieldNames: extraFields.map((field) => field.title),
      deleteFields: deleteResult
    };
  }

  const fieldsAfter = await getFields(settings, accessToken);
  return {
    ok: true,
    status: "ok",
    expectedFieldNames,
    beforeFieldNames: fieldsBefore.fieldNames,
    deletedFieldNames: extraFields.map((field) => field.title),
    deletedFieldCount: fieldIdsToDelete.length,
    missingIdFieldNames: missingIdFields,
    afterFieldNames: fieldsAfter.fieldNames,
    afterFieldCount: fieldsAfter.fieldNames.length,
    deleteFields: {
      ok: true,
      skipped: Boolean(deleteResult.skipped),
      errcode: deleteResult.errcode,
      errmsg: deleteResult.errmsg
    }
  };
}

module.exports = {
  addIssueRecord,
  cleanupBugCollectionFields,
  createBugCollectionDocument,
  listBugCollectionFields,
  migrateBugCollectionTaskIds,
  setupBugCollectionSheet
};
