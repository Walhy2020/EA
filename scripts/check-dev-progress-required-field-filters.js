"use strict";

const assert = require("assert");
const { getDevProgressSettings } = require("../src/config/settingsStore");

const requiredFields = getDevProgressSettings().rules.requiredFields;

assert.strictEqual(requiredFields.mode, "fieldRulesV2");
assert.strictEqual(requiredFields.ruleFile, "config/dev-progress-field-rules.json");
assert.deepStrictEqual(requiredFields.fieldFilters, []);
assert.deepStrictEqual(requiredFields.items, []);
assert.strictEqual(requiredFields.fallbackOwner, "王谦");
assert.deepStrictEqual(requiredFields.fallbackOwners, ["王谦", "李晶晶"]);
assert.ok(requiredFields.fieldRules.length > 0);

const monitoredFields = new Set(requiredFields.fieldRules.map((item) => item.field));
for (const oldField of [
  "UI制作交付日期",
  "UI监修完成日期",
  "程序开发交付日期",
  "动效监修完成日期",
  "内网验收/测试完成日期",
  "正式验收/测试完成日期",
  "动效制作耗时",
  "动效制作剩余"
]) {
  assert.ok(!monitoredFields.has(oldField), `legacy field must be removed: ${oldField}`);
}

assert.ok(monitoredFields.has("UI完成时间"));
assert.ok(monitoredFields.has("前端耗时"));
assert.ok(monitoredFields.has("动效制作交付日期"));
assert.ok(monitoredFields.has("监修时间"));
assert.ok(monitoredFields.has("特效制作耗时"));
assert.ok(monitoredFields.has("特效制作剩余"));
assert.ok(monitoredFields.has("动作制作耗时"));
assert.ok(monitoredFields.has("动作制作剩余"));
assert.strictEqual(requiredFields.sourceVersion, "V0003");
assert.strictEqual(requiredFields.version, "3.0.0");
assert.deepStrictEqual(requiredFields.statusGroups, {
  "开发中监控": ["待分配", "规划中", "实现中"],
  "验收中监控": ["内网验收中", "验收后bug修改中", "内网测试中", "测试2验收中", "测试2测试中", "测试1验收/测试中", "测试阻塞"],
  "验收完-更新前监控": ["测试服全完成", "上线前整备", "待上线"],
  "更新完成后监控": ["已上线", "需跟进上限后效果", "待复盘", "已更新但未验收"],
  "其他阻塞阶段": ["已拒绝", "暂停中"]
});
assert.strictEqual(requiredFields.fieldRules.filter((rule) => rule.endStatus === "实现中").length, 20);
assert.strictEqual(requiredFields.fieldRules.filter((rule) => rule.endStatus === "测试阻塞").length, 3);
assert.strictEqual(requiredFields.fieldRules.filter((rule) => rule.endStatus === "待上线").length, 9);
assert.strictEqual(requiredFields.fieldRules.filter((rule) => rule.endStatus === "已更新但未验收").length, 7);
assert.ok(requiredFields.fieldRules.every((rule) => rule.monitorGroups.length > 0));

console.log("Dev progress legacy required-field filters are disabled");
