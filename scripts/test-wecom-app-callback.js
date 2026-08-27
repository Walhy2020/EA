"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
  appFeedbackRefForTaskId,
  createWatchdogModule
} = require("../src/modules/watchdog/watchdogModule");
const { createWecomAppCallback } = require("../src/notification/wecomAppCallback");
const { verifyDemandH5State } = require("../src/admin/demandH5AuthState");

const callbackToken = "callback-test-token";
const callbackAesKey = Buffer.alloc(32, 7).toString("base64").replace(/=$/, "");
const corpId = "test-corp-id";
const feedbackSecret = "test-feedback-oauth-secret";
const wecomPkcs7BlockSize = 32;

function signature(encrypted, timestamp = "1700000000", nonce = "test-nonce") {
  return crypto.createHash("sha1").update([callbackToken, timestamp, nonce, encrypted].sort().join("")).digest("hex");
}

function wecomPkcs7Pad(value) {
  const paddingLength = wecomPkcs7BlockSize - (value.length % wecomPkcs7BlockSize);
  return Buffer.concat([value, Buffer.alloc(paddingLength, paddingLength)]);
}

function encryptRaw(plain) {
  const key = Buffer.from(`${callbackAesKey}=`, "base64");
  const cipher = crypto.createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");
}

function encrypt(payload, targetCorpId = corpId) {
  const content = Buffer.from(payload, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(content.length, 0);
  const plain = Buffer.concat([Buffer.alloc(16, 1), length, content, Buffer.from(targetCorpId, "utf8")]);
  return encryptRaw(wecomPkcs7Pad(plain));
}

function encryptWithInvalidPadding(payload) {
  const content = Buffer.from(payload, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(content.length, 0);
  const plain = Buffer.concat([Buffer.alloc(16, 1), length, content, Buffer.from(corpId, "utf8")]);
  const padded = wecomPkcs7Pad(plain);
  padded[padded.length - 2] = 0;
  return encryptRaw(padded);
}

function callbackUrl(encrypted, invalidSignature = false) {
  const timestamp = "1700000000";
  const nonce = "test-nonce";
  const params = new URLSearchParams({
    msg_signature: invalidSignature ? "invalid" : signature(encrypted, timestamp, nonce),
    timestamp,
    nonce
  });
  return `/api/wecom/watchdog-callback?${params.toString()}`;
}

function request(port, method, pathname, body = "") {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: body
        ? { "Content-Type": "application/xml", "Content-Length": Buffer.byteLength(body) }
        : {}
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function selectedItemsXml(selectedItems) {
  if (!Array.isArray(selectedItems) || selectedItems.length === 0) return "";
  return [
    "<SelectedItems>",
    ...selectedItems.map((item) => [
      "<SelectedItem>",
      `<QuestionKey><![CDATA[${item.questionKey}]]></QuestionKey>`,
      "<OptionIds>",
      ...(item.optionIds || []).map((optionId) => `<OptionId><![CDATA[${optionId}]]></OptionId>`),
      "</OptionIds>",
      "</SelectedItem>"
    ].join("")),
    "</SelectedItems>"
  ].join("");
}

function eventXml({ taskId, eventKey, userId = "assignee", selectedItems = [] }) {
  return [
    "<xml>",
    `<ToUserName><![CDATA[${corpId}]]></ToUserName>`,
    `<FromUserName><![CDATA[${userId}]]></FromUserName>`,
    "<MsgType><![CDATA[event]]></MsgType>",
    "<Event><![CDATA[template_card_event]]></Event>",
    `<EventKey><![CDATA[${eventKey}]]></EventKey>`,
    `<TaskId><![CDATA[${taskId}]]></TaskId>`,
    selectedItemsXml(selectedItems),
    "<ResponseCode><![CDATA[test-response-code]]></ResponseCode>",
    "</xml>"
  ].join("");
}

function callbackBody(payload) {
  return `<xml><Encrypt><![CDATA[${encrypt(payload)}]]></Encrypt></xml>`;
}

function fixture(id, extra = {}) {
  const now = "2026-08-14T06:00:00.000Z";
  return {
    id,
    status: "active",
    mode: "recurring",
    assigneeUserId: "assignee",
    assigneeName: "责任同事",
    requesterUserId: "requester",
    requesterTargetId: "requester",
    requesterName: "发起同事",
    content: `隔离回调测试任务-${id}`,
    intervalMinutes: 60,
    createdAt: now,
    updatedAt: now,
    nextRunAt: "2026-08-14T07:00:00.000Z",
    responses: [],
    initialAckEvents: [],
    ...extra
  };
}

function loadTasks(storeFile) {
  return JSON.parse(fs.readFileSync(storeFile, "utf8")).tasks;
}

function taskById(storeFile, id) {
  return loadTasks(storeFile).find((item) => item.id === id);
}

async function main() {
  process.env.TEST_APP_CALLBACK_TOKEN = callbackToken;
  process.env.TEST_APP_CALLBACK_AES_KEY = callbackAesKey;
  process.env.TEST_APP_CORP_ID = corpId;
  process.env.TEST_FEEDBACK_CORP_ID = corpId;
  process.env.TEST_FEEDBACK_AGENT_ID = "1000011";
  process.env.TEST_FEEDBACK_SECRET = feedbackSecret;

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ea-wecom-app-callback-"));
  const storeFile = path.join(directory, "watchdog-tasks.json");
  const tasks = [
    fixture("wd_active"),
    fixture("wd_receipt"),
    fixture("wd_completed", { status: "completed", nextRunAt: "" }),
    fixture("wd_once", { mode: "once", dueAt: "2026-08-14T07:00:00.000Z" }),
    fixture("wd_initial")
  ];
  fs.writeFileSync(storeFile, `${JSON.stringify({ tasks, drafts: [] }, null, 2)}\n`, "utf8");

  let robotMessageCount = 0;
  const callbackAppMessages = [];
  let cardUpdateCount = 0;
  const cardUpdates = [];
  const appNotifier = {
    getStatus: () => ({ configured: true, nativeCard: { ready: true } }),
    send: async (message) => {
      callbackAppMessages.push(message);
      return { ok: true, msgid: "isolated" };
    },
    updateTemplateCard: async (options) => {
      cardUpdateCount += 1;
      cardUpdates.push(options);
      return { ok: true };
    }
  };
  const watchdog = createWatchdogModule({
    storeFile,
    moduleConfig: {
      enabled: true,
      appPush: {
        enabled: true,
        corpIdEnv: "TEST_FEEDBACK_CORP_ID",
        agentIdEnv: "TEST_FEEDBACK_AGENT_ID",
        secretEnv: "TEST_FEEDBACK_SECRET",
        nativeCard: { enabled: true }
      }
    },
    appFeedbackUrl: "https://ea.example.com/watchdog-feedback.html",
    appNotifier,
    logger: { info() {}, warn() {} }
  });
  watchdog.setRobotServer({
    sendMarkdownMessage: async () => {
      robotMessageCount += 1;
      return { errcode: 0 };
    }
  });
  const callbackWarnings = [];
  const callback = createWecomAppCallback({
    appMessage: {
      corpIdEnv: "TEST_APP_CORP_ID",
      nativeCard: {
        enabled: true,
        callbackPath: "/api/wecom/watchdog-callback",
        callbackTokenEnv: "TEST_APP_CALLBACK_TOKEN",
        callbackAesKeyEnv: "TEST_APP_CALLBACK_AES_KEY"
      }
    },
    watchdog,
    appNotifier,
    logger: { info() {}, warn(...args) { callbackWarnings.push(args); } }
  });
  const server = http.createServer((req, res) => {
    Promise.resolve(callback.handleRequest(req, res, new URL(req.url, "http://localhost"))).catch((error) => {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(error.message);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const echo = encrypt("verify-ok");
    const validGet = await request(port, "GET", `${callbackUrl(echo)}&echostr=${encodeURIComponent(echo)}`);
    assert.equal(validGet.statusCode, 200);
    assert.equal(validGet.body, "verify-ok");

    const invalidGet = await request(port, "GET", `${callbackUrl(echo, true)}&echostr=${encodeURIComponent(echo)}`);
    assert.equal(invalidGet.statusCode, 403);

    const wrongCorpEcho = encrypt("verify-ok", "wrong-corp-id");
    const wrongCorp = await request(port, "GET", `${callbackUrl(wrongCorpEcho)}&echostr=${encodeURIComponent(wrongCorpEcho)}`);
    assert.equal(wrongCorp.statusCode, 403);

    const invalidPaddingEcho = encryptWithInvalidPadding("verify-ok");
    const invalidPadding = await request(port, "GET", `${callbackUrl(invalidPaddingEcho)}&echostr=${encodeURIComponent(invalidPaddingEcho)}`);
    assert.equal(invalidPadding.statusCode, 403);

    async function sendEvent(data) {
      const body = callbackBody(eventXml(data));
      const encrypted = /<!\[CDATA\[([\s\S]+?)\]\]>/.exec(body)[1];
      return request(port, "POST", callbackUrl(encrypted), body);
    }

    const denied = await sendEvent({ taskId: "ea_watch_wd_active_1", eventKey: "ea_watch_progress", userId: "other-user" });
    assert.equal(denied.statusCode, 200);
    assert.equal(taskById(storeFile, "wd_active").responses.length, 0);

    const unknown = await sendEvent({ taskId: "ea_watch_wd_active_2", eventKey: "not_allowed" });
    assert.equal(unknown.statusCode, 200);
    assert.equal(taskById(storeFile, "wd_active").responses.length, 0);

    const deniedReceipt = await sendEvent({
      taskId: "ea_watch_wd_receipt_20",
      eventKey: "ea_watch_card_received",
      userId: "other-user"
    });
    assert.equal(deniedReceipt.statusCode, 200);
    assert.equal(taskById(storeFile, "wd_receipt").appCardReceiptEvents, undefined);

    const received = await sendEvent({ taskId: "ea_watch_wd_receipt_21", eventKey: "ea_watch_card_received" });
    assert.equal(received.statusCode, 200);
    const receivedTask = taskById(storeFile, "wd_receipt");
    assert.equal(receivedTask.responses.length, 0);
    assert.equal(receivedTask.initialAckEvents.length, 0);
    assert.equal(receivedTask.appCardReceiptEvents.length, 1);
    assert.equal(receivedTask.appCardReceiptEvents[0].cardTaskId, "ea_watch_wd_receipt_21");
    assert.equal(receivedTask.appCardReceiptEvents[0].eventKey, "ea_watch_card_received");
    const receivedUpdate = cardUpdates.at(-1).templateCard;
    assert.equal(receivedUpdate.card_type, "text_notice");
    assert.equal(receivedUpdate.source.desc, "EA盯梢 · 已收到");
    assert.equal(receivedUpdate.source.desc_color, 3);
    assert.equal(receivedUpdate.card_action.type, 1);
    assert.match(receivedUpdate.card_action.url, /^https:\/\/open\.weixin\.qq\.com\/connect\/oauth2\/authorize/);
    assert.equal(receivedUpdate.button_list, undefined);
    assert.equal(receivedUpdate.task_id, "ea_watch_wd_receipt_21");
    assert.equal(receivedUpdate.jump_list, undefined);
    const receivedDetail = receivedUpdate.horizontal_content_list.find((item) => item.keyname === "详情");
    assert.equal(receivedDetail.value, "查看反馈记录");
    assert.equal(receivedDetail.type, 1);
    assert.equal(receivedDetail.url, receivedUpdate.card_action.url);

    const duplicateReceipt = await sendEvent({ taskId: "ea_watch_wd_receipt_21", eventKey: "ea_watch_card_received" });
    assert.equal(duplicateReceipt.statusCode, 200);
    assert.equal(taskById(storeFile, "wd_receipt").appCardReceiptEvents.length, 1);

    const initialReceipt = await sendEvent({
      taskId: "ea_watch_initial_wd_initial_22",
      eventKey: "ea_watch_card_received"
    });
    assert.equal(initialReceipt.statusCode, 200);
    assert.equal(taskById(storeFile, "wd_initial").status, "active");
    assert.equal(taskById(storeFile, "wd_initial").initialAckEvents.length, 0);
    assert.equal(taskById(storeFile, "wd_initial").appCardReceiptEvents.length, 1);

    const progress = await sendEvent({
      taskId: "ea_watch_wd_active_3",
      eventKey: "ea_watch_progress",
      selectedItems: [{ questionKey: "ea_watch_situation", optionIds: ["waiting_integration"] }]
    });
    assert.equal(progress.statusCode, 200, `${progress.body} ${JSON.stringify(callbackWarnings.slice(-1))}`);
    assert.equal(taskById(storeFile, "wd_active").responses.length, 1);
    assert.equal(taskById(storeFile, "wd_active").responses[0].source, "wecom-app-native");
    assert.equal(taskById(storeFile, "wd_active").responses[0].note, "等待联调");
    assert.equal(taskById(storeFile, "wd_active").lastFeedbackNote, "等待联调");

    const duplicate = await sendEvent({ taskId: "ea_watch_wd_active_3", eventKey: "ea_watch_progress" });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(taskById(storeFile, "wd_active").responses.length, 1);

    const completed = await sendEvent({ taskId: "ea_watch_wd_active_30", eventKey: "ea_watch_done" });
    assert.equal(completed.statusCode, 200);
    assert.equal(taskById(storeFile, "wd_active").status, "completed");
    assert.ok(callbackAppMessages.some((message) => (
      message.purpose === "watchdog_result_notice"
      && message.messageType === undefined
      && message.templateCard === undefined
      && message.text.includes("【EA盯梢已完成】")
      && message.text.includes("状态：已完成，盯梢已停止")
    )));

    const terminal = await sendEvent({ taskId: "ea_watch_wd_completed_4", eventKey: "ea_watch_progress" });
    assert.equal(terminal.statusCode, 200);
    assert.equal(taskById(storeFile, "wd_completed").responses.length, 0);
    assert.equal(taskById(storeFile, "wd_completed").status, "completed");

    const once = await sendEvent({ taskId: "ea_watch_wd_once_5", eventKey: "ea_watch_delay" });
    assert.equal(once.statusCode, 200);
    assert.equal(taskById(storeFile, "wd_once").awaitingRescheduleFrom, "assignee");
    assert.equal(robotMessageCount, 0);

    const rejected = await sendEvent({ taskId: "ea_watch_initial_wd_initial_6", eventKey: "ea_watch_initial_reject" });
    assert.equal(rejected.statusCode, 200);
    assert.equal(taskById(storeFile, "wd_initial").status, "rejected");
    assert.equal(robotMessageCount, 0);
    assert.ok(callbackAppMessages.length >= 4);
    assert.ok(cardUpdateCount >= 11);

    const reminderStoreFile = path.join(directory, "safe-reminder-tasks.json");
    fs.writeFileSync(reminderStoreFile, `${JSON.stringify({
      tasks: [fixture("wd_safe_reminder", { nextRunAt: "2026-08-14T05:00:00.000Z" })],
      drafts: []
    }, null, 2)}\n`, "utf8");
    const sentReminders = [];
    const safeReminderWatchdog = createWatchdogModule({
      storeFile: reminderStoreFile,
      moduleConfig: { enabled: true, appPush: { enabled: true, nativeCard: { enabled: false } } },
      appNotifier: {
        getStatus: () => ({ configured: true, nativeCard: { ready: false } }),
        send: async (message) => {
          sentReminders.push(message);
          return { ok: true, msgid: "isolated-reminder" };
        }
      },
      logger: { info() {}, warn() {} }
    });
    await safeReminderWatchdog.tick();
    assert.equal(sentReminders.length, 1);
    assert.equal(sentReminders[0].messageType, undefined);
    assert.match(sentReminders[0].text, /反馈按钮正在升级/);
    assert.equal(JSON.stringify(sentReminders[0]).includes("watchdog-feedback"), false);

    const linkedReminderStoreFile = path.join(directory, "linked-reminder-tasks.json");
    fs.writeFileSync(linkedReminderStoreFile, `${JSON.stringify({
      tasks: [fixture("wd_linked_reminder", {
        nextRunAt: "2026-08-14T05:00:00.000Z",
        firstReminderSentAt: "2026-08-14T04:00:00.000Z",
        initialAckStatus: "received",
        initialAckAt: "2026-08-14T04:00:00.000Z",
        appFeedbackToken: "legacy-feedback-token"
      }), fixture("wd_linked_reminder_2", {
        nextRunAt: "2099-08-14T05:00:00.000Z",
        firstReminderSentAt: "2026-08-14T04:00:00.000Z",
        initialAckStatus: "received",
        initialAckAt: "2026-08-14T04:00:00.000Z",
        initialAckEvents: [{
          receivedAt: "2026-08-14T04:00:00.000Z",
          eventKey: "ea_watch_initial_received",
          label: "收到",
          senderUserId: "assignee",
          source: "wecom-app"
        }],
        responses: [{
          receivedAt: "2026-08-14T04:30:00.000Z",
          eventKey: "ea_watch_progress",
          label: "正常推进",
          senderUserId: "assignee",
          source: "wecom-app",
          note: "已完成第一阶段"
        }, {
          receivedAt: "2026-08-14T05:00:00.000Z",
          eventKey: "ea_watch_delay",
          label: "需要延期",
          senderUserId: "assignee",
          source: "wecom-app",
          note: "等待测试环境"
        }]
      }), fixture("wd_linked_completed", {
        status: "completed",
        nextRunAt: ""
      })],
      drafts: []
    }, null, 2)}\n`, "utf8");
    const linkedMessages = [];
    const linkedReminderWatchdog = createWatchdogModule({
      storeFile: linkedReminderStoreFile,
      moduleConfig: {
        enabled: true,
        appPush: {
          enabled: true,
          corpIdEnv: "TEST_FEEDBACK_CORP_ID",
          agentIdEnv: "TEST_FEEDBACK_AGENT_ID",
          secretEnv: "TEST_FEEDBACK_SECRET",
          nativeCard: { enabled: true }
        }
      },
      appFeedbackUrl: "https://ea.example.com/watchdog-feedback.html",
      appNotifier: {
        getStatus: () => ({ configured: true, nativeCard: { ready: true } }),
        send: async (message) => {
          linkedMessages.push(message);
          return { ok: true, msgid: `linked-${linkedMessages.length}` };
        }
      },
      logger: { info() {}, warn() {} }
    });
    await linkedReminderWatchdog.tick();
    assert.equal(linkedMessages.length, 1);
    assert.equal(linkedMessages[0].messageType, "template_card");
    const linkedCard = linkedMessages[0].templateCard;
    assert.equal(linkedCard.button_selection, undefined);
    assert.equal(linkedCard.source.desc, "NEW · EA盯梢");
    assert.equal(linkedCard.source.desc_color, 2);
    assert.equal(linkedCard.card_action.type, 1);
    assert.match(linkedCard.card_action.url, /^https:\/\/open\.weixin\.qq\.com\/connect\/oauth2\/authorize/);
    assert.deepEqual(linkedCard.button_list, [
      { text: "收到", key: "ea_watch_card_received", style: 1 }
    ]);
    assert.equal(linkedCard.jump_list, undefined);
    const linkedDetail = linkedCard.horizontal_content_list.find((item) => item.keyname === "详情");
    assert.equal(linkedDetail.value, "查看反馈记录");
    assert.equal(linkedDetail.type, 1);
    assert.equal(linkedDetail.url, linkedCard.card_action.url);
    const feedbackAuthorizeUrl = new URL(linkedDetail.url);
    assert.equal(feedbackAuthorizeUrl.origin, "https://open.weixin.qq.com");
    assert.equal(feedbackAuthorizeUrl.pathname, "/connect/oauth2/authorize");
    assert.equal(feedbackAuthorizeUrl.searchParams.get("appid"), corpId);
    assert.equal(feedbackAuthorizeUrl.searchParams.get("agentid"), "1000011");
    assert.equal(feedbackAuthorizeUrl.searchParams.get("scope"), "snsapi_base");
    assert.equal(feedbackAuthorizeUrl.hash, "#wechat_redirect");
    const feedbackCallbackUrl = new URL(feedbackAuthorizeUrl.searchParams.get("redirect_uri"));
    assert.equal(feedbackCallbackUrl.toString(), "https://ea.example.com/demand-h5-auth");
    const feedbackReturnPath = verifyDemandH5State(
      feedbackAuthorizeUrl.searchParams.get("state"),
      feedbackSecret,
      { audience: "wecom_h5", normalizeReturnPath: (value) => String(value || "") }
    );
    const feedbackCardUrl = new URL(feedbackReturnPath, "https://ea.example.com");
    assert.equal(feedbackCardUrl.pathname, "/watchdog-feedback.html");
    assert.equal(feedbackCardUrl.searchParams.has("taskId"), false);
    assert.equal(feedbackCardUrl.searchParams.has("token"), false);
    assert.equal(feedbackCardUrl.searchParams.get("ref"), appFeedbackRefForTaskId("wd_linked_reminder"));
    assert.equal(feedbackCardUrl.hash, "");
    assert.equal(linkedDetail.url.includes("wd_linked_reminder"), false);
    assert.equal(linkedDetail.url.includes("legacy-feedback-token"), false);
    assert.equal(linkedCard.horizontal_content_list.some((item) => item.keyname === "当前情况说明"), false);
    const feedbackPageScript = fs.readFileSync(path.join(__dirname, "..", "src", "admin", "static", "watchdog-feedback.js"), "utf8");
    const feedbackPageHtml = fs.readFileSync(path.join(__dirname, "..", "src", "admin", "static", "watchdog-feedback.html"), "utf8");
    assert.match(feedbackPageScript, /window\.location\.hash/);
    assert.match(feedbackPageScript, /query\.get\("ref"\)/);
    assert.match(feedbackPageScript, /\/api\/dev-progress\/h5-session/);
    assert.match(feedbackPageScript, /\/demand-h5-auth\?returnTo=/);
    assert.match(feedbackPageScript, /renderFeedbackHistory/);
    assert.match(feedbackPageHtml, /id="feedbackHistoryList"/);
    assert.match(feedbackPageHtml, /历史反馈记录/);

    const signedFeedbackView = linkedReminderWatchdog.getAppFeedbackTask({
      ref: feedbackCardUrl.searchParams.get("ref"),
      assigneeUserId: "assignee"
    });
    assert.equal(signedFeedbackView.ok, true);
    assert.equal(signedFeedbackView.task.id, "wd_linked_reminder");
    const secondSignedFeedbackView = linkedReminderWatchdog.getAppFeedbackTask({
      ref: appFeedbackRefForTaskId("wd_linked_reminder_2"),
      assigneeUserId: "assignee"
    });
    assert.equal(secondSignedFeedbackView.ok, true);
    assert.equal(secondSignedFeedbackView.task.id, "wd_linked_reminder_2");
    assert.deepEqual(
      secondSignedFeedbackView.task.feedbackHistory.map((item) => item.label),
      ["需要延期", "正常推进", "收到"]
    );
    assert.equal(secondSignedFeedbackView.task.feedbackHistory[0].note, "等待测试环境");
    assert.equal(secondSignedFeedbackView.task.feedbackHistory[1].note, "已完成第一阶段");
    assert.equal(secondSignedFeedbackView.task.lastFeedback.label, "需要延期");
    assert.equal(Object.hasOwn(secondSignedFeedbackView.task.feedbackHistory[0], "senderUserId"), false);
    const foreignFeedbackView = linkedReminderWatchdog.getAppFeedbackTask({
      ref: feedbackCardUrl.searchParams.get("ref"),
      assigneeUserId: "other-user"
    });
    assert.equal(foreignFeedbackView.ok, false);
    assert.equal(foreignFeedbackView.statusCode, 403);

    const feedbackView = linkedReminderWatchdog.getAppFeedbackTask({
      taskId: "wd_linked_reminder",
      token: "legacy-feedback-token"
    });
    assert.equal(feedbackView.ok, true);
    const completedFeedback = await linkedReminderWatchdog.submitAppFeedback({
      ref: appFeedbackRefForTaskId("wd_linked_completed"),
      assigneeUserId: "assignee",
      action: "done",
      note: ""
    });
    assert.equal(completedFeedback.ok, false);
    assert.match(completedFeedback.message, /不能重复反馈/);
    const overlong = await linkedReminderWatchdog.submitAppFeedback({
      taskId: "wd_linked_reminder",
      token: "legacy-feedback-token",
      action: "progress",
      note: "进".repeat(501)
    });
    assert.equal(overlong.ok, false);
    assert.match(overlong.message, /不能超过 500 字/);
    assert.equal(taskById(linkedReminderStoreFile, "wd_linked_reminder").responses.length, 0);

    const feedback = await linkedReminderWatchdog.submitAppFeedback({
      taskId: "wd_linked_reminder",
      token: "legacy-feedback-token",
      action: "progress",
      note: "联调完成，正在观察运行情况"
    });
    assert.equal(feedback.ok, true);
    const linkedTask = taskById(linkedReminderStoreFile, "wd_linked_reminder");
    assert.equal(linkedTask.responses.length, 1);
    assert.equal(linkedTask.responses[0].note, "联调完成，正在观察运行情况");
    assert.equal(linkedTask.lastFeedbackNote, "联调完成，正在观察运行情况");
    assert.equal(feedback.task.feedbackHistory[0].label, "正常推进");
    assert.equal(feedback.task.feedbackHistory[0].note, "联调完成，正在观察运行情况");
    assert.ok(linkedMessages.some((message) => (
      message.purpose === "watchdog_result_notice"
      && /说明：联调完成，正在观察运行情况/.test(message.text)
    )));

    const expiredControlStoreFile = path.join(directory, "expired-control-tasks.json");
    fs.writeFileSync(expiredControlStoreFile, `${JSON.stringify({
      tasks: [fixture("wd_expired_control", {
        mode: "once",
        dueAt: "2026-08-14T04:00:00.000Z",
        nextRunAt: "",
        firstReminderSentAt: "2026-08-14T04:00:00.000Z",
        oneTimeReminderSentAt: "2026-08-14T04:00:00.000Z",
        controlCardRetryAt: "2026-08-14T04:01:00.000Z"
      })],
      drafts: []
    }, null, 2)}\n`, "utf8");
    let expiredControlCardSendCount = 0;
    const expiredControlWatchdog = createWatchdogModule({
      storeFile: expiredControlStoreFile,
      moduleConfig: { enabled: true, appPush: { enabled: false }, sendQueue: { minIntervalMs: 1 } },
      logger: { info() {}, warn() {} }
    });
    expiredControlWatchdog.setRobotServer({
      sendTemplateCardMessage: async () => {
        expiredControlCardSendCount += 1;
        return { errcode: 0 };
      }
    });
    await expiredControlWatchdog.tick();
    assert.equal(expiredControlCardSendCount, 0);
    assert.equal(expiredControlWatchdog.getStatus().queuedControlCardCount, 0);
    expiredControlWatchdog.stop();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("WeCom app callback isolated test passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
