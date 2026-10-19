"use strict";

const VERSION = "0.2.1";
const ROLES = [
  { id: "fe", name: "前端", field: "前端开发", total: "前端耗时", remaining: "前端剩余", owner: "frontend", due: "开发截止日期", leader: "前端组长" },
  { id: "be", name: "后端", field: "后端开发", total: "后端耗时", remaining: "后端剩余", owner: "backend", due: "开发截止日期", leader: "后端组长" },
  { id: "ui", name: "美术", field: "UI人员", total: "UI耗时", remaining: "UI剩余时间", owner: "ui", due: "美术截止日期", leader: "UI组长" }
];
const REQUIRED = ["需求Id", "项目", "需求名称", "需求类型", "需求进度", "UI需求", "UI进度", "UI日方时间",
  ...ROLES.flatMap((r) => [r.field, r.total, r.remaining, r.due])];
const NEEDED = [...new Set([...REQUIRED, "需求内容", "更新时间", "备注", "前端组长", "后端组长"])];
const UI_DONE = new Set(["制作完成", "制作完成（未监修或提交）", "已监修", "已提交"]);
const INACTIVE = new Set(["暂停中", "暂停", "已拒绝", "已完成", "已上线", "上线", "已取消", "取消", "已关闭"]);
const str = (v) => String(v ?? "").trim();
const names = (v) => [...new Set((Array.isArray(v) ? v : str(v).split(/[、,，;；|\s]+/)).map((n) => str(typeof n === "object" ? n.name : n)).filter(Boolean))];
const number = (v) => str(v) !== "" && /^\d+(?:\.\d+)?$/.test(str(v)) ? Number(v) : null;
const round = (v) => Math.round(v * 1e6) / 1e6;
class ReadError extends Error {}
function date(v) {
  const text = str(v);
  if (/^(?:\d{10}|\d{13})$/.test(text)) {
    const d = new Date(Number(text) * (text.length === 10 ? 1000 : 1) + 480 * 60000);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  }
  const m = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|(?:[T ]\d.*))?$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
    ? d.toISOString().slice(0, 10) : null;
}
function todayAt(ms) {
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  return value;
}
function aliasResolver(aliases = {}) {
  const index = new Map();
  for (const [canonical, values] of Object.entries(aliases)) {
    for (const n of [canonical, ...names(values)]) {
      if (!index.has(n)) index.set(n, new Set());
      index.get(n).add(canonical);
    }
  }
  return (n) => {
    const hits = index.get(str(n));
    return hits?.size > 1 ? null : hits?.size === 1 ? [...hits][0] : str(n);
  };
}
function value(record, title) {
  if (Object.prototype.hasOwnProperty.call(record.fields || {}, title)) return record.fields[title];
  const s = record.standard || {};
  const keys = { "需求Id": "demandId", "项目": "project", "需求名称": "demand", "需求内容": "demandContent", "需求类型": "demandType", "需求进度": "status" };
  if (keys[title]) return s[keys[title]] ?? (title === "需求进度" ? s.progress : "") ?? "";
  const role = ROLES.find((r) => r.field === title);
  if (role) return s.owners?.[role.owner] ?? "";
  if (title === "开发截止日期") return s.dates?.devDeadline ?? "";
  return "";
}
function participates(record, role) {
  return str(value(record, role.field)) !== "-" && (role.id !== "ui" || str(value(record, "UI需求")) !== "-");
}
function roleConfig(settings, workflow, role) {
  const config = workflow.normalizedRules?.roles?.[role.field] || {};
  const leaders = [];
  const groups = { ...(config.leaderMemberNames || {}) };
  for (const [key, entry] of Object.entries(settings.rules?.requiredFields?.leaders || {})) {
    if (entry.memberField === role.field || key === role.leader) {
      leaders.push(...names(entry.names), ...Object.keys(entry.memberGroups || {}));
      for (const [name, members] of Object.entries(entry.memberGroups || {})) groups[name] = [...names(groups[name]), ...names(members)];
    }
  }
  return { leaders: [...new Set([...names(config.leaderNames), ...leaders])], groups,
    members: [...new Set([...names(config.memberNames), ...Object.values(groups).flatMap(names)])] };
}

// Readers use the original client convention: readRecords(settings, options).
// This service never writes source records, files, or notifications.
function createAssignmentReferenceService({ getSettings, getWorkflowRulesSettings, readFieldDefinitions, readRecords, readWorkdayCalendar, resolveProjectName = (name) => name, nowMs = Date.now, logger } = {}) {
  let cached = null;
  const inflight = new Map();
  let activeReads = 0;
  const waitingReads = [];
  async function readPage(settings, options) {
    if (activeReads >= 2) await new Promise((resolve) => waitingReads.push(resolve));
    else activeReads++;
    try { return await readRecords(settings, options); }
    finally {
      const next = waitingReads.shift();
      if (next) next();
      else activeReads--;
    }
  }
  async function load(settings, key, forceRefresh) {
    if (inflight.has(key)) return { data: await inflight.get(key), cacheHit: false, sharedInflight: true };
    if (!forceRefresh && cached?.key === key && nowMs() - cached.at < 60000) return { data: cached.data, cacheHit: true, sharedInflight: false };
    const promise = (async () => {
      const schema = await readFieldDefinitions(settings);
      if (!schema?.ok) throw new ReadError("无法读取真实字段定义");
      const titles = new Set(schema.fieldTitles || schema.fields?.map((f) => f.title) || []);
      const missing = [...new Set(REQUIRED)].filter((f) => !titles.has(f));
      if (missing.length) throw new ReadError(`缺少必需字段：${missing.join("、")}`);
      const fieldTitles = NEEDED.filter((f) => titles.has(f));
      const records = [];
      let expected = null;
      let pages = 0;
      let done = false;
      async function page(offset) {
        const result = await readPage(settings, { limit: 500, offset, fieldTitles });
        if (!result?.ok || result.incomplete || result.partial || result.status === "incomplete" || !Array.isArray(result.records)) throw new ReadError("记录读取失败或不完整");
        if (result.records.length > 500) throw new ReadError("分页返回数量超出限制");
        const total = result.total == null ? null : Number(result.total);
        if (total !== null && (!Number.isInteger(total) || total < 0 || total > 10000)) throw new ReadError("记录总数无效或超过10000上限");
        if (total !== null) {
          if (expected !== null && total !== expected) throw new ReadError("分页期间记录总数变化，请刷新重试");
          expected = total;
        }
        return { ...result, offset };
      }
      function consume(p) {
        pages++;
        if (done) {
          if (p.records.length) throw new ReadError("分页结束标志与后续数据冲突");
          return;
        }
        records.push(...p.records);
        const end = p.offset + p.records.length;
        if (p.hasMore === true && p.records.length < 500) throw new ReadError("分页不足500条但仍有后续数据");
        if (expected !== null && (end > expected || (p.hasMore === false && end < expected))) throw new ReadError("分页结果与总数不一致");
        done = p.hasMore === false || (expected !== null && end === expected) || (p.hasMore == null && expected === null && p.records.length < 500);
        if (done && p.hasMore === true) throw new ReadError("分页结束条件矛盾");
      }
      consume(await page(0));
      let offset = 500;
      while (!done && offset < 10000) {
        const offsets = [offset];
        if (offset + 500 < 10000 && (expected === null || offset + 500 < expected)) offsets.push(offset + 500);
        // Wait for both requests even on failure; no orphan production reads.
        const results = await Promise.allSettled(offsets.map(page));
        if (results.some((r) => r.status === "rejected")) throw results.find((r) => r.status === "rejected").reason;
        for (const r of results) consume(r.value);
        offset += offsets.length * 500;
      }
      if (!done || (expected !== null && expected !== records.length)) throw new ReadError("记录不完整或超过10000上限");
      const ids = records.map((r) => str(r.recordId || r.id));
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new ReadError("记录主键缺失或分页重复");
      const calendar = await readWorkdayCalendar(settings, { forceRefresh: Boolean(forceRefresh), utcOffsetMinutes: 480 });
      const completedAt = nowMs();
      const data = { records, calendar, pages, fieldTitles, generatedAt: new Date(completedAt).toISOString() };
      cached = { key, at: completedAt, data };
      logger?.info?.("assignment_reference_read", { recordCount: records.length, pageCount: pages, fieldCount: fieldTitles.length });
      return data;
    })();
    inflight.set(key, promise);
    try { return { data: await promise, cacheHit: false, sharedInflight: false }; }
    finally { inflight.delete(key); }
  }

  async function query(input = {}) {
    const queriedAt = new Date(nowMs()).toISOString();
    const base = { ok: false, status: "error", message: "", version: VERSION, readOnly: true, generatedAt: null, queriedAt,
      identity: { name: str(input.userName), isFallback: false }, roles: [], role: null, tasks: [], taskId: null,
      calendar: { ok: false, firstDate: null, lastDate: null, today: todayAt(nowMs()), workdays: [] }, candidates: [], warnings: [], source: { recordCount: 0, cacheHit: false } };
    const fail = (status, message, httpStatus) => ({ ...base, status, message, httpStatus });
    try {
      const settings = structuredClone(await getSettings());
      const workflow = await getWorkflowRulesSettings();
      const canonical = aliasResolver(settings.personAliases);
      const who = canonical(str(input.userName));
      const configs = Object.fromEntries(ROLES.map((r) => [r.id, roleConfig(settings, workflow, r)]));
      if (!who) return fail("forbidden", "身份别名冲突", 403);
      const same = (n) => canonical(n) === who;
      base.identity.isFallback = Boolean(who && names(settings.rules?.requiredFields?.fallbackOwners).some(same));
      const allowed = ROLES.filter((r) => base.identity.isFallback || configs[r.id].leaders.some(same));
      base.roles = allowed.map(({ id, name, field }) => ({ id, name, field }));
      if (!str(input.userName) || !allowed.length) return fail("forbidden", "仅岗位组长或总兜底可查询分配参考", 403);
      const role = input.role ? allowed.find((r) => r.id === input.role) : allowed[0];
      if (!role) return fail("forbidden", "无权查询该岗位", 403);
      base.role = role.id;
      const effort = input.effort == null || str(input.effort) === "" ? null : number(input.effort);
      if (input.effort != null && str(input.effort) !== "" && (effort === null || !Number.isFinite(effort) || effort <= 0 || effort > 40)) return fail("invalid_effort", "粗估必须大于0且不超过40人日", 400);
      if (settings.enabled !== true) return fail("disabled", "需求进度模块未启用，暂不可读取", 503);
      if (settings.ready !== true) return fail("not_ready", "需求进度数据源配置未就绪，暂不可读取", 503);
      // Bind the cache to all reader settings (including doc/sheet/view/mapping).
      const key = JSON.stringify(stable(settings));
      const loaded = await load(settings, key, Boolean(input.forceRefresh));
      const { records, calendar, pages, fieldTitles } = loaded.data;
      base.generatedAt = loaded.data.generatedAt;
      base.source = { recordCount: records.length, cacheHit: loaded.cacheHit, sharedInflight: loaded.sharedInflight, pageCount: pages, fieldTitles, complete: true, metric: "known_deadline_capacity_lower_bound" };
      const days = [...new Set((calendar?.dates || []).map(date).filter(Boolean))].sort();
      const invalidCalendar = (calendar?.dates || []).some((d) => !date(d));
      base.calendar = { ok: Boolean(calendar?.ok && days.length && !invalidCalendar), firstDate: days[0] || null, lastDate: days.at(-1) || null, today: base.calendar.today, workdays: days };
      const today = base.calendar.today;
      const covered = (due) => Boolean(base.calendar.ok && due && today >= days[0] && today <= days.at(-1) && due <= days.at(-1) && due >= days[0]);
      base.warnings = ["只读参考；候选资格未校验；仅计算已知截止容量压力下界，不是完整联合排期或安全承诺", "未验证可承接岗位资格；不提供历史经验推断"];
      if (!base.calendar.ok || today < days[0] || today > days.at(-1)) base.warnings.push("工作日日历无效或未覆盖今天");
      const project = str(input.project) === "all" ? "" : str(input.project);
      const projectKey = (name) => str(resolveProjectName(str(name), settings)).replace(/\s+/g, "").toLowerCase();
      const targetProject = projectKey(project);
      const eligible = records.filter((r) => str(value(r, "需求进度")) === "待分配" && str(value(r, "需求类型")) !== "任务拆分"
        && participates(r, role) && !str(value(r, role.field)) && (!project || projectKey(value(r, "项目")) === targetProject));
      base.source.projectFilter = { requested: project, canonical: targetProject };
      logger?.info?.("assignment_reference_filtered", { role: role.id, project, canonicalProject: targetProject, recordCount: records.length, taskCount: eligible.length, cacheHit: loaded.cacheHit });
      base.tasks = eligible.map((r) => {
        const warnings = [];
        if (!str(value(r, "需求名称"))) warnings.push("需求名称缺失");
        if (!str(value(r, "项目"))) warnings.push("项目缺失");
        if (role.id === "ui" && !str(value(r, "UI需求"))) warnings.push("UI参与信息缺失，不能默认就绪");
        if (role.id === "ui" && UI_DONE.has(str(value(r, "UI进度")))) warnings.push("UI完成态与待分配信息冲突");
        const deadline = date(value(r, role.due));
        if (!covered(deadline)) warnings.push("期限缺失、格式错误或日历覆盖不足");
        if (/bug/i.test(str(value(r, "需求类型"))) && effort === null) warnings.push("Bug无人工粗估，不作新增工作量精算");
        return { id: str(r.recordId || r.id), demandId: str(value(r, "需求Id")), title: str(value(r, "需求名称")), project: str(resolveProjectName(str(value(r, "项目")), settings)), state: "待分配", type: str(value(r, "需求类型")), summary: str(value(r, "需求内容")), deadline, effort: null, warnings };
      });
      const selected = input.taskId ? eligible.find((r) => str(r.recordId || r.id) === str(input.taskId)) : eligible[0];
      if (input.taskId && !selected) return fail("task_unavailable", "需求不在当前岗位和项目的可分配池中", 404);
      if (!selected) return { ...base, ok: true, status: "ok", message: "当前没有待分配需求" };
      base.taskId = str(selected.recordId || selected.id);

      // userRefs are record-wide: only match explicit names, never infer field ownership.
      const refIds = new Map();
      const idNames = new Map();
      for (const r of records) for (const ref of r.userRefs || []) {
        const n = canonical(ref.name);
        if (!n || !str(ref.userId)) continue;
        if (!refIds.has(n)) refIds.set(n, new Set());
        refIds.get(n).add(str(ref.userId));
        if (!idNames.has(str(ref.userId))) idNames.set(str(ref.userId), new Set());
        idNames.get(str(ref.userId)).add(n);
      }
      const anchors = new Map();
      const preferred = ROLES.flatMap((r) => configs[r.id].members.map(canonical));
      for (const group of idNames.values()) {
        if ([...group].some((n) => refIds.get(n).size !== 1)) continue;
        const anchor = preferred.find((n) => group.has(n)) || [...group].sort()[0];
        for (const n of group) anchors.set(n, anchor);
      }
      const person = (name) => {
        const n = canonical(name);
        return anchors.get(n) || n;
      };
      const ambiguous = (n) => !n || (refIds.get(n)?.size || 0) > 1;
      const candidateNames = [...new Set(configs[role.id].members.map(person))];
      const work = [];
      for (const r of records) {
        const state = str(value(r, "需求进度"));
        if (INACTIVE.has(state) || str(value(r, "需求类型")) === "任务拆分") continue;
        for (const job of ROLES) {
          if (!participates(r, job)) continue;
          if (job.id === "ui" && UI_DONE.has(str(value(r, "UI进度")))) continue;
          const owners = names(value(r, job.field));
          if (!owners.length) continue;
          const assigned = [...new Set(owners.map(person))];
          const reserved = state === "待分配";
          const raw = number(value(r, job.remaining));
          const total = number(value(r, job.total));
          const uncertain = assigned.length !== 1 || owners.length !== 1 || assigned.some(ambiguous) || reserved;
          if (!uncertain && raw === 0) continue;
          const amount = uncertain ? null : raw;
          work.push({ owners: assigned, invalid: raw !== null && total !== null && raw > total,
            item: { id: str(value(r, "需求Id")), title: str(value(r, "需求名称")), project: str(value(r, "项目")), role: job.id,
              effort: amount, due: date(value(r, job.due)), source: reserved ? "unknown_reservation" : amount === null ? "unknown" : "formal_remaining", reserved } });
        }
      }
      const targetDue = date(value(selected, role.due));
      const dependencies = [];
      let missingDependency = false;
      if (role.id === "fe") {
        const uiNeed = str(value(selected, "UI需求"));
        if (uiNeed !== "-" && !UI_DONE.has(str(value(selected, "UI进度")))) {
          dependencies.push("UI未证实完整制作/拆分就绪，不能证明前端正常开工可行");
          missingDependency = true;
        }
        if (!uiNeed) { dependencies.push("UI参与信息缺失，需核实"); missingDependency = true; }
        if (str(value(selected, "后端开发")) !== "-" && number(value(selected, "后端剩余")) !== 0) {
          dependencies.push("后端尚未证实具备联调条件；理想先于前端开工完成的顺序未验证");
          missingDependency = true;
        }
      }
      if (role.id === "ui" || (role.id === "fe" && str(value(selected, "UI需求")) !== "-")) {
        const progress = str(value(selected, "UI进度"));
        const japan = date(value(selected, "UI日方时间"));
        if (!UI_DONE.has(progress)) {
          if (progress === "日方制作中") {
            dependencies.push(!japan ? "日方承诺返回日期缺失" : japan < today ? "日方承诺已逾期且未证实返回，不可据旧日期证明可行" : "日方日期仅为承诺，实际返回及我方拆图就绪未验证");
            missingDependency = true;
          } else if (!japan && role.id === "ui") {
            dependencies.push("UI制作路线未确认，不能默认我方制作；粗估只计我方工作");
            missingDependency = true;
          }
        }
      }
      dependencies.push("待分配阶段需求对齐/实际释放日未确认；未进行全依赖联合调度复核");
      function pressure(items) {
        const known = items.filter((i) => i.effort !== null && covered(i.due));
        const overdue = known.filter((i) => i.due < today).reduce((s, i) => s + i.effort, 0);
        let worst = 0;
        const nodes = [...new Set([...(overdue > 0 ? [today] : []), ...known.filter((i) => i.due >= today).map((i) => i.due)])];
        for (const due of nodes) {
          const demand = overdue + known.filter((i) => i.due >= today && i.due <= due).reduce((s, i) => s + i.effort, 0);
          worst = Math.max(worst, demand - days.filter((d) => d >= today && d <= due).length);
        }
        return round(Math.max(0, worst));
      }
      base.candidates = candidateNames.map((n) => {
        const owned = work.filter((w) => w.owners.includes(n));
        const items = owned.map((w) => ({ ...w.item }));
        const unknownCount = items.filter((i) => i.effort === null).length;
        const reasons = ["候选来自真实岗位配置，资格未校验", "指标仅含已知工作量，缺口为下界，不代表整体安全"];
        const badIdentity = ambiguous(n);
        if (badIdentity) reasons.push("人员别名/重名或userRefs存在冲突，无法精确归属");
        if (unknownCount) reasons.push(`有${unknownCount}项未知工作量（含预占或多人分工），不能当零`);
        const incomplete = !covered(targetDue) || items.some((i) => !covered(i.due));
        if (incomplete) reasons.push("期限缺失或日历覆盖不足，容量指标不完整");
        if (items.some((i) => i.effort > 0 && i.due && i.due < today)) reasons.push("已有逾期剩余继续占用未来产能，不归因于本次分配");
        if (owned.some((w) => w.invalid)) reasons.push("剩余超过总耗时，需人工核实");
        if (effort === null) reasons.push("未填新任务粗估，不能计算新增占用和影响");
        if (missingDependency) reasons.push("依赖证据不足，无法完整验证；请查看依赖明细");
        const total = round(items.reduce((s, i) => s + (i.effort ?? 0), 0));
        const baseline = incomplete || badIdentity ? null : pressure(items);
        const quantified = effort !== null && !incomplete && !badIdentity;
        const gap = quantified ? pressure([...items, { effort, due: targetDue }]) : null;
        const missing = badIdentity || incomplete || missingDependency || unknownCount > 0 || effort === null || owned.some((w) => w.invalid);
        const leaders = Object.entries(configs[role.id].groups).filter(([, members]) => names(members).some((m) => person(m) === n)).map(([leader]) => leader);
        if (!Object.keys(configs[role.id].groups).length) leaders.push(...configs[role.id].leaders);
        const leader = leaders.join("、") + (leaders.length > 1 ? "（归属待核实）" : "");
        if (leaders.length > 1) reasons.push("岗位配置包含多个组长，未明确个人归属，展示全部组长待核实");
        return { id: n || "ambiguous-alias", name: n || "别名冲突人员", job: role.name, leader, total, reservation: 0,
          unknownCount, status: missing ? "missing" : gap > 0 ? "conflict" : "conditional", baseline, gap,
          delta: gap === null || baseline === null ? null : round(gap - baseline), quantified, items, reasons, dependencies: [...dependencies] };
      }).sort((a, b) => ({ conflict: 1, conditional: 0, missing: 2 }[a.status] - { conflict: 1, conditional: 0, missing: 2 }[b.status]) || (a.delta ?? Infinity) - (b.delta ?? Infinity) || a.name.localeCompare(b.name));
      return { ...base, ok: true, status: "ok", message: "真实数据只读参考；未执行完整联合排期" };
    } catch (_) {
      // Never log upstream error bodies: they may contain tokens or task content.
      logger?.warn?.("assignment_reference_failed", { status: "read_failed", reason: _ instanceof ReadError ? _.message : "generic" });
      const safe = _ instanceof ReadError ? _.message : "真实数据读取或分析失败，请重试";
      return fail("read_failed", safe, 502);
    }
  }
  return { query };
}

module.exports = { createAssignmentReferenceService };
