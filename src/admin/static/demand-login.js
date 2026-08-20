"use strict";

const loginButton = document.getElementById("loginButton");
const loginStatus = document.getElementById("loginStatus");

function safeReturnPath() {
  const raw = new URLSearchParams(window.location.search).get("returnTo") || "/demand-h5.html";
  try {
    const parsed = new URL(raw, window.location.origin);
    return new Set(["/", "/index.html", "/demand-h5.html", "/demand", "/demand/"]).has(parsed.pathname)
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : "/demand-h5.html";
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
