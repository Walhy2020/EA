"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const settingsApi = require("../src/admin/static/demand-project-settings");

const catalog = [
  { value: "恶魔高校", label: "恶魔高校", aliases: ["高校"] },
  { value: "一骑当千", label: "一骑当千", aliases: ["一骑", "STB"] },
  { value: "女王之刃", label: "女王之刃", aliases: ["女王"] },
  { value: "嗜血", label: "噬血狂袭", aliases: ["噬血狂袭"] },
  { value: "魔王", label: "魔王", aliases: [] }
];

const defaults = settingsApi.normalizeSettings({}, catalog);
assert.strictEqual(defaults.showAll, false);
assert.deepStrictEqual(defaults.allProjects, catalog.map((item) => item.value));
assert.deepStrictEqual(settingsApi.selectableProjects(defaults, catalog).map((item) => item.value), catalog.map((item) => item.value));

const configured = settingsApi.normalizeSettings({
  showAll: true,
  allProjects: ["恶魔高校", "嗜血", "unknown", "嗜血"],
  order: ["魔王", settingsApi.ALL_PROJECT_VALUE, "恶魔高校", "unknown"]
}, catalog);
assert.deepStrictEqual(configured.allProjects, ["恶魔高校", "嗜血"]);
assert.deepStrictEqual(
  settingsApi.selectableProjects(configured, catalog).map((item) => item.value),
  ["魔王", settingsApi.ALL_PROJECT_VALUE, "恶魔高校", "一骑当千", "女王之刃", "嗜血"]
);

const moved = settingsApi.moveProject(configured, catalog, settingsApi.ALL_PROJECT_VALUE, "up");
assert.deepStrictEqual(settingsApi.visibleOrder(moved, catalog).slice(0, 2), [settingsApi.ALL_PROJECT_VALUE, "魔王"]);
assert.deepStrictEqual(settingsApi.moveProject(moved, catalog, settingsApi.ALL_PROJECT_VALUE, "up"), moved);

const records = [
  { id: "highschool", project: "高校" },
  { id: "strike", project: "嗜血" },
  { id: "queen", project: "女王" },
  { id: "other", project: "小小" }
];
assert.deepStrictEqual(
  settingsApi.filterItems(records, settingsApi.ALL_PROJECT_VALUE, configured, catalog).map((item) => item.id),
  ["highschool", "strike"]
);
assert.strictEqual(settingsApi.itemMatchesSelection(records[0], "恶魔高校", configured, catalog), true);
assert.strictEqual(settingsApi.itemMatchesSelection(records[2], "恶魔高校", configured, catalog), false);
assert.deepStrictEqual(settingsApi.filterItems(records, "恶魔高校", configured, catalog), records);

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "admin", "static", "demand-h5.html"), "utf8");
const js = fs.readFileSync(path.join(root, "src", "admin", "static", "demand-h5.js"), "utf8");
const css = fs.readFileSync(path.join(root, "src", "admin", "static", "demand-h5.css"), "utf8");
const server = fs.readFileSync(path.join(root, "src", "admin", "adminServer.js"), "utf8");

assert(/id="projectSelect"[\s\S]*?id="monitorRefreshButton"[\s\S]*?id="projectSettingsButton"/.test(html), "刷新和设置按钮必须位于项目选择右侧");
assert(html.includes('id="projectSettingsDialog"'), "页面必须包含项目设置窗口");
assert(html.includes('id="showAllProjectsInput"'), "项目设置必须支持启用全部项目");
assert(html.includes('id="allProjectsOptions"'), "项目设置必须支持配置全部项目包含范围");
assert(html.includes('id="projectOrderList"'), "项目设置必须支持调整项目顺序");
assert(/demand-project-settings\.js\?v=0\.3\.2[\s\S]*demand-h5\.js\?v=0\.3\.2/.test(html), "项目设置模块必须先于主页面脚本加载");
assert(js.includes('const H5_PAGE_VERSION = "0.3.2"'), "页面请求必须携带最新版本号");
assert(js.includes('params.set("forceRefresh", "1")'), "手动刷新必须请求服务端强制刷新");
assert(js.includes('params.set("waitForRefresh", "1")'), "手动刷新必须等待最新总表扫描完成");
assert(js.includes('dataStatus.textContent = "数据更新时间：正在读取最新需求总表..."'), "刷新期间必须显示明确状态");
assert(js.includes('showToast("已读取最新需求总表")'), "刷新成功必须有用户提示");
assert(js.includes('throw new Error("未能读取最新需求总表，当前仍显示上一次成功数据")'), "旧缓存不得伪装成手动刷新成功");
assert(js.includes("window.localStorage.setItem(PROJECT_SETTINGS_API.STORAGE_KEY"), "项目设置必须持久保存到当前浏览器");
assert(js.includes("filterItemsForSelectedProject"), "全部项目必须按设置范围过滤");
assert(css.includes(".project-toolbar") && css.includes("grid-template-columns: minmax(0, 1fr) 40px 40px;"), "项目选择和两个图标按钮必须保持稳定布局");
assert(css.includes(".project-settings-dialog") && css.includes(".project-order-button"), "项目设置窗口和排序按钮必须有完整样式");
assert(server.includes('forceRefresh: url.searchParams.get("forceRefresh") === "1"'), "服务端日志必须记录强制刷新标记");
assert(server.includes('waitForRefresh: url.searchParams.get("waitForRefresh") === "1"'), "服务端日志必须记录等待刷新标记");
assert(server.includes("cacheRefreshedAt"), "服务端日志必须记录本次返回的缓存更新时间");
assert(server.includes("cacheModifyTime"), "服务端日志必须记录本次返回的文档修改时间");

console.log(JSON.stringify({
  passed: true,
  checks: {
    manualRefreshForcesLatestScan: true,
    staleRefreshIsNotReportedAsSuccess: true,
    allProjectToggle: true,
    allProjectMembership: true,
    projectOrderIncludingAll: true,
    projectAliasFiltering: true,
    browserPersistence: true,
    responsiveControlLayout: true,
    refreshAuditLogging: true
  }
}, null, 2));
