(function () {
  "use strict";
  const M = window.AssignmentReference;
  const { html, number, date } = M;
  const $ = selector => document.querySelector(selector);
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const embedded = new URLSearchParams(window.location.search).get("embed") === "1" && window.parent !== window;
  const REQUEST_TIMEOUT_MS = 130000;
  const state = { project: "all", projects: null, role: "", taskId: "", roles: [], tasks: [], result: null, phase: "waiting", message: "等待查询", search: "", order: "asc", effort: "", dirty: false, expanded: null, tab: "load" };
  let pendingId = null;
  let sequence = 0;
  let timer;
  let contextReceived = false;
  let dialogReturnTarget;
  document.body.classList.toggle("host-embedded", embedded);
  function icons() {
    window.lucide.createIcons({ attrs: { "stroke-width": 1.7 } });
    document.querySelectorAll("svg[data-lucide]").forEach(svg => svg.removeAttribute("data-lucide"));
  }
  const task = () => state.tasks.find(t => t.id === state.taskId);
  const role = () => state.roles.find(r => r.id === state.role);
  const allowed = () => state.project === "all" ? state.projects : null;
  const tasks = () => M.visibleTasks(state.tasks, allowed(), state.search, state.order);
  const people = () => state.result?.candidates || [];
  const lines = values => values.map(value => `<p>${html(value)}</p>`).join("");
  const back = () => `<button class="mobile-back text-button" data-action="back">${icon("arrow-left")}需求列表</button>`;
  function fail(message) {
    clearTimeout(timer);
    pendingId = null;
    state.result = null;
    state.phase = "error";
    state.message = message;
    render();
  }
  function request(forceRefresh = false) {
    if (!embedded) return;
    const effort = M.effort(state.effort);
    clearTimeout(timer);
    pendingId = `assignment-${Date.now()}-${++sequence}`;
    state.result = null;
    state.phase = "loading";
    state.message = "正在查询和分析…";
    state.dirty = false;
    state.expanded = null;
    render();
    const query = { project: state.project, role: state.role, taskId: state.taskId, effort, forceRefresh: Boolean(forceRefresh) };
    window.parent.postMessage({ type: "ea-assignment-reference-request", requestId: pendingId, query }, "*");
    timer = setTimeout(() => fail("查询超时，请重试"), REQUEST_TIMEOUT_MS);
  }
  function selectTask(id, mobile = false) {
    if (!state.tasks.some(t => t.id === id)) return;
    if (mobile) $("#assign-view").classList.add("show-detail");
    if (state.taskId === id && state.phase === "ready") return;
    state.taskId = id;
    state.effort = "";
    request();
  }
  function renderTasks() {
    const visible = tasks();
    $("#task-count").textContent = visible.length;
    $("#task-list").innerHTML = visible.length ? visible.map(t => `<button class="task-item ${state.taskId === t.id ? "selected" : ""}" data-task="${html(t.id)}" aria-pressed="${state.taskId === t.id}"><strong>${html(t.title || "未命名需求")}</strong><span class="task-bottom"><span>${html(t.demandId || t.id)}</span><span>${date(t.deadline)} 截止</span></span></button>`).join("") : `<div class="empty-state"><h3>${state.phase === "loading" ? "正在查询…" : "暂无符合条件的需求"}</h3>${state.search ? '<button class="text-button" data-action="clear-filter">清除筛选</button>' : ""}</div>`;
  }
  function header(t) {
    return `${back()}<div class="detail-title"><h2>${html(t.title || "未命名需求")}</h2></div><p class="task-description">${html(t.summary)}</p>
      <dl class="task-meta"><div><dt>分配岗位</dt><dd>${html(role()?.name)}</dd></div><div><dt>截止日期</dt><dd>${date(t.deadline)}</dd></div><div><dt>需求状态</dt><dd>${html(t.state)}</dd></div></dl>
      <form id="estimate-form" class="estimate-bar" novalidate><label class="estimate-field"><span>本岗位粗估</span><span class="number-field"><input id="effort" aria-label="本岗位粗估人日" type="number" max="40" step="any" value="${html(state.effort)}"><span>人日</span></span></label><label class="check-label"><input id="skip-estimate" type="checkbox" ${state.effort === "" ? "checked" : ""}>暂不粗估</label><button class="primary-button" type="submit">${icon("refresh-cw")}重新分析</button><span class="estimate-origin">本页临时粗估 · 不写回</span></form>
      <div id="estimate-error" class="error-text" role="alert" hidden></div><p id="analysis-state" class="analysis-state amber" role="status" ${state.dirty ? "" : "hidden"}>输入已变化 · 请重新分析</p>`;
  }
  function evidence(p) {
    let content;
    if (state.tab === "load") {
      content = `<div class="comparison"><div><span>原有容量缺口下界</span><strong>${number(p.baseline)} <small>人日</small></strong></div><span class="comparison-arrow">${icon("arrow-right")}</span><div><span>加入本任务后</span><strong>${p.quantified ? number(p.gap) : "未知"} <small>人日</small></strong></div><div class="delta"><span>本次新增压力</span><strong>${p.quantified ? number(p.delta) : "未知"} 人日</strong></div></div>
        <div class="evidence-table-wrap"><table class="evidence-table"><thead><tr><th>构成负载的需求</th><th>岗位 / 来源</th><th>剩余</th><th>截止日</th></tr></thead><tbody>${p.items.map(item => `<tr><td><button class="table-link" data-work="${html(item.id)}" data-person-id="${html(p.id)}">${html(item.title)}${icon("arrow-up-right")}</button><span>${html(item.project)} · ${html(item.id)}</span></td><td>${M.itemRole(item.role)}<span>${M.itemSource(item.source)}${item.reserved ? " · 预占" : ""}</span></td><td>${number(item.effort)} 人日</td><td>${date(item.due)}</td></tr>`).join("")}</tbody></table>${p.items.length ? "" : '<p class="evidence-note">暂无工作量明细</p>'}</div>
        <div class="evidence-note">${icon("calendar-days")}${state.result.calendar?.ok ? `${date(state.result.calendar.firstDate)} 至 ${date(state.result.calendar.lastDate)}` : "工作日历未就绪"}</div>`;
    } else if (state.tab === "dependency") content = `<div class="dependency-detail warning"><div>${p.dependencies.length ? lines(p.dependencies) : "暂无依赖分析"}</div></div>`;
    else content = '<div class="experience">暂无历史分析</div>';
    return `<div class="evidence"><nav class="evidence-tabs" aria-label="候选人依据">${[["load", "工作量与影响"], ["dependency", "上下游依赖"], ["history", "历史经验"]].map(([id, title]) => `<button data-evidence-tab="${id}" class="${state.tab === id ? "active" : ""}" aria-pressed="${state.tab === id}">${title}</button>`).join("")}</nav>${content}</div>`;
  }
  function candidate(p) {
    const expanded = state.expanded === p.id;
    const status = Object.hasOwn(M.labels, p.status) ? p.status : "missing";
    const unknown = Number.isInteger(p.unknownCount) && p.unknownCount >= 0 ? p.unknownCount : null;
    return `<article class="candidate ${expanded ? "expanded" : ""}" data-person="${html(p.id)}"><div class="candidate-row"><div class="person"><span class="avatar">${html(p.name.slice(-2))}</span><div><strong>${html(p.name)}</strong><span>${html(p.job)} · ${html(p.leader)}</span></div></div>
      <div class="load-number"><span class="mobile-label">已知负载</span><strong>${number(p.total)}</strong><span>人日</span></div><div class="load-number"><span class="mobile-label">已知预占</span><strong>${number(p.reservation)}</strong><span>人日${unknown === null ? " · 未知项数待核实" : unknown > 0 ? ` + ${unknown}项未知` : ""}</span></div>
      <div class="conclusion"><span class="status ${status}">${icon(({ conditional: "circle-help", conflict: "triangle-alert", missing: "circle-help" })[status])}${M.labels[status]}</span><span>${p.reasons.length ? html(p.reasons.join("；")) : "暂无结论依据"}</span></div><div class="candidate-actions"><button class="text-button" data-evidence="${html(p.id)}" aria-expanded="${expanded}">依据${icon(expanded ? "chevron-up" : "chevron-down")}</button></div></div>${expanded ? evidence(p) : ""}</article>`;
  }
  function renderDetail() {
    const t = task();
    if (!embedded) {
      $("#task-detail").innerHTML = '<div class="empty-state"><h3>请从需求工作台进入</h3><a class="text-button" href="/demand-h5.html?panel=assignment">进入分配参考</a></div>';
    } else if (state.phase !== "ready") {
      $("#task-detail").innerHTML = `${back()}<div class="empty-state" role="status"><h3>${html(state.message)}</h3>${state.phase === "error" ? '<button class="secondary-button" data-action="retry">重试</button>' : ""}</div>`;
    } else if (!t) $("#task-detail").innerHTML = `${back()}<div class="empty-state"><h3>暂无可分析需求</h3></div>`;
    else $("#task-detail").innerHTML = `${header(t)}<div class="data-warnings">${lines([...(t.warnings || []), ...(state.result.warnings || [])])}</div><div class="candidate-table" aria-label="可行性分析"><div class="candidate-table-head"><span>候选人 / 所属组长</span><span>已知负载</span><span>已知预占</span><span>加入新任务后的影响</span><span>依据</span></div><div id="candidate-results">${people().map(candidate).join("") || '<div class="empty-state">暂无候选人分析</div>'}</div></div><div class="results-foot"><span>${icon("info")}容量下界不代表联合排期可行</span><span>只读分析</span></div>`;
  }
  function render() {
    $("#role-tabs").innerHTML = state.roles.map(r => `<button data-role="${html(r.id)}" class="${state.role === r.id ? "active" : ""}" aria-pressed="${state.role === r.id}">${html(r.name)}</button>`).join("");
    const label = `截止时间：${state.order === "asc" ? "由近到远" : "由远到近"}`;
    if ($("#time-sort").title !== label) {
      $("#time-sort").title = label;
      $("#time-sort").setAttribute("aria-label", label);
      $("#time-sort").innerHTML = icon(state.order === "asc" ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow");
    }
    $("#identity-name").textContent = state.result?.identity?.name || "身份待确认";
    $("#identity-name").title = state.result?.identity?.isFallback ? "兜底人" : "";
    $("#snapshot").textContent = state.phase === "ready" ? M.snapshot(state.result?.generatedAt) : state.message;
    $("#bridge-status").textContent = embedded ? state.phase === "ready" ? M.snapshot(state.result?.generatedAt) : state.message : "请从需求工作台进入";
    $("#refresh").disabled = !embedded || state.phase === "loading";
    renderTasks(); renderDetail(); icons();
  }
  function markDirty() {
    state.dirty = true;
    $("#analysis-state").hidden = false;
    // Hide previous conclusions until the server analyzes the new estimate.
    $("#candidate-results").innerHTML = '<div class="empty-state">待重新分析</div>';
  }
  document.addEventListener("input", event => {
    if (event.target.id === "search") { state.search = event.target.value.trim(); renderTasks(); icons(); }
    if (event.target.id === "effort") {
      state.effort = event.target.value;
      $("#skip-estimate").checked = state.effort === "";
      markDirty();
    }
  });
  document.addEventListener("change", event => {
    if (event.target.id === "skip-estimate") {
      state.effort = "";
      $("#effort").value = "";
      markDirty();
    }
  });
  document.addEventListener("submit", event => {
    if (event.target.id !== "estimate-form") return;
    event.preventDefault();
    try { M.effort(state.effort); request(); }
    catch (error) { $("#estimate-error").textContent = error.message; $("#estimate-error").hidden = false; }
  });
  function closeDialog() { $("#confirm-dialog").close(); if (dialogReturnTarget?.isConnected) dialogReturnTarget.focus(); }
  document.addEventListener("click", event => {
    const b = event.target.closest("button");
    if (!b) return;
    if (b.dataset.task) selectTask(b.dataset.task, true);
    if (b.dataset.role && b.dataset.role !== state.role && state.roles.some(r => r.id === b.dataset.role)) {
      state.role = b.dataset.role; state.taskId = ""; state.effort = ""; state.tasks = []; request();
    }
    if (b.dataset.evidence) { state.expanded = state.expanded === b.dataset.evidence ? null : b.dataset.evidence; state.tab = "load"; renderDetail(); icons(); }
    if (b.dataset.evidenceTab) { state.tab = b.dataset.evidenceTab; renderDetail(); icons(); }
    if (b.id === "time-sort") { state.order = state.order === "asc" ? "desc" : "asc"; renderTasks(); icons(); }
    if (b.id === "refresh" || b.dataset.action === "retry") {
      state.taskId = "";
      state.effort = "";
      state.tasks = [];
      try { request(true); }
      catch (error) { $("#estimate-error").textContent = error.message; $("#estimate-error").hidden = false; }
    }
    if (b.dataset.action === "back") $("#assign-view").classList.remove("show-detail");
    if (b.dataset.action === "clear-filter") { state.search = ""; $("#search").value = ""; renderTasks(); icons(); }
    if (b.dataset.action === "close") closeDialog();
    if (b.dataset.work) {
      const p = people().find(p => p.id === b.dataset.personId);
      const item = p?.items.find(i => i.id === b.dataset.work);
      if (!item) return;
      dialogReturnTarget = document.activeElement;
      $("#dialog-content").innerHTML = `<header class="dialog-header"><h2 id="dialog-title">关联需求</h2><button class="icon-button" data-action="close" aria-label="关闭">${icon("x")}</button></header><div class="dialog-body"><h3>${html(item.title)}</h3><p>${html(item.project)} · ${html(item.id)}</p><dl class="confirm-meta"><div><dt>岗位</dt><dd>${M.itemRole(item.role)}</dd></div><div><dt>负责人</dt><dd>${html(p.name)}</dd></div><div><dt>${M.itemSource(item.source)}</dt><dd>${number(item.effort)} 人日</dd></div><div><dt>截止日期</dt><dd>${date(item.due)}</dd></div></dl></div>`;
      icons(); $("#confirm-dialog").showModal();
    }
  });
  $("#confirm-dialog").addEventListener("click", event => { if (event.target === $("#confirm-dialog")) closeDialog(); });
  function applyContext(context) {
    const project = typeof context.project === "string" ? context.project : "all";
    const projects = project === "all" && Array.isArray(context.projects) ? [...new Set(context.projects.filter(p => typeof p === "string"))].sort() : null;
    const changed = state.project !== project || JSON.stringify(state.projects) !== JSON.stringify(projects);
    const first = !contextReceived;
    contextReceived = true;
    document.body.dataset.projectTheme = typeof context.theme === "string" ? context.theme : "";
    if (!changed && !first) return;
    if (!changed && state.phase !== "waiting") return;
    state.project = project; state.projects = projects; state.taskId = ""; state.role = ""; state.effort = ""; state.tasks = []; state.roles = [];
    state.search = ""; $("#search").value = "";
    if ($("#confirm-dialog").open) closeDialog();
    request();
  }
  function receive(event) {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.type === "ea-assignment-preview-context") { applyContext(data); return; }
    if (data?.type !== "ea-assignment-reference-result" || !pendingId || data.requestId !== pendingId) return;
    const r = data.result;
    if (data.error || !r?.ok) { fail(String(data.error || r?.message || "查询失败，请重试")); return; }
    if (!M.validResult(r)) { fail("返回数据格式不正确，请重试"); return; }
    clearTimeout(timer); pendingId = null;
    state.roles = r.roles; state.tasks = r.tasks; state.role = r.role;
    if (!r.roles.some(role => role.id === r.role) && r.tasks.length) { fail("当前岗位不可用"); return; }
    const visible = M.visibleTasks(r.tasks, allowed(), "", state.order);
    const selected = visible.find(t => t.id === r.taskId);
    if (!selected && visible.length) {
      if (state.taskId === visible[0].id) { fail("目标需求分析不可用，请重试"); return; }
      state.taskId = visible[0].id; state.effort = ""; request(); return;
    }
    state.taskId = selected?.id || "";
    state.result = { ...r, candidates: selected ? r.candidates : [] };
    state.phase = "ready"; state.message = r.message || "查询完成";
    render();
  }
  if (embedded) {
    window.addEventListener("message", receive);
    let scheduled = false;
    const reportHeight = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          scheduled = false;
          window.parent.postMessage({ type: "ea-assignment-preview-height", height: Math.ceil(document.body.getBoundingClientRect().height) + 2 }, "*");
        });
      });
    };
    new ResizeObserver(reportHeight).observe(document.body);
    window.parent.postMessage({ type: "ea-assignment-preview-ready" }, "*");
    setTimeout(() => { if (!contextReceived && state.phase === "waiting") request(); }, 1500);
  }
  if (!embedded) $("#assign-view").classList.add("show-detail");
  render();
})();
