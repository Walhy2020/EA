"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDevProgressMonitorBridge } = require("../src/monitors/devProgressMonitorBridge");

async function main() {
  const stateFile = path.join(os.tmpdir(), `ea-dev-pilot-${Date.now()}.json`);
  const messages = [];
  const groupCards = [];
  const groupMentions = [];
  const result = {
    ok: true,
    scannedCount: 1,
    anomalyCount: 1,
    issueCount: 1,
    push: {
      targetOverride: {
        enabled: true,
        targetName: "高文盛"
      },
      targets: [
        {
          ownerName: "高文盛",
          targetId: "YuYin",
          targetOverride: true,
          items: [
            {
              originalOwnerName: "时振兴",
              missingFields: ["预计上线日期"],
              status: "开发中",
              task: {
                recordId: "R1",
                demandId: "D1",
                demand: "试运行需求",
                project: "测试项目",
                status: "开发中",
                links: { demandLink: "https://example.com" }
              }
            }
          ]
        }
      ],
      responsibilityTargets: [
        {
          ownerName: "时振兴",
          targetId: "ShiZhenXing",
          items: [
            {
              missingFields: ["预计上线日期"],
              status: "开发中",
              task: {
                recordId: "R1",
                demandId: "D1",
                demand: "试运行需求",
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
      prepareRequiredFieldPush: async () => result
    },
    appNotifier: {
      send: async (message) => {
        messages.push(message);
        return { ok: true, msgid: `M${messages.length}` };
      }
    },
    appFeedbackUrl: "http://127.0.0.1:39200/dev-required-feedback.html",
    robotServer: {
      sendTemplateCardMessage: async (_chatId, card) => {
        groupCards.push(card);
        return { errcode: 0 };
      },
      sendMarkdownMessage: async (chatId, content) => {
        groupMentions.push({ chatId, content });
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
        pilot: {
          enabled: true,
          targetName: "高文盛",
          remindMinutes: 0.001,
          summaryMinutes: 0.002,
          mentionDelaySeconds: 0.001
        },
        groupCard: { enabled: true, maxCardsPerTick: 1, remindMinutes: 30 }
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
      text: "绑定需求必填提醒群",
      sender: {
        chatType: "group",
        chatId: "G1",
        userId: "ADMIN",
        name: "管理员"
      }
    });
    await bridge.tick();
    await new Promise((resolve) => setTimeout(resolve, 90));
    await bridge.tick();
    const link = new URL(messages[1].url);
    const input = {
      reminderId: link.searchParams.get("reminderId"),
      token: link.searchParams.get("token")
    };
    const waitingDetail = bridge.getPilotGroupDetail();
    const directDone = await bridge.submitPilotAppFeedback({ ...input, action: "done" });
    const processing = await bridge.submitPilotAppFeedback({ ...input, action: "processing" });
    const processingDetail = bridge.getPilotGroupDetail();
    await bridge.tick();
    const groupCardsBeforeDailyWindow = groupCards.length;
    await new Promise((resolve) => setTimeout(resolve, 90));
    await bridge.tick();
    const done = await bridge.submitPilotAppFeedback({ ...input, action: "done" });
    await new Promise((resolve) => setTimeout(resolve, 90));
    await bridge.tick();
    const completedDetail = bridge.getPilotGroupDetail();
    const invalid = await bridge.getPilotAppFeedback({ ...input, token: "invalid" });
    const checks = {
      targetUserId: messages[0].toUser,
      repeatedBeforeProcessing: messages.length === 2,
      directDoneBlocked: !directDone.ok && /先点击/.test(directDone.message || ""),
      processingRecorded: processing.ok && processing.task.status === "processing",
      stoppedAfterProcessing: messages.length === 2,
      completed: done.ok && done.task.status === "completed",
      invalidTokenBlocked: !invalid.ok,
      groupUsesSummaryCard: groupCards.length === 2
        && groupCards.every((card) => card.card_type === "text_notice"),
      groupTitlesHaveNoStatus: groupCards.every((card) =>
        card.main_title
        && card.main_title.title === "需求必填字段试运行汇总"
        && !/^【/.test(card.main_title.title)
      ),
      groupTopStatusVisible: groupCards[0].source
        && groupCards[0].source.desc === "EA需求监控 · 未操作"
        && groupCards[1].source
        && groupCards[1].source.desc === "EA需求监控 · 正在处理",
      groupDailyWindowStrict: groupCardsBeforeDailyWindow === 1,
      groupMentionsOwner: groupMentions.length === 2
        && groupMentions.every((message) =>
          message.chatId === "G1"
          && message.content.includes("<@YuYin>")
          && message.content.includes("责任人：高文盛")
        ),
      groupHasNoHiddenStatusMenu: groupCards.every((card) => !card.action_menu),
      groupCardUsesSummaryPage: groupCards.every((card) =>
        card.card_action
        && card.card_action.url === "http://127.0.0.1:39200/dev-required-summary.html"
      ),
      groupSummaryLabelsClear: /当前试运行 1 条/.test(groupCards[0].main_title.desc || "")
        && groupCards[0].horizontal_content_list.some((item) =>
          item.keyname === "全部待核查" && item.value === "1"
        ),
      groupDetailStatusProgression: waitingDetail.summary.task.statusText === "未操作"
        && processingDetail.summary.task.statusText === "正在处理"
        && completedDetail.summary.task.statusText === "已完成",
      groupDetailIsReadOnly: !Object.hasOwn(waitingDetail.summary.task, "token")
        && !Object.hasOwn(waitingDetail.summary.task, "canStart")
        && !Object.hasOwn(waitingDetail.summary.task, "canComplete")
    };
    const passed = checks.targetUserId === "YuYin"
      && checks.repeatedBeforeProcessing
      && checks.directDoneBlocked
      && checks.processingRecorded
      && checks.stoppedAfterProcessing
      && checks.completed
      && checks.invalidTokenBlocked
      && checks.groupUsesSummaryCard
      && checks.groupTitlesHaveNoStatus
      && checks.groupTopStatusVisible
      && checks.groupDailyWindowStrict
      && checks.groupMentionsOwner
      && checks.groupHasNoHiddenStatusMenu
      && checks.groupCardUsesSummaryPage
      && checks.groupSummaryLabelsClear
      && checks.groupDetailStatusProgression
      && checks.groupDetailIsReadOnly;
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
