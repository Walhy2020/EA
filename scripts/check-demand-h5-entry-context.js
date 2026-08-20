"use strict";

const context = require("../src/admin/static/demand-entry-context");

const checks = {
  legacyOauthIdentityBlocked: context.resolveIdentity({
    search: "?userName=%E9%AB%98%E6%96%87%E7%9B%9B&entryAuth=wecom_oauth",
    isWeCom: true
  }).name === "",
  directH5WithNameBlocked: context.resolveIdentity({
    search: "?userName=%E9%AB%98%E6%96%87%E7%9B%9B",
    storedName: "李晶晶",
    fallbackName: "李晶晶",
    isWeCom: false
  }).name === "",
  workbenchWithoutStorageRequiresAuth: context.resolveIdentity({
    search: "",
    storedName: "",
    fallbackName: "李晶晶",
    isWeCom: true
  }).source === "wecom_session_required",
  directH5WithUserIdBlocked: context.resolveIdentity({
    search: "?userid=YuYin",
    storedName: "",
    fallbackName: "李晶晶",
    isWeCom: true
  }).name === "",
  localStorageAndFallbackBlocked: context.resolveIdentity({
    search: "",
    storedName: "李晶晶",
    fallbackName: "李晶晶",
    isWeCom: false
  }).source === "web_session_required",
  oldNameParameterBlocked: context.resolveIdentity({
    search: "?name=%E9%AB%98%E6%96%87%E7%9B%9B",
    isWeCom: false
  }).name === "",
  workbenchPreservesIdentityAndPanel: context.buildDemandH5Url(
    "http://10.1.1.81:39200/demand-workbench.html?userName=%E9%AB%98%E6%96%87%E7%9B%9B&embed=1",
    "draft"
  ) === "/demand-h5.html?userName=%E9%AB%98%E6%96%87%E7%9B%9B&embed=1#draft"
};

const passed = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ passed, checks }, null, 2));
if (!passed) process.exitCode = 1;
