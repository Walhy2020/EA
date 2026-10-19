(function (root, factory) {
  const model = factory();
  if (typeof module === "object" && module.exports) module.exports = model;
  else root.AssignmentReference = model;
})(typeof window === "object" ? window : globalThis, function () {
  "use strict";
  const version = "0.2.1";
  const labels = { missing: "数据不足", conflict: "存在明确冲突", conditional: "有条件参考" };
  const itemRole = value => ({ fe: "前端", be: "后端", ui: "美术" })[value] || "岗位待核实";
  const itemSource = value => ({ formal_remaining: "正式剩余", unknown_reservation: "未量化预占", unknown: "来源待核实" })[value] || "来源待核实";
  const html = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const number = value => typeof value === "number" && Number.isFinite(value) ? String(value) : "未知";
  const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "待核实";
  function snapshot(value) {
    if (!value) return "快照时间未知";
    const time = new Date(value);
    if (!Number.isFinite(time.getTime())) return "快照时间未知";
    return `快照：${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(time)}`;
  }
  function effort(value) {
    if (value === "" || value === null) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > 40) throw new Error("请输入大于 0、不超过 40 的人日，或留空。");
    return n;
  }
  function visibleTasks(tasks, projects, search, order) {
    return tasks.filter(t => (!projects || projects.includes(t.project)) && `${t.title} ${t.demandId} ${t.id}`.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => {
        if (!a.deadline || !b.deadline) return a.deadline ? -1 : b.deadline ? 1 : String(a.id).localeCompare(String(b.id));
        return (order === "asc" ? 1 : -1) * a.deadline.localeCompare(b.deadline) || String(a.id).localeCompare(String(b.id));
      });
  }
  function validResult(r) {
    return r && r.ok === true && r.version === version && r.readOnly === true && Array.isArray(r.roles) && Array.isArray(r.tasks) && Array.isArray(r.candidates)
      && r.roles.every(role => role && ["fe", "be", "ui"].includes(role.id) && typeof role.name === "string")
      && Array.isArray(r.warnings)
      && r.tasks.every(t => t && typeof t.id === "string" && (t.deadline === null || typeof t.deadline === "string") && Array.isArray(t.warnings))
      && r.candidates.every(p => p && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.items) && p.items.every(item => item && typeof item.id === "string") && Array.isArray(p.reasons) && Array.isArray(p.dependencies));
  }
  return { version, labels, html, number, date, snapshot, effort, visibleTasks, validResult, itemRole, itemSource };
});
