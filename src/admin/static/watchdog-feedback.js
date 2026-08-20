"use strict";

(() => {
  const query = new URLSearchParams(window.location.search);
  const state = {
    taskId: query.get("taskId") || "",
    token: query.get("token") || "",
    task: null,
    submitting: false
  };
  const elements = {
    loading: document.getElementById("loadingPanel"),
    error: document.getElementById("errorPanel"),
    panel: document.getElementById("taskPanel"),
    badge: document.getElementById("statusBadge"),
    content: document.getElementById("taskContent"),
    taskId: document.getElementById("taskId"),
    assignee: document.getElementById("assigneeName"),
    requester: document.getElementById("requesterName"),
    mode: document.getElementById("modeText"),
    schedule: document.getElementById("scheduleText"),
    remarkBlock: document.getElementById("remarkBlock"),
    remark: document.getElementById("remarkText"),
    attachmentBlock: document.getElementById("attachmentBlock"),
    attachment: document.getElementById("attachmentText"),
    lastFeedbackBlock: document.getElementById("lastFeedbackBlock"),
    lastFeedback: document.getElementById("lastFeedbackText"),
    note: document.getElementById("feedbackNote"),
    message: document.getElementById("actionMessage"),
    buttons: Array.from(document.querySelectorAll("#actionGrid button"))
  };

  function feedbackQuery() {
    const params = new URLSearchParams({ taskId: state.taskId, token: state.token });
    return params.toString();
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

  function setButtonsDisabled(disabled) {
    elements.buttons.forEach((button) => {
      button.disabled = Boolean(disabled);
    });
    elements.note.disabled = Boolean(disabled);
  }

  function statusClass(task) {
    if (task.status === "completed") {
      return "is-done";
    }
    return task.canFeedback ? "" : "is-ended";
  }

  function formatShanghaiMinute(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value || "").replace("T", " ").slice(0, 16);
    }
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date).reduce((result, part) => {
      if (part.type !== "literal") {
        result[part.type] = part.value;
      }
      return result;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  }

  function renderLastFeedback(lastFeedback) {
    if (!lastFeedback || !lastFeedback.label) {
      elements.lastFeedbackBlock.hidden = true;
      return;
    }
    const lines = [lastFeedback.label];
    if (lastFeedback.note) {
      lines.push(`说明：${lastFeedback.note}`);
    }
    if (lastFeedback.receivedAt) {
      lines.push(`时间：${formatShanghaiMinute(lastFeedback.receivedAt)}`);
    }
    elements.lastFeedback.textContent = lines.join("\n");
    elements.lastFeedbackBlock.hidden = false;
  }

  function renderTask(task) {
    state.task = task;
    elements.badge.textContent = task.statusText || "未知状态";
    elements.badge.className = `status-badge ${statusClass(task)}`.trim();
    elements.content.textContent = task.content || "未填写任务内容";
    elements.taskId.textContent = task.id || state.taskId || "-";
    elements.assignee.textContent = task.assigneeName || "-";
    elements.requester.textContent = task.requesterName || "-";
    elements.mode.textContent = task.modeText || "-";
    elements.schedule.textContent = task.schedule || "-";
    elements.remark.textContent = task.remark || "";
    elements.remarkBlock.hidden = !task.remark;
    elements.attachment.textContent = task.attachment || "";
    elements.attachmentBlock.hidden = !task.attachment;
    renderLastFeedback(task.lastFeedback);
    setButtonsDisabled(state.submitting || !task.canFeedback);
    if (!task.canFeedback) {
      setMessage(`这条盯梢${task.statusText}。`);
    }
  }

  async function loadTask() {
    if (!state.taskId || !state.token) {
      elements.loading.hidden = true;
      elements.error.textContent = "反馈链接不完整，请从企业微信盯梢消息中重新打开。";
      elements.error.hidden = false;
      elements.badge.textContent = "链接无效";
      elements.badge.classList.add("is-ended");
      return;
    }
    try {
      const result = await requestJson(`/api/watchdog/app-feedback?${feedbackQuery()}`);
      elements.loading.hidden = true;
      elements.error.hidden = true;
      elements.panel.hidden = false;
      renderTask(result.task);
    } catch (error) {
      elements.loading.hidden = true;
      elements.error.textContent = error.message || "读取盯梢任务失败。";
      elements.error.hidden = false;
      elements.badge.textContent = "无法访问";
      elements.badge.classList.add("is-ended");
    }
  }

  async function submitFeedback(action) {
    if (!state.task || !state.task.canFeedback || state.submitting) {
      return;
    }
    const note = elements.note.value.trim();
    if (action === "reject" && !note) {
      setMessage("拒绝盯梢前，请填写拒绝原因。", true);
      elements.note.focus();
      return;
    }
    state.submitting = true;
    setButtonsDisabled(true);
    setMessage("正在提交反馈...");
    try {
      const result = await requestJson("/api/watchdog/app-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: state.taskId,
          token: state.token,
          action,
          note
        })
      });
      elements.note.value = "";
      renderTask(result.task);
      setMessage(result.message || "反馈已记录。");
    } catch (error) {
      if (error.result && error.result.task) {
        renderTask(error.result.task);
      }
      setMessage(error.message || "反馈提交失败，请稍后重试。", true);
    } finally {
      state.submitting = false;
      setButtonsDisabled(!state.task || !state.task.canFeedback);
    }
  }

  elements.buttons.forEach((button) => {
    button.addEventListener("click", () => submitFeedback(button.dataset.action || ""));
  });

  loadTask();
})();
