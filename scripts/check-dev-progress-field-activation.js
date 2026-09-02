const assert = require("assert");
const fieldRuleConfig = require("../config/dev-progress-field-rules.json");
const { inspectRequiredFields } = require("../src/modules/devProgress/anomalyScanner");

const rules = {
  requiredFields: {
    ...fieldRuleConfig,
    enabled: true,
    mode: "fieldRulesV2"
  }
};
const gatedFields = new Set(["需求名称", "群聊"]);

assert.strictEqual(rules.requiredFields.mode, "fieldRulesV2");
assert.strictEqual(rules.requiredFields.fallbackOwner, "王谦");
assert.deepStrictEqual(rules.requiredFields.fallbackOwners, ["王谦", "李晶晶"]);

function decisions(demandType, status, groupChat) {
  const result = inspectRequiredFields({
    standard: { demandType, status },
    fields: { 群聊: groupChat }
  }, rules);
  return result.filter((item) => gatedFields.has(item.fieldName));
}

function missingFieldNames(demandType, status, groupChat) {
  return [...new Set(decisions(demandType, status, groupChat)
    .filter((item) => item.missing)
    .map((item) => item.fieldName))].sort();
}

function fieldIsMissing(fieldName, demandType, status, fields = {}) {
  return inspectRequiredFields({
    standard: { demandType, status },
    fields
  }, rules).some((item) => item.fieldName === fieldName && item.missing);
}

assert.deepStrictEqual(missingFieldNames("新功能", "待分配", ""), []);
assert.deepStrictEqual(missingFieldNames("新功能", "规划中", ""), ["需求名称"]);
assert.deepStrictEqual(missingFieldNames("新功能", "实现中", ""), ["群聊", "需求名称"]);
assert.deepStrictEqual(missingFieldNames("新功能", "实现中", "需求群"), ["需求名称"]);
assert.deepStrictEqual(missingFieldNames("新功能", "内网验收中", ""), ["需求名称"]);
assert.deepStrictEqual(missingFieldNames("新功能", "测试阻塞", ""), []);
assert.deepStrictEqual(missingFieldNames("任务拆分", "实现中", ""), []);

assert.deepStrictEqual(missingFieldNames("配置", "实现中", ""), ["需求名称"]);
assert.deepStrictEqual(missingFieldNames("bug", "实现中", ""), ["需求名称"]);
assert.deepStrictEqual(missingFieldNames("配置bug", "实现中", ""), ["需求名称"]);

assert.strictEqual(fieldIsMissing("规模类型", "新功能", "规划中"), true);
assert.strictEqual(fieldIsMissing("规模类型", "新功能", "实现中"), true);
assert.strictEqual(fieldIsMissing("规模类型", "新功能", "内网验收中"), true);
assert.strictEqual(fieldIsMissing("规模类型", "新功能", "已上线"), true);
assert.strictEqual(fieldIsMissing("测试人员", "新功能", "内网验收中"), true);
assert.strictEqual(fieldIsMissing("测试人员", "新功能", "已上线"), false);
assert.strictEqual(fieldIsMissing("监修时间", "新功能", "实现中", {
  UI需求: "-",
  动效需求: "需要动效"
}), true);
assert.strictEqual(fieldIsMissing("监修时间", "新功能", "实现中", {
  UI需求: "-",
  动效需求: "-"
}), false);

console.log("Dev progress field-rule activation checks passed.");
