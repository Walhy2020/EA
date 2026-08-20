const assert = require("assert");
const config = require("../config/dev-progress.config.json");
const { getDevProgressSettings } = require("../src/config/settingsStore");
const { inspectRequiredFields } = require("../src/modules/devProgress/anomalyScanner");

const rules = config.rules;
const gatedFields = new Set(["群聊", "需求链接"]);

assert.strictEqual(config.rules.requiredFields.fallbackOwner, "王谦");
assert.strictEqual(getDevProgressSettings().rules.requiredFields.fallbackOwner, "王谦");

function decisions(demandType, status, groupChat, demandLink) {
  const result = inspectRequiredFields({
    standard: { demandType, status },
    fields: { 群聊: groupChat, 需求链接: demandLink }
  }, rules);
  return result.filter((item) => gatedFields.has(item.fieldName));
}

function missingFieldNames(demandType, status, groupChat, demandLink) {
  return [...new Set(decisions(demandType, status, groupChat, demandLink)
    .filter((item) => item.missing)
    .map((item) => item.fieldName))].sort();
}

for (const status of ["待分配", "规划中"]) {
  assert.deepStrictEqual(missingFieldNames("新功能", status, "", ""), []);
  assert.deepStrictEqual(missingFieldNames("新功能", status, "-", "-"), []);
  assert.deepStrictEqual(missingFieldNames("新功能", status, "需求群", "https://example.test"), []);
}

for (const status of ["设计中", "实现中"]) {
  assert.deepStrictEqual(missingFieldNames("新功能", status, "", ""), ["群聊", "需求链接"]);
  assert.deepStrictEqual(missingFieldNames("新功能", status, "-", "-"), []);
  assert.deepStrictEqual(missingFieldNames("新功能", status, "需求群", "https://example.test"), []);
}

assert.deepStrictEqual(missingFieldNames("配置", "规划中", "", ""), []);
assert.deepStrictEqual(missingFieldNames("配置", "设计中", "", ""), ["需求链接"]);
assert.deepStrictEqual(missingFieldNames("bug", "设计中", "", ""), []);
assert.deepStrictEqual(missingFieldNames("配置bug", "设计中", "", ""), []);

console.log("Dev progress required-field activation checks passed.");
