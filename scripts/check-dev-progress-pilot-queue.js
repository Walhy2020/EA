"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDevProgressMonitorBridge } = require("../src/monitors/devProgressMonitorBridge");

function task(index) {
  return {
    missingFields: [`缺失字段${index}`],
    status: "测试中",
    task: {
      recordId: `R-${index}`,
      demandId: `D-${index}`,
      demand: `测试任务${index}`,
      project: "测试项目",
      status: "测试中",
      links: {}
    }
  };
}

function pushResult() {
  return {
    ok: true,
    push: {
      targetOverride: { enabled: true, targetName: "高文盛" },
      targets: [{
        ownerName: "高文盛",
        targetId: "YuYin",
        targetOverride: true,
        items: [task(1), task(2), task(3)]
      }]
    }
  };
}

function feedbackInput(message) {
  const url = new URL(message.url);
  return {
    reminderId: url.searchParams.get("reminderId"),
    token: url.searchParams.get("token")
  };
}

async function main() {
  const stateFile = path.join(os.tmpdir(), `ea-pilot-queue-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const messages = [];
  const bridge = createDevProgressMonitorBridge({
    devProgressModule: {
      prepareRequiredFieldPush: async () => pushResult()
    },
    appNotifier: {
      send: async (message) => {
        messages.push(message);
        return { ok: true, msgid: `M-${messages.length}` };
      }
    },
    appFeedbackUrl: "http://127.0.0.1:39200/dev-required-feedback.html",
    monitorConfig: {
      enabled: false,
      notifyThroughCenter: true,
      changeDetection: { enabled: false },
      requiredFieldsPush: {
        enabled: true,
        testMode: true,
        testTargetName: "高文盛",
        testNextTaskDelaySeconds: 45,
        pilot: {
          enabled: true,
          targetName: "高文盛",
          remindMinutes: 60,
          maxActiveTasks: 1
        }
      }
    },
    logger: { info() {}, warn() {}, error() {} },
    stateFile
  });

  try {
    await bridge.tick();
    const firstOnly = messages.length === 1 && messages[0].description.includes("测试任务1");

    await bridge.submitPilotAppFeedback({ ...feedbackInput(messages[0]), action: "processing" });
    bridge.stop();
    await bridge.tick();
    const processingReleasesSlot = messages.length === 2 && messages[1].description.includes("测试任务2");

    await bridge.tick();
    const awaitingStillOccupiesSlot = messages.length === 2;

    await bridge.submitPilotAppFeedback({ ...feedbackInput(messages[1]), action: "processing" });
    bridge.stop();
    await bridge.tick();
    const secondProcessingReleasesNextSlot = messages.length === 3 && messages[2].description.includes("测试任务3");
    const status = bridge.getStatus().requiredFieldsPush.pilot;
    const processingStatePreserved = status.processingCount === 2 && status.awaitingProcessingCount === 1;
    const checks = {
      firstOnly,
      processingReleasesSlot,
      awaitingStillOccupiesSlot,
      secondProcessingReleasesNextSlot,
      processingStatePreserved
    };
    const passed = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({ passed, checks, messageCount: messages.length, status }, null, 2));
    if (!passed) {
      process.exitCode = 1;
    }
  } finally {
    bridge.stop();
    fs.rmSync(stateFile, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
