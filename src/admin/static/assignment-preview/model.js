(function (root, factory) {
  const model = factory();
  if (typeof module === "object" && module.exports) module.exports = model;
  else root.AssignmentDemo = model;
})(typeof window === "object" ? window : globalThis, function () {
  "use strict";
  const version = "0.1.1";
  const roles = [{ id: "fe", name: "前端", field: "前端开发" }, { id: "be", name: "后端", field: "后端开发" }, { id: "ui", name: "UI", field: "UI人员" }, { id: "plan", name: "策划", field: "策划人员" }];
  const days = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"];
  const tasks = [
    { id: "DEMO-01026", title: "活动入口优化", project: "恶魔高校", state: "待分配", type: "优化", deadline: 4, effort: 2, summary: "活动首页新增限时入口与状态展示，接入活动配置和领取接口。", chain: "ready", roles: ["fe", "be", "ui", "plan"] },
    { id: "DEMO-01031", title: "公会商店改版", project: "一骑当千", state: "待分配", type: "新功能", deadline: 3, effort: 2.5, summary: "调整商品分类与兑换流程，增加公会等级限制及库存状态。", chain: "coord", roles: ["fe", "be", "ui", "plan"] },
    { id: "DEMO-01038", title: "跨服排行榜", project: "恶魔高校", state: "待分配", type: "新功能", deadline: 2, effort: 3, summary: "增加跨服排名与奖励预览，涉及榜单接口及完整 UI 资源。", chain: "missing", roles: ["fe", "be", "ui", "plan"] },
    { id: "DEMO-01042", title: "角色详情页调整", project: "女王之刃", state: "待分配", type: "优化", deadline: 6, effort: 1.5, summary: "调整角色属性分组、装备入口和技能说明的呈现。", chain: "ready", roles: ["fe", "be", "ui", "plan"] },
    { id: "DEMO-01047", title: "节日签到配置", project: "一骑当千", state: "规划中", type: "活动配置", deadline: 4, effort: 1, summary: "配置七日签到奖励与对应的活动开放条件。", chain: "ready", roles: ["plan", "ui"] }
  ];
  const pools = {
    fe: [["lin", "张林", "前端", "沈组长", 2.5, 0.5, 0, false], ["mu", "陈沐", "前端 / 后端", "顾组长", 2, 1, 2, false], ["yu", "周屿", "前端", "沈组长", 4.5, 1, 0, false], ["an", "林安", "前端", "顾组长", 1, 0.5, 0, true]],
    be: [["mu", "陈沐", "前端 / 后端", "顾组长", 2, 1, 0, false], ["xu", "许澄", "后端", "宋组长", 2.5, 0.5, 1, false], ["lu", "陆知", "后端", "宋组长", 4, 1.5, 0, false]],
    ui: [["wen", "温宁", "UI", "程组长", 2, 0.5, 0, false], ["qiao", "乔一", "UI", "程组长", 1.5, 1, 2, false], ["ye", "叶青", "UI", "程组长", 3.5, 1.5, 0, true]],
    plan: [["yan", "严禾", "策划", "夏组长", 2, 0.5, 0, false], ["su", "苏言", "策划", "江组长", 1, 1.5, 0, false], ["ning", "宁川", "策划", "夏组长", 3.5, 1, 0, true]]
  };
  function pool(role) { return (pools[role] || []).map(([id, name, job, leader, load, reserved, release, missing]) => ({ id, name, job, leader, load, reserved, release, missing })); }
  const round = n => Math.round(n * 100) / 100;
  const day = index => days[index] || "日期待核实";
  function workload(person, role) {
    const otherRole = person.id === "mu" ? (role === "fe" ? "后端" : "前端") : roles.find(r => r.id === role).name;
    return [
      { id: "DEMO-L01", title: "每日任务奖励调整", project: "恶魔高校", role: otherRole, effort: round(person.load * 0.6), due: 1, source: "正式剩余", reserved: false },
      { id: "DEMO-L02", title: "角色养成界面", project: "女王之刃", role: roles.find(r => r.id === role).name, effort: round(person.load * 0.4), due: 4, source: "正式剩余", reserved: false },
      { id: "DEMO-L03", title: "活动任务面板", project: "一骑当千", role: roles.find(r => r.id === role).name, effort: person.reserved, due: 3, source: "分配粗估", reserved: true }
    ];
  }
  // Demonstration only: discrete single-person capacity with supplied release dates.
  // This is not the PRD's joint cross-person dependency solver.
  function schedule(items) {
    const slots = days.map(() => 1);
    let gap = 0;
    const failures = [];
    for (const item of [...items].sort((a, b) => a.due - b.due || (b.release || 0) - (a.release || 0))) {
      let left = item.effort;
      for (let d = item.release || 0; d <= item.due && d < slots.length; d++) {
        const take = Math.min(slots[d], left);
        slots[d] = round(slots[d] - take);
        left = round(left - take);
      }
      if (left > 0) { gap = round(gap + left); failures.push({ due: item.due, amount: left }); }
    }
    return { gap, failures, slots };
  }
  function analyze(task, role, effort, assignments = {}) {
    const quantified = Number.isFinite(effort) && effort > 0;
    return pool(role).map(person => {
      const items = workload(person, role);
      for (const [key, entry] of Object.entries(assignments)) {
        const [taskId, entryRole] = key.split(":");
        const otherTask = tasks.find(t => t.id === taskId);
        if (otherTask && entry.personId === person.id && quantifiedEntry(entry)) {
          items.push({ id: taskId, title: otherTask.title, project: otherTask.project, role: roles.find(r => r.id === entryRole).name, effort: entry.effort, due: otherTask.deadline, source: "演示分配粗估", reserved: true, key });
        }
      }
      const targetKey = `${task.id}:${role}`;
      const baseline = schedule(items);
      const proposed = items.filter(item => item.key !== targetKey);
      const after = schedule(quantified ? [...proposed, { effort, due: task.deadline, release: person.release }] : proposed);
      const missing = person.missing || task.chain === "missing" || !quantified || Object.values(assignments).some(e => e.personId === person.id && !quantifiedEntry(e));
      const needsCoord = person.release > 0 || task.chain === "coord";
      const status = missing ? "missing" : after.gap > 0 ? "conflict" : needsCoord ? "coord" : "ready";
      return { ...person, items, baseline: baseline.gap, gap: quantified ? after.gap : null, delta: quantified ? round(after.gap - baseline.gap) : null, status, needsCoord, quantified,
        total: round(items.filter(i => !i.reserved).reduce((n, i) => n + i.effort, 0)),
        reservation: round(items.filter(i => i.reserved).reduce((n, i) => n + i.effort, 0)) };
    });
  }
  function quantifiedEntry(entry) { return Number.isFinite(entry.effort) && entry.effort > 0; }
  const labels = { ready: "当前条件支持", coord: "调整后可支持", conflict: "存在明确冲突", missing: "数据不足" };
  function sort(results, mode) {
    const weight = { ready: 0, coord: 1, conflict: 2, missing: 3 };
    return [...results].sort((a, b) => mode === "load" ? (a.total + a.reservation) - (b.total + b.reservation) : weight[a.status] - weight[b.status] || (a.delta || 0) - (b.delta || 0) || a.total - b.total);
  }
  return { version, roles, days, tasks, pool, workload, analyze, sort, schedule, day, labels, round };
});
