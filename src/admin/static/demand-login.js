"use strict";

const loginButton = document.getElementById("loginButton");
const loginStatus = document.getElementById("loginStatus");

function safeReturnPath() {
  const raw = new URLSearchParams(window.location.search).get("returnTo") || "/demand-h5.html";
  try {
    const parsed = new URL(raw, window.location.origin);
    if (!new Set(["/", "/index.html", "/demand-h5.html", "/demand", "/demand/", "/watchdog-feedback.html"]).has(parsed.pathname)) {
      return "/demand-h5.html";
    }
    if (parsed.pathname === "/watchdog-feedback.html") {
      const feedbackRef = String(parsed.searchParams.get("ref") || "").trim().toLowerCase();
      return /^[a-f0-9]{12}$/.test(feedbackRef)
        ? `/watchdog-feedback.html?ref=${encodeURIComponent(feedbackRef)}`
        : "/watchdog-feedback.html";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch (error) {
    return "/demand-h5.html";
  }
}

async function initializeLogin() {
  const returnTo = safeReturnPath();
  loginButton.href = `/demand-web-login?returnTo=${encodeURIComponent(returnTo)}`;
  const entryError = new URLSearchParams(window.location.search).get("entryError");
  if (entryError) {
    loginStatus.textContent = "登录未完成，请重新扫码。";
    return;
  }

  try {
    const response = await fetch("/api/dev-progress/h5-session", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.identity || !payload.identity.name) {
      loginStatus.textContent = "请使用企业微信扫码登录";
      return;
    }
    loginStatus.textContent = `已登录：${payload.identity.name}`;
    loginButton.textContent = "进入需求进度管理";
    loginButton.href = returnTo;
  } catch (error) {
    loginStatus.textContent = "请使用企业微信扫码登录";
  }
}

initializeLogin();
