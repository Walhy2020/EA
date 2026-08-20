"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { createWatchdogModule } = require("../src/modules/watchdog/watchdogModule");
const { createWecomAppCallback } = require("../src/notification/wecomAppCallback");

const callbackToken = "callback-test-token";
const callbackAesKey = Buffer.alloc(32, 7).toString("base64").replace(/=$/, "");
const corpId = "test-corp-id";
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

function eventXml({ taskId, eventKey, userId = "assignee" }) {
  return [
    "<xml>",
    `<ToUserName><![CDATA[${corpId}]]></ToUserName>`,
    `<FromUserName><![CDATA[${userId}]]></FromUserName>`,
    "<MsgType><![CDATA[event]]></MsgType>",
    "<Event><![CDATA[template_card_event]]></Event>",
    `<EventKey><![CDATA[${eventKey}]]></EventKey>`,
    `<TaskId><![CDATA[${taskId}]]></TaskId>`,
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

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ea-wecom-app-callback-"));
  const storeFile = path.join(directory, "watchdog-tasks.json");
  const tasks = [
    fixture("wd_active"),
    fixture("wd_completed", { status: "completed", nextRunAt: "" }),
    fixture("wd_once", { mode: "once", dueAt: "2026-08-14T07:00:00.000Z" }),
    fixture("wd_initial")
  ];
  fs.writeFileSync(storeFile, `${JSON.stringify({ tasks, drafts: [] }, null, 2)}\n`, "utf8");

  let robotMessageCount = 0;
  let appMessageCount = 0;
  let cardUpdateCount = 0;
  const appNotifier = {
    getStatus: () => ({ configured: true, nativeCard: { ready: true } }),
    send: async () => {
      appMessageCount += 1;
      return { ok: true, msgid: "isolated" };
    },
    updateTemplateCard: async () => {
      cardUpdateCount += 1;
      return { ok: true };
    }
  };
  const watchdog = createWatchdogModule({
    storeFile,
    moduleConfig: {
      enabled: true,
      appPush: { enabled: true, nativeCard: { enabled: true } }
    },
    appNotifier,
    logger: { info() {}, warn() {} }
  });
  watchdog.setRobotServer({
    sendMarkdownMessage: async () => {
      robotMessageCount += 1;
      return { errcode: 0 };
    }
  });
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
    logger: { info() {}, warn() {} }
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

    const progress = await sendEvent({ taskId: "ea_watch_wd_active_3", eventKey: "ea_watch_progress" });
    assert.equal(progress.statusCode, 200);
    assert.equal(taskById(storeFile, "wd_active").responses.length, 1);
    assert.equal(taskById(storeFile, "wd_active").responses[0].source, "wecom-app-native");

    const duplicate = await sendEvent({ taskId: "ea_watch_wd_active_3", eventKey: "ea_watch_progress" });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(taskById(storeFile, "wd_active").responses.length, 1);

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
    assert.ok(appMessageCount >= 3);
    assert.ok(cardUpdateCount >= 7);

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
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("WeCom app callback isolated test passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
