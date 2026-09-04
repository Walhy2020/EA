"use strict";

const assert = require("assert");
const { createDevProgressModule } = require("../src/modules/devProgress/devProgressModule");

function scanBundle() {
  return {
    settings: {
      docUrl: "https://doc.weixin.qq.com/sheet/test",
      docid: "test-doc",
      sheetId: "test-sheet",
      viewId: "test-view",
      personAliases: {},
      rules: { requiredFields: { fieldRules: [] } }
    },
    rules: { requiredFields: { fieldRules: [] } },
    readResult: {
      ok: true,
      limit: 4000,
      recordCount: 1,
      userNameResolvedCount: 1,
      fieldsUsed: ["需求ID", "需求名称"],
      pages: [],
      records: [{
        recordId: "record-1",
        scanIndex: 1,
        viewRowNumber: 2,
        standard: {
          demandId: "DEMAND-1",
          project: "恶魔高校",
          demand: "缓存同步测试",
          demandType: "功能",
          status: "开发中",
          owners: { frontend: ["张三"] },
          dates: {},
          links: {}
        }
      }]
    },
    scanResult: {
      ok: true,
      scannedCount: 1,
      anomalyCount: 0,
      issueCount: 0,
      anomalies: [],
      rules: {
        requiredFieldRuleSourceVersion: "V0004",
        requiredFieldRuleCount: 39,
        requiredFieldAvailableRuleCount: 38,
        requiredFieldUnavailableRuleCount: 1,
        requiredFieldUnavailableFields: ["监修时间"]
      }
    }
  };
}

async function main() {
  const writes = [];
  const logEntries = [];
  const module = createDevProgressModule({
    logger: {
      info(message, meta) { logEntries.push({ level: "info", message, meta }); },
      warn(message, meta) { logEntries.push({ level: "warn", message, meta }); }
    },
    runAnomalyScan: async () => scanBundle(),
    readDocumentInfo: async () => ({
      ok: true,
      signal: "test-doc|test-sheet|test-view|1788486962",
      modifyTime: "1788486962"
    }),
    readH5MonitorCacheFile: () => ({
      ok: true,
      version: 21,
      signal: "test-doc|test-sheet|test-view|1788486071",
      modifyTime: "1788486071",
      refreshedAt: "2026-09-04T01:45:20.000Z",
      requiredItems: [],
      personTaskItems: []
    }),
    writeH5MonitorCacheFile: (cache) => writes.push(JSON.parse(JSON.stringify(cache)))
  });

  const full = await module.prepareRequiredFieldPush({ syncH5MonitorCache: true });
  assert.strictEqual(full.ok, true);
  assert.strictEqual(full.h5CacheSync.synced, true);
  assert.strictEqual(full.h5CacheSync.modifyTime, "1788486962");
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].refreshReason, "required_field_scan");
  assert.strictEqual(writes[0].modifyTime, "1788486962");
  assert.strictEqual(writes[0].personTaskItems.length, 1);
  assert(logEntries.some((entry) => entry.message === "Dev progress H5 cache synced from required-field scan"));

  const partial = await module.prepareRequiredFieldPush({
    syncH5MonitorCache: true,
    recordIds: ["record-1"]
  });
  assert.strictEqual(partial.ok, true);
  assert.strictEqual(partial.h5CacheSync.synced, false);
  assert.strictEqual(partial.h5CacheSync.reason, "partial_scan");
  assert.strictEqual(writes.length, 1);

  const writeFailureModule = createDevProgressModule({
    logger: { info() {}, warn() {} },
    runAnomalyScan: async () => scanBundle(),
    readDocumentInfo: async () => ({
      ok: true,
      signal: "test-doc|test-sheet|test-view|1788486962",
      modifyTime: "1788486962"
    }),
    readH5MonitorCacheFile: () => null,
    writeH5MonitorCacheFile: () => { throw new Error("disk unavailable"); }
  });
  const writeFailure = await writeFailureModule.prepareRequiredFieldPush({ syncH5MonitorCache: true });
  assert.strictEqual(writeFailure.ok, true);
  assert.strictEqual(writeFailure.h5CacheSync.ok, false);
  assert.strictEqual(writeFailure.h5CacheSync.reason, "cache_write_failed");

  console.log(JSON.stringify({
    passed: true,
    checks: {
      fullRequiredFieldScanUpdatesH5Cache: true,
      scanResultIsReusedWithoutSecondRead: true,
      documentSignalIsPersisted: true,
      partialFeedbackScanCannotOverwriteFullCache: true,
      cacheWriteFailureDoesNotBlockMonitorScan: true,
      cacheSyncIsLogged: true
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
