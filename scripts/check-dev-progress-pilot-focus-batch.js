"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDevProgressMonitorBridge } = require("../src/monitors/devProgressMonitorBridge");

function item(demandId) {
  return {
    missingFields: ["测试组长"],
    status: "测试中",
    task: {
      recordId: `R-${demandId}`,
      demandId,
      demand: `重点需求${demandId}`,
      project: "测试项目",
      status: "测试中",
      links: {}
    }
  };
}

async function main() {
  const stateFile = path.join(os.tmpdir(), `ea-pilot-focus-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const messages = [];
  const logs = [];
  const prepareOptions = [];
  const pushResult = {
    ok: true,
    push: {
      responsibilityTargets: [{
        ownerName: "高文盛",
        targetId: "YuYin",
        items: [item("003999")]
      }],
      targetOverride: {
        enabled: true,
        targetName: "高文盛"
      },
      targets: [{
        ownerName: "高文盛",
        targetId: "YuYin",
        items: [item("003614"), item("003612"), item("003612"), item("003613")]
      }]
    }
  };
  const bridge = createDevProgressMonitorBridge({
    devProgressModule: {
      prepareRequiredFieldPush: async (options) => {
        prepareOptions.push(options);
        return pushResult;
      }
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
        pilot: {
          enabled: true,
          targetName: "高文盛",
          remindMinutes: 1440,
          maxActiveTasks: 3,
          focusDemandIds: ["3612", "003613", "3614"]
        }
      }
    },
    logger: {
      info(message, details) { logs.push({ level: "info", message, details }); },
      warn(message, details) { logs.push({ level: "warn", message, details }); },
      error(message, details) { logs.push({ level: "error", message, details }); }
    },
    stateFile
  });

  try {
    await bridge.tick();
    const descriptions = messages.map((message) => message.description || "");
    const checks = {
      sendsThreeInOneTick: messages.length === 3,
      followsConfiguredOrder: ["003612", "003613", "003614"].every((id, index) => String(descriptions[index] || "").includes(id)),
      excludesNonFocusedDemand: descriptions.every((description) => !description.includes("003999")),
      deduplicatesSameDemand: descriptions.filter((description) => description.includes("003612")).length === 1,
      passesFocusToSourceScan: JSON.stringify(prepareOptions[0] && prepareOptions[0].focusDemandIds) === JSON.stringify(["003612", "003613", "003614"]),
      exposesFocusInStatus: JSON.stringify(bridge.getStatus()).includes('"focusDemandIds":["003612","003613","003614"]')
    };
    const passed = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({ passed, checks, messageCount: messages.length, descriptions, status: bridge.getStatus(), logs }, null, 2));
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
