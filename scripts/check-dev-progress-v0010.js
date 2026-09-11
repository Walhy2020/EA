"use strict";

const assert = require("assert");
const { getDevProgressSettings } = require("../src/config/settingsStore");
const { inspectRequiredFields } = require("../src/modules/devProgress/anomalyScanner");
const rules = getDevProgressSettings().rules;
const config = rules.requiredFields;
assert.strictEqual(config.sourceVersion, "V0010");
const today = new Date(2026, 8, 11);
const workdayDates = ["2026-09-11", "2026-09-14", "2026-09-15", "2026-09-16"];
function inspect(field, fields = {}, status = "实现中", demandType = "新功能") {
  return inspectRequiredFields({ recordId: "v0010-test", fields: {
    UI需求: "需要UI", 动效需求: "需要动效", 策划人员: "许翔宇", ...fields
  }, standard: { demandId: "test", status, demandType, owners: {} } }, rules, { today, workdayDates })
    .filter((item) => item.fieldName === field);
}
function expect(field, fields, status, reason = "") {
  const items = inspect(field, fields, status);
  assert(items.length > 0, `${field}: expected active decisions`);
  assert(items.every((item) => reason ? item.missing && item.reason === reason : !item.missing),
    `${field}/${status}: ${JSON.stringify(items.map((item) => ({ reason: item.reason, problems: item.problems })))}`);
}
for (const type of ["bug", "配置bug"]) {
  for (const status of config.statusSequence) assert.strictEqual(inspect("规模类型", {}, status, type).length, 0);
}
expect("规模类型", {}, "规划中", "empty_value");
for (const field of ["UI需求", "动效需求"]) {
  const decisions = inspect(field, { [field]: "" });
  assert(decisions.some((item) => item.responsibilityRole === "leader" && item.ownerNames.includes("李东"))
    || decisions.some((item) => item.ownerNames.includes("李东")), `${field}: planner leader missing`);
  assert.strictEqual(config.fieldRules.find((r) => r.field === field).leaderRole, "策划组长");
}
for (const status of ["日方制作中", " 日方制作中 "]) expect("UI日方时间", { UI进度: status }, "实现中", "empty_value");
for (const status of ["", "待分配", "制作/拆分中", "部分完成", "已提交", "替换图已拆完", "日方制作中待确认"]) {
  expect("UI日方时间", { UI进度: status }, "实现中");
}
for (const deadline of ["美术截止日期", "UI完成时间"]) {
  expect("UI日方时间", { UI进度: "日方制作中", UI日方时间: "2026-09-15", [deadline]: "2026-09-14" }, "实现中", "date_after_deadline");
  expect("UI日方时间", { UI进度: "日方制作中", UI日方时间: "2026-09-14", [deadline]: "2026-09-14" }, "实现中");
}
assert.strictEqual(inspect("UI日方时间", { UI需求: "-", UI进度: "日方制作中" }).length, 0);

const acceptance = [...config.statusGroups["验收中监控"], ...config.statusGroups["验收完-更新前监控"]];
for (const progress of ["替换图已全返", "替换图部分拆完", "替换图拆分中", " 替换图部分拆完 "]) {
  for (const status of acceptance) {
    expect("UI剩余时间", { UI进度: progress, UI剩余时间: 1, 美术截止日期: "2026-09-14" }, status);
    expect("UI剩余时间", { UI进度: progress }, status, "empty_value");
    expect("UI剩余时间", { UI进度: progress, UI剩余时间: 2, 美术截止日期: "2026-09-14" }, status, "date_after_deadline");
    expect("UI剩余时间", { UI进度: progress, UI剩余时间: "abc", 美术截止日期: "2026-09-14" }, status, "invalid_workday_amount");
  }
}
for (const progress of ["替换图部分返回", "替换图部分拆完待确认", "替换图已拆完", "", "已提交"]) {
  expect("UI剩余时间", { UI进度: progress, UI剩余时间: 1 }, "内网验收中", "number_above_maximum");
}
for (const [field, deadline] of [["需求设计剩余", "需求截止日期"], ["配置/数值剩余", "配置截止日期"]]) {
  for (const status of config.statusGroups["验收中监控"]) {
    expect(field, { [field]: 1, [deadline]: "2026-09-14" }, status);
    expect(field, {}, status, "empty_value");
    expect(field, { [field]: 2, [deadline]: "2026-09-14" }, status, "date_after_deadline");
  }
  for (const status of config.statusGroups["验收完-更新前监控"]) {
    expect(field, { [field]: 1 }, status, "number_above_maximum");
    expect(field, { [field]: 0 }, status);
  }
  assert.strictEqual(inspect(field, { [field]: 1 }, "已上线").length, 0);
}
for (const field of ["特效制作剩余", "动作制作剩余"]) {
  expect(field, { [field]: 1, 动效制作交付日期: "2026-09-11", 动效资源截止日期: "2026-09-14" }, "实现中");
  expect(field, { [field]: 1, 动效制作交付日期: "2026-09-16", 动效资源截止日期: "2026-09-11" }, "实现中", "date_after_deadline");
  expect(field, { [field]: 1, 动效资源截止日期: "2026-09-16", 美术截止日期: "2026-09-11" }, "实现中", "date_after_deadline");
  expect(field, { [field]: 1 }, "内网验收中", "number_above_maximum");
  const missingDependency = inspect(field, { [field]: 1, 动效制作交付日期: "2026-09-11" });
  assert(missingDependency.every((item) => !item.missing && item.validationSkipped.some((s) => s.code === "deadline_dependency_unavailable")));
}
console.log("V0010 nine changed fields, exact conditions, stage boundaries, workdays and responsibility checks passed");
