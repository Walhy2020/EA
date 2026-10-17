"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

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
  const browser = await chromium.launch({ headless: true, channel: process.env.EA_PREVIEW_BROWSER || "msedge" });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, ignoreHTTPSErrors: true });
    const errors = [];
    const apiCalls = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => {
      const req = route.request();
      apiCalls.push({ method: req.method(), url: req.url(), child: req.frame().parentFrame() !== null });
      const payload = req.url().includes("h5-session")
        ? { ok: true, identity: { name: "页面验收组长", source: "signed_session" } }
        : { ok: true, devProgress: { items: [], leaderRoles: ["前端组长"], memberViews: [], cache: { refreshedAt: "2026-10-17T08:00:00.000Z" } } };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    const base = process.env.EA_PREVIEW_HOST || `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/demand-h5.html`);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("#assignmentPreviewFrame").getAttribute("src"), null, "preview is lazy loaded");
    await page.locator('[data-panel="assignment"]').click();
    const frame = page.frameLocator("#assignmentPreviewFrame");
    await frame.locator(".candidate").first().waitFor();
    await page.waitForTimeout(200);
    assert.equal(await frame.locator(".task-item").count(), 2, "parent project filters synthetic tasks");
    assert.equal(await frame.locator(".app-header").isVisible(), false, "no duplicate app header");
    assert.equal(await frame.locator("#project").isVisible(), false, "one shared project selector");
    assert.equal(await frame.locator(".main-nav a").isVisible(), false);
    assert.ok(await page.locator("#sessionUserName").textContent() === "页面验收组长");
    assert.equal(await page.locator("#assignmentPreviewFrame").getAttribute("sandbox"), "allow-scripts allow-forms");
    const frameHeight = await page.locator("#assignmentPreviewFrame").evaluate(el => el.getBoundingClientRect().height);
    assert.ok(frameHeight >= 400 && frameHeight < 3000, "height fits content without runaway resize");
    await page.screenshot({ path: path.join(output, "integrated-desktop.png"), fullPage: true });
    await frame.locator('[data-evidence="lin"]').click();
    await frame.locator('[data-select="mu"]').click();
    await frame.locator("#risk-ack").check();
    await frame.locator("#confirm-assignment").click();
    assert.match(await frame.locator(".success-receipt").textContent(), /陈沐/);
    await frame.locator('[data-action="show-coord"]').click();
    await frame.locator("[data-promise]").click();
    await frame.locator('#coord-form button[type="submit"]').click();
    assert.match(await frame.locator(".coord-item-header .status").textContent(), /待复核/);
    await page.locator('[data-panel="todo"]').click();
    assert.ok(await page.locator("#panel-todo").isVisible());
    assert.ok(await page.locator("#panel-assignment").isHidden());
    await page.locator('[data-panel="draft"]').click();
    assert.ok(await page.locator("#panel-draft").isVisible());
    await page.locator('[data-panel="assignment"]').click();
    await frame.locator('[data-view="assign"]').click();
    assert.match(await frame.locator(".success-receipt").textContent(), /陈沐/, "tab switching preserves demo state");
    await page.locator("#projectSelect").selectOption("女王之刃");
    await page.waitForLoadState("networkidle");
    assert.equal(await frame.locator(".task-item").count(), 1);
    assert.match(await frame.locator(".task-item").textContent(), /角色详情/);
    await frame.locator("#reset").click();
    await frame.locator('[data-action="reset-confirm"]').click();
    assert.equal(await frame.locator(".task-item").count(), 1, "reset cannot override host project");
    await page.locator("#projectSelect").selectOption("魔王");
    await page.waitForLoadState("networkidle");
    assert.equal(await frame.locator(".task-item").count(), 0);
    await page.locator("#projectSelect").selectOption("恶魔高校");
    await page.waitForLoadState("networkidle");
    assert.equal(await frame.locator(".task-item").count(), 2);
    await page.evaluate(() => window.postMessage({ type: "ea-assignment-preview-height", height: 9999 }, "*"));
    await page.waitForTimeout(100);
    assert.notEqual(await page.locator("#assignmentPreviewFrame").evaluate(el => el.style.height), "9999px", "unrelated messages ignored");
    for (const width of [1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `host width ${width}`);
      assert.equal(await frame.locator("body").evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `child width ${width}`);
      if (width === 390) {
        await frame.locator('[data-task="DEMO-01026"]').click();
        await page.waitForTimeout(350);
        assert.ok(await frame.locator(".candidate").last().evaluate(el => el.getBoundingClientRect().bottom <= innerHeight + 1), "last candidate fits the expanded frame");
        await page.screenshot({ path: path.join(output, "integrated-mobile.png"), fullPage: true });
        await frame.locator(".candidate").last().scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, "integrated-mobile-bottom.png") });
        await frame.locator('[data-action="back"]').click();
      }
    }
    assert.deepEqual(errors, [], "no runtime errors");
    assert.ok(apiCalls.every(c => c.method === "GET" && !c.child), "only the existing host uses read APIs; no preview API or writes");
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(`${base}/demand-h5.html?panel=assignment`);
    await page.waitForLoadState("networkidle");
    assert.ok(await page.locator("#panel-assignment").isVisible(), "deep link selects host tab");
    const loggedOut = await browser.newPage();
    await loggedOut.route("**/api/**", route => route.fulfill({ status: 401, contentType: "application/json", body: '{"ok":false}' }));
    await loggedOut.goto(`${base}/demand-h5.html?panel=assignment`);
    await loggedOut.waitForURL("**/demand-login.html?**");
    assert.ok(loggedOut.url().includes("returnTo="), "existing login remains required");
    console.log(`Integrated assignment preview passed: existing login/navigation, lazy sandbox, shared project, demo interactions, no writes, responsive 320-1440. Screenshots: ${output}`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
