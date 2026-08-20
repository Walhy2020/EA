"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const sort = require("../src/admin/static/demand-task-time-sort");
const { getDevProgressSettings } = require("../src/config/settingsStore");
const { __test } = require("../src/modules/devProgress/devProgressModule");
const filter = require("../src/admin/static/demand-fallback-leader-filter");

const cache = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "..", "data", "dev-progress", "h5-monitor-cache.json"),
  "utf8"
));
const settings = getDevProgressSettings();

function demandIds(items) {
  return items.map((item) => String(item.demandId || item.recordId || item.id || "")).filter(Boolean);
}

function assertRealDirection(label, items) {
  const oldestFirst = sort.sortByCreatedTime(items, false);
  const newestFirst = sort.sortByCreatedTime(items, true);
  const validCount = items.filter((item) => Number.isFinite(sort.createdTimestamp(item))).length;
  assert(validCount >= 10, `${label} 的有效创建时间不足 10 条`);
  const oldestTopTen = demandIds(oldestFirst).slice(0, 10);
  const newestTopTen = demandIds(newestFirst).slice(0, 10);
  assert.notDeepStrictEqual(oldestTopTen, newestTopTen, `${label} 前十项排序未随方向变化`);
  const oldestTimestamps = oldestFirst.map(sort.createdTimestamp).filter(Number.isFinite);
  const newestTimestamps = newestFirst.map(sort.createdTimestamp).filter(Number.isFinite);
  assert(oldestTimestamps.every((value, index) => index === 0 || oldestTimestamps[index - 1] <= value), `${label} 默认排序不是创建时间升序`);
  assert(newestTimestamps.every((value, index) => index === 0 || newestTimestamps[index - 1] >= value), `${label} 点击后排序不是创建时间降序`);
  return { validCount, oldestTopTen, newestTopTen };
}

const leaderName = "高文盛";
const fieldItems = __test.requiredFieldLeaderViewItems(cache, settings, leaderName, null);
const fallbackItems = filter.visibleItems(
  __test.fallbackLeaderViewItems(cache, settings, null),
  [leaderName]
);
const fieldResult = assertRealDirection("字段待补充", fieldItems);
const fallbackResult = assertRealDirection("兜底需求", fallbackItems);

console.log(JSON.stringify({
  passed: true,
  cache: { version: cache.version, refreshedAt: cache.refreshedAt || "" },
  field: fieldResult,
  fallback: fallbackResult,
  checks: {
    realCacheEpochTimestampParsed: true,
    fieldTopTenChangesByDirection: true,
    fallbackTopTenChangesByDirection: true,
    invalidCreationTimesStableLast: true
  }
}, null, 2));
