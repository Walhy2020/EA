"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { __test } = require("../src/modules/devProgress/devProgressModule");

const workflow = { roles: {
  策划人员: { leaderField: "策划组长", leaderNames: ["组长甲", "组长空"],
    leaderMemberNames: { 组长甲: ["A", "B", "Zero", "组长甲"], 组长空: [] },
    memberNames: ["A", "B", "Zero", "无关员工"] }
} };
const settings = { rules: { requiredFields: { fallbackOwners: ["B"] } } };
function row(id, ownerName, direct, leader = [], project = "P1") {
  return { id: `${id}-${ownerName}`, recordId: id, demandId: id, project, ownerName,
    missingFields: [...direct, ...leader], directMissingFields: direct, leaderMissingFields: leader,
    fieldProblems: [...direct, ...leader].map((fieldName) => ({ fieldName, code: "missing" })) };
}
const cache = { requiredItems: [
  row("shared", "A", ["FieldA"], ["LeaderOnly"]), row("shared", "B", ["FieldB"]),
  row("own", "组长甲", ["Own"], ["LeaderOnly"]), row("other-project", "A", ["Other"], [], "P2"),
  row("foreign", "无关员工", ["Foreign"]),
  { ...row("fallback", "B", []), missingFields: ["Fallback"], isFallbackOwner: true },
  row("subordinate", "A", [], ["SubordinateField"])
] };
const before = JSON.stringify(cache);
const view = __test.requiredFieldMemberViews(cache, settings, "组长甲", null, workflow);
assert(view.isLeader);
assert.deepStrictEqual(view.views.map((entry) => entry.name), ["A", "B", "Zero"]);
assert.strictEqual(view.views[2].total, 0);
for (const entry of view.views) {
  const direct = __test.directRequiredFieldItems(cache, settings, entry.name);
  assert.deepStrictEqual(entry.items.map((item) => item.recordId).sort(), direct.map((item) => item.recordId).sort());
  assert(entry.items.every((item) => item.leaderMissingFields.length === 0 && !item.isFallbackOwner));
}
assert.deepStrictEqual(view.views[0].items.find((item) => item.recordId === "shared").missingFields, ["FieldA"]);
assert.deepStrictEqual(view.views[1].items[0].missingFields, ["FieldB"]);
assert.deepStrictEqual(view.views[0].items.find((item) => item.recordId === "shared").fieldProblems,
  [{ fieldName: "FieldA", code: "missing", message: "" }]);
assert.strictEqual(__test.requiredFieldMemberViews(cache, settings, "A", null, workflow).isLeader, false);
assert.deepStrictEqual(__test.requiredFieldMemberViews(cache, settings, "组长空", null, workflow).views, []);
const projectView = __test.requiredFieldMemberViews(cache, settings, "组长甲", { projectName: "P1" }, workflow);
assert.deepStrictEqual(projectView.views[0].items.map((item) => item.recordId), ["shared"]);
assert.strictEqual(JSON.stringify(cache), before, "view building must not mutate shared cache");

const source = fs.readFileSync(path.join(__dirname, "../src/admin/static/demand-h5.js"), "utf8");
const tabs = { hidden: true, children: [], replaceChildren() { this.children = []; },
  appendChild(child) { this.children.push(child); } };
const context = vm.createContext({
  document: { getElementById: () => tabs, createElement: () => ({ dataset: {},
    attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } }) },
  requiredFieldItems: [{ id: "all" }],
  filterItemsForSelectedProject: (items) => items.filter((item) => item.project !== "P2"),
  normalizeRequiredFieldItem: (item) => item
});
vm.runInContext(source.slice(source.indexOf("const requiredMemberTabs ="),
  source.indexOf("const fallbackRequiredFieldItems =")), context);
context.data = { isLeader: true, selfItems: [{ id: "own" }], memberViews: [
  { name: "A", items: [{ id: "a" }, { id: "p2", project: "P2" }] }, { name: "Zero", items: [] }
] };
vm.runInContext("replaceRequiredMemberViews(data); renderRequiredMemberTabs()", context);
assert(!tabs.hidden);
assert.deepStrictEqual(tabs.children.map((button) => button.textContent), ["全部 1", "本人 1", "A 1", "Zero 0"]);
assert.strictEqual(tabs.children.filter((button) => button.tabIndex === 0).length, 1);
for (const [key, ids] of [["self", ["own"]], ["member:A", ["a"]], ["member:Zero", []]]) {
  context.key = key;
  const actual = vm.runInContext("selectedRequiredMember = key; visibleRequiredFieldItems().map(item => item.id)", context);
  assert.deepStrictEqual(Array.from(actual), ids);
}
context.data = { isLeader: false, selfItems: [], memberViews: [] };
vm.runInContext("replaceRequiredMemberViews(data); renderRequiredMemberTabs()", context);
assert(tabs.hidden);
assert.strictEqual(vm.runInContext("selectedRequiredMember", context), "all");
context.data = { isLeader: true, memberViews: [] };
vm.runInContext("selectedRequiredMember = 'member:Removed'; replaceRequiredMemberViews(data)", context);
assert.strictEqual(vm.runInContext("selectedRequiredMember", context), "all");
assert(source.includes("visibleRequiredFieldItems().find((item) => item.id === requiredTarget.dataset.requiredItemId)"));
const api = fs.readFileSync(path.join(__dirname, "../src/admin/adminServer.js"), "utf8");
const route = api.slice(api.indexOf('url.pathname === "/api/dev-progress/required-field-items"'));
assert(route.slice(0, 3500).includes("requireDemandH5Identity"), "route must still require signed identity");
console.log("Required member tabs: direct field isolation, empty members, project filter, UI selection and signed route passed");
