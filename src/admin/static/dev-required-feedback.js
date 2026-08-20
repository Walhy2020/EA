"use strict";

(() => {
  const query = new URLSearchParams(window.location.search);
  const state = {
    reminderId: query.get("reminderId") || "",
    token: query.get("token") || "",
    task: null,
    submitting: false,
    refreshing: false
  };
  const elements = {
    loading: document.getElementById("loadingPanel"),
    error: document.getElementById("errorPanel"),
    panel: document.getElementById("taskPanel"),
    badge: document.getElementById("statusBadge"),
    demand: document.getElementById("demandName"),
    demandId: document.getElementById("demandId"),
    owner: document.getElementById("ownerName"),
    project: document.getElementById("projectName"),
    missing: document.getElementById("missingFields"),
    refresh: document.getElementById("refreshButton"),
    processing: document.getElementById("processingButton"),
    done: document.getElementById("doneButton"),
    message: document.getElementById("actionMessage")
  };

  function queryString() {
    return new URLSearchParams({
      reminderId: state.reminderId,
      token: state.token
    }).toString();
  }

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    const result = await response.json().catch(() => ({ ok: false, message: "服务返回内容无效" }));
    if (!response.ok || !result.ok) {
      const error = new Error(result.message || "请求失败");
      error.result = result;
      throw error;
    }
    return result;
  }

  function setMessage(message, isError = false) {
    elements.message.textContent = message || "";
    elements.message.classList.toggle("error", Boolean(isError));
  }

  function render(task) {
    state.task = task;
    elements.badge.textContent = task.statusText || "未知状态";
    elements.demand.textContent = task.demand || "未填写需求名称";
    elements.demandId.textContent = task.demandId || "-";
    elements.owner.textContent = task.ownerName || "-";
    elements.project.textContent = task.project || "-";
    const missingFields = Array.isArray(task.missingFields) ? task.missingFields : [];
    elements.missing.textContent = missingFields.length > 0 ? missingFields.join("、") : "已无缺失字段";
    elements.refresh.disabled = state.submitting || state.refreshing;
    elements.processing.disabled = state.submitting || state.refreshing || !task.canStart;
    elements.done.disabled = state.submitting || state.refreshing || !task.canComplete;
  }

  async function load(options = {}) {
    if (!state.reminderId || !state.token) {
      elements.loading.hidden = true;
      elements.error.hidden = false;
      elements.error.textContent = "处理链接不完整，请从需求进度管理消息中重新打开。";
      elements.badge.textContent = "链接无效";
      return;
    }
    state.refreshing = true;
    elements.refresh.disabled = true;
    if (state.task) {
      setMessage(options.manual ? "正在刷新字段..." : "正在同步最新字段...");
    }
    try {
      const suffix = options.manual ? "&refresh=1" : "";
      const result = await requestJson(`/api/dev-progress/required-feedback?${queryString()}${suffix}`);
      elements.loading.hidden = true;
      elements.error.hidden = true;
      elements.panel.hidden = false;
      render(result.task);
      if (result.message) {
        setMessage(result.message, false);
      } else if (options.manual) {
        setMessage("字段已刷新。");
      }
    } catch (error) {
      elements.loading.hidden = true;
      if (state.task) {
        setMessage(error.message || "刷新字段失败。", true);
      } else {
        elements.error.hidden = false;
        elements.error.textContent = error.message || "读取需求失败。";
        elements.badge.textContent = "无法访问";
      }
    } finally {
      state.refreshing = false;
      if (state.task) {
        render(state.task);
      } else {
        elements.refresh.disabled = false;
      }
    }
  }

  async function submit(action) {
    if (!state.task || state.submitting) {
      return;
    }
    state.submitting = true;
    elements.processing.disabled = true;
    elements.done.disabled = true;
    setMessage("正在提交...");
    try {
      const result = await requestJson("/api/dev-progress/required-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reminderId: state.reminderId,
          token: state.token,
          action
        })
      });
      render(result.task);
      setMessage(result.message || "状态已更新。");
    } catch (error) {
      if (error.result && error.result.task) {
        render(error.result.task);
      }
      setMessage(error.message || "提交失败，请稍后重试。", true);
    } finally {
      state.submitting = false;
      if (state.task) {
        render(state.task);
      }
    }
  }

  elements.processing.addEventListener("click", () => submit("processing"));
  elements.done.addEventListener("click", () => submit("done"));
  elements.refresh.addEventListener("click", () => load({ manual: true }));
  load();
})();
