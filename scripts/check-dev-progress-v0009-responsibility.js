"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { getDevProgressSettings } = require("../src/config/settingsStore");
const { inspectRequiredFields, scanDevProgressAnomalies } = require("../src/modules/devProgress/anomalyScanner");
const { createDevProgressModule, __test } = require("../src/modules/devProgress/devProgressModule");
const filter = require("../src/admin/static/demand-fallback-leader-filter");
const settings = getDevProgressSettings();
const required = settings.rules.requiredFields;
const groups = required.leaders["策划组长"].memberGroups;

function record(id, planner) {
  return {
    recordId: id,
    fields: { 策划人员: planner },
    standard: {
      demandId: id, demand: id, project: "测试项目", demandType: "新功能",
      status: "规划中", owners: { planner }
    }
  };
}
function owners(planner, kind) {
  return [...new Set(inspectRequiredFields(record("test", planner), settings.rules)
    .filter((entry) => entry.fieldName === "需求内容" && entry.responsibilityKind === kind)
    .flatMap((entry) => entry.ownerNames))].sort();
}
for (const [leader, members] of Object.entries(groups)) {
  for (const member of members) assert.deepStrictEqual(owners(member, "leader"), [leader]);
}
assert.deepStrictEqual(owners("李东", "leader"), ["时振兴"]);
assert.deepStrictEqual(owners(" 刘飞 、 李猛 ", "leader"), ["时振兴", "李东"].sort());
for (const member of ["", "-", "未分组策划", "刘飞2", "时振兴"]) {
  assert.deepStrictEqual(owners(member, "leader"), []);
  assert.deepStrictEqual(owners(member, "fallback"), required.fallbackOwners.slice().sort());
}
assert.deepStrictEqual(owners("刘晓明", "member"), ["刘晓明"]);
assert.deepStrictEqual(owners("刘晓明", "fallback"), required.fallbackOwners.slice().sort());

const workflow = { roles: {
  策划人员: { leaderField: "策划组长", leaderNames: ["旧组长"], memberNames: ["旧组员"] }
} };
const before = JSON.stringify(workflow);
const resolved = __test.monitorWorkflowRules(settings, workflow);
assert.strictEqual(JSON.stringify(workflow), before, "M02 must not mutate shared workflow configuration");
assert.deepStrictEqual(resolved.roles["策划人员"].leaderMemberNames, groups);
for (const name of Object.keys(groups)) {
  const scopes = __test.leaderMemberScopesForPerson(name, {}, settings, workflow);
  assert.deepStrictEqual(scopes.find((scope) => scope.assigneeField === "策划人员").memberNames, groups[name]);
}
assert(__test.canReadRequiredFieldFallbackScope(settings, "刘晓明"));
assert(!__test.canReadRequiredFieldFallbackScope(settings, "李东"));
assert(fs.readFileSync(path.join(__dirname, "../src/admin/static/demand-h5.js"), "utf8")
  .includes('new Set(["王谦", "李晶晶", "刘晓明"])'));

async function main() {
  const records = [
    record("li-group", "刘飞"), record("shi-group", "李猛"),
    record("li-own", "李东"), record("mixed", "刘飞、李猛"),
    record("unknown", "未分组策划"), record("empty", ""), record("fallback-own", "刘晓明")
  ];
  const testSettings = {
    ...settings,
    rules: {
      ...settings.rules,
      requiredFields: { ...required, fieldRules: required.fieldRules.filter((rule) => rule.field === "需求内容") }
    }
  };
  const scanResult = scanDevProgressAnomalies(records, testSettings.rules);
  let persisted;
  const logs = [];
  const module = createDevProgressModule({
    logger: { info(message, meta) { logs.push({ message, meta }); }, warn() {} },
    getSettings: () => testSettings,
    getWorkflowRulesSettings: () => ({ normalizedRules: workflow }),
    runAnomalyScan: async () => ({
      settings: testSettings, rules: testSettings.rules, scanResult,
      readResult: { ok: true, records, recordCount: records.length, fieldsUsed: [] }
    }),
    readDocumentInfo: async () => ({ ok: true, signal: "v0009-test", modifyTime: "1" }),
    readH5MonitorCacheFile: () => persisted || null,
    writeH5MonitorCacheFile: (value) => { persisted = JSON.parse(JSON.stringify(value)); }
  });
  const li = await module.listRequiredFieldItems({ userName: "李东", forceRefresh: true, waitForRefresh: true });
  assert(li.ok);
  assert.deepStrictEqual(li.items.map((item) => item.demandId).sort(), ["li-group", "li-own", "mixed"].sort());
  assert(li.isLeader);
  assert.deepStrictEqual(li.memberViews.map((view) => view.name), groups["李东"]);
  assert.deepStrictEqual(li.selfItems.map((item) => item.demandId), ["li-own"]);
  for (const view of li.memberViews) {
    const personal = await module.listRequiredFieldItems({ userName: view.name });
    assert(!personal.isLeader);
    assert.deepStrictEqual(view.items, personal.items, "member tab must equal the member's own page");
  }
  const shi = await module.listRequiredFieldItems({ userName: "时振兴" });
  assert.deepStrictEqual(shi.items.map((item) => item.demandId).sort(), ["shi-group", "li-own", "mixed"].sort());
  assert.deepStrictEqual(shi.memberViews.find((view) => view.name === "李东").items, li.selfItems,
    "a nested leader's tab includes personal duties, not their entire team");
  const liLeader = __test.requiredFieldLeaderViewItems(persisted, testSettings, "李东");
  assert.deepStrictEqual(liLeader.map((item) => item.demandId).sort(), ["li-group", "mixed"]);
  const liu = await module.listRequiredFieldItems({ userName: "刘晓明" });
  assert.deepStrictEqual(liu.items.map((item) => item.demandId), ["fallback-own"]);
  assert(!liu.isLeader);
  assert.deepStrictEqual(liu.memberViews, []);
  // Filter options must not depend on a cache created before UI/animation were included.
  workflow.roles.UI人员 = { leaderField: "UI组长", leaderNames: ["王谦"] };
  workflow.roles.动效人员 = { leaderField: "动效组长", leaderNames: ["刘晓明"] };
  assert(!persisted.fallbackLeaderFilters.some((item) => item.name === "刘晓明"));
  for (const name of required.fallbackOwners) {
    const fallback = await module.listRequiredFieldItems({ userName: name, scope: "fallback" });
    assert.strictEqual(new Set(fallback.items.map((item) => item.demandId)).size, records.length);
    assert.deepStrictEqual(filter.visibleItems(fallback.items, ["李东"]).map((item) => item.demandId).sort(),
      liLeader.map((item) => item.demandId).sort());
    assert(fallback.leaderFilters.some((item) => item.name === "李东"));
    assert(fallback.leaderFilters.some((item) => item.name === "刘晓明" && item.role === "动效"));
    assert(fallback.leaderFilters.some((item) => item.name === "王谦" && item.role === "UI"));
    assert(!fallback.leaderFilters.some((item) => item.name === "旧组长"));
  }
  const memberTasks = await module.listMemberTaskItems({ userName: "李东" });
  assert(memberTasks.ok);
  assert(memberTasks.leaderRoles.some((scope) => scope.memberNames.includes("刘飞")));
  assert(logs.some((entry) => entry.message === "Dev progress required-field access evaluated"
    && entry.meta.ruleSourceVersion === "V0010"));
  assert.strictEqual(new Set(persisted.requiredItems.map((item) => item.ownerName + "|" + item.recordId)).size,
    persisted.requiredItems.length, "one task per recipient after responsibility merge");
  console.log("V0010 member/leader/fallback routing, personal views, member scopes and cache checks passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
