"use strict";

const assert = require("node:assert/strict");
const { createAssignmentReferenceService } = require("../src/modules/devProgress/assignmentReference");
const FIELDS = ["需求Id", "项目", "需求名称", "需求内容", "需求类型", "需求进度", "前端开发", "前端耗时", "前端剩余", "后端开发", "后端耗时", "后端剩余", "UI人员", "UI耗时", "UI剩余时间", "UI需求", "UI进度", "UI日方时间", "美术截止日期", "开发截止日期", "更新时间", "备注", "前端组长", "后端组长"];
const NOW = Date.parse("2026-10-19T02:00:00Z");
const DAYS = ["2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26"];
function record(id, fields = {}) {
  return { recordId: `r${id}`, fields: { "需求Id": `00${id}`, "需求名称": `Task${id}`, "需求类型": "新功能", "项目": "P", "需求进度": "待分配", "前端开发": "", "后端开发": "-", "UI需求": "-", "UI人员": "-", "开发截止日期": "2026-10-20", "美术截止日期": "2026-10-20", ...fields } };
}
function fixture(rows = [record(1)], overrides = {}) {
  let time = NOW;
  const settings = { enabled: true, ready: true, docid: "doc", sheetId: "sheet", viewId: "view", fieldMapping: {}, personAliases: { Alice: ["A"] }, rules: { requiredFields: { fallbackOwners: ["Boss"], leaders: { "前端组长": { memberField: "前端开发", names: ["L3"], memberGroups: { L3: ["Carol"] } } } } } };
  const workflow = { normalizedRules: { roles: {
    "前端开发": { leaderNames: ["L1", "L2"], memberNames: ["Alice", "Bob"], leaderMemberNames: { L1: ["Alice"], L2: ["Bob"] } },
    "后端开发": { leaderNames: ["BL"], memberNames: ["A"] },
    "UI人员": { leaderNames: ["UL"], memberNames: ["Artist"] }
  } } };
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const service = createAssignmentReferenceService({ getSettings: () => settings, getWorkflowRulesSettings: () => workflow,
    nowMs: () => time, readFieldDefinitions: async () => ({ ok: true, fields: FIELDS.map((title) => ({ title })) }),
    readWorkdayCalendar: async () => ({ ok: true, dates: DAYS }),
    readRecords: async (s, o) => {
      assert.equal(s.docid, settings.docid);
      assert(o.fieldTitles.includes("前端剩余"));
      assert(!o.fieldTitles.includes("不存在"));
      assert.equal(o.limit, 500);
      calls.push(o);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return { ok: true, records: rows.slice(o.offset, o.offset + o.limit), total: rows.length, hasMore: o.offset + o.limit < rows.length };
    }, ...overrides });
  return { service, settings, workflow, calls, advance: (ms) => { time += ms; }, maxActive: () => maxActive };
}
const tests = [];
function test(name, run) { tests.push({ name, run }); }
const query = (f, extra = {}) => f.service.query({ userName: "L1", role: "fe", effort: 1, ...extra });

test("authorization precedes network; members and role escalation denied", async () => {
  const f = fixture();
  assert.equal((await query(f, { userName: "Alice", identity: { isFallback: true } })).httpStatus, 403);
  assert.equal((await query(f, { role: "be" })).httpStatus, 403);
  assert.equal((await query(f, { userName: "" })).httpStatus, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await query(f, { userName: "Boss", role: "be" })).roles.length, 3);
  assert.equal((await query(f, { userName: "L3" })).ok, true);
});
test("same-role leaders see the whole pool including other groups", async () => {
  const f = fixture();
  const a = await query(f);
  const b = await query(f, { userName: "L2" });
  assert.deepEqual(a.candidates.map((c) => c.name).sort(), ["Alice", "Bob", "Carol"]);
  assert.deepEqual(a.candidates, b.candidates);
  assert.equal(a.version, "0.2.0");
  assert.equal(a.readOnly, true);
  assert(a.candidates.every((c) => c.reasons.some((r) => r.includes("资格未校验"))));
});
test("target filtering respects participation, state, type, and project", async () => {
  const f = fixture([record(1), record(2, { "前端开发": "-" }), record(3, { "前端开发": "Alice" }), record(4, { "需求类型": "任务拆分" }), record(5, { "项目": "Q" }), record(6, { "需求进度": "实现中" })]);
  const r = await query(f, { project: "P" });
  assert.deepEqual(r.tasks.map((t) => t.id), ["r1"]);
  assert.equal(r.tasks[0].demandId, "001");
  assert.equal((await query(f, { taskId: "r3" })).httpStatus, 404);
});
test("cross-role alias and cross-project load merge; project filters targets only", async () => {
  const f = fixture([record(1), record(2, { "项目": "Q", "需求进度": "实现中", "前端开发": "Alice", "前端耗时": 3, "前端剩余": 2 }), record(3, { "项目": "Q", "需求进度": "实现中", "前端开发": "-", "后端开发": "A", "后端耗时": 3, "后端剩余": 2 })]);
  const c = (await query(f, { project: "P" })).candidates.find((c) => c.name === "Alice");
  assert.equal(c.total, 4);
  assert.equal(c.baseline, 2);
  assert.equal(c.gap, 3);
  assert.equal(c.delta, 1);
  assert.equal(c.status, "conflict");
  assert.equal(c.items.length, 2);
});
test("unknown is not zero; assigned pending tasks reserve unknown effort", async () => {
  const f = fixture([record(1), record(2, { "前端开发": "Alice", "前端剩余": 9 }), record(3, { "需求进度": "实现中", "前端开发": "Alice", "前端剩余": "" }), record(4, { "需求进度": "实现中", "前端开发": "Bob", "前端剩余": 0 })]);
  const r = await query(f);
  const a = r.candidates.find((c) => c.name === "Alice");
  const b = r.candidates.find((c) => c.name === "Bob");
  assert.equal(a.unknownCount, 2);
  assert.equal(a.total, 0);
  assert.equal(a.status, "missing");
  assert.equal(a.items[0].source, "unknown_reservation");
  assert.equal(a.reservation, 0);
  assert.equal(b.unknownCount, 0);
  assert.equal(b.items.length, 0);
});
test("multiple owners and conflicting userRefs produce unknown, not duplicated effort", async () => {
  const a = record(2, { "需求进度": "实现中", "前端开发": "Alice、Bob", "前端剩余": 4 });
  a.userRefs = [{ name: "Alice", userId: "u1" }, { name: "A", userId: "u2" }];
  const f = fixture([record(1), a]);
  const r = await query(f);
  assert(r.candidates.filter((c) => ["Alice", "Bob"].includes(c.name)).every((c) => c.total === 0 && c.status === "missing"));
});
test("calendar includes today and due day; overdue work occupies future; paused excluded", async () => {
  const f = fixture([record(1, { "开发截止日期": "2026-10-19" }), record(2, { "需求进度": "实现中", "前端开发": "Alice", "前端剩余": 2, "开发截止日期": "2026-10-16" }), record(3, { "需求进度": "暂停中", "前端开发": "Alice", "前端剩余": 50 })]);
  const c = (await query(f)).candidates.find((c) => c.name === "Alice");
  assert.equal(c.total, 2);
  assert.equal(c.gap, 2);
  assert.equal(c.baseline, 1);
  assert.equal(c.delta, 1);
  assert(c.reasons.some((r) => r.includes("逾期")));
  const b = (await query(f)).candidates.find((c) => c.name === "Bob");
  assert.equal(b.gap, 0);
  assert.equal(b.status, "conditional");
});
test("missing dates and missing calendar never use weekday assumptions", async () => {
  const f = fixture([record(1, { "开发截止日期": "10月20日" })]);
  assert((await query(f)).candidates.every((c) => c.status === "missing" && c.gap === null));
  const g = fixture(undefined, { readWorkdayCalendar: async () => ({ ok: false, dates: [] }) });
  assert((await query(g)).candidates.every((c) => c.status === "missing"));
});
test("dependency evidence incomplete; UI complete overrides stale positive remaining", async () => {
  const rows = [record(1, { "UI需求": "需要", "UI进度": "日方制作中", "UI日方时间": "2026-10-16", "后端开发": "Bob", "后端剩余": "" }), record(2, { "需求进度": "实现中", "前端开发": "-", "UI人员": "Alice", "UI需求": "需要", "UI进度": "已提交", "UI剩余时间": 4 })];
  const r = await query(fixture(rows));
  const a = r.candidates.find((c) => c.name === "Alice");
  assert.equal(a.total, 0);
  assert.equal(a.status, "missing");
  assert(a.dependencies.some((s) => s.includes("逾期")));
  assert(a.dependencies.some((s) => s.includes("联调")));
});
test("UI missing participation warns; bug without estimate has no new-task metrics", async () => {
  const f = fixture([record(1, { "UI需求": "", "UI人员": "", "需求类型": "Bug" })]);
  const r = await query(f, { userName: "UL", role: "ui", effort: null });
  assert.equal(r.tasks.length, 1);
  assert(r.tasks[0].warnings.length > 0);
  assert(r.candidates.every((c) => c.gap === null && !c.quantified && c.status === "missing"));
});
test("active positive remaining survives late lifecycle stages", async () => {
  const f = fixture([record(1), record(2, { "需求进度": "内网验收中", "前端开发": "Alice", "前端剩余": 2 })]);
  assert.equal((await query(f)).candidates.find((c) => c.name === "Alice").total, 2);
});
test("same userId with different display names merges across roles", async () => {
  const fe = record(2, { "需求进度": "实现中", "前端开发": "Alice", "前端剩余": 2 });
  fe.userRefs = [{ name: "Alice", userId: "u1" }];
  const be = record(3, { "需求进度": "实现中", "前端开发": "-", "后端开发": "AliceOld", "后端剩余": 3 });
  be.userRefs = [{ name: "AliceOld", userId: "u1" }];
  const f = fixture([record(1), fe, be]);
  const a = (await query(f)).candidates.find((c) => c.name === "Alice");
  assert.equal(a.total, 5);
  assert.equal(a.items.length, 2);
});
test("full pagination, max concurrency two, TTL, forced refresh joins inflight", async () => {
  const rows = Array.from({ length: 1601 }, (_, i) => record(i));
  const f = fixture(rows);
  const [a, b] = await Promise.all([query(f), query(f, { forceRefresh: true })]);
  assert.equal(a.source.recordCount, 1601);
  assert.equal(b.source.sharedInflight, true);
  assert.equal(f.calls.length, 4);
  assert.equal(f.maxActive(), 2);
  assert.equal((await query(f)).source.cacheHit, true);
  f.advance(60000);
  await query(f);
  assert.equal(f.calls.length, 8);
  await query(f, { forceRefresh: true });
  assert.equal(f.calls.length, 12);
  f.settings.viewId = "other";
  await query(f);
  assert.equal(f.calls.length, 16);
  f.settings.fieldMapping.extra = "备注";
  await query(f);
  assert.equal(f.calls.length, 20);
});
test("failed page and incomplete source are not normal partial success", async () => {
  let calls = 0;
  const f = fixture(undefined, { readRecords: async (_, o) => {
    calls++;
    if (o.offset) return { ok: false, records: [] };
    return { ok: true, total: 600, hasMore: true, records: Array.from({ length: 500 }, (_, i) => record(i)) };
  } });
  const r = await query(f);
  assert.equal(r.ok, false);
  assert.equal(r.candidates.length, 0);
  await query(f);
  assert.equal(calls, 4);
  const g = fixture(undefined, { readRecords: async () => ({ ok: true, incomplete: true, records: [record(1)] }) });
  assert.equal((await query(g)).ok, false);
});
test("schema intersection, required schema failure, inconsistent totals and read cap", async () => {
  const f = fixture(undefined, { readFieldDefinitions: async () => ({ ok: true, fieldTitles: FIELDS.filter((f) => f !== "前端剩余") }) });
  const r = await query(f);
  assert.equal(r.ok, false);
  assert(r.message.includes("前端剩余"));
  assert.equal(f.calls.length, 0);
  for (const result of [
    { ok: true, total: 10001, records: [] },
    { ok: true, total: 2, hasMore: false, records: [record(1)] },
    { ok: true, total: 1, hasMore: true, records: [record(1)] }
  ]) assert.equal((await query(fixture(undefined, { readRecords: async () => result }))).ok, false);
});
test("upstream error bodies never leak into logs or response", async () => {
  const logs = [];
  const f = fixture(undefined, { logger: { warn: (...args) => logs.push(args) }, readRecords: async () => { throw new Error("secret-token-body"); } });
  const result = await query(f);
  assert(!JSON.stringify([result, logs]).includes("secret-token-body"));
  assert.equal(logs[0][1].reason, "generic");
});
test("internal read failures log a safe diagnostic reason without upstream bodies", async () => {
  const logs = [];
  const f = fixture(undefined, { logger: { warn: (...args) => logs.push(args) },
    readRecords: async () => ({ ok: false, message: "upstream-secret-body", records: [] }) });
  assert.equal((await query(f)).ok, false);
  assert.equal(logs[0][1].reason, "记录读取失败或不完整");
  assert(!JSON.stringify(logs).includes("upstream-secret-body"));
  const schemaLogs = [];
  const g = fixture(undefined, { logger: { warn: (...args) => schemaLogs.push(args) },
    readFieldDefinitions: async () => ({ ok: true, fieldTitles: FIELDS.filter((f) => f !== "UI进度") }) });
  await query(g);
  assert.equal(schemaLogs[0][1].reason, "缺少必需字段：UI进度");
});
test("optional schema intersection explicitly requests only existing fields", async () => {
  const titles = FIELDS.filter((f) => !["更新时间", "备注", "需求内容", "前端组长", "后端组长"].includes(f));
  const f = fixture(undefined, { readFieldDefinitions: async () => ({ ok: true, fieldTitles: titles }) });
  assert.equal((await query(f)).ok, true);
  assert(!f.calls[0].fieldTitles.includes("备注"));
});
test("pagination without total is complete; duplicate pages and changing totals fail", async () => {
  const rows = Array.from({ length: 501 }, (_, i) => record(i));
  const f = fixture(rows, { readRecords: async (_, o) => ({ ok: true, hasMore: o.offset + 500 < rows.length, records: rows.slice(o.offset, o.offset + 500) }) });
  assert.equal((await query(f)).source.recordCount, 501);
  for (const mode of ["duplicate", "changed"]) {
    const g = fixture(rows, { readRecords: async (_, o) => ({ ok: true, total: mode === "changed" && o.offset ? 502 : 501, hasMore: o.offset === 0, records: o.offset ? [rows[0]] : rows.slice(0, 500) }) });
    assert.equal((await query(g)).ok, false);
  }
});
test("cache is reauthorized on every query; doc and sheet changes invalidate it", async () => {
  const f = fixture();
  await query(f);
  f.workflow.normalizedRules.roles["前端开发"].leaderNames = [];
  assert.equal((await query(f)).httpStatus, 403);
  assert.equal(f.calls.length, 1);
  f.workflow.normalizedRules.roles["前端开发"].leaderNames = ["L1"];
  f.settings.docid = "doc2";
  await query(f);
  f.settings.sheetId = "sheet2";
  await query(f);
  assert.equal(f.calls.length, 3);
});
test("formal zero is real zero but invalid remainder and future calendar gaps are missing", async () => {
  const f = fixture([record(1), record(2, { "需求进度": "实现中", "前端开发": "Alice", "前端耗时": 1, "前端剩余": 2 })]);
  const r = await query(f, { effort: 1 });
  assert.equal(r.candidates.find((c) => c.name === "Alice").status, "missing");
  assert.equal(r.candidates.find((c) => c.name === "Bob").gap, 0);
  assert.equal((await query(f, { effort: -1 })).httpStatus, 400);
  const g = fixture([record(1, { "开发截止日期": "2027-01-01" })]);
  assert((await query(g)).candidates.every((c) => c.status === "missing"));
});

test("all project sentinel includes actual projects", async () => {
  const f = fixture([record(1), record(2, { "项目": "Q" })]);
  assert.equal((await query(f, { project: "all" })).tasks.length, 2);
});
test("real Unix milliseconds and seconds date fields use Shanghai calendar labels", async () => {
  const f = fixture([record(1, { "开发截止日期": String(Date.parse("2026-10-20T00:00:00Z")), "更新时间": "1762963200000" }),
    record(2, { "需求进度": "实现中", "前端开发": "Alice", "前端剩余": 2, "开发截止日期": String(Date.parse("2026-10-19T00:00:00Z") / 1000) })]);
  const r = await query(f);
  assert.equal(r.tasks[0].deadline, "2026-10-20");
  const a = r.candidates.find((c) => c.name === "Alice");
  assert.equal(a.items[0].due, "2026-10-19");
  assert.equal(a.baseline, 1);
  const g = fixture([record(1, { "开发截止日期": "2026-02-30" })]);
  assert.equal((await query(g)).tasks[0].deadline, null);
  const h = fixture([record(1, { "开发截止日期": "1762963200000" })]);
  assert.equal((await query(h)).tasks[0].deadline, "2025-11-13");
});
test("Shanghai midnight numeric dates align with explicitly offset workday reader", async () => {
  const millis = Date.parse("2026-10-19T00:00:00+08:00");
  const seconds = millis / 1000;
  const options = [];
  const f = fixture([record(1, { "开发截止日期": String(millis) }),
    record(2, { "需求进度": "实现中", "前端开发": "Alice", "前端剩余": 1, "开发截止日期": String(seconds) })], {
    readWorkdayCalendar: async (_, o) => {
      options.push(o);
      return { ok: true, dates: ["2026-10-16", "2026-10-19", "2026-10-20", "2026-10-26"] };
    }
  });
  const r = await query(f);
  assert.equal(r.tasks[0].deadline, "2026-10-19");
  const a = r.candidates.find((c) => c.name === "Alice");
  assert.equal(a.items[0].due, "2026-10-19");
  assert.equal(a.baseline, 0);
  assert.equal(a.gap, 1);
  assert(!r.calendar.workdays.includes("2026-10-18"));
  assert(!r.calendar.workdays.includes("2026-10-25"));
  assert.deepEqual(options, [{ forceRefresh: false, utcOffsetMinutes: 480 }]);
  await query(f, { forceRefresh: true });
  assert.deepEqual(options[1], { forceRefresh: true, utcOffsetMinutes: 480 });
  const beforeMidnight = fixture([record(1, { "开发截止日期": String(millis - 1) })]);
  assert.equal((await query(beforeMidnight)).tasks[0].deadline, "2026-10-18");
});
test("effort bounds reject before any schema, record or calendar network call", async () => {
  let reads = 0;
  const f = fixture(undefined, { readFieldDefinitions: async () => { reads++; throw Error("unexpected"); } });
  for (const effort of [0, -1, 40.01, Infinity, NaN, "9".repeat(400), "no", true]) {
    assert.equal((await query(f, { effort })).httpStatus, 400);
  }
  assert.equal(reads, 0);
  assert.equal(f.calls.length, 0);
  assert.equal((await query(fixture(), { effort: 40 })).ok, true);
  assert.equal((await query(fixture(), { effort: 0.2 })).ok, true);
});
test("disabled or unready settings cannot read even cached data", async () => {
  const f = fixture();
  await query(f);
  for (const flag of ["enabled", "ready"]) {
    f.settings[flag] = false;
    const r = await query(f);
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 503);
    f.settings[flag] = true;
  }
  assert.equal(f.calls.length, 1);
});
test("cached generatedAt stays the snapshot completion time, queriedAt advances", async () => {
  const f = fixture();
  const a = await query(f);
  f.advance(30000);
  const b = await query(f);
  assert.equal(a.generatedAt, b.generatedAt);
  assert.notEqual(a.queriedAt, b.queriedAt);
  const c = await query(f, { forceRefresh: true });
  assert.notEqual(a.generatedAt, c.generatedAt);
});
test("existing Bug formal remaining is preserved; missing Bug remaining stays unknown", async () => {
  const f = fixture([record(1), record(2, { "需求类型": "配置bug", "需求进度": "实现中", "前端开发": "Alice", "前端剩余": 1.5 }),
    record(3, { "需求类型": "Bug", "需求进度": "实现中", "前端开发": "Alice", "前端剩余": "" })]);
  const a = (await query(f)).candidates.find((c) => c.name === "Alice");
  assert.equal(a.total, 1.5);
  assert.equal(a.unknownCount, 1);
  assert.equal(a.items[0].source, "formal_remaining");
});

test("ungrouped UI and backend use a sole configured leader; multiple leaders remain unassigned", async () => {
  const f = fixture([record(1, { "后端开发": "", "UI需求": "需要", "UI人员": "" })]);
  for (const [role, field, leader] of [["be", "后端开发", "王谦"], ["ui", "UI人员", "王文静"]]) {
    f.workflow.normalizedRules.roles[field].leaderNames = [leader];
    f.workflow.normalizedRules.roles[field].leaderMemberNames = {};
    const single = await query(f, { userName: "Boss", role });
    assert(single.candidates.length > 0);
    assert(single.candidates.every((c) => c.leader === leader));
    f.workflow.normalizedRules.roles[field].leaderNames = [leader, "OtherLeader"];
    const multiple = await query(f, { userName: "Boss", role });
    assert(multiple.candidates.every((c) => c.leader === `${leader}、OtherLeader（归属待核实）`));
    assert(multiple.candidates.every((c) => c.reasons.some((r) => r.includes("未明确个人归属"))));
  }
  f.workflow.normalizedRules.roles["后端开发"].leaderMemberNames = { SpecificLeader: ["SomeoneElse"] };
  const grouped = await query(f, { userName: "Boss", role: "be" });
  assert.equal(grouped.candidates.find((c) => c.name === "Alice").leader, "");
  assert.equal(grouped.candidates.find((c) => c.name === "SomeoneElse").leader, "SpecificLeader");
});
test("blank title and project remain raw and have explicit task warnings", async () => {
  const f = fixture([record(1, { "需求名称": "  ", "项目": "" })]);
  const r = await query(f, { project: "all" });
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].title, "");
  assert.equal(r.tasks[0].project, "");
  assert(r.tasks[0].warnings.includes("需求名称缺失"));
  assert(r.tasks[0].warnings.includes("项目缺失"));
});
test("calendar preserves Saturday explicitly supplied as a company workday", async () => {
  const dates = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-26"];
  const f = fixture([record(1, { "开发截止日期": "2026-10-24" }), record(2, { "需求进度": "实现中", "前端开发": "Alice", "前端剩余": 5, "开发截止日期": "2026-10-24" })], {
    readWorkdayCalendar: async () => ({ ok: true, dates })
  });
  const r = await query(f);
  assert.deepEqual(r.calendar.workdays, dates);
  assert.equal(r.candidates.find((c) => c.name === "Alice").gap, 0);
});

(async () => {
  for (const t of tests) {
    await t.run();
    console.log(`PASS ${t.name}`);
  }
  console.log(`PASS ${tests.length} assignment reference tests (synthetic data; no production environment)`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
