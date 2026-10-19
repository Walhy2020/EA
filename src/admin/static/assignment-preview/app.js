(function () {
  "use strict";
  const M = window.AssignmentDemo;
  const embedded = new URLSearchParams(window.location.search).get("embed") === "1" && window.parent !== window;
  document.body.classList.toggle("host-embedded", embedded);
  let hostContext = null;
  const $ = selector => document.querySelector(selector);
  const html = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const date = index => M.day(index).slice(5).replace("-", "/");
  const state = { persona: "fallback", role: "fe", project: "all", search: "", taskOrder: "asc", taskId: M.tasks[0].id, effort: 2, skip: false, dirty: false, expanded: null, evidenceTab: "load", assignments: {}, selection: null };
  let toastTimer;
  let dialogReturnTarget;
  const task = () => M.tasks.find(t => t.id === state.taskId);
  const role = () => M.roles.find(r => r.id === state.role);
  const upstream = () => ({ fe: "后端组长", be: "策划组长", ui: "UI组长（日方资源）", plan: "动效组长" })[state.role];
  const key = () => `${state.taskId}:${state.role}`;
  const currentResults = () => task() ? M.sort(M.analyze(task(), state.role, state.skip ? null : state.effort, state.assignments), "risk") : [];
  const visibleRoles = () => M.roles.filter(r => state.persona === "fallback" || r.id === state.persona);
  function icons() {
    window.lucide.createIcons({ attrs: { "stroke-width": 1.7 } });
    // Keep existing icons stable while new task content is rendered.
    document.querySelectorAll("svg[data-lucide]").forEach(svg => svg.removeAttribute("data-lucide"));
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $("#toast").textContent = message;
    $("#toast").hidden = false;
    toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 4500);
  }
  function visibleTasks() {
    return M.tasks.filter(t => t.state === "待分配" && !state.assignments[`${t.id}:${state.role}`]
      && t.roles.includes(state.role) && (state.project === "all" || t.project === state.project)
      && (!state.allowedProjects || state.allowedProjects.includes(t.project))
      && `${t.title} ${t.id}`.toLowerCase().includes(state.search.toLowerCase()))
      .sort((a, b) => (state.taskOrder === "asc" ? a.deadline - b.deadline : b.deadline - a.deadline) || a.id.localeCompare(b.id));
  }
  function selectTask(id, mobile = false) {
    state.taskId = id;
    const t = task();
    const previous = state.assignments[key()];
    state.effort = previous?.effort ?? t?.effort ?? 2;
    state.skip = Boolean(previous && previous.effort === null);
    state.dirty = false;
    state.expanded = null;
    if (mobile) $("#assign-view").classList.add("show-detail");
    render();
  }
  function renderTasks() {
    const tasks = visibleTasks();
    $("#task-count").textContent = tasks.length;
    $("#task-list").innerHTML = tasks.length ? tasks.map(t => {
      return `<button class="task-item ${state.taskId === t.id ? "selected" : ""}" data-task="${t.id}" aria-pressed="${state.taskId === t.id}">
        <strong>${html(t.title)}</strong><span class="task-bottom"><span>${t.id}</span><span>${date(t.deadline)} 截止</span></span></button>`;
    }).join("") : `<div class="empty-state">${icon("search-x")}<h3>没有符合条件的需求</h3><p>当前岗位：${role().name}</p><button class="text-button" data-action="clear-filter">清除筛选</button></div>`;
  }
  function renderHeader(t) {
    const assigned = state.assignments[key()];
    return `<button class="mobile-back text-button" data-action="back">${icon("arrow-left")}需求列表</button>
      <div class="detail-title"><h2>${html(t.title)}</h2></div>
      <p class="task-description">${html(t.summary)}</p>
      <dl class="task-meta"><div><dt>分配岗位</dt><dd>${role().name}</dd></div><div><dt>${state.role === "ui" ? "美术" : state.role === "plan" ? "需求" : "开发"}截止</dt><dd>${M.day(t.deadline)}<span class="muted"> · ${t.deadline + 1} 工作日</span></dd></div><div><dt>当前负责人</dt><dd>${assigned ? html(assigned.name) : "未分配"}${assigned ? '<span class="muted"> · 演示</span>' : ""}</dd></div></dl>
      ${assigned ? `<div class="success-receipt">${icon("check-check")}<div><strong>当前负责人已更新为：${html(assigned.name)}（演示）</strong><span>本次仅预览，未写入需求总表</span></div></div>` : ""}
      <form id="estimate-form" class="estimate-bar"><label class="estimate-field"><span>本岗位粗估</span><span class="number-field"><input id="effort" aria-label="本岗位粗估人日" type="number" min="0.1" max="40" step="any" value="${state.effort ?? ""}" ${state.skip ? "disabled" : ""}><span>人日</span></span></label><label class="check-label"><input id="skip-estimate" type="checkbox" ${state.skip ? "checked" : ""}>暂不粗估</label><button class="primary-button" type="submit">${icon("refresh-cw")}重新分析</button><span class="estimate-origin">${icon("database")}分配粗估 · 不修改正式耗时</span></form>
      <div id="estimate-error" class="error-text" role="alert" hidden></div>
      <p id="analysis-state" class="analysis-state amber" role="status" ${state.dirty ? "" : "hidden"}>输入已变化 · 请重新分析</p>`;
  }
  function reason(p) {
    if (!p.quantified) return "未填写粗估，新增占用尚未计算";
    if (p.missing || task().chain === "missing") return "剩余工作量或上游交付尚未明确";
    if (p.status === "conflict") return `截止前合计缺口 ${p.gap} 人日，新增 ${Math.max(0, p.delta)} 人日`;
    if (p.status === "coord") return "需要上游组长确认提前交付日期";
    return "示例的既定交付条件与容量支持";
  }
  function candidate(p, index) {
    const expanded = state.expanded === p.id;
    const current = state.assignments[key()]?.personId === p.id;
    return `<article class="candidate ${expanded ? "expanded" : ""}" data-person="${p.id}">
      <div class="candidate-row"><div class="person"><span class="avatar">${html(p.name.slice(-2))}</span><div><strong>${html(p.name)}${current ? '<span class="current-label">当前</span>' : ""}</strong><span>${html(p.job)} · ${html(p.leader)}</span></div></div>
      <div class="load-number"><span class="mobile-label">确定负载</span><strong>${p.total}</strong><span>人日</span></div>
      <div class="load-number"><span class="mobile-label">预占负载</span><strong>${p.reservation}</strong><span>人日${p.missing ? " + 1项未知" : ""}</span></div>
      <div class="conclusion"><span class="status ${p.status}">${icon(({ ready: "circle-check", coord: "messages-square", conflict: "triangle-alert", missing: "circle-help" })[p.status])}${M.labels[p.status]}</span><span>${html(reason(p))}</span></div>
      <div class="candidate-actions"><button class="text-button" data-evidence="${p.id}" aria-expanded="${expanded}">依据${icon(expanded ? "chevron-up" : "chevron-down")}</button><button class="${index === 0 && p.status === "ready" ? "primary-button" : "secondary-button"}" data-select="${p.id}" ${state.dirty ? "disabled" : ""}>${current ? "重新确认" : "选择"}</button></div></div>
      ${expanded ? evidence(p) : ""}</article>`;
  }
  function evidence(p) {
    let content;
    if (state.evidenceTab === "load") {
      const after = p.quantified ? `${p.gap} 人日` : "未计算";
      content = `<div class="comparison"><div><span>原有截止缺口</span><strong>${p.baseline} <small>人日</small></strong></div><span class="comparison-arrow">${icon("arrow-right")}</span><div><span>加入本任务后</span><strong class="${p.gap > 0 ? "red" : ""}">${after}</strong></div><div class="delta"><span>本次新增压力</span><strong>${p.quantified ? `+${Math.max(0, p.delta)} 人日` : "未知"}</strong></div></div>
        <div class="evidence-table-wrap"><table class="evidence-table"><thead><tr><th>构成负载的需求</th><th>岗位 / 来源</th><th>剩余</th><th>截止日</th></tr></thead><tbody>${p.items.map(item => `<tr><td><button class="table-link" data-work="${item.id}" data-person-id="${p.id}">${html(item.title)}${icon("arrow-up-right")}</button><span>${html(item.project)} · ${item.id}</span></td><td>${html(item.role)}<span>${item.source}</span></td><td>${item.effort} 人日</td><td>${date(item.due)}</td></tr>`).join("")}</tbody></table></div>
        <div class="evidence-note">${icon("calendar-days")}演示工作日历：10/19 至 10/23、10/26 至 10/30${p.id === "mu" ? " · 前后端共用一份产能" : ""}</div>`;
    } else if (state.evidenceTab === "dependency") {
      const blocked = p.needsCoord || task().chain !== "ready";
      const chain = { fe: [["palette", "UI 完整资源"], ["server", "后端交付"], ["panel-top", "前端开发 / 联调"]], be: [["file-check", "需求对齐"], ["server", "后端开发"], ["panel-top", "前端联调"]], ui: [["package-open", "制作资源就绪"], ["palette", "UI 制作 / 拆分"], ["panel-top", "前端开发"]], plan: [["file-check", "需求设计"], ["settings-2", "配置 / 数值"], ["clipboard-check", "功能验收"]] }[state.role];
      content = `<div class="dependency-chain">${chain.map(([symbol, title], index) => `${index ? icon("arrow-right") : ""}<div><span class="node-icon">${icon(symbol)}</span><strong>${title}</strong><span>${index === 2 ? "后续阶段" : blocked ? "交付条件待核对" : "示例条件已确认"}</span></div>`).join("")}</div>
        <div class="dependency-detail ${blocked ? "warning" : ""}">${icon(blocked ? "messages-square" : "circle-check")}<div><strong>${blocked ? `需要${upstream()}确认交付条件` : "本示例没有待协调的上游条件"}</strong><p>${blocked ? `本任务需要上游最迟 ${date(Math.max(0, task().deadline - Math.ceil(state.effort || 2)))} 交付。提交承诺后仍需核对其他任务，不能只比较日期。` : "已有上游交付条件作为本次演示输入。"}</p></div></div>`;
    } else {
      content = `<div class="experience"><span class="node-icon">${icon("history")}</span><div><strong>${p.name} · 活动界面调整</strong><p>DEMO-H018 · 一骑当千 · ${role().name} · 已上线</p><p>相关点：活动入口、状态切换与奖励展示。</p><span class="muted">相似功能示例，不据此减少预估人日。</span></div></div>`;
    }
    return `<div class="evidence"><nav class="evidence-tabs" aria-label="候选人依据">${[["load", "工作量与影响"], ["dependency", "上下游依赖"], ["history", "历史经验"]].map(([id, title]) => `<button data-evidence-tab="${id}" class="${state.evidenceTab === id ? "active" : ""}" aria-pressed="${state.evidenceTab === id}">${title}</button>`).join("")}</nav>${content}</div>`;
  }
  function renderDetail() {
    const t = task();
    if (!t) { $("#task-detail").innerHTML = '<div class="empty-state"><h3>暂无可分配需求</h3><p>调整左侧筛选后查看。</p></div>'; return; }
    $("#task-detail").innerHTML = `${renderHeader(t)}<div class="candidate-table" aria-label="可行性分析"><div class="candidate-table-head"><span>候选人 / 所属组长</span><span>确定负载</span><span>预占负载</span><span>加入新任务后的影响</span><span>操作</span></div>${currentResults().map(candidate).join("")}</div><div class="results-foot"><span>${icon("info")}同一人的不同岗位合并计量</span><span>工作日 1 人日 / 人</span></div>`;
  }
  function render() {
    $("#role-tabs").innerHTML = visibleRoles().map(r => `<button data-role="${r.id}" class="${state.role === r.id ? "active" : ""}" aria-pressed="${state.role === r.id}">${r.name}</button>`).join("");
    const sortLabel = `截止时间：${state.taskOrder === "asc" ? "由近到远" : "由远到近"}`;
    $("#time-sort").title = sortLabel;
    $("#time-sort").setAttribute("aria-label", sortLabel);
    $("#time-sort").innerHTML = icon(state.taskOrder === "asc" ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow");
    renderTasks(); renderDetail(); icons();
  }
  function openDialog(content) {
    dialogReturnTarget = document.activeElement;
    $("#dialog-content").innerHTML = content;
    icons();
    $("#confirm-dialog").showModal();
    if (embedded) $("#confirm-dialog").scrollIntoView({ block: "center" });
  }
  function closeDialog() { $("#confirm-dialog").close(); if (dialogReturnTarget?.isConnected) dialogReturnTarget.focus(); }
  function dialogHeader(title, label = "演示操作") {
    return `<header class="dialog-header"><div><span class="eyebrow">${label}</span><h2 id="dialog-title">${title}</h2></div><button class="icon-button" data-action="close" aria-label="关闭">${icon("x")}</button></header>`;
  }
  function selectPerson(id) {
    if (state.dirty) { toast("粗估已变化，请先重新分析。"); return; }
    const person = currentResults().find(p => p.id === id);
    if (!person) return;
    state.selection = person;
    const risky = person.status !== "ready";
    openDialog(`${dialogHeader("确认人员分配")}<div class="dialog-body"><h3>${html(task().title)}</h3><p class="muted">${task().id} · ${role().name}</p><div class="assignment-change"><div><span>原负责人</span><strong>${html(state.assignments[key()]?.name || "未分配")}</strong></div>${icon("arrow-right")}<div><span>新负责人</span><strong>${html(person.name)}</strong></div></div><dl class="confirm-meta"><div><dt>分配粗估</dt><dd>${state.skip ? "未填写" : `${state.effort} 人日`}</dd></div><div><dt>截止日期</dt><dd>${M.day(task().deadline)}</dd></div></dl><div class="confirmation-note ${risky ? "warning" : ""}">${icon(risky ? "triangle-alert" : "circle-check")}<div><strong>${M.labels[person.status]}</strong><p>${html(reason(person))}</p></div></div>${person.job.includes("/") ? '<p class="muted small">兼任人员：建议与其所属组长先行沟通。</p>' : ""}${risky ? '<label class="risk-ack"><input id="risk-ack" type="checkbox">我已了解以上风险或信息不足，仍选择此人</label>' : ""}<p class="demo-disclaimer">仅记录本次演示，不修改企业微信总表。</p></div><footer class="dialog-footer"><button class="secondary-button" data-action="close">返回比较</button><button class="primary-button" id="confirm-assignment" ${risky ? "disabled" : ""}>确认演示分配</button></footer>`);
  }
  function confirmAssignment() {
    const p = state.selection;
    if (!p || (p.status !== "ready" && !$("#risk-ack")?.checked)) return;
    const t = task();
    state.assignments[key()] = { personId: p.id, name: p.name, effort: state.skip ? null : state.effort };
    state.selection = null;
    closeDialog(); render();
    $("#task-detail .detail-title h2")?.scrollIntoView({ block: "nearest" });
    toast("演示分配已记录，未写回企业微信。");
  }
  function updateFilter() {
    const tasks = visibleTasks();
    if (!tasks.some(t => t.id === state.taskId)) selectTask(tasks[0]?.id || null);
    else { renderTasks(); icons(); }
  }
  document.addEventListener("click", async event => {
    const b = event.target.closest("button");
    if (!b) return;
    if (b.dataset.task) selectTask(b.dataset.task, true);
    if (b.dataset.role && visibleRoles().some(r => r.id === b.dataset.role)) { state.role = b.dataset.role; const tasks = visibleTasks(); selectTask(tasks.find(t => t.id === state.taskId)?.id || tasks[0]?.id || null); }
    if (b.dataset.evidence) { state.expanded = state.expanded === b.dataset.evidence ? null : b.dataset.evidence; state.evidenceTab = "load"; renderDetail(); icons(); }
    if (b.dataset.evidenceTab) { state.evidenceTab = b.dataset.evidenceTab; renderDetail(); icons(); }
    if (b.dataset.select) selectPerson(b.dataset.select);
    if (b.dataset.copy) { try { await navigator.clipboard.writeText(b.dataset.copy); toast("需求 ID 已复制"); } catch (_) { toast(`需求 ID：${b.dataset.copy}`); } }
    if (b.dataset.work) {
      const p = currentResults().find(p => p.id === b.dataset.personId);
      const item = p?.items.find(item => item.id === b.dataset.work);
      if (item) openDialog(`${dialogHeader("关联需求", "演示需求")}<div class="dialog-body"><h3>${html(item.title)}</h3><p>${html(item.project)} · ${item.id}</p><dl class="confirm-meta"><div><dt>岗位</dt><dd>${item.role}</dd></div><div><dt>负责人</dt><dd>${html(p.name)}</dd></div><div><dt>${item.source}</dt><dd>${item.effort} 人日</dd></div><div><dt>截止日期</dt><dd>${M.day(item.due)}</dd></div></dl></div><footer class="dialog-footer"><button class="secondary-button" data-action="close">返回依据</button></footer>`);
    }
    if (b.id === "confirm-assignment") confirmAssignment();
    if (b.id === "time-sort") { state.taskOrder = state.taskOrder === "asc" ? "desc" : "asc"; render(); }
    if (b.id === "reset") openDialog(`${dialogHeader("重置演示")}<div class="dialog-body"><p>清除本次演示的分配记录，恢复初始示例？</p></div><footer class="dialog-footer"><button class="secondary-button" data-action="close">取消</button><button class="primary-button" data-action="reset-confirm">重置</button></footer>`);
    switch (b.dataset.action) {
      case "close": closeDialog(); break;
      case "back": $("#assign-view").classList.remove("show-detail"); break;
      case "clear-filter": state.search = ""; $("#search").value = ""; updateFilter(); break;
      case "reset-confirm": state.assignments = {}; state.selection = null; state.search = ""; state.taskOrder = "asc"; $("#search").value = ""; closeDialog(); selectTask(visibleTasks()[0]?.id || null); toast("演示已重置"); break;
    }
    if (embedded && hostContext && ["clear-filter", "reset-confirm"].includes(b.dataset.action)) applyHostContext(hostContext);
  });
  document.addEventListener("change", event => {
    const el = event.target;
    if (el.id === "project") { state.project = el.value; updateFilter(); }
    if (el.id === "persona") { state.persona = el.value; if (!visibleRoles().some(r => r.id === state.role)) state.role = visibleRoles()[0].id; selectTask(visibleTasks()[0]?.id || null); }
    if (el.id === "skip-estimate") { state.skip = el.checked; state.dirty = true; $("#effort").disabled = el.checked; markDirty(); }
    if (el.id === "risk-ack") $("#confirm-assignment").disabled = !el.checked;
  });
  function markDirty() {
    state.dirty = true;
    $("#analysis-state").textContent = "输入已变化 · 请重新分析";
    $("#analysis-state").hidden = false;
    $("#analysis-state").classList.add("amber");
    document.querySelectorAll("[data-select]").forEach(b => { b.disabled = true; });
  }
  document.addEventListener("input", event => {
    if (event.target.id === "search") { state.search = event.target.value.trim(); updateFilter(); }
    if (event.target.id === "effort") { state.effort = event.target.value === "" ? null : Number(event.target.value); markDirty(); }
  });
  document.addEventListener("submit", event => {
    event.preventDefault();
    if (event.target.id === "estimate-form") {
      if (!state.skip && (!Number.isFinite(state.effort) || state.effort <= 0 || state.effort > 40)) { $("#estimate-error").textContent = "请输入大于 0、不超过 40 的人日，或选择暂不粗估。"; $("#estimate-error").hidden = false; return; }
      state.dirty = false; renderDetail(); icons(); toast(state.skip ? "已更新已有负载比较" : "演示场景已重新分析");
    }
  });
  $("#confirm-dialog").addEventListener("click", event => { if (event.target === $("#confirm-dialog")) closeDialog(); });
  function applyHostContext(context) {
    const project = typeof context.project === "string" ? context.project : "all";
    const projects = project === "all" && Array.isArray(context.projects) ? context.projects.filter(p => typeof p === "string") : null;
    const changed = state.project !== project || JSON.stringify(state.allowedProjects ?? null) !== JSON.stringify(projects);
    state.project = project;
    state.allowedProjects = projects;
    document.body.dataset.projectTheme = String(context.theme || "");
    if (changed) updateFilter();
  }
  if (embedded) {
    window.addEventListener("message", event => {
      if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.type !== "ea-assignment-preview-context") return;
      hostContext = event.data;
      applyHostContext(hostContext);
    });
    let scheduled = false;
    const reportHeight = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        window.parent.postMessage({ type: "ea-assignment-preview-height", height: Math.ceil(document.body.getBoundingClientRect().height) + 2 }, "*");
      });
    };
    new ResizeObserver(reportHeight).observe(document.body);
    window.parent.postMessage({ type: "ea-assignment-preview-ready" }, "*");
  }
  render();
})();
