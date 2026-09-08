"use strict";
const assert = require("assert");
const { getDevProgressSettings } = require("../src/config/settingsStore");
const { inspectRequiredFields } = require("../src/modules/devProgress/anomalyScanner");
const rules = getDevProgressSettings().rules;
const config = rules.requiredFields;
assert.strictEqual(config.sourceVersion, "V0008");
const source = require(`../docs/monitor-rules/${config.sourceVersion}.source.json`);
const rows = source.sheets[0].rows.filter(({ cells }) => ["是", "看需求类型"].includes(cells[1]));
assert.strictEqual(config.fieldRules.length, rows.length);
for (const { cells } of rows) {
  const rule = config.fieldRules.find((item) => item.field === cells[0]);
  assert.ok(rule, cells[0]);
  assert.strictEqual(rule.startStatus, cells[3]);
  assert.deepStrictEqual(rule.monitorGroups, cells[4].split(","));
  assert.deepStrictEqual(rule.excludedDemandTypes.slice().sort(), (cells[5] || "").split(",").filter(Boolean).sort());
  assert.strictEqual(rule.leaderRole, cells[6]);
}
function inspect(field, values, status = "实现中", demandType = "新功能") {
  return inspectRequiredFields({
    recordId: "rule-source-test",
    fields: { UI需求: "需要UI", UI人员: "测试组员", ...values },
    standard: { demandId: "test", status, demandType, owners: {} }
  }, rules).filter((item) => item.fieldName === field);
}
function expectEvery(items, predicate) {
  assert.ok(items.length > 0);
  assert.ok(items.every(predicate));
}
for (const field of ["UI耗时", "UI剩余时间", "UI开始时间", "UI完成时间", "UI日方时间"]) {
  const exempt = ["制作完成(未监修或提交)", "制作完成（未监修或提交）", "已监修", "已提交", "日方制作中", "替换图已拆完", " 替换图已拆完 "];
  for (const progress of exempt) expectEvery(inspect(field, { UI进度: progress }), (item) => !item.missing);
  for (const progress of ["待分配", "制作/拆分中", "", "部分完成", "替换图已全返", "替换图部分返回", "替换图拆分中", "替换图已拆完待确认"]) {
    expectEvery(inspect(field, { UI进度: progress }), (item) => item.reason === "empty_value");
  }
  assert.strictEqual(inspect(field, { UI需求: "-", UI进度: "待分配" }).length, 0);
  assert.strictEqual(inspect(field, { UI进度: "待分配" }, "实现中", "bug").length, 0);
}
expectEvery(inspect("UI日方时间", { UI进度: "日方制作中" }), (item) => !item.missing);
expectEvery(inspect("UI日方时间", {
  UI进度: "日方制作中", UI日方时间: "2026-09-10", 美术截止日期: "2026-09-09"
}), (item) => item.reason === "date_after_deadline");
expectEvery(inspect("UI剩余时间", { UI进度: "替换图已拆完", UI剩余时间: 1 }, "内网测试中"),
  (item) => item.reason === "number_above_maximum");
expectEvery(inspect("UI剩余时间", { UI进度: "替换图已拆完", UI剩余时间: 0 }, "内网测试中"), (item) => !item.missing);
assert.strictEqual(inspect("策划人员", {}, "规划中", "bug").length, 0);
expectEvery(inspect("策划人员", {}, "规划中", "配置bug"), (item) => item.reason === "empty_value");
for (const [status, value] of [["验收后bug修改中", 3], ["内网测试中", 2]]) {
  expectEvery(inspect("配置/数值剩余", { "配置/数值剩余": value }, status), (item) => item.reason === "number_above_maximum");
}
console.log(`${config.sourceVersion} source parity and conditional required-field checks passed`);
