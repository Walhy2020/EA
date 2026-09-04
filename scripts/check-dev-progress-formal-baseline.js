"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDevProgressMonitorBridge } = require("../src/monitors/devProgressMonitorBridge");

const stateFile = path.join(os.tmpdir(), `ea-dev-progress-formal-${process.pid}-${Date.now()}.json`);
let scanCount = 0;
let sendCount = 0;
let scanOptions = null;

async function main() {
  try {
  fs.writeFileSync(stateFile, JSON.stringify({
    sent: {},
    groupBinding: { enabled: true, chatId: "test-group" },
    pilotReminders: { stale: { id: "stale" } },
    pilotSent: { stale: { sentAt: "2026-01-01T00:00:00.000Z" } },
    pilotGroupSummary: { actionUrl: "http://10.1.1.81:39200/dev-required-summary.html" },
    pilotGroupMention: { status: "pending" }
  }));
  const bridge = createDevProgressMonitorBridge({
    stateFile,
    monitorConfig: {
      enabled: true,
      intervalMinutes: 1,
      notifyThroughCenter: false,
      changeDetection: { enabled: false },
      requiredFieldsPush: {
        enabled: false,
        testMode: false,
        groupCard: { enabled: true },
        pilot: { enabled: false, targetName: "", focusDemandIds: [] }
      }
    },
    devProgressModule: {
      async prepareRequiredFieldPush(options) {
        scanCount += 1;
        scanOptions = options;
        return {
          ok: true,
          scannedCount: 1,
          anomalyCount: 1,
          issueCount: 1,
          rules: { requiredFieldRuleCount: 1 },
          push: {
            targetCount: 1,
            unresolvedCount: 1,
            skippedNoOwnerCount: 0,
            targets: [{ ownerName: "任何人", issueCount: 1, items: [] }]
          }
        };
      }
    },
    appNotifier: { async send() { sendCount += 1; throw new Error("must not send"); } },
    robotServer: { async sendMessage() { sendCount += 1; throw new Error("must not send"); } },
    logger: { info() {}, warn() {}, error() {} }
  });
  const result = await bridge.tick();
  const status = bridge.getStatus();
  assert.strictEqual(scanCount, 1);
  assert.strictEqual(scanOptions.syncH5MonitorCache, true);
  assert.strictEqual(sendCount, 0);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.sentTargetCount, 0);
  assert.strictEqual(result.sentGroupCardCount, 0);
  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.scanEnabled, true);
  assert.strictEqual(status.personalPushEnabled, false);
  assert.strictEqual(status.requiredFieldsPush.mode, "formal");
  assert.strictEqual(status.requiredFieldsPush.autoPushStatus, "disabled_pending_recipient_scope");
  assert.strictEqual(status.requiredFieldsPush.groupCard.enabled, false);
  console.log(JSON.stringify({
    passed: true,
    checks: {
      readOnlyScanRuns: true,
      fullScanSyncsH5Cache: true,
      personalAndGroupPushBlocked: true,
      formalStatusExposed: true
    }
  }, null, 2));
  } finally {
    fs.rmSync(stateFile, { force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
