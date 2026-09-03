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
const fixedRuleLeaderNames = filter.uniqueNames(Object.values(settings.rules?.requiredFields?.leaders || {})
  .flatMap((leader) => Array.isArray(leader && leader.names) ? leader.names : []));
const requestedLeaderNames = filter.uniqueNames([...configuredLeaderNames, ...fixedRuleLeaderNames]);
const expectedLeaderNames = ["时振兴", "胡锦南", "赵琛", "王文静", "高文盛", "王谦", "刘晓明"];

for (const leaderName of expectedLeaderNames) {
  assert(requestedLeaderNames.includes(leaderName), `当前规则或缓存未配置组长：${leaderName}`);
}

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
  const rawFieldItems = __test.requiredFieldLeaderViewItems(cache, settings, leaderName, null);
  const fieldItems = canonical(rawFieldItems);
  const directItems = (cache.requiredItems || []).filter((item) => (
    String(item.ownerName || "").trim() === leaderName
    && !item.isFallbackOwner
    && !item.fallbackOwner
    && item.ownerType !== "fallback"
  ));
  const personalItems = __test.mergeRequiredFieldViewItems([...directItems, ...rawFieldItems]);
  const fallbackItems = canonical(filter.visibleItems(allFallbackLeaderItems, [leaderName]));
  const difference = differences(fieldItems, fallbackItems);
  const uniqueRecordCount = new Set(rawFieldItems.map((item) => item.recordId).filter(Boolean)).size;
  const personalUniqueRecordCount = new Set(personalItems.map((item) => item.recordId).filter(Boolean)).size;
  parityResults.push({
    leaderName,
    personalCount: personalItems.length,
    personalUniqueRecordCount,
    fieldCount: fieldItems.length,
    uniqueRecordCount,
    fallbackFilteredCount: fallbackItems.length,
    onlyFieldDemandIds: difference.onlyLeft,
    onlyFallbackDemandIds: difference.onlyRight,
    differentMissingFieldDemandIds: difference.fieldDifference
  });
  assert(personalItems.length > 0, `${leaderName} 当前真实个人字段页不应为空`);
  assert.strictEqual(personalUniqueRecordCount, personalItems.length, `${leaderName} 当前真实个人字段页存在重复 recordId`);
  assert(fieldItems.length > 0, `${leaderName} 当前真实字段页不应为空`);
  assert.strictEqual(uniqueRecordCount, rawFieldItems.length, `${leaderName} 当前真实字段页存在重复 recordId`);
  assert.deepStrictEqual(difference, { onlyLeft: [], onlyRight: [], fieldDifference: [] }, `${leaderName} 兜底筛选与本人字段页不一致`);
}

const uiFieldSet = new Set(settings.rules.requiredFields.fieldRules
  .filter((rule) => rule.leaderRole === "UI组长")
  .map((rule) => rule.field));
const wangQianItems = __test.requiredFieldLeaderViewItems(cache, settings, "王谦", null);
assert(wangQianItems.length > 0, "王谦 UI 组长字段页不应为空");
assert(
  wangQianItems.every((item) => (item.missingFields || []).every((fieldName) => uiFieldSet.has(fieldName))),
  "王谦个人字段页只能包含 UI 组长负责字段，不能混入总兜底字段"
);

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
  wangQianUiScope: {
    fieldCount: wangQianItems.length,
    allowedFields: [...uiFieldSet]
  },
  projectParity
}, null, 2));
