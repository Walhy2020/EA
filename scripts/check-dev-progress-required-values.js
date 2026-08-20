"use strict";

const {
  inspectRequiredFields,
  scanDevProgressAnomalies
} = require("../src/modules/devProgress/anomalyScanner");
const {
  applyLookupFallbacks,
  normalizeDevProgressRecord
} = require("../src/modules/devProgress/wecomSmartsheetClient");
const { createDevProgressMonitorBridge } = require("../src/monitors/devProgressMonitorBridge");
const fs = require("fs");
const os = require("os");
const path = require("path");
const devProgressConfig = require("../config/dev-progress.config.json");

const OMITTED_FIELD = Symbol("omitted-field");

const rules = {
  scanStartDate: "2026-01-01",
  excludedProjects: [],
  completedStatusKeywords: [],
  onlineStatusKeywords: [],
  ignoredStatusKeywords: [],
  requiredFields: {
    enabled: true,
    cumulative: false,
    items: [{
      demandType: "优化",
      status: "测试中",
      owner: "高文盛",
      requiredFields: ["目标字段"]
    }]
  }
};

function record(value, options = {}) {
  return {
    recordId: options.recordId || "R-1",
    fields: { "目标字段": value },
    fieldValueTypes: { "目标字段": options.rawValueType || (value === null ? "null" : typeof value) },
    standard: {
      demandId: options.demandId || "D-1",
      demand: options.demand || "同名需求",
      project: options.project || "测试项目",
      demandType: "优化",
      status: "测试中",
      dates: {},
      owners: {},
      links: {}
    },
    mapped: {}
  };
}

function decisionFor(value, options = {}) {
  return inspectRequiredFields(record(value, options), rules)[0];
}

function pushResult(items) {
  return {
    ok: true,
    push: {
      targetOverride: {
        enabled: true,
        targetName: "高文盛"
      },
      targets: [{
        ownerName: "高文盛",
        targetId: "YuYin",
        targetOverride: true,
        items
      }]
    }
  };
}

function task(recordId, demandId, missingFields) {
  return {
    missingFields,
    status: "测试中",
    task: {
      recordId,
      demandId,
      demand: "重复标题",
      project: "女王",
      status: "测试中",
      links: {}
    }
  };
}

async function duplicateTitleCheck() {
  const stateFile = path.join(os.tmpdir(), `ea-required-values-${Date.now()}.json`);
  const messages = [];
  const results = [
    pushResult([task("R-A", "D-A", ["初始字段"])]),
    pushResult([
      task("R-B", "D-B", ["不应串入"]),
      task("R-A", "D-A", ["仅此字段"])
    ])
  ];
  const bridge = createDevProgressMonitorBridge({
    devProgressModule: {
      prepareRequiredFieldPush: async () => results.shift() || pushResult([])
    },
    appNotifier: {
      send: async (message) => {
        messages.push(message);
        return { ok: true, msgid: "M1" };
      }
    },
    appFeedbackUrl: "http://127.0.0.1:39200/dev-required-feedback.html",
    monitorConfig: {
      enabled: false,
      notifyThroughCenter: true,
      changeDetection: { enabled: false },
      requiredFieldsPush: {
        enabled: true,
        testMode: true,
        testTargetName: "高文盛",
        pilot: { enabled: true, targetName: "高文盛", remindMinutes: 60 }
      }
    },
    logger: { info() {}, warn() {}, error() {} },
    stateFile
  });

  try {
    await bridge.tick();
    const url = new URL(messages[0].url);
    const refreshed = await bridge.getPilotAppFeedback({
      reminderId: url.searchParams.get("reminderId"),
      token: url.searchParams.get("token")
    });
    const passed = refreshed.ok
      && refreshed.task.demandId === "D-A"
      && JSON.stringify(refreshed.task.missingFields) === JSON.stringify(["仅此字段"]);
    return passed;
  } finally {
    bridge.stop();
    fs.rmSync(stateFile, { force: true });
  }
}

function configuredRequiredFieldNames() {
  const requiredRule = devProgressConfig.rules && devProgressConfig.rules.requiredFields
    ? devProgressConfig.rules.requiredFields
    : {};
  const items = Array.isArray(requiredRule.items) ? requiredRule.items : [];
  return [...new Set(items.flatMap((item) => (
    Array.isArray(item && item.requiredFields) ? item.requiredFields : []
  )).map((fieldName) => String(fieldName || "").trim()).filter(Boolean))].sort((left, right) => (
    left.localeCompare(right, "zh-CN")
  ));
}

function requiredFieldMatrixDecision(fieldName, rawValue, userNameMap = {}) {
  const values = rawValue === OMITTED_FIELD ? {} : { [fieldName]: rawValue };
  const normalized = normalizeDevProgressRecord({
    record_id: `MATRIX-${fieldName}`,
    values
  }, {
    fieldMapping: {}
  }, userNameMap);
  normalized.standard = {
    demandId: `MATRIX-${fieldName}`,
    demand: "全字段三态检查",
    project: "测试项目",
    demandType: "矩阵检查",
    status: "检查中",
    dates: {},
    owners: {},
    links: {}
  };
  const matrixRules = {
    requiredFields: {
      enabled: true,
      cumulative: false,
      items: [{
        demandType: "矩阵检查",
        status: "检查中",
        owner: "测试责任人",
        requiredFields: [fieldName]
      }]
    }
  };
  return inspectRequiredFields(normalized, matrixRules)[0];
}

function requiredFieldMatrixCheck() {
  const fieldNames = configuredRequiredFieldNames();
  const emptyCases = [
    ["omitted", OMITTED_FIELD, {}],
    ["null", null, {}],
    ["empty_string", "", {}],
    ["whitespace", "   ", {}],
    ["empty_array", [], {}],
    ["empty_object", {}, {}],
    ["empty_value_object", { value: "" }, {}],
    ["empty_content_object", { content: "" }, {}],
    ["empty_user_with_no_name", { user_id: "", name: "" }, {}]
  ];
  const dashCases = [
    ["dash_string", "-", {}],
    ["dash_array", ["-"], {}],
    ["dash_text_object", { text: "-" }, {}],
    ["dash_value_object", { value: "-" }, {}],
    ["dash_content_object", { content: "-" }, {}],
    ["dash_name_object", { name: "-" }, {}],
    ["dash_empty_user_name", { user_id: "", name: "-" }, {}],
    ["dash_mapped_user", { user_id: "matrix-dash" }, { "matrix-dash": "-" }]
  ];
  const valueCases = [
    ["text", "测试值", {}],
    ["zero", 0, {}],
    ["false", false, {}],
    ["text_array", ["测试值"], {}],
    ["text_object", { text: "测试值" }, {}],
    ["value_object", { value: "测试值" }, {}],
    ["content_object", { content: "测试值" }, {}],
    ["name_object", { name: "测试值" }, {}],
    ["empty_user_name", { user_id: "", name: "测试用户" }, {}],
    ["mapped_user", { user_id: "matrix-user" }, { "matrix-user": "测试用户" }]
  ];
  const failures = [];
  let caseCount = 0;
  for (const fieldName of fieldNames) {
    for (const [caseName, rawValue, userNameMap] of emptyCases) {
      caseCount += 1;
      const decision = requiredFieldMatrixDecision(fieldName, rawValue, userNameMap);
      if (!decision || decision.missing !== true) {
        failures.push({ fieldName, state: "empty", caseName, decision });
      }
    }
    for (const [caseName, rawValue, userNameMap] of dashCases) {
      caseCount += 1;
      const decision = requiredFieldMatrixDecision(fieldName, rawValue, userNameMap);
      if (!decision || decision.missing !== false || decision.normalizedValue !== "-") {
        failures.push({ fieldName, state: "dash", caseName, decision });
      }
    }
    for (const [caseName, rawValue, userNameMap] of valueCases) {
      caseCount += 1;
      const decision = requiredFieldMatrixDecision(fieldName, rawValue, userNameMap);
      if (!decision || decision.missing !== false) {
        failures.push({ fieldName, state: "value", caseName, decision });
      }
    }
  }
  return {
    passed: fieldNames.length > 0 && failures.length === 0,
    fieldCount: fieldNames.length,
    caseCount,
    states: {
      emptyCaseCount: emptyCases.length,
      dashCaseCount: dashCases.length,
      valueCaseCount: valueCases.length
    },
    fieldNames,
    failures
  };
}

async function main() {
  const normalizedObject = normalizeDevProgressRecord({
    record_id: "P-1",
    values: { "目标字段": { user_id: "u-wenjing" } }
  }, {
    fieldMapping: { backendLead: "目标字段" }
  }, { "u-wenjing": "王文静" });
  const normalizedArray = normalizeDevProgressRecord({
    record_id: "P-2",
    values: { "目标字段": [{ name: "王文静" }] }
  }, {
    fieldMapping: { backendLead: "目标字段" }
  });
  const mappedButDirectField = normalizeDevProgressRecord({
    record_id: "P-3",
    values: { "后端组长": "王文静" }
  }, {
    fieldMapping: { backendLead: "错误映射列" }
  });
  const mappingRules = {
    ...rules,
    requiredFields: {
      ...rules.requiredFields,
      items: [{
        demandType: "优化",
        status: "测试中",
        owner: "高文盛",
        requiredFields: ["后端组长"]
      }]
    }
  };
  const mappedRecord = {
    ...mappedButDirectField,
    standard: {
      ...record("", { recordId: "P-3" }).standard,
      demandId: "D-3"
    }
  };
  const emptyCases = [null, "", "   "];
  const emptyCasesMissing = emptyCases.every((value) => decisionFor(value).missing);
  const dashAccepted = !decisionFor("-").missing;
  const nameAccepted = !decisionFor("王文静").missing;
  const objectAccepted = !decisionFor(normalizedObject.fields["目标字段"], {
    rawValueType: normalizedObject.fieldValueTypes["目标字段"]
  }).missing;
  const arrayAccepted = !decisionFor(normalizedArray.fields["目标字段"], {
    rawValueType: normalizedArray.fieldValueTypes["目标字段"]
  }).missing;
  const mappingFallbackAccepted = inspectRequiredFields(mappedRecord, mappingRules)[0].missing === false;
  const lookupRecord = {
    record_id: "LOOKUP-1",
    values: {
      "前端开发": [{ user_id: "frontend-user" }],
      "后端开发": [{ user_id: "backend-user" }],
      "前端组长": null,
      "后端组长": null
    }
  };
  const lookupResolver = {
    lookups: new Map([
      ["前端组长", {
        fieldId: "frontend-lead-id",
        fieldType: "FIELD_TYPE_LOOKUP",
        lookupFieldId: "leader-id",
        sourceSheetId: "people-sheet",
        ownerTitle: "前端开发",
        valuesByOwner: new Map([["frontend-user", [{ user_id: "frontend-lead" }]]])
      }],
      ["后端组长", {
        fieldId: "backend-lead-id",
        fieldType: "FIELD_TYPE_LOOKUP",
        lookupFieldId: "leader-id",
        sourceSheetId: "people-sheet",
        ownerTitle: "后端开发",
        valuesByOwner: new Map([["backend-user", [{ user_id: "backend-lead" }]]])
      }]
    ])
  };
  const lookupSources = applyLookupFallbacks([lookupRecord], lookupResolver, {});
  const lookupNormalized = normalizeDevProgressRecord(lookupRecord, {
    fieldMapping: {
      frontendOwner: "前端开发",
      backendOwner: "后端开发",
      frontendLead: "前端组长",
      backendLead: "后端组长"
    }
  }, {
    "frontend-lead": "-",
    "backend-lead": "王文静"
  }, {
    fieldValueSources: lookupSources.get("LOOKUP-1")
  });
  const lookupFallbackAccepted = lookupNormalized.fields["前端组长"] === "-"
    && lookupNormalized.fields["后端组长"] === "王文静"
    && lookupNormalized.fieldValueSources["后端组长"].source === "lookup_people_mapping";
  const placeholderRecord = {
    record_id: "LOOKUP-PLACEHOLDER",
    values: {
      "后端开发": [{ user_id: "backend-none" }],
      "后端组长": null
    }
  };
  const placeholderSources = applyLookupFallbacks([placeholderRecord], lookupResolver, {
    "backend-none": "-"
  });
  const placeholderNormalized = normalizeDevProgressRecord(placeholderRecord, {
    fieldMapping: {
      backendOwner: "后端开发",
      backendLead: "后端组长"
    }
  }, {
    "backend-none": "-"
  }, {
    fieldValueSources: placeholderSources.get("LOOKUP-PLACEHOLDER")
  });
  const lookupOwnerPlaceholderAccepted = placeholderNormalized.fields["后端组长"] === "-"
    && placeholderNormalized.fieldValueSources["后端组长"].source === "lookup_owner_placeholder";
  const scanRecognizesOnlyEmpty = scanDevProgressAnomalies([
    record("-", { recordId: "R-DASH", demandId: "D-DASH" }),
    record("", { recordId: "R-EMPTY", demandId: "D-EMPTY" })
  ], rules).anomalies.length === 1;
  const duplicateTitlesIsolated = await duplicateTitleCheck();
  const requiredFieldMatrix = requiredFieldMatrixCheck();
  const checks = {
    emptyCasesMissing,
    dashAccepted,
    nameAccepted,
    objectAccepted,
    arrayAccepted,
    mappingFallbackAccepted,
    lookupFallbackAccepted,
    lookupOwnerPlaceholderAccepted,
    scanRecognizesOnlyEmpty,
    duplicateTitlesIsolated,
    requiredFieldMatrix: requiredFieldMatrix.passed
  };
  const passed = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ passed, checks, requiredFieldMatrix }, null, 2));
  if (!passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
