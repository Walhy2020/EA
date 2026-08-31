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
  "监修时间"
]) {
  assert.ok(!monitoredFields.has(oldField), `legacy field must be removed: ${oldField}`);
}

assert.ok(monitoredFields.has("UI完成时间"));
assert.ok(monitoredFields.has("前端耗时"));
assert.ok(monitoredFields.has("动效制作交付日期"));

console.log("Dev progress legacy required-field filters are disabled");
