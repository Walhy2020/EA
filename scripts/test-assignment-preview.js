"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const M = require("../src/admin/static/assignment-preview/model");
const root = path.resolve(__dirname, "../src/admin/static/assignment-preview");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const specialId = 'record-"<unsafe>&';

// Contract fixtures only; no production endpoint or session is used.
function result(query = {}) {
  const role = query.role || "fe";
  const tasks = [
    { id: specialId, demandId: "REQ-101", title: '真实结构 <img src=x onerror="alert(1)">', project: "目标项目", state: "待分配", type: "优化", summary: "服务端过滤结果", deadline: "2026-11-02", effort: null, warnings: ["截止待确认"] },
    { id: "record-2", demandId: "REQ-102", title: "", project: "目标项目", state: "待分配", type: "功能", summary: "需求内容", deadline: "2026-11-03", effort: null, warnings: ["缺少需求名称"] },
    { id: "record-hidden", demandId: "REQ-103", title: "其他目标项目需求", project: "不在目标范围", state: "待分配", deadline: null, warnings: [] }
  ];
  return { ok: true, status: "ok", message: "查询完成", version: "0.2.1", readOnly: true, generatedAt: "2026-10-18T08:30:00+08:00", identity: { name: "签名会话组长", isFallback: false }, roles: [{ id: "fe", name: "前端", field: "前端开发" }, { id: "be", name: "后端", field: "后端开发" }], role, tasks, taskId: query.taskId || specialId,
    calendar: { ok: true, firstDate: "2026-10-19", lastDate: "2026-11-03", today: "2026-10-19", workdays: ["2026-10-19"] },
    candidates: [{ id: 'person-"<>', name: "跨组候选人", job: "前端 / 后端", leader: "另一组长", total: 4, reservation: 0, unknownCount: 2, status: query.effort === null || query.effort === undefined ? "missing" : "conditional", baseline: 0, gap: query.effort ? 1 : null, delta: query.effort ? 1 : null, quantified: Boolean(query.effort),
      items: [{ id: 'work-"<>', title: "跨项目负载", project: "负载来自其他项目", role: "be", effort: 4, due: "2026-10-30", source: "formal_remaining", reserved: false }, { id: "unknown", title: "未量化任务", project: "其他项目", role: "unrecognized_role", effort: null, due: null, source: "unknown_reservation", reserved: true }, { id: "unknown-source", title: "未知来源任务", project: "其他项目", role: "ui", effort: null, due: null, source: "unrecognized_source", reserved: false }], reasons: ["存在未量化工作量"], dependencies: ["上游交付待确认 <script>"] }], warnings: ["容量仅为下界"], source: { recordCount: 3, cacheHit: true } };
}

function modelChecks() {
  assert.equal(M.version, "0.2.1");
  assert.equal(M.effort(""), null);
  assert.equal(M.effort(null), null);
  for (const n of [0, -1, 40.01, Infinity, "bad"]) assert.throws(() => M.effort(n));
  for (const n of [0.001, 1, 40]) assert.equal(M.effort(String(n)), n);
  assert.equal(M.number(null), "未知");
  assert.equal(M.date(null), "待核实");
  assert.equal(M.date("2026-11-02"), "2026-11-02");
  assert.equal(M.snapshot(null), "快照时间未知");
  assert.equal(M.snapshot("invalid"), "快照时间未知");
  assert.match(M.snapshot("2026-10-18T00:30:00Z"), /10\/18 08:30/);
  assert.equal(M.itemRole("be"), "后端");
  assert.equal(M.itemRole("surprise"), "岗位待核实");
  assert.equal(M.itemSource("surprise"), "来源待核实");
  assert.ok(M.validResult(result()));
  assert.ok(!M.validResult({ ...result(), readOnly: false }));
  assert.equal(M.visibleTasks(result().tasks, ["目标项目"], "", "asc").length, 2);
  const app = read("app.js");
  assert.ok(!/fetch\s*\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage/.test(app));
  assert.ok(!/AssignmentDemo|DEMO-|演示|合成示例|persona|confirmAssignment|data-select/.test(app + read("model.js") + read("index.html")));
  assert.match(read("index.html"), /connect-src 'none'/);
  assert.ok(!/target="_top"/.test(app));
  assert.match(app, /REQUEST_TIMEOUT_MS = 130000/);
  assert.match(app, /setTimeout\([^\n]+REQUEST_TIMEOUT_MS\)/);
}

async function browserChecks() {
  const { chromium } = require("playwright");
  const output = process.env.EA_PREVIEW_TEST_OUTPUT || path.join(os.tmpdir(), "ea-assignment-reference-qa");
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/fixture") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}iframe{display:block;width:100%;height:1500px;border:0}</style></head><body><iframe id="child" sandbox="allow-scripts allow-forms" src="/index.html?embed=1"></iframe><script>
        window.requests=[];window.messages=[];
        window.send=data=>document.querySelector('iframe').contentWindow.postMessage(data,'*');
        window.addEventListener('message',e=>{
          if(e.source!==document.querySelector('iframe').contentWindow||e.origin!=='null')return;
          messages.push(e.data);
          if(e.data.type==='ea-assignment-preview-height')document.querySelector('iframe').style.height=e.data.height+'px';
          if(e.data.type==='ea-assignment-preview-ready')send({type:'ea-assignment-preview-context',project:'all',projects:['目标项目'],theme:'maou',identity:{name:'不可伪造'},persona:'ui'});
          if(e.data.type==='ea-assignment-reference-request')requests.push(e.data);
        });
      </script></body></html>`);
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const type = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png" }[path.extname(file)] || "application/octet-stream";
    res.setHeader("Content-Type", `${type}; charset=utf-8`);
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.EA_PREVIEW_BROWSER || "msedge" });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    const errors = [];
    const apiRequests = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (r.url().includes("/api/")) apiRequests.push(r.url()); });
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/fixture`);
    const frame = page.frames().find(f => f.url().includes("embed=1"));
    const waitRequest = async count => { await page.waitForFunction(n => requests.length >= n, count); return page.evaluate(() => requests.at(-1)); };
    const send = async (request, payload = result(request.query), error) => page.evaluate(data => send(data), { type: "ea-assignment-reference-result", requestId: request.requestId, result: payload, error });
    let req = await waitRequest(1);
    assert.deepEqual(req.query, { project: "all", role: "", taskId: "", effort: null, forceRefresh: false });
    await page.evaluate(() => send({ type: "ea-assignment-preview-context", project: "all", projects: ["目标项目"], theme: "ikki" }));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => requests.length), 1, "duplicate context must not duplicate queries");
    await frame.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data, source: window, origin: location.origin })), { type: "ea-assignment-reference-result", requestId: req.requestId, result: result() });
    assert.equal(await frame.locator(".candidate").count(), 0, "non-parent source ignored");
    await frame.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data, source: parent, origin: "https://wrong.invalid" })), { type: "ea-assignment-reference-result", requestId: req.requestId, result: result() });
    assert.equal(await frame.locator(".candidate").count(), 0, "wrong origin ignored");
    await send(req);
    await frame.locator(".candidate").waitFor();
    assert.equal(await frame.locator(".task-item").count(), 2);
    assert.equal(await frame.locator("#identity-name").textContent(), "签名会话组长");
    assert.equal(await frame.locator("[data-role]").count(), 2);
    assert.equal(await frame.locator("#effort").inputValue(), "");
    assert.equal(await frame.locator("#task-detail img,#task-list img").count(), 0, "HTML escaped");
    assert.match(await frame.locator(".candidate").textContent(), /2项未知/);
    assert.match(await frame.locator("#snapshot").textContent(), /10\/18 08:30/);
    assert.equal(await frame.locator("#bridge-status").textContent(), M.snapshot(result().generatedAt));
    assert.equal(await frame.locator('[data-task="record-2"] strong').textContent(), "未命名需求");
    assert.equal(await frame.locator("[data-select],#confirm-assignment,#persona").count(), 0);
    const person = frame.locator("[data-evidence]");
    await person.click();
    assert.match(await frame.locator(".evidence-table").textContent(), /后端.*正式剩余/s);
    assert.match(await frame.locator(".evidence-table").textContent(), /岗位待核实.*未量化预占/s);
    assert.ok(!(await frame.locator(".evidence").textContent()).includes("unrecognized"));
    assert.match(await frame.locator(".evidence-table").textContent(), /负载来自其他项目/);
    await frame.locator("[data-work]").first().click();
    assert.match(await frame.locator("dialog").textContent(), /后端.*正式剩余/s);
    await frame.locator('[data-action="close"]').click();
    await frame.locator('[data-evidence-tab="dependency"]').click();
    assert.match(await frame.locator(".dependency-detail").textContent(), /上游交付待确认 <script>/);
    await frame.locator('[data-evidence-tab="history"]').click();
    assert.match(await frame.locator(".experience").textContent(), /暂无历史分析/);
    await frame.locator("#effort").fill("0");
    await frame.locator('#estimate-form [type="submit"]').click();
    assert.ok(await frame.locator("#estimate-error").isVisible());
    assert.equal(await page.evaluate(() => requests.length), 1);
    await frame.locator("#effort").fill("41");
    await frame.locator('#estimate-form [type="submit"]').click();
    assert.equal(await page.evaluate(() => requests.length), 1);
    await frame.locator("#effort").fill("2.5");
    await frame.locator('#estimate-form [type="submit"]').click();
    req = await waitRequest(2);
    assert.equal(req.query.effort, 2.5);
    assert.deepEqual(Object.keys(req.query).sort(), ["effort", "forceRefresh", "project", "role", "taskId"]);
    assert.equal(await frame.locator(".candidate").count(), 0, "loading clears analysis");
    await send(req);
    await frame.locator(".candidate").waitFor();
    assert.equal(await frame.locator(".task-item").count(), 2, "analysis cannot assign or remove task");
    assert.equal(await frame.locator(".success-receipt").count(), 0);
    await frame.locator('[data-task="record-2"]').click();
    req = await waitRequest(3);
    assert.equal(req.query.effort, null, "task changes clear estimate");
    await send(req);
    await frame.locator(".candidate").waitFor();
    assert.equal(await frame.locator('.detail-title h2').textContent(), '未命名需求');
    await frame.locator('#search').fill('REQ-101');
    assert.equal(await frame.locator('.task-item').count(), 1);
    await frame.locator('#search').fill('');
    await frame.locator('#time-sort').click();
    assert.equal(await frame.locator('.task-item').first().getAttribute('data-task'), 'record-2');
    assert.equal(await page.evaluate(() => requests.length), 3, 'search and sort stay local');
    await frame.locator('[data-role="be"]').click();
    const older = await waitRequest(4);
    await page.evaluate(() => send({ type: "ea-assignment-preview-context", project: "新项目" }));
    req = await waitRequest(5);
    assert.equal(await frame.locator('.task-item,.candidate').count(), 0, 'project change clears old data');
    await send(older);
    await page.waitForTimeout(50);
    assert.equal(await frame.locator('.candidate').count(), 0, 'stale response ignored');
    await send(req, { ok: false, httpStatus: 403, message: '无权限查看该项目' });
    await frame.locator('[data-action="retry"]').waitFor();
    assert.match(await frame.locator('#bridge-status').textContent(), /无权限/);
    await frame.locator('[data-action="retry"]').click();
    req = await waitRequest(6);
    assert.equal(req.query.forceRefresh, true);
    await send(req, null, '服务暂不可用');
    await frame.locator('[data-action="retry"]').waitFor();
    await frame.locator('[data-action="retry"]').click();
    req = await waitRequest(7);
    await send(req, { ...result(req.query), readOnly: false });
    await frame.locator('[data-action="retry"]').waitFor();
    assert.equal(await frame.locator('.candidate').count(), 0);
    await frame.locator('[data-action="retry"]').click();
    req = await waitRequest(8);
    await send(req, { ...result(req.query), tasks: [], taskId: '', candidates: [] });
    await frame.locator('#task-detail .empty-state').waitFor();
    assert.match(await frame.locator('#task-detail').textContent(), /暂无可分析需求/);
    await page.evaluate(() => send({ type: 'ea-assignment-preview-context', project: 'all', projects: ['目标项目'] }));
    req = await waitRequest(9);
    await send(req);
    await frame.locator('.candidate').waitFor();
    const heightSettled = async () => {
      await page.waitForTimeout(150);
      const geometry = await frame.evaluate(() => ({
        bottom: document.querySelector('.candidate:last-child').getBoundingClientRect().bottom,
        innerHeight,
        bodyHeight: document.body.getBoundingClientRect().height,
        scrollY
      }));
      assert.ok(geometry.bottom + geometry.scrollY <= geometry.innerHeight + 1, `last candidate fits iframe: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.bodyHeight <= geometry.innerHeight + 1, 'footer fits iframe too');
    };
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (width <= 760) {
        await frame.locator('.mobile-back').click();
        await frame.locator('.task-item.selected').click();
      }
      assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `no page overflow at ${width}`);
      assert.ok(await frame.locator('.candidate').isVisible());
      await frame.locator('[data-evidence]').click();
      assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `no evidence overflow at ${width}`);
      await heightSettled();
      if (width === 1440 || width === 320 || width === 390) {
        await page.evaluate(() => scrollTo(0, 0));
        await frame.evaluate(() => scrollTo(0, 0));
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(output, `reference-${width}.png`), fullPage: true });
      }
      await frame.locator('[data-evidence]').click();
    }
    await frame.locator('#refresh').click();
    req = await waitRequest(10);
    assert.equal(req.query.taskId, '', 'refresh must recover if a former task was assigned or removed');
    assert.equal(req.query.effort, null, 'refresh cannot reuse an estimate for another task');
    const large = result(req.query);
    large.candidates = Array.from({ length: 18 }, (_, n) => ({ ...large.candidates[0], id: `large-person-${n}`, name: `候选人${n + 1}`, items: Array.from({ length: 24 }, (_, i) => ({ ...large.candidates[0].items[0], id: `large-work-${i}`, title: `关联负载需求 ${i + 1}` })) }));
    await send(req, large);
    await frame.locator('.candidate').last().waitFor();
    await heightSettled();
    await frame.locator('[data-evidence]').last().click();
    await heightSettled();
    assert.equal(await frame.locator('.evidence-table tbody tr').count(), 24);
    assert.ok(await frame.locator('svg').count() > 8, 'local icons rendered');
    await page.clock.install();
    await page.evaluate(() => send({ type: 'ea-assignment-preview-context', project: 'timeout-project' }));
    await waitRequest(11);
    await page.clock.runFor(31000);
    assert.match(await frame.locator('#bridge-status').textContent(), /正在查询/, '31.5s real table query must not time out at 30s');
    await page.clock.runFor(98000);
    assert.match(await frame.locator('#bridge-status').textContent(), /正在查询/, 'child waits longer than parent 120s');
    await page.clock.runFor(2000);
    assert.match(await frame.locator('#bridge-status').textContent(), /超时/);
    await page.clock.resume();
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`${base}/index.html?persona=ui&identity=forged`);
    assert.ok(await page.locator('a[href="/demand-h5.html?panel=assignment"]').isVisible());
    assert.equal(await page.locator('.candidate,[data-role]').count(), 0);
    assert.equal(await page.locator('#identity-name').textContent(), '身份待确认');
    assert.deepEqual(apiRequests, []);
    assert.deepEqual(errors, []);
    console.log(`Assignment reference browser checks passed: sandbox bridge, source/origin, stale results, read-only, estimates, errors/retry/timeout, empty/403, Chinese mappings, mobile 320-1440. Screenshots: ${output}`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  modelChecks();
  console.log("Assignment reference model/static checks passed");
  if (!process.argv.includes("--model-only")) await browserChecks();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
