"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { inspectRequiredFields } = require("../src/modules/devProgress/anomalyScanner");

const configPath = path.resolve(__dirname, "..", "config", "dev-progress.config.json");
const hasProductionConfig = fs.existsSync(configPath);
const config = require(hasProductionConfig
  ? "../config/dev-progress.config.json"
  : "../config/dev-progress.config.example.json");

const UI_FIELDS = ["UI制作交付日期", "UI监修完成日期"];
const PROGRAM_FIELD = "程序开发交付日期";
const DEMAND_PROGRESS_STATUSES = [
  "内网验收中",
  "待上线",
  "内网测试中",
  "测试2验收中",
  "测试2测试中",
  "测试1验收/测试中"
];
const UI_PROGRESS_STATUSES = ["已监修", "已提交", "制作完成"];
const existingConfigurationFilter = {
  title: "配置类需求不要求UI和程序交付日期（回归夹具）",
  when: { demandTypes: ["配置", "活动配置", "配置bug"] },
  fields: [...UI_FIELDS, PROGRAM_FIELD]
};
const hasConfiguredExistingFilter = (config.rules.requiredFields.fieldFilters || []).some((item) => (
  item.title === "配置类需求不要求程序交付日期"
));
const fieldFilters = hasConfiguredExistingFilter
  ? config.rules.requiredFields.fieldFilters
  : [...config.rules.requiredFields.fieldFilters, existingConfigurationFilter];

function configuredFilter(title) {
  const filter = (config.rules.requiredFields.fieldFilters || []).find((item) => item.title === title);
  assert.ok(filter, `missing configured filter: ${title}`);
  return filter;
}

function rulesFor(status, demandType = "新功能") {
  return {
    requiredFields: {
      enabled: true,
      cumulative: false,
      fieldFilters,
      items: [
        { demandType, status, owner: "UI组长", requiredFields: UI_FIELDS },
        { demandType, status, owner: "前端组长、后端组长", requiredFields: [PROGRAM_FIELD] },
        { demandType, status, owner: "王谦", requiredFields: [...UI_FIELDS, PROGRAM_FIELD] }
      ]
    }
  };
}

function missingByField(status, uiProgress, demandType) {
  const decisions = inspectRequiredFields({
    recordId: "FILTER-REGRESSION",
    standard: { demandId: "FILTER-REGRESSION", demandType: demandType || "新功能", status },
    fields: {
      "UI进度": uiProgress,
      "UI制作交付日期": "",
      "UI监修完成日期": "",
      "程序开发交付日期": "",
      "UI需求": "需要UI",
      "前端开发": "需要前端",
      "后端开发": "需要后端"
    }
  }, rulesFor(status, demandType));
  return [...new Set(decisions.filter((item) => item.missing).map((item) => item.fieldName))].sort();
}

const demandFilter = configuredFilter("验收与待上线阶段不要求UI和程序交付日期");
assert.deepStrictEqual(demandFilter.when.statuses, DEMAND_PROGRESS_STATUSES);
assert.deepStrictEqual(demandFilter.fields, [...UI_FIELDS, PROGRAM_FIELD]);

const uiFilter = configuredFilter("UI进度完成阶段不要求UI交付日期");
assert.deepStrictEqual(uiFilter.when.fieldValues["UI进度"], UI_PROGRESS_STATUSES);
assert.deepStrictEqual(uiFilter.fields, UI_FIELDS);

for (const status of DEMAND_PROGRESS_STATUSES) {
  assert.deepStrictEqual(missingByField(status, "制作中"), [], `demand progress filter must match ${status}`);
  assert.deepStrictEqual(missingByField(` ${status} `, "制作中"), [], `demand progress filter must trim ${status}`);
}

for (const uiProgress of UI_PROGRESS_STATUSES) {
  assert.deepStrictEqual(
    missingByField("实现中", uiProgress),
    [PROGRAM_FIELD],
    `UI progress filter must only remove UI date fields for ${uiProgress}`
  );
  assert.deepStrictEqual(
    missingByField("实现中", ` ${uiProgress} `),
    [PROGRAM_FIELD],
    `UI progress filter must trim ${uiProgress}`
  );
}

assert.deepStrictEqual(missingByField("内网测试中", "已提交"), [], "two filters must combine as a union");
assert.deepStrictEqual(
  missingByField("内网验收中x", "制作中"),
  [...UI_FIELDS, PROGRAM_FIELD].sort(),
  "similar demand progress must not match"
);
assert.deepStrictEqual(
  missingByField("实现中", "已提交中"),
  [...UI_FIELDS, PROGRAM_FIELD].sort(),
  "similar UI progress must not match"
);
assert.deepStrictEqual(
  missingByField("实现中", "", "优化"),
  [...UI_FIELDS, PROGRAM_FIELD].sort(),
  "new filters must not remove fields when neither condition matches"
);
assert.deepStrictEqual(missingByField("实现中", "", "配置"), [], "existing configuration filters must remain effective");

console.log(JSON.stringify({
  passed: true,
  configSource: hasProductionConfig ? "production" : "example",
  existingFilterSource: hasConfiguredExistingFilter ? "production_config" : "regression_fixture",
  demandProgressStatusCount: DEMAND_PROGRESS_STATUSES.length,
  uiProgressStatusCount: UI_PROGRESS_STATUSES.length,
  checks: [
    "exact_and_trimmed_demand_progress_match",
    "exact_and_trimmed_ui_progress_match",
    "union_combination",
    "similar_values_do_not_match",
    "non_matching_values_remain_checked",
    "existing_configuration_filter_regression"
  ]
}, null, 2));
