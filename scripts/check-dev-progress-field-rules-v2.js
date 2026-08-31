"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { inspectRequiredFields, scanDevProgressAnomalies } = require("../src/modules/devProgress/anomalyScanner");
const { getDevProgressSettings } = require("../src/config/settingsStore");

const projectRoot = path.resolve(__dirname, "..");
const fieldRuleConfig = JSON.parse(fs.readFileSync(
  path.join(projectRoot, "config", "dev-progress-field-rules.json"),
  "utf8"
));
const requiredFields = {
  ...fieldRuleConfig,
  enabled: true,
  mode: "fieldRulesV2"
};
const rules = { requiredFields };

function record(fields = {}, options = {}) {
  return {
    recordId: options.recordId || "record-test",
    fields,
    mapped: {},
    standard: {
      demandId: options.demandId || "999999",
      project: options.project || "测试项目",
      demand: options.demand || "规则测试需求",
      demandType: options.demandType || "新功能",
      status: options.status || "实现中",
      owners: {}
    }
  };
}

function decisions(fields = {}, options = {}, inspectOptions = {}) {
  return inspectRequiredFields(record(fields, options), rules, inspectOptions);
}

function fieldDecisions(fieldName, fields = {}, options = {}, inspectOptions = {}) {
  return decisions(fields, options, inspectOptions).filter((item) => item.fieldName === fieldName);
}

function ownerNames(items) {
  return [...new Set(items.flatMap((item) => item.ownerNames || []))].sort();
}

const normalizedFromSettings = getDevProgressSettings().rules.requiredFields;
assert.strictEqual(normalizedFromSettings.mode, "fieldRulesV2");
assert.strictEqual(normalizedFromSettings.ruleFile, "config/dev-progress-field-rules.json");
assert.strictEqual(normalizedFromSettings.fieldRules.length, 36);
assert.strictEqual(normalizedFromSettings.fallbackOwner, "王谦");

assert.strictEqual(fieldDecisions("需求名称", {}, { status: "待分配" }).length, 0);
assert.ok(fieldDecisions("需求名称", {}, { status: "规划中" }).some((item) => item.missing));
assert.strictEqual(fieldDecisions("需求名称", {}, { status: "设计中" }).length, 0);
assert.strictEqual(decisions({}, { status: "测试阻塞" }).length, 0);
assert.strictEqual(decisions({}, { demandType: "任务拆分" }).length, 0);
assert.ok(fieldDecisions("规模类型", {}, { status: "规划中" }).some((item) => item.missing));

const scanSummary = scanDevProgressAnomalies([record({}, { status: "规划中" })], {
  requiredFields
});
assert.strictEqual(scanSummary.rules.requiredFieldRuleMode, "fieldRulesV2");
assert.strictEqual(scanSummary.rules.requiredFieldRuleVersion, "2.0.0");
assert.strictEqual(scanSummary.rules.requiredFieldRuleCount, 36);

const configuredFields = new Set(requiredFields.fieldRules.map((item) => item.field));
assert.ok(!configuredFields.has("监修时间"));
assert.ok(!configuredFields.has("监修日期修正值"));
assert.ok(!configuredFields.has("监修日期修正值（可负）"));

assert.strictEqual(fieldDecisions("群聊", {}, { demandType: "bug" }).length, 0);
assert.ok(fieldDecisions("群聊", {}, { demandType: "新功能" }).some((item) => item.missing));
assert.strictEqual(fieldDecisions("需求设计耗时", {}, { demandType: "活动配置", status: "规划中" }).length, 0);
assert.ok(fieldDecisions("需求设计剩余", {}, { demandType: "活动配置", status: "规划中" }).some((item) => item.missing));

const noUiCascade = decisions({ UI需求: "" });
assert.ok(noUiCascade.some((item) => item.fieldName === "UI需求" && item.missing));
assert.strictEqual(noUiCascade.filter((item) => item.fieldName === "UI人员").length, 0);
assert.strictEqual(fieldDecisions("UI人员", { UI需求: "-" }).length, 0);
assert.ok(fieldDecisions("UI人员", { UI需求: "需要UI", 策划人员: "张三" }).some((item) => item.missing));

const plannerOwners = ownerNames(fieldDecisions("需求内容", { 策划人员: "张三" }));
assert.deepStrictEqual(plannerOwners, ["张三", "时振兴", "王谦"].sort());
const uiOwners = ownerNames(fieldDecisions("UI进度", { UI需求: "需要UI", UI人员: "李四" }));
assert.deepStrictEqual(uiOwners, ["李四", "王谦"].sort());
const uiFallbackOnly = fieldDecisions("UI进度", { UI需求: "需要UI", UI人员: "" });
assert.deepStrictEqual(ownerNames(uiFallbackOnly), ["王谦"]);
assert.strictEqual(uiFallbackOnly.filter((item) => item.ownerNames.includes("王谦")).length, 1);
const frontendOwners = ownerNames(fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端组长: "胡锦南"
}));
assert.deepStrictEqual(frontendOwners, ["赵鹏", "胡锦南", "王谦"].sort());
const frontendFallbackOnly = fieldDecisions("前端开发", {
  前端开发: "",
  前端组长: ""
});
assert.deepStrictEqual(ownerNames(frontendFallbackOnly), ["王谦"]);

const workdayDates = [
  "2026-08-31",
  "2026-09-01",
  "2026-09-02",
  "2026-09-03"
];
const deadlineViolation = fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端组长: "胡锦南",
  前端剩余: "2",
  开发截止日期: "2026-09-01"
}, {}, { today: new Date(2026, 7, 31), workdayDates });
assert.ok(deadlineViolation.every((item) => item.missing && item.reason === "date_after_deadline"));
assert.ok(deadlineViolation.every((item) => item.problems[0].resultDate === "2026-09-02"));

const deadlinePass = fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端组长: "胡锦南",
  前端剩余: "2",
  开发截止日期: "2026-09-02"
}, {}, { today: new Date(2026, 7, 31), workdayDates });
assert.ok(deadlinePass.every((item) => !item.missing));

const missingDeadlineIgnored = fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端组长: "胡锦南",
  前端剩余: "2",
  开发截止日期: ""
}, {}, { today: new Date(2026, 7, 31), workdayDates });
assert.ok(missingDeadlineIgnored.every((item) => !item.missing));
assert.ok(missingDeadlineIgnored.every((item) => item.validationSkipped.some((skip) => skip.code === "deadline_dependency_unavailable")));

const missingCalendarIgnored = fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端组长: "胡锦南",
  前端剩余: "2",
  开发截止日期: "2026-09-01"
}, {}, { today: new Date(2026, 7, 31), workdayDates: [] });
assert.ok(missingCalendarIgnored.every((item) => !item.missing));
assert.ok(missingCalendarIgnored.every((item) => item.validationSkipped.some((skip) => skip.code === "workday_calendar_unavailable")));

const directDateViolation = fieldDecisions("UI日方时间", {
  UI需求: "需要UI",
  UI人员: "李四",
  UI日方时间: "2026-09-03",
  UI完成时间: "2026-09-02",
  美术截止日期: "2026-09-04"
});
assert.ok(directDateViolation.every((item) => item.missing && item.reason === "date_after_deadline"));

console.log("Dev progress field rules v2 check passed");
