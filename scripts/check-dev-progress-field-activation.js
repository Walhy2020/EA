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

assert.deepStrictEqual(missingFieldNames("新功能", "待分配", ""), []);
assert.deepStrictEqual(missingFieldNames("新功能", "规划中", ""), ["需求名称"]);
assert.deepStrictEqual(missingFieldNames("新功能", "实现中", ""), ["群聊", "需求名称"]);
assert.deepStrictEqual(missingFieldNames("新功能", "实现中", "需求群"), ["需求名称"]);
assert.deepStrictEqual(missingFieldNames("新功能", "测试阻塞", ""), []);
assert.deepStrictEqual(missingFieldNames("任务拆分", "实现中", ""), []);

assert.deepStrictEqual(missingFieldNames("配置", "实现中", ""), ["需求名称"]);
assert.deepStrictEqual(missingFieldNames("bug", "实现中", ""), ["需求名称"]);
assert.deepStrictEqual(missingFieldNames("配置bug", "实现中", ""), ["需求名称"]);

console.log("Dev progress field-rule activation checks passed.");
