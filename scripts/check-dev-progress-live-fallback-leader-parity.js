"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { getDevProgressSettings } = require("../src/config/settingsStore");
const { __test } = require("../src/modules/devProgress/devProgressModule");
const filter = require("../src/admin/static/demand-fallback-leader-filter");

const cachePath = path.resolve(__dirname, "..", "data", "dev-progress", "h5-monitor-cache.json");
const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
const settings = getDevProgressSettings();
const configuredLeaderNames = filter.uniqueNames((cache.fallbackLeaderFilters || []).map((item) => item.name));
const requestedLeaderNames = filter.uniqueNames([
  "高文盛",
  configuredLeaderNames.find((name) => name !== "高文盛")
]);

assert(requestedLeaderNames.includes("高文盛"), "当前缓存未配置高文盛组长筛选项");
assert(requestedLeaderNames.length >= 2, "当前缓存没有可用于通用性验证的第二名组长");

function canonical(items) {
  return filter.mergeVisibleItems(items)
    .map((item) => ({
      taskKey: filter.taskKey(item, 0),
      demandId: String(item.demandId || ""),
      missingFields: filter.uniqueNames(item.missingFields).slice().sort()
    }))
    .sort((left, right) => left.taskKey.localeCompare(right.taskKey, "zh-Hans-CN", { numeric: true }));
}

function differences(left, right) {
  const leftMap = new Map(left.map((item) => [item.taskKey, item]));
  const rightMap = new Map(right.map((item) => [item.taskKey, item]));
  const onlyLeft = left.filter((item) => !rightMap.has(item.taskKey)).map((item) => item.demandId || item.taskKey);
  const onlyRight = right.filter((item) => !leftMap.has(item.taskKey)).map((item) => item.demandId || item.taskKey);
  const fieldDifference = left
    .filter((item) => rightMap.has(item.taskKey))
    .filter((item) => JSON.stringify(item.missingFields) !== JSON.stringify(rightMap.get(item.taskKey).missingFields))
    .map((item) => item.demandId || item.taskKey);
  return { onlyLeft, onlyRight, fieldDifference };
}

const allFallbackLeaderItems = __test.fallbackLeaderViewItems(cache, settings, null);
const parityResults = [];
for (const leaderName of requestedLeaderNames) {
  const fieldItems = canonical(__test.requiredFieldLeaderViewItems(cache, settings, leaderName, null));
  const fallbackItems = canonical(filter.visibleItems(allFallbackLeaderItems, [leaderName]));
  const difference = differences(fieldItems, fallbackItems);
  parityResults.push({
    leaderName,
    fieldCount: fieldItems.length,
    fallbackFilteredCount: fallbackItems.length,
    onlyFieldDemandIds: difference.onlyLeft,
    onlyFallbackDemandIds: difference.onlyRight,
    differentMissingFieldDemandIds: difference.fieldDifference
  });
  assert.deepStrictEqual(difference, { onlyLeft: [], onlyRight: [], fieldDifference: [] }, `${leaderName} 兜底筛选与本人字段页不一致`);
}

const multiPersonalItems = canonical(requestedLeaderNames.flatMap((leaderName) => (
  __test.requiredFieldLeaderViewItems(cache, settings, leaderName, null)
    .map((item) => ({ ...item, leaderNames: [leaderName] }))
)));
const multiFallbackItems = canonical(filter.visibleItems(allFallbackLeaderItems, requestedLeaderNames));
assert.deepStrictEqual(multiFallbackItems, multiPersonalItems, "多选组长必须等于各组长本人字段页的去重并集");

const projectName = String((__test.requiredFieldLeaderViewItems(cache, settings, "高文盛", null)[0] || {}).project || "").trim();
let projectParity = { skipped: true };
if (projectName) {
  const projectFilter = { projectName };
  const fieldItems = canonical(__test.requiredFieldLeaderViewItems(cache, settings, "高文盛", projectFilter));
  const fallbackItems = canonical(filter.visibleItems(
    __test.fallbackLeaderViewItems(cache, settings, projectFilter),
    ["高文盛"]
  ));
  const difference = differences(fieldItems, fallbackItems);
  assert.deepStrictEqual(difference, { onlyLeft: [], onlyRight: [], fieldDifference: [] }, "项目筛选后的高文盛口径不一致");
  projectParity = { projectName, fieldCount: fieldItems.length, fallbackFilteredCount: fallbackItems.length };
}

console.log(JSON.stringify({
  passed: true,
  cache: {
    version: cache.version,
    refreshedAt: cache.refreshedAt || "",
    requiredItemCount: Array.isArray(cache.requiredItems) ? cache.requiredItems.length : 0
  },
  parity: parityResults,
  multiLeader: {
    selectedNames: requestedLeaderNames,
    taskCount: multiFallbackItems.length
  },
  projectParity
}, null, 2));
