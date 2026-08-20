"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDevProgressMonitorBridge } = require("../src/monitors/devProgressMonitorBridge");

async function main() {
  const stateFile = path.join(os.tmpdir(), `ea-dev-group-${Date.now()}.json`);
  const cards = [];
  const preparedResult = {
    ok: true,
    scannedCount: 1,
    anomalyCount: 1,
    issueCount: 1,
    push: {
      targets: [],
      responsibilityTargets: [
        {
          ownerName: "张三",
          targetId: "U1",
          items: [
            {
              missingFields: ["预计上线日期"],
              status: "开发中",
              task: {
                recordId: "R1",
                demandId: "D1",
                demand: "测试需求",
                project: "测试项目",
                status: "开发中",
                links: { demandLink: "https://example.com" }
              }
            }
          ]
        }
      ]
    }
  };
  const bridge = createDevProgressMonitorBridge({
    devProgressModule: {
      prepareRequiredFieldPush: async () => preparedResult
    },
    robotServer: {
      sendTemplateCardMessage: async (_chatId, card) => {
        cards.push(card);
        return { errcode: 0 };
      }
    },
    monitorConfig: {
      enabled: false,
      notifyThroughCenter: true,
      intervalMinutes: 1,
      changeDetection: { enabled: false },
      requiredFieldsPush: {
        enabled: true,
        cooldownMinutes: 1440,
        groupCard: {
          enabled: true,
          maxCardsPerTick: 1,
          remindMinutes: 0.001
        }
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {}
    },
    stateFile
  });

  try {
    await bridge.captureTextMessage({
      text: "@1号机器人 绑定需求必填提醒群",
      sender: {
        chatType: "group",
        chatId: "G1",
        userId: "ADMIN",
        name: "管理员"
      }
    });
    await bridge.tick();
    const first = cards[0];
    const directDone = await bridge.handleTemplateCardEvent(
      { taskId: first.task_id, eventKey: "ea_dev_required_done" },
      { userId: "U1", name: "张三" }
    );
    const denied = await bridge.handleTemplateCardEvent(
      { taskId: first.task_id, eventKey: "ea_dev_required_processing" },
      { userId: "U2", name: "李四" }
    );

    await new Promise((resolve) => setTimeout(resolve, 90));
    await bridge.tick();
    const repeatCardCountBeforeProcessing = cards.length;
    const second = cards[1];
    const processing = await bridge.handleTemplateCardEvent(
      { taskId: second.task_id, eventKey: "ea_dev_required_processing" },
      { userId: "U1", name: "张三" }
    );

    await new Promise((resolve) => setTimeout(resolve, 90));
    await bridge.tick();
    const done = await bridge.handleTemplateCardEvent(
      { taskId: second.task_id, eventKey: "ea_dev_required_done" },
      { userId: "U1", name: "张三" }
    );

    const checks = {
      firstButton: first.button_list[0].key,
      directDoneBlocked: /先点击/.test(directDone.message || ""),
      unauthorizedBlocked: /只有责任同事/.test(denied.message || ""),
      repeatCardCountBeforeProcessing,
      processingButton: processing.updateCard.button_list[0].key,
      noRepeatAfterProcessing: cards.length === 2,
      completedCardType: done.updateCard.card_type
    };
    const passed = checks.firstButton === "ea_dev_required_processing"
      && checks.directDoneBlocked
      && checks.unauthorizedBlocked
      && checks.repeatCardCountBeforeProcessing === 2
      && checks.processingButton === "ea_dev_required_done"
      && checks.noRepeatAfterProcessing
      && checks.completedCardType === "text_notice";

    console.log(JSON.stringify({ passed, checks }, null, 2));
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
