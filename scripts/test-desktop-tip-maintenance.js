"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAdminServer } = require("../src/admin/adminServer");
const {
  COOKIE_NAME,
  createDemandH5Session
} = require("../src/admin/demandH5Session");
const { createDesktopTipModule } = require("../src/modules/desktopTip/desktopTipModule");
const { createMarkdownMessagePayload, senderFromFrame } = require("../src/robot/wecomBotServer");

function tempFile(root, name) {
  return path.join(root, name);
}

function minutesFrom(base, minutes) {
  return new Date(base.getTime() + minutes * 60 * 1000).toISOString();
}

function createModule(root, overrides = {}) {
  const logger = {
    info(message, meta) {
      if (Array.isArray(overrides.logs)) overrides.logs.push({ level: "info", message, meta });
    },
    warn(message, meta) {
      if (Array.isArray(overrides.logs)) overrides.logs.push({ level: "warn", message, meta });
    },
    error(message, meta) {
      if (Array.isArray(overrides.logs)) overrides.logs.push({ level: "error", message, meta });
    }
  };
  const productionMaintenance = {
    enabled: true,
    storePath: tempFile(root, "maintenance.json"),
    messageAdmins: ["admin_user"],
    authorizedSenders: ["sender_user"],
    sendPermissionMode: "all_signed_in",
    recipientUsers: ["receiver_a", "receiver_b"],
    recipientGroups: {
      formal_ops: ["receiver_a", "receiver_b"]
    },
    defaultRecipientGroupId: "formal_ops",
    countdownMinutes: [30, 10, 5, 1],
    maxExtensionMinutes: 120,
    eventTtlMinutes: 240,
    schedulerIntervalSeconds: 5,
    deliveryChannels: ["desktop_tip"],
    ...(overrides.productionMaintenance || {})
  };
  return createDesktopTipModule({
    logger,
    disableMaintenanceScheduler: true,
    moduleConfig: {
      enabled: true,
      name: "EA 桌面提醒",
      version: "0.4.2",
      storePath: tempFile(root, "events.json"),
      ttlMinutes: 240,
      clientRegistry: {
        storePath: tempFile(root, "clients.json"),
        persistIntervalSeconds: overrides.persistIntervalSeconds || 3600,
        maxRegisteredClients: 1000
      },
      wecomGroupRegistry: {
        storePath: tempFile(root, "wecom-groups.json"),
        maxGroups: 50
      },
      productionMaintenance,
      ...(overrides.moduleConfig || {})
    }
  });
}

function assertThrowsStatus(fn, statusCode, message) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, message || "expected function to throw");
  assert.equal(thrown.statusCode, statusCode);
}

function pollDevice(module, clientId, clientVersion, userId) {
  return module.listTips({
    clientId,
    clientVersion,
    targetUserId: userId || ""
  }).events;
}

function pollUser(module, userId, clientId, clientVersion) {
  return module.listTips({
    targetUserId: userId,
    clientId: clientId || `client_${userId}`,
    clientVersion
  }).events;
}

function sendHistoryCount(item) {
  return Array.isArray(item.sendHistory) ? item.sendHistory.length : 0;
}

function signedCookie(userId, name, secret) {
  const session = createDemandH5Session({ userId, name }, secret);
  return `${COOKIE_NAME}=${encodeURIComponent(session.token)}`;
}

async function requestJson(baseUrl, method, pathname, body, cookie, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = {};
  try {
    data = await response.json();
  } catch (_) {
    data = {};
  }
  return {
    status: response.status,
    data
  };
}

async function runApiPermissionTests() {
  const previousSecret = process.env.WECOM_DOC_SECRET;
  process.env.WECOM_DOC_SECRET = "desktop-tip-session-test-secret";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-desktop-tip-maintenance-api-"));
  const desktopTip = createModule(root, {
    productionMaintenance: {
      recipientUsers: [],
      recipientGroups: {},
      defaultRecipientGroupId: "",
      defaultRecipientScope: "all_registered_clients"
    }
  });
  pollDevice(desktopTip, "api_client_a", "0.3.0");
  const logger = { info() {}, warn() {}, error() {} };
  const adminServer = createAdminServer({
    config: {
      app: {
        server: { host: "127.0.0.1", port: 0, https: { enabled: false } },
        runtime: { logLevel: "info" },
        security: { showSecretsInAdmin: false }
      },
      modules: { modules: {}, monitors: {}, notification: {} },
      routes: {}
    },
    router: { handleMessage: async () => ({ ok: true }) },
    modules: { desktopTip },
    robotServer: {},
    robotDiagnostics: {},
    monitorManager: { getStatus: () => ({}) },
    notificationCenter: { getStatus: () => ({}) },
    wecomAppCallback: null,
    logger
  });
  const server = adminServer.start();
  if (!server.listening) {
    await new Promise((resolve) => server.once("listening", resolve));
  }
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const now = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const createPayload = {
    operatorUserId: "sender_user",
    createdBy: "sender_user",
    title: "API 权限测试",
    serverName: "正式服 API 权限",
    scheduledStopAt: minutesFrom(now, 40),
    expectedResumeAt: minutesFrom(now, 100),
    recipientScope: "all_registered_clients"
  };

  try {
    let response = await requestJson(baseUrl, "POST", "/api/desktop-tip/maintenance/events", createPayload);
    assert.equal(response.status, 401, "maintenance create without signed session must return 401");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/test", {
      operatorUserId: "admin_user",
      targetUserId: "receiver_a"
    });
    assert.equal(response.status, 401, "desktop-tip test without signed session must return 401");

    const receiverCookie = signedCookie("receiver_a", "Receiver A", process.env.WECOM_DOC_SECRET);
    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/maintenance/events", {
      ...createPayload,
      operatorUserId: "sender_user",
      createdBy: "sender_user",
      serverName: "正式服 API 伪造身份"
    }, receiverCookie, { "x-ea-operator-userid": "admin_user" });
    assert.equal(response.status, 200, "any signed-in user can create in all_signed_in mode");
    assert.equal(response.data.maintenance.createdBy, "receiver_a", "forged body/header operator must be ignored");
    assert.equal(response.data.maintenance.recipientType, "client");
    assert.equal(response.data.maintenance.recipients.length, 1);

    const senderCookie = signedCookie("sender_user", "Sender User", process.env.WECOM_DOC_SECRET);
    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/maintenance/config", {
      operatorUserId: "admin_user",
      config: { countdownMinutes: [20, 5] }
    }, senderCookie);
    assert.equal(response.status, 403, "sender must not modify source permission config");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/test", {
      operatorUserId: "admin_user",
      targetUserId: "receiver_a"
    }, senderCookie);
    assert.equal(response.status, 403, "sender must not send anonymous/manual test tip");

    response = await requestJson(baseUrl, "GET", "/api/desktop-tip/maintenance/events?operatorUserId=admin_user", undefined, receiverCookie);
    assert.equal(response.status, 200, "any signed-in user can list maintenance events in all_signed_in mode");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/maintenance/events", {
      ...createPayload,
      serverName: "正式服 API 权限 2"
    }, senderCookie);
    assert.equal(response.status, 200, "authorized signed sender can create maintenance event");
    const maintenanceId = response.data.maintenance.maintenanceId;
    assert.ok(maintenanceId);

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/maintenance/events", {
      ...createPayload,
      serverName: "正式服 API 权限 2",
      title: "API conflict status test"
    }, senderCookie);
    assert.equal(response.status, 409, "duplicate active server maintenance must preserve HTTP 409");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/maintenance/stop", {
      operatorUserId: "admin_user",
      maintenanceId
    }, senderCookie);
    assert.equal(response.status, 200, "authorized signed sender can advance maintenance event");
    assert.equal(response.data.maintenance.status, "stopped");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/maintenance/complete", {
      operatorUserId: "admin_user",
      maintenanceId
    }, receiverCookie);
    assert.equal(response.status, 200, "any signed-in user can complete in all_signed_in mode");
    assert.equal(response.data.maintenance.completedBy, "receiver_a", "complete operator must come from signed session");
  } finally {
    adminServer.stop();
    desktopTip.stop();
    if (previousSecret === undefined) {
      delete process.env.WECOM_DOC_SECRET;
    } else {
      process.env.WECOM_DOC_SECRET = previousSecret;
    }
  }
}

async function runManualMessageApiTests() {
  const previousSecret = process.env.WECOM_DOC_SECRET;
  process.env.WECOM_DOC_SECRET = "desktop-tip-manual-message-secret";
  const logger = { info() {}, warn() {}, error() {} };
  const createServer = (desktopTip, robotServer = {}) => createAdminServer({
    config: {
      app: {
        server: { host: "127.0.0.1", port: 0, https: { enabled: false } },
        runtime: { logLevel: "info" },
        security: { showSecretsInAdmin: false }
      },
      modules: { modules: {}, monitors: {}, notification: {} },
      routes: {}
    },
    router: { handleMessage: async () => ({ ok: true }) },
    modules: { desktopTip },
    robotServer,
    robotDiagnostics: {},
    monitorManager: { getStatus: () => ({}) },
    notificationCenter: { getStatus: () => ({}) },
    wecomAppCallback: null,
    logger
  });
  const ordinaryCookie = signedCookie("ordinary_user", "Ordinary User", process.env.WECOM_DOC_SECRET);

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ea-desktop-tip-manual-empty-"));
  const emptyDesktopTip = createModule(emptyRoot);
  const emptyAdminServer = createServer(emptyDesktopTip);
  const emptyServer = emptyAdminServer.start();
  if (!emptyServer.listening) {
    await new Promise((resolve) => emptyServer.once("listening", resolve));
  }
  const emptyBaseUrl = `http://127.0.0.1:${emptyServer.address().port}`;

  try {
    let response = await requestJson(emptyBaseUrl, "POST", "/api/desktop-tip/manual-message", {
      title: "EA desktop tip test",
      body: "manual message"
    });
    assert.equal(response.status, 401, "manual message without signed session must return 401");

    response = await requestJson(emptyBaseUrl, "POST", "/api/desktop-tip/manual-message", {
      title: "EA desktop tip test",
      body: "manual message"
    }, ordinaryCookie);
    assert.equal(response.status, 409, "manual message must reject zero registered desktop clients");

    const emptyBind = emptyDesktopTip.captureWecomGroupBindingMessage({
      text: "@1号机器人 绑定M04通知群 空客户端群",
      sender: { chatType: "group", chatId: "chat_empty", userId: "ordinary_user", name: "Ordinary User" }
    });
    assert.equal(emptyBind.ok, true);
    response = await requestJson(emptyBaseUrl, "POST", "/api/desktop-tip/manual-message", {
      title: "EA desktop tip test",
      body: "manual message",
      wecomGroups: {
        enabled: true,
        targets: [{ groupId: emptyBind.group.groupId, mentionMode: "all" }]
      }
    }, ordinaryCookie);
    assert.equal(response.status, 409, "zero desktop clients must reject before optional group notification");
  } finally {
    emptyAdminServer.stop();
    emptyDesktopTip.stop();
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-desktop-tip-manual-api-"));
  const desktopTip = createModule(root);
  pollDevice(desktopTip, "manual_client_a", "0.3.0");
  pollDevice(desktopTip, "manual_client_b", "0.3.0");
  const groupSends = [];
  const failedChatIds = new Set();
  const robotServer = {
    sendMarkdownMessage: async (chatId, content, options = {}) => {
      groupSends.push({ chatId, content, options });
      if (failedChatIds.has(chatId)) {
        throw new Error(`mock group failed ${chatId}`);
      }
      return { errcode: 0 };
    }
  };
  const adminServer = createServer(desktopTip, robotServer);
  const server = adminServer.start();
  if (!server.listening) {
    await new Promise((resolve) => server.once("listening", resolve));
  }
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    let response = await requestJson(baseUrl, "POST", "/api/desktop-tip/manual-message", {
      title: "",
      body: "body"
    }, ordinaryCookie);
    assert.equal(response.status, 400, "manual empty title must return 400");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/manual-message", {
      title: "title",
      body: ""
    }, ordinaryCookie);
    assert.equal(response.status, 400, "manual empty body must return 400");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/manual-message", {
      title: "t".repeat(81),
      body: "body"
    }, ordinaryCookie);
    assert.equal(response.status, 400, "manual title over max length must return 400");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/manual-message", {
      title: "title",
      body: "b".repeat(1001)
    }, ordinaryCookie);
    assert.equal(response.status, 400, "manual body over max length must return 400");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/manual-message", {
      title: "title",
      body: "body",
      clientIds: ["manual_client_a"]
    }, ordinaryCookie);
    assert.equal(response.status, 400, "manual body must not accept caller-specified clientIds");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/manual-message", {
      operatorUserId: "admin_user",
      title: "EA desktop tip test",
      body: "manual message body"
    }, ordinaryCookie, { "x-ea-operator-userid": "admin_user" });
    assert.equal(response.status, 200, "any signed-in ordinary user can send manual desktop message");
    assert.equal(response.data.operator.userId, "ordinary_user", "manual operator must come from signed session");
    assert.equal(response.data.sourceKey, "admin_manual_message");
    assert.equal(response.data.recipientCount, 2);
    assert.equal(response.data.queuedCount, 2);
    assert.equal(response.data.failedCount, 0);
    assert.equal(response.data.wecomGroups.enabled, false, "group notification must be disabled by default");
    assert.equal(groupSends.length, 0, "default manual desktop message must not send WeCom group notification");

    const clientAEvents = pollDevice(desktopTip, "manual_client_a", "0.3.0");
    const clientBEvents = pollDevice(desktopTip, "manual_client_b", "0.3.0");
    const manualA = clientAEvents.filter((event) => event.meta && event.meta.sourceKey === "admin_manual_message");
    const manualB = clientBEvents.filter((event) => event.meta && event.meta.sourceKey === "admin_manual_message");
    assert.equal(manualA.length, 1, "client A must receive one manual message");
    assert.equal(manualB.length, 1, "client B must receive one manual message");
    assert.notEqual(manualA[0].id, manualB[0].id, "each client must get an isolated event");
    assert.equal(manualA[0].targetClientId, "manual_client_a");
    assert.equal(manualB[0].targetClientId, "manual_client_b");
    assertThrowsStatus(() => desktopTip.ackTip({
      eventId: manualA[0].id,
      clientId: "manual_client_b",
      action: "dismissed"
    }), 401, "client B must not ack client A manual message");
    assert.equal(desktopTip.ackTip({
      eventId: manualA[0].id,
      clientId: "manual_client_a",
      action: "dismissed"
    }).ok, true);
    assert.equal(pollDevice(desktopTip, "manual_client_a", "0.3.0").some((event) => event.id === manualA[0].id), false, "acked manual message must not show again");

    assert.equal(fs.existsSync(tempFile(root, "maintenance.json")), false, "manual message must not write production maintenance store");

    const bindA = desktopTip.captureWecomGroupBindingMessage({
      text: "@1号机器人 绑定M04通知群 正式服通知群A",
      sender: { chatType: "group", chatId: "chat_group_a", userId: "ordinary_user", name: "Ordinary User" }
    });
    const bindB = desktopTip.captureWecomGroupBindingMessage({
      text: "@1号机器人 绑定M04通知群 正式服通知群B",
      sender: { chatType: "group", chatId: "chat_group_b", userId: "ordinary_user", name: "Ordinary User" }
    });
    assert.equal(bindA.ok, true);
    assert.equal(bindB.ok, true);

    const beforeInvalidGroupEvents = pollDevice(desktopTip, "manual_client_a", "0.3.0").length;
    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/manual-message", {
      title: "EA desktop tip test",
      body: "manual message body",
      wecomGroups: { enabled: true, targets: [] }
    }, ordinaryCookie);
    assert.equal(response.status, 400, "checked group notification without target must return 400");
    assert.equal(pollDevice(desktopTip, "manual_client_a", "0.3.0").length, beforeInvalidGroupEvents, "invalid group selection must not queue desktop event");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/manual-message", {
      title: "EA desktop tip group test",
      body: "manual message body",
      operatorUserId: "forged_user",
      wecomGroups: {
        enabled: true,
        targets: [{ groupId: bindA.group.groupId, mentionMode: "all" }]
      }
    }, ordinaryCookie, { "x-ea-operator-userid": "forged_user" });
    assert.equal(response.status, 200, "signed user can send optional group notification");
    assert.equal(response.data.operator.userId, "ordinary_user", "group notification operator must still come from signed session");
    assert.equal(response.data.queuedCount, 2, "desktop delivery must still queue for both clients");
    assert.equal(response.data.wecomGroups.successCount, 1);
    assert.equal(response.data.wecomGroups.failedCount, 0);
    assert.equal(groupSends[groupSends.length - 1].chatId, "chat_group_a");
    assert.equal(groupSends[groupSends.length - 1].options.mentionAll, true, "@all mode must be passed to robot sender");
    assert.match(groupSends[groupSends.length - 1].content, /@所有人/, "@all message content must be clear");

    failedChatIds.add("chat_group_b");
    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/manual-message", {
      title: "EA desktop tip group partial test",
      body: "manual message body",
      wecomGroups: {
        enabled: true,
        targets: [
          { groupId: bindA.group.groupId, mentionMode: "none" },
          { groupId: bindB.group.groupId, mentionMode: "none" }
        ]
      }
    }, ordinaryCookie);
    assert.equal(response.status, 200, "partial group failure must not roll back desktop delivery");
    assert.equal(response.data.queuedCount, 2);
    assert.equal(response.data.wecomGroups.requestedCount, 2);
    assert.equal(response.data.wecomGroups.successCount, 1);
    assert.equal(response.data.wecomGroups.failedCount, 1);
    assert.ok(response.data.wecomGroups.results.some((item) => !item.ok && /mock group failed/.test(item.message)), "failed group reason must be returned");

    const watchdogEvent = desktopTip.createTip({
      source: "watchdog",
      targetUserId: "watchdog_manual_user",
      title: "watchdog compatibility"
    }).event;
    assert.equal(pollUser(desktopTip, "watchdog_manual_user", "watchdog_manual_client", "0.3.0").some((event) => event.id === watchdogEvent.id), true, "watchdog userId path must remain compatible after manual message");
  } finally {
    adminServer.stop();
    desktopTip.stop();
    if (previousSecret === undefined) {
      delete process.env.WECOM_DOC_SECRET;
    } else {
      process.env.WECOM_DOC_SECRET = previousSecret;
    }
  }
}

async function runClientManualMessageApiTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-desktop-tip-client-manual-api-"));
  const logs = [];
  const desktopTip = createModule(root, { logs });
  const groupSends = [];
  const failedChatIds = new Set();
  const robotServer = {
    sendMarkdownMessage: async (chatId, content, options = {}) => {
      groupSends.push({ chatId, content, options });
      if (failedChatIds.has(chatId)) {
        throw new Error(`mock group failed ${chatId}`);
      }
      return { errcode: 0 };
    }
  };
  const logger = { info() {}, warn() {}, error() {} };
  const adminServer = createAdminServer({
    config: {
      app: {
        server: { host: "127.0.0.1", port: 0, https: { enabled: false } },
        runtime: { logLevel: "info" },
        security: { showSecretsInAdmin: false }
      },
      modules: { modules: {}, monitors: {}, notification: {} },
      routes: {}
    },
    router: { handleMessage: async () => ({ ok: true }) },
    modules: { desktopTip },
    robotServer,
    robotDiagnostics: {},
    monitorManager: { getStatus: () => ({}) },
    notificationCenter: { getStatus: () => ({}) },
    wecomAppCallback: null,
    logger
  });
  const server = adminServer.start();
  if (!server.listening) {
    await new Promise((resolve) => server.once("listening", resolve));
  }
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    let response = await requestJson(baseUrl, "GET", "/api/desktop-tip/client-send/options");
    assert.equal(response.status, 401, "client send options without clientId must return 401");

    response = await requestJson(baseUrl, "GET", "/api/desktop-tip/client-send/options?clientId=missing_client");
    assert.equal(response.status, 403, "unregistered client must not read send options");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/client-send/manual-message", {
      clientId: "missing_client",
      title: "client send",
      body: "body"
    });
    assert.equal(response.status, 403, "unregistered client must not send");

    pollDevice(desktopTip, "client_sender_a", "0.4.0");
    pollDevice(desktopTip, "client_sender_b", "0.4.0");
    pollDevice(desktopTip, "client_sender_c", "0.4.0");

    response = await requestJson(baseUrl, "GET", "/api/desktop-tip/client-send/options?clientId=client_sender_a&clientVersion=0.4.0");
    assert.equal(response.status, 200, "registered client can read send options");
    assert.equal(response.data.registeredClientCount, 3);
    assert.equal(response.data.limits.rateLimitSeconds, 60);

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/client-send/manual-message", {
      clientId: "client_sender_a",
      title: "",
      body: "body"
    });
    assert.equal(response.status, 400, "client send empty title must return 400");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/client-send/manual-message", {
      clientId: "client_sender_a",
      title: "title",
      body: ""
    });
    assert.equal(response.status, 400, "client send empty body must return 400");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/client-send/manual-message", {
      clientId: "client_sender_a",
      title: "t".repeat(81),
      body: "body"
    });
    assert.equal(response.status, 400, "client send title max must be enforced");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/client-send/manual-message", {
      clientId: "client_sender_a",
      title: "title",
      body: "b".repeat(1001)
    });
    assert.equal(response.status, 400, "client send body max must be enforced");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/client-send/manual-message", {
      clientId: "client_sender_a",
      title: "title",
      body: "body",
      operatorUserId: "forged_operator"
    });
    assert.equal(response.status, 400, "client send must reject forged operator");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/client-send/manual-message", {
      clientId: "client_sender_a",
      title: "title",
      body: "body",
      targetClientId: "client_sender_b"
    });
    assert.equal(response.status, 400, "client send must reject caller-specified targetClientId");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/client-send/manual-message", {
      clientId: "client_sender_a",
      title: "title",
      body: "body",
      wecomGroups: {
        enabled: true,
        targets: [{ groupId: "g1", chatId: "chat_a", mentionMode: "all" }]
      }
    });
    assert.equal(response.status, 400, "client send must reject nested chatId");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/client-send/manual-message", {
      clientId: "client_sender_a",
      clientVersion: "0.4.0",
      title: "Client desktop message",
      body: "client body",
      wecomGroups: { enabled: false, targets: [] }
    });
    assert.equal(response.status, 200, "registered client can send desktop notification");
    assert.equal(response.data.sourceKey, "client_manual_message");
    assert.equal(response.data.recipientCount, 3);
    assert.equal(response.data.queuedCount, 3);
    assert.equal(response.data.wecomGroups.enabled, false);
    assert.equal(response.data.sender.source, "registered_desktop_client");
    assert.equal(groupSends.length, 0, "desktop-only client send must not send group notification");

    const senderAEvents = pollDevice(desktopTip, "client_sender_a", "0.4.0");
    const senderBEvents = pollDevice(desktopTip, "client_sender_b", "0.4.0");
    assert.equal(senderAEvents.filter((event) => event.meta && event.meta.sourceKey === "client_manual_message").length, 1, "sender A must receive client message as a registered device");
    assert.equal(senderBEvents.filter((event) => event.meta && event.meta.sourceKey === "client_manual_message").length, 1, "sender B must receive isolated client message");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/client-send/manual-message", {
      clientId: "client_sender_a",
      title: "duplicate",
      body: "duplicate"
    });
    assert.equal(response.status, 429, "client send duplicate click must be rate limited");

    const bindA = desktopTip.captureWecomGroupBindingMessage({
      text: "@1号机器人 绑定M04通知群 客户端群A",
      sender: { chatType: "group", chatId: "client_chat_group_a", userId: "ordinary_user", name: "Ordinary User" }
    });
    const bindB = desktopTip.captureWecomGroupBindingMessage({
      text: "@1号机器人 绑定M04通知群 客户端群B",
      sender: { chatType: "group", chatId: "client_chat_group_b", userId: "ordinary_user", name: "Ordinary User" }
    });
    assert.equal(bindA.ok, true);
    assert.equal(bindB.ok, true);

    response = await requestJson(baseUrl, "GET", "/api/desktop-tip/client-send/options?clientId=client_sender_b");
    assert.equal(response.status, 200);
    assert.equal(response.data.wecomGroups.groupCount, 2);
    assert.ok(response.data.wecomGroups.groups.every((group) => !Object.prototype.hasOwnProperty.call(group, "chatId")), "client options must not expose chatId");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/client-send/manual-message", {
      clientId: "client_sender_b",
      title: "group missing target",
      body: "body",
      wecomGroups: { enabled: true, targets: [] }
    });
    assert.equal(response.status, 400, "checked group notification without selected group must return 400");

    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/client-send/manual-message", {
      clientId: "client_sender_b",
      title: "group all",
      body: "body",
      wecomGroups: {
        enabled: true,
        targets: [{ groupId: bindA.group.groupId, mentionMode: "all" }]
      }
    });
    assert.equal(response.status, 200, "registered client can send optional @all group notification");
    assert.equal(response.data.queuedCount, 3, "desktop delivery must still queue before group send");
    assert.equal(response.data.wecomGroups.successCount, 1);
    assert.equal(groupSends[groupSends.length - 1].chatId, "client_chat_group_a");
    assert.equal(groupSends[groupSends.length - 1].options.mentionAll, true, "@all option must reach robot sender");
    assert.match(groupSends[groupSends.length - 1].content, /@所有人/, "@all content must be in final markdown payload");

    failedChatIds.add("client_chat_group_b");
    response = await requestJson(baseUrl, "POST", "/api/desktop-tip/client-send/manual-message", {
      clientId: "client_sender_c",
      title: "partial group",
      body: "body",
      wecomGroups: {
        enabled: true,
        targets: [
          { groupId: bindA.group.groupId, mentionMode: "none" },
          { groupId: bindB.group.groupId, mentionMode: "none" }
        ]
      }
    });
    assert.equal(response.status, 200, "partial group failure must not roll back client desktop delivery");
    assert.equal(response.data.queuedCount, 3);
    assert.equal(response.data.wecomGroups.requestedCount, 2);
    assert.equal(response.data.wecomGroups.successCount, 1);
    assert.equal(response.data.wecomGroups.failedCount, 1);
    assert.ok(response.data.wecomGroups.results.some((item) => !item.ok && /mock group failed/.test(item.message)), "client send failed group reason must be returned");

    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ea-desktop-tip-client-manual-empty-"));
    const emptyDesktopTip = createModule(emptyRoot);
    const emptyAdminServer = createAdminServer({
      config: {
        app: {
          server: { host: "127.0.0.1", port: 0, https: { enabled: false } },
          runtime: { logLevel: "info" },
          security: { showSecretsInAdmin: false }
        },
        modules: { modules: {}, monitors: {}, notification: {} },
        routes: {}
      },
      router: { handleMessage: async () => ({ ok: true }) },
      modules: { desktopTip: emptyDesktopTip },
      robotServer,
      robotDiagnostics: {},
      monitorManager: { getStatus: () => ({}) },
      notificationCenter: { getStatus: () => ({}) },
      wecomAppCallback: null,
      logger
    });
    const emptyServer = emptyAdminServer.start();
    if (!emptyServer.listening) {
      await new Promise((resolve) => emptyServer.once("listening", resolve));
    }
    const emptyBaseUrl = `http://127.0.0.1:${emptyServer.address().port}`;
    try {
      response = await requestJson(emptyBaseUrl, "POST", "/api/desktop-tip/client-send/manual-message", {
        clientId: "never_registered",
        title: "empty",
        body: "empty"
      });
      assert.equal(response.status, 403, "zero registered clients and unregistered sender must reject");
    } finally {
      emptyAdminServer.stop();
      emptyDesktopTip.stop();
    }
  } finally {
    adminServer.stop();
    desktopTip.stop();
  }
}

function runClientRegistryTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-desktop-tip-clients-"));
  const logs = [];
  let module = createModule(root, {
    logs,
    productionMaintenance: {
      recipientUsers: [],
      recipientGroups: {},
      defaultRecipientGroupId: "",
      defaultRecipientScope: "all_registered_clients"
    }
  });

  let status = module.getStatus();
  assert.equal(status.clientRegistry.registeredUserCount, 0);
  assert.equal(status.clientRegistry.registeredClientCount, 0);
  assertThrowsStatus(() => module.listTips({}), 401, "missing userId and clientId must not read all events");
  assertThrowsStatus(() => module.maintenance.createMaintenance({
    operatorUserId: "any_signed_user",
    title: "无客户端拒绝",
    serverName: "正式服无客户端",
    scheduledStopAt: minutesFrom(new Date(Date.now() + 60 * 60 * 1000), 30),
    expectedResumeAt: minutesFrom(new Date(Date.now() + 60 * 60 * 1000), 90),
    recipientScope: "all_registered_clients"
  }), 400, "all registered recipient scope must reject empty registry");

  pollDevice(module, "install_a");
  status = module.getStatus();
  assert.equal(status.clientRegistry.registeredUserCount, 0, "no-login client must not require UserID");
  assert.equal(status.clientRegistry.registeredClientCount, 1);
  let registry = JSON.parse(fs.readFileSync(tempFile(root, "clients.json"), "utf8"));
  assert.equal(registry.clients[0].clientVersion, "unknown", "old client without version must register as unknown");
  assert.equal(registry.clients[0].clientId, "install_a");
  const firstPersisted = fs.readFileSync(tempFile(root, "clients.json"), "utf8");

  pollDevice(module, "install_a", "0.3.0");
  status = module.getStatus();
  assert.equal(status.clientRegistry.registeredClientCount, 1, "same client restart must not duplicate registration");
  const secondPersisted = fs.readFileSync(tempFile(root, "clients.json"), "utf8");
  assert.equal(secondPersisted, firstPersisted, "same client lastSeenAt must be throttled on disk");

  pollDevice(module, "install_b", "0.3.0");
  pollDevice(module, "install_legacy", "0.2.2", "receiver_legacy");
  status = module.getStatus();
  assert.equal(status.clientRegistry.registeredUserCount, 1, "old userId+clientId clients remain readable but are not required");
  assert.equal(status.clientRegistry.registeredClientCount, 3);

  const deviceEvent = module.createTip({
    source: "device-test",
    targetClientId: "install_a",
    recipientType: "client",
    title: "设备隔离"
  }).event;
  assert.equal(pollDevice(module, "install_a", "0.3.0").some((event) => event.id === deviceEvent.id), true);
  assert.equal(pollDevice(module, "install_b", "0.3.0").some((event) => event.id === deviceEvent.id), false, "another client must not read device event");
  assertThrowsStatus(() => module.ackTip({
    eventId: deviceEvent.id,
    clientId: "install_b",
    action: "dismissed"
  }), 401, "another client must not ack device event");

  const watchdogEvent = module.createTip({
    source: "watchdog",
    targetUserId: "watchdog_user",
    title: "盯梢兼容"
  }).event;
  assert.equal(pollDevice(module, "install_a", "0.3.0").some((event) => event.id === watchdogEvent.id), false, "client-only poll must not read legacy user event");
  assert.equal(pollUser(module, "watchdog_user", "watchdog_client", "0.3.0").some((event) => event.id === watchdogEvent.id), true, "watchdog userId path must remain compatible");

  module.stop();
  module = createModule(root, {
    productionMaintenance: {
      recipientUsers: [],
      recipientGroups: {},
      defaultRecipientGroupId: "",
      defaultRecipientScope: "all_registered_clients"
    }
  });
  status = module.getStatus();
  assert.equal(status.clientRegistry.registeredClientCount, 4, "registry must recover after restart, including watchdog polling client");

  const base = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const created = module.maintenance.createMaintenance({
    operatorUserId: "any_signed_user",
    title: "全部登记客户端投递",
    serverName: "正式服全设备登记",
    scheduledStopAt: minutesFrom(base, 30),
    expectedResumeAt: minutesFrom(base, 90),
    recipientScope: "all_registered_clients"
  });
  assert.equal(created.maintenance.recipientType, "client");
  assert.equal(created.maintenance.recipients.length, 4, "delivery must target each registered install");

  module.maintenance.runDue(new Date(base.getTime() + 26 * 60 * 1000));
  let installAEvents = pollDevice(module, "install_a", "0.3.0");
  let installBEvents = pollDevice(module, "install_b", "0.3.0");
  assert.equal(installAEvents.filter((event) => event.type === "maintenance_countdown").length, 1);
  assert.equal(installBEvents.filter((event) => event.type === "maintenance_countdown").length, 1);

  const stopped = module.maintenance.setStopped({
    operatorUserId: "another_signed_user",
    maintenanceId: created.maintenance.maintenanceId,
    idempotencyKey: "registry-stop"
  });
  assert.equal(stopped.maintenance.status, "stopped");
  installAEvents = pollDevice(module, "install_a", "0.3.0");
  const installAMaintenanceEvents = installAEvents.filter((event) => event.meta && event.meta.sourceKey === "production_maintenance");
  assert.equal(installAMaintenanceEvents.length, 1);
  assert.equal(installAMaintenanceEvents[0].type, "maintenance_stopped", "offline client must only see latest maintenance revision after reconnect");

  module.stop();

  const corruptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ea-desktop-tip-clients-corrupt-"));
  fs.writeFileSync(tempFile(corruptRoot, "clients.json"), "{broken", "utf8");
  const corruptLogs = [];
  const corruptModule = createModule(corruptRoot, { logs: corruptLogs });
  pollDevice(corruptModule, "install_corrupt", "0.3.0");
  assert.ok(corruptLogs.some((entry) => /client registry is invalid/i.test(entry.message)), "corrupt registry must be logged");
  assert.equal(corruptModule.getStatus().clientRegistry.registeredClientCount, 1, "corrupt registry fallback must not block polling");
  corruptModule.stop();
}

function runWecomGroupRegistryTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-desktop-tip-wecom-groups-"));
  let module = createModule(root);
  assert.deepEqual(
    createMarkdownMessagePayload("@所有人\n**EA桌面提醒**", { mentionAll: true }),
    {
      msgtype: "markdown",
      markdown: { content: "@所有人\n**EA桌面提醒**" },
      mentioned_list: ["@all"]
    },
    "mentionMode=all must put @all into the final sendMessage payload body"
  );
  const realCallbackSender = senderFromFrame({
    body: {
      chattype: "group",
      chatid: "chat_from_real_callback",
      chatname: "真实回调群名",
      from: { userid: "callback_sender" },
      text: { content: "@1号机器人 绑定M04通知群" }
    }
  });
  assert.equal(realCallbackSender.chatType, "group", "real WeCom group callback chattype must be parsed");
  assert.equal(realCallbackSender.chatId, "chat_from_real_callback", "real WeCom group callback chatid must be parsed");
  assert.equal(realCallbackSender.userId, "callback_sender", "real WeCom group callback sender userid must be parsed from from.userid");
  assert.equal(realCallbackSender.chatName, "真实回调群名", "real WeCom group callback chat name must be parsed when available");

  let result = module.captureWecomGroupBindingMessage({
    text: "@1号机器人 绑定M04通知群 正式服通知群",
    sender: {
      chatType: "single",
      chatId: "chat_private",
      userId: "bind_user",
      name: "Bind User"
    }
  });
  assert.equal(result.handled, true, "binding command must be recognized");
  assert.equal(result.ok, false, "non-group callback must be rejected");

  result = module.captureWecomGroupBindingMessage({
    text: "@1号机器人 绑定M04通知群 正式服通知群",
    sender: {
      chatType: "group",
      chatId: "",
      userId: "bind_user",
      name: "Bind User"
    }
  });
  assert.equal(result.ok, false, "group callback without chatid must be rejected");

  result = module.captureWecomGroupBindingMessage({
    text: "@1号机器人 绑定M04通知群 正式服通知群",
    sender: {
      chatType: "group",
      chatId: "chat_formal_ops",
      userId: "bind_user",
      name: "Bind User"
    }
  });
  assert.equal(result.ok, true, "valid group callback must bind group");
  assert.equal(result.action, "bind");
  assert.match(result.group.displayName, /正式服通知群/);
  assert.equal(pollDevice(module, "binding_check_client", "0.3.4").length, 0, "binding command must only update configuration and must not create desktop notification");
  assert.equal(Object.prototype.hasOwnProperty.call(result.group, "chatId"), false, "registry status must not expose raw chatid");
  const groupId = result.group.groupId;

  result = module.captureWecomGroupBindingMessage({
    text: "@1号机器人 绑定M04通知群 正式服通知群",
    sender: {
      chatType: "group",
      chatId: "chat_formal_ops",
      userId: "bind_user",
      name: "Bind User"
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.idempotent, true, "repeat bind must be idempotent");
  assert.equal(module.getStatus().wecomGroupRegistry.groupCount, 1);

  const targets = module.resolveWecomGroupTargets([{ groupId, mentionMode: "all" }]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].chatId, "chat_formal_ops", "send adapter must resolve raw chatid internally");
  assert.equal(targets[0].mentionMode, "all");
  assertThrowsStatus(() => module.resolveWecomGroupTargets([{ groupId: "wg_missing" }]), 400, "invalid group target must return 400");

  module.stop();
  module = createModule(root);
  assert.equal(module.getStatus().wecomGroupRegistry.groupCount, 1, "group registry must recover after restart");

  result = module.captureWecomGroupBindingMessage({
    text: "@1号机器人 解绑M04通知群",
    sender: {
      chatType: "group",
      chatId: "chat_formal_ops",
      userId: "bind_user",
      name: "Bind User"
    }
  });
  assert.equal(result.ok, true, "unbind command must succeed from the same real group callback");
  assert.equal(result.action, "unbind");
  assert.equal(module.getStatus().wecomGroupRegistry.groupCount, 0);

  result = module.captureWecomGroupBindingMessage({
    text: "@1号机器人 解绑M04通知群",
    sender: {
      chatType: "group",
      chatId: "chat_formal_ops",
      userId: "bind_user",
      name: "Bind User"
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.idempotent, true, "repeat unbind must be idempotent");

  module.stop();

  const corruptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ea-desktop-tip-wecom-groups-corrupt-"));
  fs.writeFileSync(tempFile(corruptRoot, "wecom-groups.json"), "{broken", "utf8");
  const logs = [];
  const corruptModule = createModule(corruptRoot, { logs });
  assert.equal(corruptModule.getStatus().wecomGroupRegistry.groupCount, 0, "corrupt group registry must fallback to empty");
  assert.ok(logs.some((entry) => /WeCom group registry is invalid/i.test(entry.message)), "corrupt group registry must be logged");
  corruptModule.stop();
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-desktop-tip-maintenance-"));
  const module = createModule(root);
  const now = new Date(Date.now() + 60 * 60 * 1000);

  assertThrowsStatus(() => module.maintenance.createMaintenance({
    operatorUserId: "",
    title: "匿名创建",
    serverName: "正式服",
    scheduledStopAt: minutesFrom(now, 31),
    expectedResumeAt: minutesFrom(now, 90)
  }), 403, "anonymous operator must not create maintenance event");

  const created = module.maintenance.createMaintenance({
    operatorUserId: "sender_user",
    title: "正式服停服更新",
    serverName: "正式服",
    scheduledStopAt: minutesFrom(now, 31),
    expectedResumeAt: minutesFrom(now, 91),
    recipientGroupId: "formal_ops"
  });
  assert.equal(created.ok, true);
  assert.equal(created.maintenance.status, "scheduled");
  assert.equal(created.maintenance.recipientType, "user");
  assert.equal(created.maintenance.recipients.length, 2);

  assertThrowsStatus(() => module.maintenance.createMaintenance({
    operatorUserId: "sender_user",
    title: "重复正式服",
    serverName: "正式服",
    scheduledStopAt: minutesFrom(now, 40),
    expectedResumeAt: minutesFrom(now, 100),
    recipientGroupId: "formal_ops"
  }), 409, "same server must not have two active events");

  module.maintenance.runDue(new Date(now.getTime() + 2 * 60 * 1000));
  let receiverEvents = pollUser(module, "receiver_a");
  assert.equal(receiverEvents.length, 1);
  assert.equal(receiverEvents[0].type, "maintenance_countdown");
  assert.equal(receiverEvents[0].meta.maintenance.countdownMinutes, 30);

  module.maintenance.runDue(new Date(now.getTime() + 27 * 60 * 1000));
  receiverEvents = pollUser(module, "receiver_a");
  assert.equal(receiverEvents.length, 1);
  assert.equal(receiverEvents[0].type, "maintenance_countdown");
  assert.equal(receiverEvents[0].meta.maintenance.countdownMinutes, 5);

  const stopped = module.maintenance.setStopped({
    operatorUserId: "sender_user",
    maintenanceId: created.maintenance.maintenanceId,
    idempotencyKey: "manual-stop-1"
  });
  assert.equal(stopped.maintenance.status, "stopped");
  receiverEvents = pollUser(module, "receiver_a");
  assert.equal(receiverEvents.length, 1);
  assert.equal(receiverEvents[0].type, "maintenance_stopped");

  assertThrowsStatus(() => module.maintenance.extendMaintenance({
    operatorUserId: "sender_user",
    maintenanceId: created.maintenance.maintenanceId,
    extensionMinutes: 0
  }), 400, "zero extension must be rejected");

  const extended = module.maintenance.extendMaintenance({
    operatorUserId: "sender_user",
    maintenanceId: created.maintenance.maintenanceId,
    extensionMinutes: 15,
    reason: "回归验证",
    idempotencyKey: "extend-1"
  });
  assert.equal(extended.maintenance.status, "extended");
  assert.equal(extended.maintenance.totalExtensionMinutes, 15);

  const completed = module.maintenance.completeMaintenance({
    operatorUserId: "sender_user",
    maintenanceId: created.maintenance.maintenanceId,
    idempotencyKey: "complete-1"
  });
  assert.equal(completed.maintenance.status, "completed");
  const beforeDuplicate = sendHistoryCount(completed.maintenance);
  const duplicateComplete = module.maintenance.completeMaintenance({
    operatorUserId: "sender_user",
    maintenanceId: created.maintenance.maintenanceId,
    idempotencyKey: "complete-1"
  });
  assert.equal(duplicateComplete.skipped, true);
  assert.equal(sendHistoryCount(duplicateComplete.maintenance), beforeDuplicate);

  receiverEvents = pollUser(module, "receiver_a");
  assert.equal(receiverEvents.length, 1);
  assert.equal(receiverEvents[0].type, "maintenance_completed");
  assert.equal(receiverEvents[0].meta.maintenance.status, "completed");

  const restartRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ea-desktop-tip-maintenance-restart-"));
  let restartModule = createModule(restartRoot);
  const restartBase = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const restartCreated = restartModule.maintenance.createMaintenance({
    operatorUserId: "admin_user",
    title: "重启恢复验证",
    serverName: "正式服重启验证",
    scheduledStopAt: minutesFrom(restartBase, 20),
    expectedResumeAt: minutesFrom(restartBase, 80),
    recipientGroupId: "formal_ops"
  });
  restartModule.stop();
  restartModule = createModule(restartRoot);
  const recovered = restartModule.maintenance.runDue(new Date(restartBase.getTime() + 25 * 60 * 1000));
  assert.equal(recovered.processedCount, 1);
  const recoveredEvents = pollUser(restartModule, "receiver_b");
  assert.equal(recoveredEvents.length, 1);
  assert.equal(recoveredEvents[0].type, "maintenance_stopped");
  assert.equal(recoveredEvents[0].meta.maintenance.maintenanceId, restartCreated.maintenance.maintenanceId);

  const psClient = fs.readFileSync(path.join(__dirname, "..", "tools", "desktop-tip", "desktop-tip-client.ps1"), "utf8");
  const psPackageClient = fs.readFileSync(path.join(__dirname, "..", "tools", "desktop-tip", "OutPackage", "desktop-tip-client.ps1"), "utf8");
  for (const content of [psClient, psPackageClient]) {
    assert.match(content, /\$Script:Version = "0\.4\.2"/, "client version must be v0.4.2");
    assert.match(content, /Initialize-SingleInstance/, "client must enforce same-install single instance");
    assert.match(content, /Local\\EADesktopTip_/, "client single instance lock must be per-user Windows named mutex");
    assert.match(content, /Duplicate desktop tip client instance rejected/, "duplicate launch must exit instead of creating another UI");
    assert.match(content, /Wake-DesktopTipWindow/, "duplicate launch must wake existing EA tip window");
    assert.match(content, /Stop-OtherDesktopTipClientInstances/, "client must clean old same-path instances after update");
    assert.match(content, /Test-CommandLineTargetsMainScript/, "old instance cleanup must match exact desktop-tip-client.ps1 path");
    assert.match(content, /\$_.ProcessId -ne \$PID/, "old instance cleanup must exclude current process");
    assert.match(content, /\$Script:UpdatePromptInProgress/, "update checks must have prompt reentry lock");
    assert.match(content, /\$Script:LastUpdatePostponedVersion/, "postponed update must remember version");
    assert.match(content, /Client update auto prompt skipped after postpone/, "auto update must not prompt again before next cycle after postpone");
    assert.match(content, /Maintenance-StatusText/, "client must include maintenance panel formatter");
    assert.match(content, /TextFromCodes @\(27491,24335,26381/, "client must avoid raw Chinese literals for old PowerShell parsing");
    assert.match(content, /clientVersion=\$version/, "client poll must report clientVersion for registry");
    assert.doesNotMatch(content, /InputBox/, "client must not prompt for UserID");
    assert.doesNotMatch(content, /userId=\$user/, "client poll must not send UserID");
    assert.doesNotMatch(content, /Ensure-UserId/, "client must not require UserID");
    assert.match(content, /Check-ClientUpdate/, "client must include online update check");
    assert.match(content, /updateCheckMinutes/, "client config must include update interval");
    assert.match(content, /Show-SendNotificationWindow/, "client must include send notification window");
    assert.match(content, /client-send\/options/, "client must read send options through clientId API");
    assert.match(content, /client-send\/manual-message/, "client must submit manual message through clientId API");
    assert.match(content, /TextFromCodes @\(21457,36865,36890,30693\)/, "right click menu must expose 发送通知");
    assert.doesNotMatch(content, /指定人员/, "client must not expose @指定人员 in this phase");
    assert.match(content, /\$sendButton\.Enabled = \$false[\s\S]*?Send-ClientManualMessage[\s\S]*?\$sendButton\.Enabled = \$true/, "client send button must lock during submit");
    assert.match(content, /\$versionLabel\.Text = "V" \+ \$Script:Version/, "client panel version label must be V0.x.x only");
    assert.match(content, /\$button\.Left = 0[\s\S]*?\$button\.Top = 0[\s\S]*?\$button\.Width = 58[\s\S]*?\$button\.Height = 58/, "EA logo button must keep stable 58x58 blue container");
    assert.match(content, /\$versionLabel\.BackColor = \[System\.Drawing\.ColorTranslator\]::FromHtml\("#1677ff"\)/, "version label must stay inside the blue logo container visually");
    assert.match(content, /\$versionLabel\.Left = 0[\s\S]*?\$versionLabel\.Top = 39[\s\S]*?\$versionLabel\.Width = 58[\s\S]*?\$versionLabel\.Height = 17/, "version label must be inside blue logo bounds");
    assert.match(content, /\$bodyBox = New-Object System\.Windows\.Forms\.RichTextBox/, "generic body must use RichTextBox for native on-demand scrollbars");
    assert.match(content, /\$bodyBox\.Text = \[string\]\$Tip\.body/, "generic message panel must render only message body");
    assert.match(content, /\$bodyBox\.ScrollBars = \[System\.Windows\.Forms\.RichTextBoxScrollBars\]::Vertical/, "generic message body must use native on-demand vertical scrollbar");
    assert.doesNotMatch(content, /RichTextBoxScrollBars\]::ForcedVertical/, "generic message body must not force scrollbar for short content");
    assert.match(content, /\$bodyBox\.WordWrap = \$true/, "long generic message body must wrap lines");
    assert.match(content, /\$bodyBox\.DetectUrls = \$false/, "generic message body must not expose URL behavior");
    assert.match(content, /\$titleLabel\.Font = New-Object System\.Drawing\.Font\("Microsoft YaHei UI", 12, \[System\.Drawing\.FontStyle\]::Bold\)/, "title font size must stay 12");
    assert.match(content, /\$bodyBox\.Font = New-Object System\.Drawing\.Font\("Microsoft YaHei UI", 12\)/, "generic body font size must match title size");
    assert.match(content, /\$bodyBox\.Top = 76[\s\S]*?\$bodyBox\.Height = 108[\s\S]*?\$openButton\.Top = 194/, "generic body layout must leave space before the button");
    assert.match(content, /\$genericWindowWidth = 376/, "generic message window width must stay explicit for button centering");
    assert.match(content, /\$genericActionCenter = \$bodyBox\.Left \+ \[int\]\(\$bodyBox\.Width \/ 2\)/, "generic action center must use body/action area center");
    assert.match(content, /\$openButton\.Left = \[int\]\(\$genericActionCenter - \(\$openButton\.Width \/ 2\)\)/, "generic receive button center must align with action area center");
    assert.match(content, /\$bodyBox\.Left = 18[\s\S]*?\$openButton\.Width = 78[\s\S]*?\$bodyBox\.Width = 340[\s\S]*?\$genericActionCenter = \$bodyBox\.Left \+ \[int\]\(\$bodyBox\.Width \/ 2\)[\s\S]*?\$openButton\.Left = \[int\]\(\$genericActionCenter - \(\$openButton\.Width \/ 2\)\)/, "generic receive button center point must align with the 188px body/window center");
    assert.match(content, /Body scroll self test failed/, "client selftest must cover short and long body scroll cases");
    assert.match(content, /\$shortSingle\.Height -gt 108 -or \$shortMulti\.Height -gt 108 -or \$longMulti\.Height -le 108/, "client selftest must verify short single-line, short multi-line, and long multi-line body overflow");
    assert.match(content, /TextFromCodes @\(25910,21040\)/, "generic message panel must use single 收到 button");
    assert.match(content, /Send-TipAck -Tip \$Script:CurrentTip -Action "done"/, "generic message primary button must ack done");
    assert.match(content, /if \(\$primaryAction -eq "opened"\)/, "maintenance panel must keep separate opened/view-details path");
    assert.match(content, /\$dismissButton\.Visible = \$false/, "generic message panel must hide secondary button");
  }

  module.stop();
  restartModule.stop();
  runClientRegistryTests();
  runWecomGroupRegistryTests();
  await runApiPermissionTests();
  await runManualMessageApiTests();
  await runClientManualMessageApiTests();
  console.log("Desktop tip production maintenance tests passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
