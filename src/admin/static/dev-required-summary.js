"use strict";

(() => {
  const elements = {
    loading: document.getElementById("loadingPanel"),
    error: document.getElementById("errorPanel"),
    empty: document.getElementById("emptyPanel"),
    panel: document.getElementById("taskPanel"),
    badge: document.getElementById("statusBadge"),
    demand: document.getElementById("demandName"),
    reminderId: document.getElementById("reminderId"),
    owner: document.getElementById("ownerName"),
    project: document.getElementById("projectName"),
    demandId: document.getElementById("demandId"),
    missing: document.getElementById("missingFields"),
    latestAction: document.getElementById("latestAction")
  };

  function formatChinaTime(value) {
    const date = new Date(value || "");
    if (!Number.isFinite(date.getTime())) {
      return "-";
    }
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date).replace(/\//g, "-");
  }

  function statusClass(status) {
    if (status === "processing") {
      return "is-processing";
    }
    if (status === "awaiting_processing") {
      return "is-waiting";
    }
    if (status === "completed" || status === "resolved") {
      return "is-done";
    }
    return "";
  }

  function latestActionText(task, updatedAt) {
    if (task.status === "processing") {
      return `正在处理，开始时间：${formatChinaTime(task.processingAt || updatedAt)}`;
    }
    if (task.status === "completed") {
      return `已完成，完成时间：${formatChinaTime(task.completedAt || updatedAt)}`;
    }
    if (task.status === "resolved") {
      return `字段已补齐，核对时间：${formatChinaTime(task.resolvedAt || updatedAt)}`;
    }
    return `尚未开始处理，提醒时间：${formatChinaTime(updatedAt)}`;
  }

  function render(summary) {
    const task = summary && summary.task;
    elements.loading.hidden = true;
    if (!task) {
      elements.empty.hidden = false;
      elements.badge.textContent = "暂无任务";
      return;
    }
    elements.panel.hidden = false;
    elements.badge.textContent = task.statusText || "未知状态";
    elements.badge.className = `status-badge ${statusClass(task.status)}`.trim();
    elements.demand.textContent = task.demand || "未填写需求名称";
    elements.reminderId.textContent = task.id || "-";
    elements.owner.textContent = task.ownerName || summary.targetName || "-";
    elements.project.textContent = task.project || "-";
    elements.demandId.textContent = task.demandId || "-";
    elements.missing.textContent = (task.missingFields || []).join("、") || "-";
    elements.latestAction.textContent = latestActionText(task, summary.updatedAt);
  }

  async function load() {
    try {
      const response = await fetch("/api/dev-progress/required-summary", {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      const result = await response.json().catch(() => ({ ok: false, message: "服务返回内容无效" }));
      if (!response.ok || !result.ok) {
        throw new Error(result.message || "需求任务读取失败");
      }
      render(result.summary);
    } catch (error) {
      elements.loading.hidden = true;
      elements.error.hidden = false;
      elements.error.textContent = error.message || "需求任务读取失败，请稍后重试。";
      elements.badge.textContent = "读取失败";
      elements.badge.className = "status-badge is-ended";
    }
  }

  load();
})();
