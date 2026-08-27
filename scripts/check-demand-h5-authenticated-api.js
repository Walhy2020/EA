"use strict";

const assert = require("assert");
const http = require("http");

const settingsStorePath = require.resolve("../src/config/settingsStore");
require.cache[settingsStorePath] = {
  id: settingsStorePath,
  filename: settingsStorePath,
  loaded: true,
  exports: {
    getDevProgressSettings: () => ({
      auth: {
        corpIdEnv: "TEST_DEMAND_CORP_ID",
        agentIdEnv: "TEST_DEMAND_AGENT_ID",
        secretEnv: "TEST_DEMAND_SECRET"
      },
      monitor: { requiredFieldsPush: { testMode: false } }
    }),
    getAllSettings: () => ({}),
    getBugCollectionSettings: () => ({}),
    getDemandWorkflowRulesSettings: () => ({}),
    getRobotSettings: () => ({}),
    updateAiSettings: () => ({}),
    updateBasicSettings: () => ({}),
    updateBugCollectionSettings: () => ({}),
    updateDemandWorkflowRulesSettings: () => ({}),
    updateDevProgressSettings: () => ({}),
    updateNotificationSettings: () => ({}),
    updateRankSettings: () => ({}),
    updateRobotSettings: () => ({}),
    updateRobotOutboundTestSettings: () => ({})
  }
};

const configLoaderPath = require.resolve("../src/config/configLoader");
require.cache[configLoaderPath] = {
  id: configLoaderPath,
  filename: configLoaderPath,
  loaded: true,
  exports: { sanitizedConfigSummary: () => ({}) }
};

process.env.TEST_DEMAND_CORP_ID = "ww-test-corp";
process.env.TEST_DEMAND_AGENT_ID = "1000011";
process.env.TEST_DEMAND_SECRET = "test-only-demand-session-secret";

const { createDemandH5Session, demandH5SessionCookie } = require("../src/admin/demandH5Session");
const { createAdminServer } = require("../src/admin/adminServer");

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : "";
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: options.method || "GET",
      headers: {
        Host: "test.example.com",
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ statusCode: res.statusCode, headers: res.headers, payload: text ? JSON.parse(text) : {} });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const captured = {};
  const modules = {
    demandCollaboration: {
      listDrafts: (options) => ({ ok: true, items: [], options }),
      listTodoItems: (options) => ({ ok: true, items: [], options }),
      listMemberTodoItems: (options) => ({ ok: true, items: [], options }),
      createDraft: (options) => {
        captured.draft = options;
        return { ok: true, draft: {} };
      },
      submitLeaderSupplement: (options) => {
        captured.supplement = options;
        return { ok: true, draft: {} };
      }
    },
    devProgress: {
      listRequiredFieldItems: async (options) => {
        captured.requiredFields = options;
        return { ok: true, items: [] };
      },
      listPersonTaskItems: async (options) => ({ ok: true, items: [], options }),
      listMemberTaskItems: async (options) => ({ ok: true, items: [], options })
    },
    watchdog: {
      getAppFeedbackTask: (options) => {
        captured.watchdogGet = options;
        if (options.taskId === "legacy-task" && options.token === "legacy-token") {
          return { ok: true, task: { id: "legacy-task" } };
        }
        if (options.ref === "abcdef123456" && options.assigneeUserId === "LiJingJing") {
          return { ok: true, task: { id: "signed-task" } };
        }
        return { ok: false, statusCode: 403, message: "无权访问" };
      },
      submitAppFeedback: async (options) => {
        captured.watchdogSubmit = options;
        if (options.ref === "abcdef123456" && options.assigneeUserId === "LiJingJing") {
          return { ok: true, task: { id: "signed-task" }, message: "反馈已记录" };
        }
        return { ok: false, statusCode: 403, message: "无权访问" };
      }
    }
  };
  const noopStatus = { getStatus: () => ({}) };
  const app = createAdminServer({
    config: {
      app: { server: { host: "127.0.0.1", port: 0, https: { enabled: false } }, security: {} },
      modules: {
        modules: {
          demandCollaboration: {
            oauthRedirectOrigin: "http://test.example.com",
            internalHttpOAuth: { enabled: true, allowedOrigin: "http://test.example.com" }
          }
        }
      }
    },
    router: {},
    modules,
    robotServer: noopStatus,
    robotDiagnostics: noopStatus,
    monitorManager: noopStatus,
    notificationCenter: noopStatus,
    wecomAppCallback: null,
    logger: { info() {}, warn() {}, error() {} }
  });
  const server = app.start();
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const session = createDemandH5Session({ userId: "LiJingJing", name: "李晶晶" }, process.env.TEST_DEMAND_SECRET);
  const cookie = demandH5SessionCookie(session.token, { secure: false }).split(";")[0];
  const otherSession = createDemandH5Session({ userId: "OtherUser", name: "其他同事" }, process.env.TEST_DEMAND_SECRET);
  const otherCookie = demandH5SessionCookie(otherSession.token, { secure: false }).split(";")[0];

  try {
    const unauthorized = await request(port, "/api/dev-progress/required-field-items?userName=%E9%AB%98%E6%96%87%E7%9B%9B");
    assert.strictEqual(unauthorized.statusCode, 401);
    assert.strictEqual(unauthorized.payload.code, "demand_session_required");

    const identity = await request(port, "/api/dev-progress/h5-session", { cookie });
    assert.strictEqual(identity.statusCode, 200);
    assert.strictEqual(identity.payload.identity.name, "李晶晶");

    const unsignedWatchdogFeedback = await request(port, "/api/watchdog/app-feedback?ref=abcdef123456");
    assert.strictEqual(unsignedWatchdogFeedback.statusCode, 401);
    assert.strictEqual(unsignedWatchdogFeedback.payload.code, "demand_session_required");

    const signedWatchdogFeedback = await request(port, "/api/watchdog/app-feedback?ref=abcdef123456", { cookie });
    assert.strictEqual(signedWatchdogFeedback.statusCode, 200);
    assert.strictEqual(captured.watchdogGet.assigneeUserId, "LiJingJing");
    assert.strictEqual(captured.watchdogGet.ref, "abcdef123456");

    const foreignWatchdogFeedback = await request(port, "/api/watchdog/app-feedback?ref=abcdef123456", { cookie: otherCookie });
    assert.strictEqual(foreignWatchdogFeedback.statusCode, 403);

    const unsignedWatchdogSubmit = await request(port, "/api/watchdog/app-feedback", {
      method: "POST",
      body: { ref: "abcdef123456", action: "progress", note: "处理中" }
    });
    assert.strictEqual(unsignedWatchdogSubmit.statusCode, 401);

    const signedWatchdogSubmit = await request(port, "/api/watchdog/app-feedback", {
      method: "POST",
      cookie,
      body: { ref: "abcdef123456", action: "progress", note: "处理中" }
    });
    assert.strictEqual(signedWatchdogSubmit.statusCode, 200);
    assert.strictEqual(captured.watchdogSubmit.assigneeUserId, "LiJingJing");
    assert.strictEqual(captured.watchdogSubmit.note, "处理中");

    const legacyWatchdogFeedback = await request(port, "/api/watchdog/app-feedback?taskId=legacy-task&token=legacy-token");
    assert.strictEqual(legacyWatchdogFeedback.statusCode, 200);
    assert.strictEqual(legacyWatchdogFeedback.payload.task.id, "legacy-task");

    const requiredFields = await request(port, "/api/dev-progress/required-field-items?userName=%E9%AB%98%E6%96%87%E7%9B%9B&scope=fallback", { cookie });
    assert.strictEqual(requiredFields.statusCode, 200);
    assert.strictEqual(captured.requiredFields.userName, "李晶晶");
    assert.strictEqual(captured.requiredFields.scope, "fallback");

    await request(port, "/api/demand-collaboration/drafts", {
      method: "POST",
      cookie,
      body: { submitterName: "高文盛", project: "恶魔高校", name: "测试" }
    });
    assert.strictEqual(captured.draft.submitterName, "李晶晶");

    await request(port, "/api/demand-collaboration/leader-supplement", {
      method: "POST",
      cookie,
      body: { userName: "高文盛", draftId: "draft-1", taskId: "task-1", values: {} }
    });
    assert.strictEqual(captured.supplement.userName, "李晶晶");

    const qrLogin = await request(port, "/demand-web-login?returnTo=%2Fdemand-h5.html");
    assert.strictEqual(qrLogin.statusCode, 302);
    assert.match(qrLogin.headers.location, /^https:\/\/login\.work\.weixin\.qq\.com\/wwlogin\/sso\/login\?/);
    assert.match(qrLogin.headers.location, /login_type=CorpApp/);

    const feedbackLogout = await request(port, "/demand-web-logout?returnTo=%2Fwatchdog-feedback.html%3Fref%3Dabcdef123456%26token%3Dshould-not-pass%23taskId%3Dhidden");
    assert.strictEqual(feedbackLogout.statusCode, 302);
    const feedbackLoginLocation = new URL(feedbackLogout.headers.location, "http://localhost");
    assert.strictEqual(feedbackLoginLocation.pathname, "/demand-login.html");
    assert.strictEqual(feedbackLoginLocation.searchParams.get("returnTo"), "/watchdog-feedback.html?ref=abcdef123456");

    const externalLogout = await request(port, "/demand-web-logout?returnTo=https%3A%2F%2Fevil.example%2Fwatchdog-feedback.html%3Fref%3Dabcdef123456");
    assert.strictEqual(externalLogout.statusCode, 302);
    const externalLoginLocation = new URL(externalLogout.headers.location, "http://localhost");
    assert.strictEqual(externalLoginLocation.searchParams.get("returnTo"), "/watchdog-feedback.html?ref=abcdef123456");

    console.log(JSON.stringify({
      passed: true,
      checks: {
        unauthenticatedApiRejected: true,
        signedIdentityReturned: true,
        queryNameImpersonationBlocked: true,
        draftNameImpersonationBlocked: true,
        supplementNameImpersonationBlocked: true,
        pcQrLoginRedirectCreated: true,
        watchdogFeedbackRequiresSession: true,
        watchdogFeedbackUsesSignedUserId: true,
        watchdogFeedbackRejectsOtherUser: true,
        watchdogLegacyTokenStillAccepted: true,
        watchdogFeedbackReturnPathSanitized: true
      }
    }, null, 2));
  } finally {
    app.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
