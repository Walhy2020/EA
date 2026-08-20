"use strict";

const fs = require("fs");
const https = require("https");
const path = require("path");
const { projectRoot } = require("../../utils/paths");

const registryDir = path.join(projectRoot, "data", "doc-creator");
const registryFile = path.join(registryDir, "created-docs.jsonl");

const DOC_KIND_SPECS = {
  document: {
    action: "create_document",
    displayName: "文档",
    defaultPrefix: "EA文档",
    prefixKey: "documentNamePrefix",
    docType: 3,
    needsSheetInfo: false
  },
  smartdoc: {
    action: "create_smart_document",
    displayName: "智能文档",
    defaultPrefix: "EA智能文档",
    prefixKey: "smartDocumentNamePrefix",
    docType: 3,
    needsSheetInfo: false
  },
  spreadsheet: {
    action: "create_spreadsheet",
    displayName: "表格",
    defaultPrefix: "EA表格",
    prefixKey: "spreadsheetNamePrefix",
    docType: 4,
    needsSheetInfo: false
  },
  smartsheet: {
    action: "create_smartsheet",
    displayName: "智能表格",
    defaultPrefix: "EA智能表格",
    prefixKey: "docNamePrefix",
    docType: 10,
    needsSheetInfo: true
  }
};

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
          resolve(text ? JSON.parse(text) : {});
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

function envValue(name) {
  return name ? (process.env[name] || "") : "";
}

function defaultConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    name: config.name || "企业微信文档创建",
    auth: {
      corpIdEnv: (config.auth && config.auth.corpIdEnv) || "WECOM_DOC_CORP_ID",
      agentIdEnv: (config.auth && config.auth.agentIdEnv) || "WECOM_DOC_AGENT_ID",
      secretEnv: (config.auth && config.auth.secretEnv) || "WECOM_DOC_SECRET"
    },
    createDoc: {
      documentNamePrefix: (config.createDoc && config.createDoc.documentNamePrefix) || "EA文档",
      smartDocumentNamePrefix: (config.createDoc && config.createDoc.smartDocumentNamePrefix) || "EA智能文档",
      docNamePrefix: (config.createDoc && config.createDoc.docNamePrefix) || "EA智能表格",
      spreadsheetNamePrefix: (config.createDoc && config.createDoc.spreadsheetNamePrefix) || "EA表格",
      docTypes: {
        document: 3,
        smartdoc: 3,
        spreadsheet: 4,
        smartsheet: 10,
        ...((config.createDoc && config.createDoc.docTypes) || {})
      },
      spaceId: (config.createDoc && config.createDoc.spaceId) || "",
      fatherId: (config.createDoc && config.createDoc.fatherId) || "",
      adminUsers: Array.isArray(config.createDoc && config.createDoc.adminUsers)
        ? config.createDoc.adminUsers
        : [],
      shareAfterCreate: !config.createDoc || config.createDoc.shareAfterCreate !== false
    }
  };
}

function missingCreateRequired(config) {
  const auth = config.auth || {};
  const missing = [];
  if (!envValue(auth.corpIdEnv)) {
    missing.push("CorpID");
  }
  if (!envValue(auth.secretEnv)) {
    missing.push("应用 Secret");
  }
  return missing;
}

async function getAccessToken(config) {
  const auth = config.auth || {};
  const corpId = envValue(auth.corpIdEnv);
  const secret = envValue(auth.secretEnv);
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
  const data = await requestJson("GET", url);
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`获取企业微信 access_token 失败：${data.errcode || "unknown"} ${data.errmsg || ""}`.trim());
  }
  return data.access_token;
}

async function postWeDoc(path, accessToken, payload) {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/wedoc/${path}?access_token=${encodeURIComponent(accessToken)}`;
  return requestJson("POST", url, payload);
}

function docKindSpec(config, kind) {
  const normalizedKind = DOC_KIND_SPECS[kind] ? kind : "smartsheet";
  const spec = DOC_KIND_SPECS[normalizedKind];
  const configuredDocType = config.createDoc
    && config.createDoc.docTypes
    && Number(config.createDoc.docTypes[normalizedKind]);
  const configuredPrefix = config.createDoc && config.createDoc[spec.prefixKey];
  return {
    ...spec,
    kind: normalizedKind,
    docType: Number.isFinite(configuredDocType) && configuredDocType > 0 ? configuredDocType : spec.docType,
    prefix: configuredPrefix || spec.defaultPrefix
  };
}

function normalizeDocName(value, prefix, options = {}) {
  const stripTypeSuffix = options.stripTypeSuffix !== false;
  const raw = String(value || "").trim();
  let cleaned = raw
    .replace(/^(?:请|帮我|麻烦)?(?:创建|新建|建立|生成|建)(?:一个|一张|个|张)?(?:新的?)?(?:企业微信)?(?:共享|在线|普通)?(?:智能)?(?:文档|表格|表)\s*/i, "")
    .replace(/^(?:叫|名叫|名称叫|名字叫|命名为)\s*/i, "")
    .replace(/[，,。！？!?.；;：:]$/g, "")
    .trim();
  if (stripTypeSuffix) {
    cleaned = cleaned.replace(/(?:的)?(?:智能)?(?:文档|表格|表)$/i, "").trim();
  }
  if (cleaned && cleaned.length <= 80) {
    return cleaned;
  }

  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0")
  ].join("");
  return `${prefix || "EA智能表格"}-${stamp}`;
}

function parseDocUrlParts(docUrl) {
  if (typeof docUrl !== "string" || !docUrl.trim()) {
    return {};
  }
  try {
    const url = new URL(docUrl.trim());
    const parts = url.pathname.split("/").filter(Boolean);
    const typeIndex = parts.findIndex((part) => ["doc", "smartdoc", "smartsheet", "sheet"].includes(part));
    return {
      docLinkId: typeIndex >= 0 && parts[typeIndex + 1] ? parts[typeIndex + 1] : "",
      sheetId: url.searchParams.get("tab") || "",
      viewId: url.searchParams.get("viewId") || ""
    };
  } catch (error) {
    return {};
  }
}

function appendCreatedDoc(entry) {
  fs.mkdirSync(registryDir, { recursive: true });
  fs.appendFileSync(registryFile, `${JSON.stringify(entry)}\n`, "utf8");
}

function uniqueNonEmpty(values) {
  return [...new Set(values
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function documentAdminUsers(config, input = {}) {
  const configured = Array.isArray(config.createDoc && config.createDoc.adminUsers)
    ? config.createDoc.adminUsers
    : [];
  const requesterUserId = input.sender && input.sender.userId ? input.sender.userId : "";
  return uniqueNonEmpty([
    ...configured,
    requesterUserId
  ]);
}

async function getSheets(docid, accessToken) {
  const data = await postWeDoc("smartsheet/get_sheet", accessToken, { docid });
  const sheetList = Array.isArray(data.sheet_list)
    ? data.sheet_list.map((sheet) => ({
      sheetId: sheet.sheet_id || sheet.sheetId || sheet.id || "",
      title: sheet.title || sheet.name || "",
      type: sheet.type || ""
    }))
    : [];
  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    sheetList
  };
}

function firstSmartSheet(sheetList) {
  return sheetList.find((sheet) => String(sheet.type || "").toLowerCase() === "smartsheet") || sheetList[0] || null;
}

function createdDocText(spec, visibleUrl) {
  return [
    `${spec.displayName}已创建。`,
    `地址：${visibleUrl || "企业微信未返回可见地址，请在文档列表中查看。"}`
  ].join("\n");
}

async function createDocument(config, input = {}, kind = "smartsheet", logger = console) {
  const spec = docKindSpec(config, kind);
  if (!config.enabled) {
    return {
      ok: false,
      status: "disabled",
      text: "企业微信文档创建功能未启用。"
    };
  }

  const missing = missingCreateRequired(config);
  if (missing.length > 0) {
    return {
      ok: false,
      status: "incomplete",
      text: `创建${spec.displayName}失败：缺少配置 ${missing.join("、")}。`,
      missing
    };
  }

  const hasExplicitDocName = Boolean(String(input.docName || "").trim());
  const docName = normalizeDocName(
    hasExplicitDocName ? input.docName : input.text,
    spec.prefix,
    { stripTypeSuffix: !hasExplicitDocName }
  );
  const accessToken = await getAccessToken(config);
  const payload = {
    doc_type: spec.docType,
    doc_name: docName
  };
  if (config.createDoc.spaceId) {
    payload.spaceid = config.createDoc.spaceId;
  }
  if (config.createDoc.fatherId) {
    payload.fatherid = config.createDoc.fatherId;
  }
  const adminUsers = documentAdminUsers(config, input);
  if (adminUsers.length > 0) {
    payload.admin_users = adminUsers;
  }

  logger.info("WeDoc create_doc start", {
    module: "docCreator",
    action: spec.action,
    kind: spec.kind,
    docType: spec.docType,
    docName,
    hasExplicitDocName,
    hasSpaceId: Boolean(config.createDoc.spaceId),
    hasFatherId: Boolean(config.createDoc.fatherId),
    adminUserCount: adminUsers.length
  });

  const created = await postWeDoc("create_doc", accessToken, payload);
  if (created.errcode !== 0 || !created.docid) {
    logger.warn("WeDoc create_doc failed", {
      module: "docCreator",
      action: spec.action,
      kind: spec.kind,
      docType: spec.docType,
      errcode: created.errcode,
      errmsg: created.errmsg
    });
    return {
      ok: false,
      status: "create_doc_failed",
      text: `创建${spec.displayName}失败：${created.errcode || ""} ${created.errmsg || ""}`.trim(),
      createDoc: {
        errcode: created.errcode,
        errmsg: created.errmsg
      }
    };
  }

  const normalizedSheets = spec.needsSheetInfo
    ? await getSheets(created.docid, accessToken)
    : { ok: true, errcode: 0, errmsg: "skipped", sheetList: [] };
  const smartSheet = spec.needsSheetInfo ? firstSmartSheet(normalizedSheets.sheetList) : null;
  const share = config.createDoc.shareAfterCreate
    ? await postWeDoc("doc_share", accessToken, { docid: created.docid })
    : { errcode: 0, errmsg: "share skipped", share_url: "" };
  const docUrlParts = parseDocUrlParts(created.url);
  const shareUrlParts = parseDocUrlParts(share.share_url);
  const visibleUrl = share.share_url || created.url || "";
  const sheetId = docUrlParts.sheetId || shareUrlParts.sheetId || (smartSheet && smartSheet.sheetId) || "";
  const viewId = docUrlParts.viewId || shareUrlParts.viewId || "";
  const createdAt = new Date().toISOString();
  appendCreatedDoc({
    createdAt,
    kind: spec.kind,
    docType: payload.doc_type,
    docName,
    docid: created.docid,
    docUrl: created.url || "",
    shareUrl: share.share_url || "",
    docLinkId: shareUrlParts.docLinkId || docUrlParts.docLinkId || "",
    sheetId,
    viewId,
    adminUsers,
    creator: {
      userId: input.sender && input.sender.userId ? input.sender.userId : "",
      name: input.sender && input.sender.name ? input.sender.name : ""
    }
  });

  logger.info("WeDoc create_doc completed", {
    module: "docCreator",
    action: spec.action,
    kind: spec.kind,
    docType: spec.docType,
    docid: created.docid,
    shareOk: share.errcode === 0,
    shareUrlCreated: Boolean(share.share_url),
    sheetId: sheetId || "",
    viewId: viewId || ""
  });

  return {
    ok: true,
    status: "created",
    module: "docCreator",
    action: spec.action,
    text: createdDocText(spec, visibleUrl),
    data: {
      kind: spec.kind,
      docType: payload.doc_type,
      docName,
      docid: created.docid,
      createdAt,
      docUrl: created.url || "",
      shareUrl: share.share_url || "",
      docLinkId: shareUrlParts.docLinkId || docUrlParts.docLinkId || "",
      sheetId,
      viewId,
      adminUsers,
      sheet: smartSheet,
      share: {
        ok: share.errcode === 0,
        errcode: share.errcode,
        errmsg: share.errmsg,
        shareUrlCreated: Boolean(share.share_url)
      },
      sheets: {
        ok: normalizedSheets.ok,
        errcode: normalizedSheets.errcode,
        errmsg: normalizedSheets.errmsg,
        sheetList: normalizedSheets.sheetList
      }
    }
  };
}

async function createNormalDocument(config, input = {}, logger = console) {
  return createDocument(config, input, "document", logger);
}

async function createSmartDocument(config, input = {}, logger = console) {
  return createDocument(config, input, "smartdoc", logger);
}

async function createSmartSheet(config, input = {}, logger = console) {
  return createDocument(config, input, "smartsheet", logger);
}

async function createSpreadsheet(config, input = {}, logger = console) {
  return createDocument(config, input, "spreadsheet", logger);
}

function createDocCreatorModule(options = {}) {
  const config = defaultConfig(options.moduleConfig || {});
  const logger = options.logger || console;

  async function handle(context = {}) {
    const task = context.route && context.route.task ? context.route.task : {};
    const params = task.params || {};
    const action = String(task.action || "").toLowerCase();
    const input = {
      text: context.text || "",
      docName: params.docName || params.name || "",
      sender: context.sender || {}
    };
    if (action === "create_document") {
      return createNormalDocument(config, input, logger);
    }
    if (action === "create_smart_document" || action === "create_smartdoc") {
      return createSmartDocument(config, input, logger);
    }
    if (action === "create_spreadsheet") {
      return createSpreadsheet(config, input, logger);
    }
    return createSmartSheet(config, input, logger);
  }

  async function getStatus() {
    const missing = missingCreateRequired(config);
    return {
      enabled: Boolean(config.enabled),
      ready: missing.length === 0,
      missing,
      registryFile,
      docTypes: Object.fromEntries(Object.keys(DOC_KIND_SPECS).map((kind) => {
        const spec = docKindSpec(config, kind);
        return [kind, spec.docType];
      }))
    };
  }

  return {
    name: "docCreator",
    handle,
    createDocument: (input = {}) => createNormalDocument(config, input, logger),
    createSmartDocument: (input = {}) => createSmartDocument(config, input, logger),
    createSmartSheet: (input = {}) => createSmartSheet(config, input, logger),
    createSpreadsheet: (input = {}) => createSpreadsheet(config, input, logger),
    getStatus
  };
}

module.exports = {
  createDocCreatorModule
};
