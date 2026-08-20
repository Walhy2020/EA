"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDevProgressMonitorBridge } = require("../src/monitors/devProgressMonitorBridge");

function pushResult(missingFields) {
  const items = missingFields.length === 0 ? [] : [{
    missingFields,
    status: "测试中",
    task: {
      recordId: "R-REFRESH",
      demandId: "D-REFRESH",
      demand: "同名需求",
      project: "女王",
      status: "测试中",
      links: {}
    }
  }];
  return {
    ok: true,
    push: {
      targetOverride: { enabled: true, targetName: "高文盛" },
      targets: [{ ownerName: "高文盛", targetId: "YuYin", targetOverride: true, items }]
    }
  };
}

async function createHarness(results) {
  const stateFile = path.join(os.tmpdir(), `ea-feedback-refresh-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const messages = [];
  const refreshRequests = [];
  const bridge = createDevProgressMonitorBridge({
    devProgressModule: {
      prepareRequiredFieldPush: async (options) => {
        refreshRequests.push(options);
        return results.shift() || pushResult([]);
      }
    },
    appNotifier: { send: async (message) => { messages.push(message); return { ok: true, msgid: "M1" }; } },
    appFeedbackUrl: "http://127.0.0.1:39200/dev-required-feedback.html",
    monitorConfig: {
      enabled: false,
      notifyThroughCenter: true,
      changeDetection: { enabled: false },
      requiredFieldsPush: {
        enabled: true,
        testMode: true,
        testTargetName: "高文盛",
        pilot: { enabled: true, targetName: "高文盛", remindMinutes: 60 }
      }
    },
    logger: { info() {}, warn() {}, error() {} },
    stateFile
  });
  await bridge.tick();
  const link = new URL(messages[0].url);
  return {
    bridge,
    stateFile,
    refreshRequests,
    input: { reminderId: link.searchParams.get("reminderId"), token: link.searchParams.get("token") }
  };
}

function persistedReminders(stateFile) {
  return Object.values(JSON.parse(fs.readFileSync(stateFile, "utf8")).pilotReminders || {});
}

async function historicalCompletionReturnsToPendingCheck() {
  const harness = await createHarness([pushResult(["历史字段"]), pushResult(["实时字段"])]);
  try {
    await harness.bridge.submitPilotAppFeedback({ ...harness.input, action: "processing" });
    await harness.bridge.submitPilotAppFeedback({ ...harness.input, action: "done" });
    const pageOpen = await harness.bridge.getPilotAppFeedback(harness.input);
    const reminders = persistedReminders(harness.stateFile);
    return pageOpen.ok
      && pageOpen.task.status === "awaiting_processing"
      && pageOpen.task.canStart
      && !pageOpen.task.canComplete
      && JSON.stringify(pageOpen.task.missingFields) === JSON.stringify(["实时字段"])
      && reminders.every((item) => item.status === "awaiting_processing" && JSON.stringify(item.missingFields) === JSON.stringify(["实时字段"]))
      && JSON.stringify(harness.refreshRequests[1].recordIds) === JSON.stringify(["R-REFRESH"]);
  } finally {
    harness.bridge.stop();
    fs.rmSync(harness.stateFile, { force: true });
  }
}

async function historicalSnapshotClearedOnCompletionCheck() {
  const harness = await createHarness([pushResult(["历史字段"]), pushResult([])]);
  try {
    const pageOpen = await harness.bridge.getPilotAppFeedback(harness.input);
    const reminders = persistedReminders(harness.stateFile);
    return pageOpen.ok
      && pageOpen.task.status === "resolved"
      && !pageOpen.task.canStart
      && !pageOpen.task.canComplete
      && pageOpen.task.missingFields.length === 0
      && reminders.every((item) => item.status === "resolved" && item.missingFields.length === 0);
  } finally {
    harness.bridge.stop();
    fs.rmSync(harness.stateFile, { force: true });
  }
}

async function main() {
  const checks = {
    historicalCompletedNewScanMissing: await historicalCompletionReturnsToPendingCheck(),
    historicalSnapshotNewScanComplete: await historicalSnapshotClearedOnCompletionCheck()
  };
  const passed = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ passed, checks }, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
