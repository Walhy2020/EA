"use strict";

const assert = require("node:assert/strict");
const { createAdminServer } = require("../src/admin/adminServer");
const { COOKIE_NAME, createDemandH5Session } = require("../src/admin/demandH5Session");

async function main() {
  const previous = process.env.WECOM_DOC_SECRET;
  process.env.WECOM_DOC_SECRET = "assignment-test-session-secret";
  const calls = [];
  const logs = [];
  const app = createAdminServer({
    config: {
      app: { server: { host: "127.0.0.1", port: 0, https: { enabled: false } }, runtime: {}, security: {} },
      modules: { modules: {}, monitors: {}, notification: {} }, routes: {}
    },
    modules: { devProgress: {
      async queryAssignmentReference(options) {
        calls.push(options);
        if (options.role === "be") return { ok: false, status: "role_forbidden", httpStatus: 403, message: "岗位无权访问" };
        return { ok: true, status: "ok", readOnly: true, role: "fe", tasks: [], candidates: [], source: { cacheHit: true } };
      }
    } },
    router: {}, robotServer: {}, robotDiagnostics: {},
    monitorManager: {}, notificationCenter: {},
    logger: { info(event, details) { logs.push({ event, details }); }, warn() {}, error() {} }
  });
  const server = app.start();
  if (!server.listening) await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = createDemandH5Session({ userId: "test-leader", name: "真实组长" }, process.env.WECOM_DOC_SECRET);
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(session.token)}`;
  try {
    let res = await fetch(`${base}/api/dev-progress/assignment-reference?userName=王谦`);
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0, "authentication happens before reader");
    res = await fetch(`${base}/api/dev-progress/assignment-reference?role=fe&project=恶魔高校&taskId=r1&effort=2&userName=王谦&operatorUserId=admin`, {
      headers: { Cookie: cookie, "X-User-Name": "spoofed-admin" }
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.devProgress.readOnly, true);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(calls[0], { userName: "真实组长", role: "fe", project: "恶魔高校", taskId: "r1", effort: "2", forceRefresh: false });
    res = await fetch(`${base}/api/dev-progress/assignment-reference?role=be`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
    res = await fetch(`${base}/api/dev-progress/assignment-reference`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: '{"owner":"Fake"}' });
    assert.notEqual(res.status, 200, "no assignment mutation route exists");
    assert.equal(calls.length, 2);
    assert.ok(logs.some(item => item.event === "Demand H5 assignment reference requested" && item.details.readOnly));
    console.log("Assignment API passed: session required, spoofed identity ignored, role denial, GET-only, no-store, audit metadata.");
  } finally {
    await new Promise(resolve => server.close(resolve));
    app.stop();
    if (previous === undefined) delete process.env.WECOM_DOC_SECRET;
    else process.env.WECOM_DOC_SECRET = previous;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
