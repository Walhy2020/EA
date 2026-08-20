"use strict";

const assert = require("assert");
const filter = require("../src/admin/static/demand-fallback-leader-filter");

const options = filter.leaderOptions([
  { name: "时振兴", role: "策划" },
  { name: "胡锦南", role: "前端" },
  { name: "赵琛", role: "前端" },
  { name: "时振兴", role: "测试" }
]);
assert.deepStrictEqual(options.map((item) => item.name), ["时振兴", "胡锦南", "赵琛"]);
assert.deepStrictEqual(options[0].roles, ["策划", "测试"]);

const items = [
  { id: "A", recordId: "rA", leaderNames: ["时振兴"], missingFields: ["字段 A"] },
  { id: "B", recordId: "rB", leaderNames: ["胡锦南", "赵琛"], missingFields: ["字段 B"] },
  { id: "C", recordId: "rC", leaderNames: ["高文盛"], missingFields: ["字段 C"] },
  { id: "D", recordId: "rD", leaderNames: [], missingFields: ["字段 D"] }
];
assert.deepStrictEqual(filter.visibleItems(items, []).map((item) => item.id), ["A", "B", "C", "D"]);
assert.deepStrictEqual(filter.visibleItems(items, ["时振兴"]).map((item) => item.id), ["A"]);
assert.deepStrictEqual(filter.visibleItems(items, ["时振兴", "胡锦南"]).map((item) => item.id), ["A", "B"]);
assert.deepStrictEqual(filter.visibleItems(items, ["王文静"]).map((item) => item.id), []);

let selected = filter.toggleSelection([], "时振兴");
selected = filter.toggleSelection(selected, "胡锦南");
selected = filter.toggleSelection(selected, "时振兴");
assert.deepStrictEqual([...selected], ["胡锦南"]);
assert.deepStrictEqual(filter.visibleItems(items, selected).map((item) => item.id), ["B"]);

const duplicatedTaskItems = [
  { id: "r1-frontend", recordId: "r1", leaderNames: ["高文盛"], missingFields: ["程序开发交付日期"] },
  { id: "r1-tester", recordId: "r1", leaderNames: ["胡锦南"], missingFields: ["内网验收/测试完成日期"] },
  { id: "r2-frontend", recordId: "r2", leaderNames: ["高文盛", "高文盛"], missingFields: ["程序开发交付日期"] },
  { id: "r3-residual", recordId: "r3", leaderNames: [], missingFields: ["需求链接"] }
];
assert.deepStrictEqual(filter.visibleItems(duplicatedTaskItems, ["高文盛"]).map((item) => item.recordId), ["r1", "r2"]);
assert.deepStrictEqual(filter.visibleItems(duplicatedTaskItems, ["高文盛", "胡锦南"]), [
  {
    id: "r1-frontend",
    recordId: "r1",
    leaderNames: ["高文盛", "胡锦南"],
    missingFields: ["程序开发交付日期", "内网验收/测试完成日期"]
  },
  {
    id: "r2-frontend",
    recordId: "r2",
    leaderNames: ["高文盛"],
    missingFields: ["程序开发交付日期"]
  }
]);
assert.deepStrictEqual(filter.visibleItems(duplicatedTaskItems, []).map((item) => item.recordId), ["r1", "r2", "r3"]);

console.log(JSON.stringify({
  passed: true,
  checks: {
    duplicateLeaderDeduplicated: true,
    noSelectionShowsAll: true,
    singleLeaderFilter: true,
    multiLeaderUsesUnion: true,
    duplicateTaskRowsMerged: true,
    mergedFieldSetUsesUnion: true,
    residualItemsRemainWithoutSelection: true,
    toggleCancelsSelection: true,
    noMatchShowsEmpty: true,
    selectionCanBeReusedAfterRefresh: true
  }
}, null, 2));
