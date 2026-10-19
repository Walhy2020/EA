"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ASSETS, createDemandPageVersionReader } = require("../src/admin/demandPageVersion");
const staticDir = path.join(__dirname, "../src/admin/static");
const script = fs.readFileSync(path.join(staticDir, "demand-page-update.js"), "utf8");
const A = "a".repeat(24), B = "b".repeat(24), C = "c".repeat(24);

async function main() {
  let now = 100000, reads = 0, revision = "1";
  const read = createDemandPageVersionReader("fixture", {
    nowMs: () => now, readFile: filename => { reads++; return filename + revision; }
  });
  const initial = read();
  assert.match(initial, /^[a-f0-9]{24}$/);
  assert.equal(reads, ASSETS.length);
  revision = "2";
  assert.equal(read(), initial, "hash work is bounded by a five second memo");
  now += 5000;
  assert.notEqual(read(), initial, "asset changes update the build signature");
  const realRead = createDemandPageVersionReader(staticDir);
  assert.match(realRead(), /^[a-f0-9]{24}$/, "all allowlisted release assets exist");

  const handlers = {}, timers = [];
  const banner = { hidden: true };
  const buttons = Object.fromEntries(["pageUpdateReload", "pageUpdateLater"].map(id => [id, {
    addEventListener: (_, callback) => { handlers[id] = callback; }
  }]));
  let payload = { ok: true, buildId: A }, status = 200, failure = false;
  let requests = 0, reloads = 0, hidden = false, resolveRequest = null;
  const window = {
    location: { reload: () => { reloads++; } },
    addEventListener: (event, callback) => { handlers[event] = callback; }
  };
  const document = {
    querySelector: () => ({ content: A }),
    getElementById: id => id === "pageUpdateNotice" ? banner : buttons[id],
    get hidden() { return hidden; },
    addEventListener: (event, callback) => { handlers[event] = callback; }
  };
  const context = { window, document, AbortController, Date: { now: () => now },
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearTimeout() {}, setInterval: callback => { handlers.interval = callback; return 1; }, clearInterval() {},
    fetch: async (url, options) => {
      requests++;
      assert.equal(url, "/api/dev-progress/page-version");
      assert.equal(options.cache, "no-store");
      if (resolveRequest) await new Promise(resolve => { resolveRequest = resolve; });
      if (failure) throw Error("offline");
      return { ok: status === 200, json: async () => payload };
    }
  };
  vm.runInNewContext(script, context);
  const check = async () => { now += 60000; await handlers.interval(); };
  await check();
  assert(banner.hidden, "same build is quiet");
  payload = { ok: true, buildId: B };
  await check();
  assert.equal(banner.hidden, false);
  assert.equal(reloads, 0, "no automatic reload");
  handlers.pageUpdateLater();
  await check();
  assert(banner.hidden, "later suppresses the same build");
  payload = { ok: true, buildId: C };
  await check();
  assert.equal(banner.hidden, false, "a subsequent release may notify again");
  handlers.pageUpdateReload();
  assert.equal(reloads, 1, "reload only after explicit click");
  hidden = true;
  const count = requests;
  await check();
  assert.equal(requests, count, "hidden pages do not poll");
  hidden = false;
  await handlers.visibilitychange();
  assert.equal(requests, count + 1);
  await handlers.focus();
  assert.equal(requests, count + 1, "focus burst is throttled");
  status = 401;
  await check();
  assert.equal(reloads, 1, "expired sessions do not navigate or erase state");
  failure = true;
  await check();
  assert.equal(reloads, 1);
  failure = false; status = 200;
  payload = { ok: true, buildId: "<invalid>" };
  await check();
  assert.equal(reloads, 1);
  resolveRequest = true;
  now += 60000;
  const pending = handlers.interval();
  const beforeConcurrent = requests;
  await handlers.focus();
  assert.equal(requests, beforeConcurrent, "only one check may be in flight");
  handlers.pagehide({ persisted: false });
  resolveRequest(); resolveRequest = null;
  await pending;
  await check();
  assert.equal(requests, beforeConcurrent, "disposed pages stop checks");

  const { chromium } = require("playwright");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://ea.test/api/dev-progress/page-version", route => route.fulfill({
      contentType: "application/json", body: JSON.stringify({ ok: true, buildId: B })
    }));
    await page.route("https://ea.test/", route => route.fulfill({ contentType: "text/html; charset=utf-8", body:
      `<meta charset="utf-8"><meta name="ea-page-build" content="${A}"><style>${fs.readFileSync(path.join(staticDir, "demand-h5.css"), "utf8")}</style>
      <main class="app-shell"><aside id="pageUpdateNotice" class="page-update-notice" hidden role="status"><span>页面有新版本，刷新后生效</span>
      <div class="page-update-actions"><button id="pageUpdateReload">刷新页面</button><button id="pageUpdateLater">稍后</button></div></aside>
      <input id="draft" value="unsaved effort 2.5"></main><script>${script}</script>` }));
    await page.goto("https://ea.test/");
    await page.locator("#pageUpdateNotice").waitFor({ state: "visible", timeout: 12000 });
    assert.equal(await page.locator("#draft").inputValue(), "unsaved effort 2.5");
    for (const width of [320, 646, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no overflow at ${width}`);
      for (const id of ["pageUpdateReload", "pageUpdateLater"]) {
        const box = await page.locator(`#${id}`).boundingBox();
        assert(box.x >= 0 && box.x + box.width <= width);
      }
    }
    const out = path.join(require("node:os").tmpdir(), "ea-page-update-qa.png");
    await page.screenshot({ path: out });
    await page.locator("#pageUpdateLater").click();
    assert(await page.locator("#pageUpdateNotice").isHidden());
    console.log(`PASS page update responsive screenshot: ${out}`);
  } finally { await browser.close(); }
  console.log("PASS page update signature, no-change, new release, later, explicit reload, visibility, errors, auth, concurrency and draft preservation");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
