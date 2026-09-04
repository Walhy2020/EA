"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createDevProgressModule } = require("../src/modules/devProgress/devProgressModule");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settings() {
  return {
    docUrl: "https://doc.weixin.qq.com/sheet/test",
    docid: "test-doc",
    sheetId: "test-sheet",
    viewId: "test-view",
    cacheMinutes: 5,
    personAliases: {},
    fieldMapping: {},
    rules: {
      scanLimit: 4000,
      requiredFields: { fieldRules: [] }
    }
  };
}

function record(recordId, demandId, ownerName) {
  return {
    recordId,
    standard: {
      demandId,
      project: "测试项目",
      demand: `任务 ${demandId}`,
      demandType: "功能",
      status: "开发中",
      owners: { frontend: ownerName },
      dates: {},
      links: {}
    }
  };
}

function scanBundle(records, scanOptions = {}) {
  return {
    settings: settings(),
    rules: settings().rules,
    readResult: {
      ok: true,
      limit: scanOptions.limit || records.length || 1,
      recordCount: records.length,
      userNameResolvedCount: 0,
      fieldsUsed: [],
      pages: [],
      records
    },
    scanResult: {
      ok: true,
      scannedCount: records.length,
      anomalyCount: 0,
      issueCount: 0,
      anomalies: [],
      rules: {
        requiredFieldRuleSourceVersion: "V0004",
        requiredFieldRuleCount: 39,
        requiredFieldAvailableRuleCount: 39,
        requiredFieldUnavailableRuleCount: 0,
        requiredFieldUnavailableFields: []
      },
      perf: { totalMs: 5 }
    }
  };
}

function initialCache() {
  return {
    ok: true,
    version: 20,
    signal: "signal-1",
    modifyTime: "1",
    signalCheckedAt: "2026-09-04T01:00:00.000Z",
    refreshedAt: "2026-09-04T01:00:00.000Z",
    generatedAt: "2026-09-04T01:00:00.000Z",
    requiredItems: [
      { id: "old-r1", recordId: "r1", demandId: "D1", ownerName: "甲", missingFields: ["测试字段"] },
      { id: "old-r2", recordId: "r2", demandId: "D2", ownerName: "甲", missingFields: ["测试字段"] }
    ],
    personTaskItems: [
      { id: "r1", recordId: "r1", demandId: "D1", project: "测试项目", demand: "任务 D1", owners: { frontend: "甲" } },
      { id: "r2", recordId: "r2", demandId: "D2", project: "测试项目", demand: "任务 D2", owners: { frontend: "甲" } }
    ],
    stats: {
      requiredItemCount: 2,
      personTaskItemCount: 2,
      rawRecordCount: 2,
      activeRecordCount: 2,
      excludedOnlineCount: 0
    }
  };
}

async function checkConcurrentPages() {
  let activeReads = 0;
  let maxActiveReads = 0;
  const attempts = new Map();
  const module = createDevProgressModule({
    logger: { info() {}, warn() {} },
    getSettings: settings,
    getWorkflowRulesSettings: () => ({ normalizedRules: {} }),
    readFieldDefinitions: async () => ({ ok: true, status: "ok", fields: [], fieldTitles: [] }),
    readRecords: async (_settings, options) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      const attempt = Number(attempts.get(options.offset) || 0) + 1;
      attempts.set(options.offset, attempt);
      await delay(15);
      activeReads -= 1;
      if (options.offset === 500 && attempt === 1) {
        return { ok: false, errcode: 45009, errmsg: "api frequency out of limit" };
      }
      const count = Math.max(0, Math.min(options.limit, 1600 - options.offset));
      return {
        ok: true,
        total: 1600,
        hasMore: options.offset + count < 1600,
        limit: options.limit,
        recordCount: count,
        userNameResolvedCount: 0,
        fieldsUsed: [],
        perf: { totalMs: 15 },
        records: Array.from({ length: count }, (_, index) => record(
          `r-${options.offset + index}`,
          `D-${options.offset + index}`,
          "甲"
        ))
      };
    }
  });

  const result = await module.scanAnomalies({ limit: 1600 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.read.recordCount, 1600);
  assert.strictEqual(result.read.pageCount, 4);
  assert.strictEqual(result.read.pageConcurrency, 2);
  assert.strictEqual(result.read.concurrencyFallbackCount, 1);
  assert.strictEqual(maxActiveReads, 2);
  assert.strictEqual(attempts.get(500), 2);
}

async function checkSharedFullScan() {
  let scanCount = 0;
  const module = createDevProgressModule({
    logger: { info() {}, warn() {} },
    getSettings: settings,
    getWorkflowRulesSettings: () => ({ normalizedRules: {} }),
    runAnomalyScan: async (scanOptions) => {
      scanCount += 1;
      await delay(20);
      return scanBundle([record("r1", "D1", "甲")], scanOptions);
    }
  });
  await Promise.all([
    module.prepareRequiredFieldPush({ limit: 4000, h5MonitorSignal: { signal: "signal-1" } }),
    module.prepareRequiredFieldPush({ limit: 4000, h5MonitorSignal: { signal: "signal-1" } })
  ]);
  assert.strictEqual(scanCount, 1);
  await module.prepareRequiredFieldPush({ limit: 4000, h5MonitorSignal: { signal: "signal-1" } });
  assert.strictEqual(scanCount, 1);
}

async function checkRecentTaskRefresh() {
  let nowMs = Date.parse("2026-09-04T02:00:00.000Z");
  let partialScanCount = 0;
  const writes = [];
  const module = createDevProgressModule({
    logger: { info() {}, warn() {} },
    nowMs: () => nowMs,
    getSettings: settings,
    getWorkflowRulesSettings: () => ({ normalizedRules: {} }),
    readDocumentInfo: async () => ({ ok: true, signal: "signal-1", modifyTime: "1" }),
    readH5MonitorCacheFile: initialCache,
    writeH5MonitorCacheFile: (cache) => writes.push(JSON.parse(JSON.stringify(cache))),
    runAnomalyScan: async (scanOptions) => {
      assert.deepStrictEqual(scanOptions.recordIds, ["r1"]);
      partialScanCount += 1;
      return scanBundle([record("r1", "D1", "乙")], scanOptions);
    }
  });

  assert.strictEqual(module.recordRecentTaskInteraction({
    userName: "甲",
    recordId: "r1",
    demandId: "D1",
    project: "测试项目",
    action: "open_task"
  }).ok, true);
  const required = await module.listRequiredFieldItems({ userName: "甲", forceRefresh: true, waitForRefresh: true });
  assert.strictEqual(required.ok, true);
  assert.deepStrictEqual(required.items.map((item) => item.recordId), ["r2"]);
  assert.strictEqual(required.cache.partialRefreshedCount, 1);
  assert.strictEqual(required.cache.signalUnchanged, true);
  assert.strictEqual(required.cache.backgroundSyncStarted, false);
  assert.strictEqual(partialScanCount, 1);
  const lastWrite = writes[writes.length - 1];
  assert.strictEqual(lastWrite.signal, "signal-1");
  assert.strictEqual(lastWrite.refreshedAt, "2026-09-04T01:00:00.000Z");
  assert(lastWrite.partialRefreshedAt);

  const oldOwner = await module.listPersonTaskItems({ userName: "甲" });
  const newOwner = await module.listPersonTaskItems({ userName: "乙" });
  assert.deepStrictEqual(oldOwner.items.map((item) => item.recordId), ["r2"]);
  assert.deepStrictEqual(newOwner.items.map((item) => item.recordId), ["r1"]);

  let retainedCount = 0;
  for (let index = 0; index < 25; index += 1) {
    retainedCount = module.recordRecentTaskInteraction({
      userName: "限制用户",
      recordId: `limit-${index}`,
      demandId: `LIMIT-${index}`
    }).retainedCount;
  }
  assert.strictEqual(retainedCount, 20);
  retainedCount = module.recordRecentTaskInteraction({
    userName: "限制用户",
    recordId: "limit-24",
    demandId: "LIMIT-24"
  }).retainedCount;
  assert.strictEqual(retainedCount, 20);
  nowMs += 31 * 60 * 1000;
  retainedCount = module.recordRecentTaskInteraction({
    userName: "限制用户",
    recordId: "after-expiry",
    demandId: "AFTER-EXPIRY"
  }).retainedCount;
  assert.strictEqual(retainedCount, 1);
}

async function checkBackgroundFullCalibration() {
  const writes = [];
  let fullScanCount = 0;
  const module = createDevProgressModule({
    logger: { info() {}, warn() {} },
    getSettings: settings,
    getWorkflowRulesSettings: () => ({ normalizedRules: {} }),
    readDocumentInfo: async () => ({ ok: true, signal: "signal-2", modifyTime: "2" }),
    readH5MonitorCacheFile: initialCache,
    writeH5MonitorCacheFile: (cache) => writes.push(JSON.parse(JSON.stringify(cache))),
    runAnomalyScan: async (scanOptions) => {
      if (Array.isArray(scanOptions.recordIds) && scanOptions.recordIds.length > 0) {
        return scanBundle([record("r1", "D1", "乙")], scanOptions);
      }
      fullScanCount += 1;
      await delay(10);
      return scanBundle([
        record("r1", "D1", "乙"),
        record("r2", "D2", "甲"),
        record("r3", "D3", "丙")
      ], scanOptions);
    }
  });
  module.recordRecentTaskInteraction({ userName: "甲", recordId: "r1", demandId: "D1" });
  const result = await module.listRequiredFieldItems({ userName: "甲", forceRefresh: true });
  assert.strictEqual(result.cache.backgroundSyncStarted, true);
  assert.strictEqual(result.cache.partialRefreshedCount, 1);
  await delay(40);
  assert.strictEqual(fullScanCount, 1);
  const finalCache = writes.findLast((cache) => cache.signal === "signal-2");
  assert(finalCache);
  assert.strictEqual(finalCache.personTaskItems.length, 3);
  assert.notStrictEqual(finalCache.refreshedAt, "2026-09-04T01:00:00.000Z");
}

async function checkDeletedTaskRemoval() {
  const module = createDevProgressModule({
    logger: { info() {}, warn() {} },
    getSettings: settings,
    getWorkflowRulesSettings: () => ({ normalizedRules: {} }),
    readDocumentInfo: async () => ({ ok: true, signal: "signal-1", modifyTime: "1" }),
    readH5MonitorCacheFile: initialCache,
    writeH5MonitorCacheFile() {},
    runAnomalyScan: async (scanOptions) => scanBundle([], scanOptions)
  });
  module.recordRecentTaskInteraction({ userName: "甲", recordId: "r1", demandId: "D1" });
  await module.listRequiredFieldItems({ userName: "甲", forceRefresh: true });
  const required = await module.listRequiredFieldItems({ userName: "甲" });
  const personal = await module.listPersonTaskItems({ userName: "甲" });
  assert.deepStrictEqual(required.items.map((item) => item.recordId), ["r2"]);
  assert.deepStrictEqual(personal.items.map((item) => item.recordId), ["r2"]);
}

function checkFrontendAndRoute() {
  const root = path.resolve(__dirname, "..");
  const js = fs.readFileSync(path.join(root, "src", "admin", "static", "demand-h5.js"), "utf8").replace(/\r\n/g, "\n");
  const server = fs.readFileSync(path.join(root, "src", "admin", "adminServer.js"), "utf8").replace(/\r\n/g, "\n");
  assert(js.includes("/api/dev-progress/recent-task-interaction"));
  assert(js.includes('recordRecentTaskInteraction(item, "copy_task_id")'));
  assert(js.includes('recordRecentTaskInteraction(item, "open_task")'));
  assert(js.includes("await Promise.all([\n    loadFallbackItemsFromServer(options)"));
  assert(js.includes("当前已是最新数据"));
  assert(js.includes("其他数据正在后台同步"));
  assert(!js.includes("未能读取最新需求总表，当前仍显示上一次成功数据"));
  assert(/recent-task-interaction[\s\S]*?requireDemandH5Identity[\s\S]*?userName: identity\.name/.test(server));
  assert(server.includes("cachePartialRefreshedCount"));
  assert(server.includes("cacheBackgroundSyncStarted"));
}

async function main() {
  await checkConcurrentPages();
  await checkSharedFullScan();
  await checkRecentTaskRefresh();
  await checkBackgroundFullCalibration();
  await checkDeletedTaskRemoval();
  checkFrontendAndRoute();
  console.log(JSON.stringify({
    passed: true,
    checks: {
      pageConcurrencyLimitedToTwo: true,
      failedConcurrentPageFallsBackToSequentialRetry: true,
      simultaneousAndRecentFullScansAreShared: true,
      recentTasksAreDeduplicatedLimitedAndExpired: true,
      partialRefreshPreservesGlobalSignalAndRefreshTime: true,
      ownerChangesRemoveOldOwnerTask: true,
      deletedTasksAreRemovedFromPartialCache: true,
      changedDocumentStartsBackgroundFullCalibration: true,
      taskClickAndCopyAreAuditedBySignedSession: true,
      pageRegionsLoadInParallel: true
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
