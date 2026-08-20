"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(name) {
    this.values.add(name);
  }

  remove(name) {
    this.values.delete(name);
  }

  toggle(name, force) {
    if (force) {
      this.add(name);
    } else {
      this.remove(name);
    }
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.checked = false;
    this.classList = new FakeClassList();
  }

  addEventListener() {}
}

function createHarness(fetchHandler) {
  const elements = new Map();
  const confirmCalls = [];
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, new FakeElement(id));
    }
    return elements.get(id);
  }

  const sandbox = {
    console,
    fetch: fetchHandler || (async () => ({ ok: true, json: async () => ({}) })),
    window: {
      addEventListener() {},
      confirm: (message) => {
        confirmCalls.push(message);
        return true;
      },
      location: { href: "" }
    },
    document: {
      getElementById: element,
      querySelector: () => new FakeElement("querySelector"),
      querySelectorAll: () => []
    },
    URLSearchParams
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "admin", "static", "app.js"), "utf8");
  vm.runInContext(source, sandbox, { filename: "app.js" });
  return {
    sandbox,
    confirmCalls,
    element,
    run(code) {
      return vm.runInContext(code, sandbox);
    }
  };
}

function statusWithRegisteredClients(count) {
  return {
    ok: true,
    app: { version: "0.6.62" },
    config: { server: { host: "127.0.0.1", port: 39200 } },
    modules: {
      rank: { files: {} },
      desktopTip: {
        version: "0.3.1",
        clientRegistry: { registeredClientCount: count },
        clientUpdate: { packageReady: true, version: "0.3.4" },
        productionMaintenance: {
          registeredReceivers: { registeredClientCount: count }
        }
      }
    },
    robot: {},
    notification: { enabled: true }
  };
}

function response(ok, payload, status = 200) {
  return {
    ok,
    status,
    json: async () => payload
  };
}

async function main() {
  const harness = createHarness();

  harness.run(`renderStatus(${JSON.stringify(statusWithRegisteredClients(2))})`);
  assert.match(harness.element("desktopTipRegisteredUserBadge").textContent, /2/, "status refresh must render registered client count");
  assert.match(harness.element("desktopTipManualScopeInput").value, /2/, "manual scope must render registered client count before login");
  assert.equal(harness.element("desktopTipManualSubmitBtn").disabled, true, "manual send must remain disabled before signed login");
  assert.match(harness.element("desktopTipManualStatus").textContent, /登录|鐧诲綍/, "manual status must still ask for login before sending");

  harness.run(`
    state.desktopTipIdentity = { userId: "signed_user", name: "Signed User" };
    renderDesktopTipConfig({
      ok: true,
      canSend: true,
      canManage: false,
      role: "sender",
      accessMode: "all_signed_in",
      config: { version: "0.3.1", countdownMinutes: [30, 10, 5, 1] },
      clientUpdate: { packageReady: true, version: "0.3.4" }
    });
  `);
  assert.match(harness.element("desktopTipManualScopeInput").value, /2/, "config payload without count must not reset previous status count to zero");
  assert.equal(harness.element("desktopTipManualSubmitBtn").disabled, false, "signed user with send permission and registered clients can send");

  harness.run(`renderStatus(${JSON.stringify(statusWithRegisteredClients(0))})`);
  assert.match(harness.element("desktopTipRegisteredUserBadge").textContent, /0/, "explicit zero status must render zero clients");
  assert.match(harness.element("desktopTipManualScopeInput").value, /0/, "explicit zero status must render zero manual scope");
  assert.equal(harness.element("desktopTipManualSubmitBtn").disabled, true, "zero clients must disable manual send");

  const autoCalls = [];
  const autoHarness = createHarness(async (url) => {
    autoCalls.push(url);
    if (url === "/api/dev-progress/h5-session") {
      return response(true, { identity: { userId: "signed_user", name: "Signed User" } });
    }
    if (url === "/api/desktop-tip/maintenance/config") {
      return response(true, {
        ok: true,
        canSend: true,
        canManage: false,
        role: "sender",
        accessMode: "all_signed_in",
        registeredReceivers: { registeredClientCount: 2 },
        config: { version: "0.3.1", countdownMinutes: [30, 10, 5, 1] },
        clientUpdate: { packageReady: true, version: "0.3.4" }
      });
    }
    if (url === "/api/desktop-tip/maintenance/events?limit=30") {
      return response(true, { ok: true, events: [] });
    }
    return response(false, { message: `unexpected ${url}` }, 404);
  });
  autoHarness.run(`state.desktopTipRegisteredClientCount = 2`);
  await autoHarness.run(`initializeDesktopTipPanel()`);
  assert.ok(autoCalls.includes("/api/desktop-tip/maintenance/config"), "signed initialization must auto load desktop-tip config");
  assert.equal(autoHarness.element("desktopTipManualSubmitBtn").disabled, false, "signed initialization must enable manual send with registered clients");
  assert.match(autoHarness.element("desktopTipManualStatus").textContent, /2/, "signed initialization must show registered client count");

  const failHarness = createHarness(async (url) => {
    if (url === "/api/dev-progress/h5-session") {
      return response(true, { identity: { userId: "signed_user", name: "Signed User" } });
    }
    if (url === "/api/desktop-tip/maintenance/config") {
      return response(false, { message: "config denied" }, 500);
    }
    return response(true, { ok: true, events: [] });
  });
  failHarness.run(`state.desktopTipRegisteredClientCount = 2`);
  await failHarness.run(`initializeDesktopTipPanel()`);
  assert.equal(failHarness.element("desktopTipManualSubmitBtn").disabled, true, "config load failure must keep manual send disabled");
  assert.match(failHarness.element("desktopTipManualStatus").textContent, /config denied|配置读取失败/, "config load failure must be visible");

  const manualCalls = [];
  const manualHarness = createHarness(async (url, options = {}) => {
    manualCalls.push({ url, method: options.method || "GET", body: options.body || "" });
    if (url === "/api/desktop-tip/manual-message") {
      return response(true, { ok: true, batchId: "manual_batch_1", queuedCount: 2, recipientCount: 2 });
    }
    if (url === "/api/desktop-tip/maintenance/config") {
      return response(true, {
        ok: true,
        canSend: true,
        canManage: false,
        role: "sender",
        accessMode: "all_signed_in",
        registeredReceivers: { registeredClientCount: 2 },
        config: { version: "0.3.1", countdownMinutes: [30, 10, 5, 1] },
        clientUpdate: { packageReady: true, version: "0.3.4" }
      });
    }
    if (url === "/api/desktop-tip/maintenance/events?limit=30") {
      return response(true, { ok: true, events: [] });
    }
    return response(false, { message: `unexpected ${url}` }, 404);
  });
  manualHarness.run(`renderStatus(${JSON.stringify(statusWithRegisteredClients(2))})`);
  manualHarness.run(`
    state.desktopTipIdentity = { userId: "signed_user", name: "Signed User" };
    renderDesktopTipConfig({
      ok: true,
      canSend: true,
      canManage: false,
      role: "sender",
      accessMode: "all_signed_in",
      registeredReceivers: { registeredClientCount: 2 },
      config: { version: "0.3.1", countdownMinutes: [30, 10, 5, 1] },
      clientUpdate: { packageReady: true, version: "0.3.4" }
    });
    $("desktopTipManualTitleInput").value = "EA桌面提醒测试";
    $("desktopTipManualBodyInput").value = "普通消息正文";
  `);
  await manualHarness.run(`sendDesktopTipManualMessage({ preventDefault() {} })`);
  assert.equal(manualHarness.confirmCalls.length, 0, "manual message send must not call confirm");
  assert.ok(
    manualCalls.some((call) => call.url === "/api/desktop-tip/manual-message" && call.method === "POST"),
    "manual message send must directly post to manual-message API"
  );
  assert.match(manualHarness.element("desktopTipManualStatus").textContent, /已排队|2\/2/, "manual message success must show queued count");

  const confirmHarness = createHarness(async (url) => {
    if (url === "/api/desktop-tip/maintenance/stop") {
      return response(true, { ok: true, maintenance: { maintenanceId: "m1", status: "stopped" } });
    }
    if (url === "/api/desktop-tip/maintenance/config") {
      return response(true, {
        ok: true,
        canSend: true,
        canManage: false,
        role: "sender",
        accessMode: "all_signed_in",
        registeredReceivers: { registeredClientCount: 2 },
        config: { version: "0.3.1", countdownMinutes: [30, 10, 5, 1] },
        clientUpdate: { packageReady: true, version: "0.3.4" }
      });
    }
    if (url === "/api/desktop-tip/maintenance/events?limit=30") {
      return response(true, { ok: true, events: [] });
    }
    return response(false, { message: `unexpected ${url}` }, 404);
  });
  confirmHarness.run(`
    state.desktopTipIdentity = { userId: "signed_user", name: "Signed User" };
    $("desktopTipMaintenanceIdInput").value = "m1";
  `);
  await confirmHarness.run(`postDesktopTipAction("/api/desktop-tip/maintenance/stop", {}, "确认将该维护事件手动推进为“已停服”？")`);
  assert.equal(confirmHarness.confirmCalls.length, 1, "production maintenance actions must keep confirm dialog");

  harness.run(`openDesktopTipLogin()`);
  assert.equal(harness.sandbox.window.location.href, "/demand-login.html?returnTo=/", "desktop-tip login must return to admin console");

  console.log("Desktop tip admin UI tests passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
