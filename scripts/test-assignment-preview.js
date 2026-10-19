"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const M = require("../src/admin/static/assignment-preview/model");
const root = path.resolve(__dirname, "../src/admin/static/assignment-preview");

async function main() {
  const initial = M.analyze(M.tasks[0], "fe", 2);
  assert.deepEqual(initial.map(p => p.status), ["ready", "coord", "conflict", "missing"]);
  assert.equal(initial[2].baseline, 0.7);
  assert.equal(initial[2].gap, 2.5);
  assert.equal(initial[2].delta, 1.8);
  assert.ok(M.analyze(M.tasks[0], "fe", null).every(p => p.status === "missing" && p.gap === null));
  const assignments = { "DEMO-01026:fe": { personId: "mu", name: "Chen", effort: 2 } };
  const be = M.analyze(M.tasks[1], "be", 2, assignments).find(p => p.id === "mu");
  assert.ok(be.items.some(item => item.key === "DEMO-01026:fe"), "natural-person workload spans roles");
  const same = M.analyze(M.tasks[0], "fe", 2, assignments).find(p => p.id === "mu");
  assert.equal(same.delta, 0, "reconfirm does not double-count existing assignment");
  assert.equal(M.sort(initial, "risk")[0].id, "lin");
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket/.test(fs.readFileSync(path.join(root, "app.js"), "utf8")), "preview has no business network calls");
  if (process.argv.includes("--model-only")) { console.log("Assignment preview model checks passed"); return; }
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.EA_PREVIEW_BROWSER ? { channel: process.env.EA_PREVIEW_BROWSER } : {}) });
  const errors = [];
  const requests = [];
  const output = path.resolve(process.env.EA_PREVIEW_TEST_OUTPUT || path.join(__dirname, "../.preview-test-output"));
  fs.mkdirSync(output, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
    await page.goto(process.env.EA_PREVIEW_URL || pathToFileURL(path.join(root, "index.html")).href);
    await page.locator('[data-select="lin"]').waitFor();
    assert.equal(await page.locator(".candidate").count(), 4);
    assert.equal(await page.locator(".task-item").count(), 4);
    assert.equal(await page.locator('[data-view="coord"], #coord-view, #task-status, #sort, .breadcrumb, .result-heading').count(), 0);
    assert.equal(await page.locator('[data-role]').count(), 3);
    assert.equal(await page.locator('.task-item').first().getAttribute('data-task'), 'DEMO-01038');
    await page.locator('#time-sort').click();
    assert.equal(await page.locator('.task-item').first().getAttribute('data-task'), 'DEMO-01042');
    await page.locator('[data-task="DEMO-01026"]').click();
    assert.ok(await page.locator("svg").count() > 10, "local icon assets loaded");
    assert.ok(await page.locator('.brand img').evaluate(img => img.complete && img.naturalWidth === 96));
    await page.screenshot({ path: path.join(output, "desktop.png"), fullPage: true });
    await page.locator('[data-evidence="lin"]').click();
    assert.equal(await page.locator(".evidence-table tbody tr").count(), 3);
    await page.screenshot({ path: path.join(output, "desktop-evidence.png"), fullPage: true });
    await page.locator('[data-evidence-tab="dependency"]').click();
    assert.ok(await page.locator(".dependency-chain").isVisible());
    await page.locator('[data-evidence-tab="history"]').click();
    assert.ok(await page.locator(".experience").isVisible());
    await page.locator('[data-evidence-tab="load"]').click();
    await page.locator('[data-work="DEMO-L01"]').click();
    assert.ok(await page.locator("dialog").isVisible());
    await page.keyboard.press("Escape");
    await page.locator('[data-select="yu"]').click();
    assert.ok(await page.locator("#confirm-assignment").isDisabled());
    await page.locator("#risk-ack").check();
    assert.ok(await page.locator("#confirm-assignment").isEnabled());
    await page.screenshot({ path: path.join(output, "risk-confirm.png") });
    await page.locator('dialog [data-action="close"]').last().click();
    assert.equal(await page.locator(".success-receipt").count(), 0, "cancel leaves assignment untouched");
    await page.locator("#effort").fill("0");
    assert.ok(await page.locator('[data-select="lin"]').isDisabled());
    await page.locator("#time-sort").click();
    assert.ok(await page.locator('[data-select="lin"]').isDisabled(), "deadline sort must not re-enable stale results");
    await page.locator("#effort").fill("3");
    await page.locator('#estimate-form button[type="submit"]').click();
    assert.match(await page.locator('[data-person="lin"] .status').textContent(), /冲突/);
    await page.locator("#skip-estimate").check();
    await page.locator('#estimate-form button[type="submit"]').click();
    assert.ok(await page.locator("#effort").isDisabled());
    assert.equal(await page.locator(".candidate .status.missing").count(), 4);
    await page.locator("#skip-estimate").uncheck();
    await page.locator("#effort").fill("2");
    await page.locator('#estimate-form button[type="submit"]').click();
    await page.locator('[data-select="mu"]').click();
    await page.locator("#risk-ack").check();
    await page.locator("#confirm-assignment").click();
    assert.match(await page.locator(".success-receipt").textContent(), /陈沐/);
    assert.match(await page.locator('.task-meta').textContent(), /陈沐/);
    assert.equal(await page.locator('.task-item').count(), 3);
    await page.locator("#search").fill("does-not-exist");
    assert.equal(await page.locator(".task-item").count(), 0);
    await page.locator('[data-action="clear-filter"]').click();
    assert.equal(await page.locator(".task-item").count(), 3);
    for (const persona of ['fe', 'be', 'ui']) {
      await page.locator('#persona').selectOption(persona);
      assert.deepEqual(await page.locator('[data-role]').evaluateAll(buttons => buttons.map(b => b.dataset.role)), [persona]);
      assert.ok(await page.locator('.candidate').count() >= 3);
    }
    await page.locator("#project").selectOption("一骑当千");
    assert.equal(await page.locator(".task-item").count(), 1, "only pending tasks shown");
    await page.locator("#reset").click();
    await page.locator('[data-action="reset-confirm"]').click();
    assert.equal(await page.locator(".success-receipt").count(), 0);
    assert.equal(await page.locator("#persona").inputValue(), "ui", "reset preserves preview identity");
    assert.equal(await page.locator("#project").inputValue(), "一骑当千", "reset preserves project");
    await page.locator('#persona').selectOption('fallback');
    await page.locator('[data-role="fe"]').click();
    await page.locator('#project').selectOption('all');
    await page.locator('[data-task="DEMO-01026"]').click();
    await page.locator("#toast").waitFor({ state: "hidden", timeout: 6000 });
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (width <= 760) {
        if (await page.locator('.mobile-back').isVisible()) await page.locator('[data-action="back"]').click();
        await page.locator('[data-task="DEMO-01026"]').click();
        assert.ok(await page.locator(".mobile-back").isVisible());
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.equal(overflow, false, `no horizontal page overflow at ${width}`);
      assert.ok(await page.locator('[data-select="lin"]').isVisible());
      if (width <= 760) {
        await page.screenshot({ path: path.join(output, `mobile-${width}.png`), fullPage: true });
        await page.locator('[data-evidence="lin"]').click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
        await page.screenshot({ path: path.join(output, `mobile-evidence-${width}.png`), fullPage: true });
        await page.locator('[data-action="back"]').click();
      }
    }
    assert.deepEqual(errors, [], "no runtime errors");
    assert.deepEqual(requests.filter(url => url.includes("/api/")), [], "no production API calls");
    console.log(`Assignment preview checks passed: model, pending tasks, role scope, deadline sorting, estimates, evidence, demo owner selection, reset, responsive 320-1440. Screenshots: ${output}`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
