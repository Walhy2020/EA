"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

function fixture(url) {
  const project = url.searchParams.get("project") || "恶魔高校";
  const role = url.searchParams.get("role") || "fe";
  const taskId = url.searchParams.get("taskId") || "record-a";
  const effort = Number(url.searchParams.get("effort")) || null;
  const tasks = project === "魔王" ? [] : [
    { id: "record-a", demandId: "001234", title: "真实需求甲", project, state: "待分配", type: "优化", summary: "需求总表真实内容", deadline: "2026-10-23", effort: null, warnings: [] },
    { id: "record-b", demandId: "001235", title: "真实需求乙", project, state: "待分配", type: "新功能", summary: "另一条需求", deadline: "2026-10-21", effort: null, warnings: [] }
  ];
  return { ok: true, status: "ok", readOnly: true, version: "0.2.0", generatedAt: "2026-10-19T04:00:00.000Z",
    identity: { name: "页面验收组长", isFallback: true },
    roles: [{ id: "fe", name: "前端", field: "前端开发" }, { id: "be", name: "后端", field: "后端开发" }, { id: "ui", name: "美术", field: "UI人员" }],
    role, tasks, taskId: tasks.length ? taskId : null,
    calendar: { ok: true, firstDate: "2025-12-01", lastDate: "2026-12-30", today: "2026-10-19", workdays: ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"] },
    candidates: tasks.length ? [{ id: "person-a", name: "候选同事", job: "前端 / 后端", leader: "组长甲", total: 3, reservation: 0,
      unknownCount: 1, status: "missing", baseline: 0, gap: effort ? 1 : null, delta: effort ? 1 : null, quantified: Boolean(effort),
      reasons: ["存在未知预占工作量", "人员可分配资格未确认"], dependencies: ["UI完整交付未确认"],
      items: [{ id: "009999", title: "其他项目工作", project: "一骑当千", role: "后端", effort: 3, due: "2026-10-21", source: "正式剩余", reserved: false }]
    }] : [], warnings: ["只读分析，不写回负责人"], source: { recordCount: 3802, cacheHit: true } };
}

async function main() {
  const { chromium } = require("playwright");
  const root = path.resolve(__dirname, "../src/admin/static");
  const output = path.resolve(process.env.EA_PREVIEW_TEST_OUTPUT || path.join(__dirname, "../.integration-test-output"));
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, `.${decodeURIComponent(new URL(req.url, "http://localhost").pathname)}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" })[path.extname(file)] || "text/plain" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [], apiCalls = [];
    let failNext = false;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => {
      const req = route.request(), url = new URL(req.url());
      apiCalls.push({ method: req.method(), url: req.url(), child: req.frame().parentFrame() !== null });
      let payload;
      if (url.pathname.endsWith("assignment-reference")) {
        if (failNext) { failNext = false; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, message: "数据源暂不可用" }) }); return; }
        payload = { ok: true, devProgress: fixture(url) };
      } else payload = url.pathname.includes("h5-session")
        ? { ok: true, identity: { name: "页面验收组长", source: "signed_session" } }
        : { ok: true, devProgress: { items: [], leaderRoles: ["前端组长"], memberViews: [], cache: { refreshedAt: "2026-10-19T04:00:00.000Z" } } };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/demand-h5.html`);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("#assignmentPreviewFrame").getAttribute("src"), null, "lazy iframe");
    await page.locator('[data-panel="assignment"]').click();
    const frame = page.frameLocator("#assignmentPreviewFrame");
    await frame.locator(".candidate").first().waitFor();
    assert.equal(await frame.locator("#persona").count(), 0, "no client-chosen identity");
    assert.equal(await frame.locator(".task-item").count(), 2);
    assert.equal(await frame.locator(".app-header").isVisible(), false);
    assert.equal(await page.locator("#assignmentPreviewFrame").getAttribute("sandbox"), "allow-scripts allow-forms");
    assert.equal(await frame.locator('[data-select], #confirm-assignment').count(), 0, "no assignment writes or simulated selection");
    assert.match(await frame.locator(".candidate").textContent(), /候选同事/);
    await frame.locator('[data-evidence="person-a"]').click();
    assert.match(await frame.locator(".evidence").textContent(), /其他项目工作/);
    await page.screenshot({ path: path.join(output, "integrated-desktop.png"), fullPage: true });
    await frame.locator("#effort").fill("2");
    const analysisResponse = page.waitForResponse(res => res.url().includes("assignment-reference") && new URL(res.url()).searchParams.get("effort") === "2");
    await frame.locator('#estimate-form button[type="submit"]').click();
    await analysisResponse;
    await page.waitForTimeout(100);
    assert.equal(await frame.locator(".task-item").count(), 2, "analysis does not assign or remove a task");
    await page.locator("#projectSelect").selectOption("魔王");
    await page.waitForTimeout(300);
    assert.equal(await frame.locator(".task-item").count(), 0);
    await page.locator("#projectSelect").selectOption("女王之刃");
    await frame.locator(".candidate").first().waitFor();
    assert.ok(apiCalls.some(c => new URL(c.url).searchParams.get("project") === "女王之刃"));
    const before = apiCalls.length;
    await page.evaluate(() => window.postMessage({ type: "ea-assignment-reference-request", requestId: "spoof", query: { project: "fake", role: "ui" } }, "*"));
    await page.waitForTimeout(100);
    assert.equal(apiCalls.length, before, "other windows cannot invoke bridge");
    for (const width of [1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `host width ${width}`);
      assert.equal(await frame.locator("body").evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `child width ${width}`);
      if (width === 390) {
        if (!(await frame.locator(".task-item").first().isVisible())) await frame.locator('[data-action="back"]').click();
        await frame.locator(".task-item").first().click();
        await frame.locator(".candidate").first().waitFor();
        await page.screenshot({ path: path.join(output, "integrated-mobile.png"), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    assert.ok(apiCalls.every(c => c.method === "GET" && !c.child), "only parent reads APIs; no child API or write");
    const loggedOut = await browser.newPage();
    await loggedOut.route("**/api/**", route => route.fulfill({ status: 401, contentType: "application/json", body: '{"ok":false}' }));
    await loggedOut.goto(`${base}/demand-h5.html?panel=assignment`);
    await loggedOut.waitForURL("**/demand-login.html?**");
    console.log(`Assignment integration passed: authenticated parent read bridge, opaque sandbox, real-shaped queries, analysis-only, cross-project evidence, project switching, login redirect, responsive 320-1440. Screenshots: ${output}`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
