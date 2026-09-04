"use strict";

const assert = require("assert");
const display = require("../src/admin/static/demand-required-field-display");
const { __test } = require("../src/modules/devProgress/devProgressModule");

const numberProblem = {
  fieldName: "配置/数值剩余",
  code: "number_above_maximum",
  message: "配置/数值剩余不得大于0",
  actualValue: 3,
  maximum: 0
};
const emptyProblem = {
  fieldName: "UI进度",
  code: "empty_value",
  message: "UI进度不得为空"
};

const validationOnly = display.issueLine({
  missingFields: ["配置/数值剩余"],
  fieldProblems: [numberProblem]
});
assert.strictEqual(validationOnly, "需修正：配置/数值剩余当前为 3，应不大于 0");

const emptyOnly = display.issueLine({
  missingFields: ["UI进度"],
  fieldProblems: [emptyProblem]
});
assert.strictEqual(emptyOnly, "缺失：UI进度未填写");

const mixed = display.issueLine({
  missingFields: ["UI进度", "配置/数值剩余"],
  fieldProblems: [emptyProblem, numberProblem]
});
assert.strictEqual(mixed, "需处理：UI进度未填写；配置/数值剩余当前为 3，应不大于 0");
assert.strictEqual(display.issueLine({ missingFields: ["配置/数值剩余"] }), "缺失：配置/数值剩余");

const h5Item = __test.requiredFieldH5Item("李东", {
  task: {
    recordId: "r-test",
    demandId: "003128",
    demand: "联盟角逐（活动）",
    project: "一骑",
    status: "验收后bug修改中",
    dates: {},
    links: {}
  },
  missingFields: ["配置/数值剩余"],
  fieldProblems: [numberProblem]
});
assert.deepStrictEqual(h5Item.fieldProblems, [numberProblem]);

const scoped = __test.requiredFieldItemForLeaderScope({
  recordId: "r-test",
  missingFields: ["UI进度", "配置/数值剩余"],
  fieldProblems: [emptyProblem, numberProblem]
}, new Set(["配置/数值剩余"]));
assert.deepStrictEqual(scoped.missingFields, ["配置/数值剩余"]);
assert.deepStrictEqual(scoped.fieldProblems, [numberProblem]);

console.log(JSON.stringify({
  passed: true,
  checks: {
    emptyFieldStillUsesMissingLabel: true,
    populatedInvalidNumberUsesCorrectionLabel: true,
    mixedProblemsUseActionLabel: true,
    legacyCacheFallbackPreserved: true,
    serverCarriesProblemDetails: true,
    scopedViewsDoNotLeakOtherFieldProblems: true
  }
}, null, 2));
