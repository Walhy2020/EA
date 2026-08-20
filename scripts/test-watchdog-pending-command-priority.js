"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createWatchdogModule } = require("../src/modules/watchdog/watchdogModule");

const requester = { userId: "LiJingJing", name: "李晶晶", chatType: "single" };
const formText = [
  "被盯梢人：王谦",
  "盯梢任务：跟进需求进度管理的运行情况",
  "盯梢间隔：工作日 11:00",
  "备注：你注意推进其他人的必填项字段的补充情况"
].join("\n");

function readTasks(storeFile) {
  return JSON.parse(fs.readFileSync(storeFile, "utf8")).tasks;
}

function taskById(storeFile, id) {
  return readTasks(storeFile).find((task) => task.id === id);
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ea-watchdog-pending-priority-"));
  const storeFile = path.join(directory, "watchdog-tasks.json");
  const now = new Date().toISOString();
  const pendingRemarkTask = {
    id: "wd_pending_remark",
    status: "active",
    mode: "recurring",
    assigneeUserId: "GaoWensheng",
    assigneeName: "高文盛",
    requesterUserId: requester.userId,
    requesterName: requester.name,
    requesterDisplayName: requester.name,
    requesterTargetId: requester.userId,
    content: "需求监控的跟进",
    remark: "",
    intervalMinutes: 1440,
    recurringSchedule: { type: "weekday", hour: 11, minute: 0 },
    createdAt: now,
    updatedAt: now,
    nextRunAt: "2026-08-18T03:00:00.000Z",
    responses: [],
    awaitingRemarkFrom: requester.userId,
    awaitingRemarkTargetId: requester.userId,
    awaitingRemarkAt: now,
    awaitingRemarkEventKey: "ea_watch_progress",
    awaitingRemarkAssigneeUserId: "GaoWensheng"
  };
  fs.writeFileSync(storeFile, `${JSON.stringify({ tasks: [pendingRemarkTask], drafts: [] }, null, 2)}\n`, "utf8");

  const watchdog = createWatchdogModule({
    storeFile,
    moduleConfig: {
      enabled: true,
      appPush: { enabled: false },
      personAliases: { "王谦": "WangQian" },
      sendQueue: { minIntervalMs: 1000 }
    },
    logger: { info() {}, warn() {} }
  });
  watchdog.setRobotServer({
    sendMarkdownMessage: async () => ({ errcode: 0 }),
    sendTemplateCardMessage: async () => ({ errcode: 0 })
  });

  const formCapture = await watchdog.capturePendingTextMessage({ sender: requester, text: formText });
  assert.equal(formCapture.handled, false, "完整新建表单必须放行给 create_watchdog");
  assert.equal(taskById(storeFile, "wd_pending_remark").remark, "", "新建表单不能改写旧备注");

  const created = await watchdog.handle({
    route: { task: { action: "create_watchdog" } },
    sender: requester,
    text: formText
  });
  assert.equal(created.ok, true);
  assert.equal(created.data.assigneeName, "王谦");
  assert.equal(created.data.content, "跟进需求进度管理的运行情况");
  assert.equal(created.data.remark, "你注意推进其他人的必填项字段的补充情况");

  const remarkCapture = await watchdog.capturePendingTextMessage({ sender: requester, text: "备注：新内容" });
  assert.equal(remarkCapture.handled, true, "纯备注文本应更新待补备注任务");
  const updatedTask = taskById(storeFile, "wd_pending_remark");
  assert.equal(updatedTask.remark, "新内容");
  assert.equal(updatedTask.awaitingRemarkFrom, "", "备注更新后必须清除待补状态");
  assert.equal(updatedTask.awaitingRemarkTargetId, "");
  assert.equal(updatedTask.awaitingRemarkAt, "");
  assert.equal(updatedTask.awaitingRemarkEventKey, "");
  assert.equal(updatedTask.awaitingRemarkAssigneeUserId, "");

  const noPendingRemark = await watchdog.capturePendingTextMessage({ sender: requester, text: "备注：不应被处理" });
  assert.equal(noPendingRemark.handled, false, "没有待补备注时不能误处理纯备注文本");

  const rescheduleDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ea-watchdog-reschedule-priority-"));
  const rescheduleStoreFile = path.join(rescheduleDirectory, "watchdog-tasks.json");
  const pendingRescheduleTask = {
    id: "wd_pending_reschedule",
    status: "active",
    mode: "once",
    assigneeUserId: "OnceAssignee",
    assigneeName: "一次性对象",
    requesterUserId: requester.userId,
    requesterName: requester.name,
    requesterTargetId: requester.userId,
    content: "一次性提醒",
    createdAt: now,
    updatedAt: now,
    nextRunAt: "",
    responses: [],
    awaitingRescheduleFrom: requester.userId,
    awaitingRescheduleAt: now,
    awaitingRescheduleReason: "completed"
  };
  fs.writeFileSync(rescheduleStoreFile, `${JSON.stringify({ tasks: [pendingRescheduleTask], drafts: [] }, null, 2)}\n`, "utf8");
  const rescheduleWatchdog = createWatchdogModule({
    storeFile: rescheduleStoreFile,
    moduleConfig: { enabled: true, appPush: { enabled: false } },
    logger: { info() {}, warn() {} }
  });
  const rescheduleCapture = await rescheduleWatchdog.capturePendingTextMessage({ sender: requester, text: formText });
  assert.equal(rescheduleCapture.handled, false, "一次性补时间等待中仍必须放行独立新建盯梢命令");

  watchdog.stop();
  rescheduleWatchdog.stop();
  fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(rescheduleDirectory, { recursive: true, force: true });
  console.log("Watchdog pending command priority OK");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
