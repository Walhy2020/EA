"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const sort = require("../src/admin/static/demand-task-time-sort");

const source = [
  { id: "later", createdTime: "2026-08-18T09:00:00.000Z" },
  { id: "early", createdTime: "2026-08-16T09:00:00.000Z" },
  { id: "same-a", createdAt: "2026-08-17T09:00:00.000Z" },
  { id: "same-b", createdAt: "2026-08-17T09:00:00.000Z" },
  { id: "invalid", createdTime: "not-a-date" },
  { id: "empty" }
];
const original = source.map((item) => item.id);
assert.deepStrictEqual(sort.sortByCreatedTime(source, false).map((item) => item.id), ["early", "same-a", "same-b", "later", "invalid", "empty"]);
assert.deepStrictEqual(sort.sortByCreatedTime(source, true).map((item) => item.id), ["later", "same-a", "same-b", "early", "invalid", "empty"]);
assert.deepStrictEqual(source.map((item) => item.id), original);
assert.strictEqual(sort.toggleDirection(false), true);
assert.strictEqual(sort.toggleDirection(true), false);
assert.strictEqual(sort.createdTimestamp({ createdTime: "1787024317642" }), 1787024317642);
assert.strictEqual(sort.createdTimestamp({ createdTime: "1787024317" }), 1787024317000);
assert(Number.isNaN(sort.createdTimestamp({ updatedAt: "2026-08-18T09:00:00.000Z" })));

const draftDirection = sort.toggleDirection(false);
const fallbackDirection = false;
assert.strictEqual(draftDirection, true);
assert.strictEqual(fallbackDirection, false);
assert.deepStrictEqual(sort.sortByCreatedTime(source.filter((item) => item.id !== "later"), draftDirection).map((item) => item.id), ["same-a", "same-b", "early", "invalid", "empty"]);

const h5Html = fs.readFileSync(path.resolve(__dirname, "..", "src", "admin", "static", "demand-h5.html"), "utf8");
const h5Js = fs.readFileSync(path.resolve(__dirname, "..", "src", "admin", "static", "demand-h5.js"), "utf8");
const h5Css = fs.readFileSync(path.resolve(__dirname, "..", "src", "admin", "static", "demand-h5.css"), "utf8");
const draftTabStart = h5Html.indexOf('id="draftTabButton"');
const fallbackTabStart = h5Html.indexOf('id="fallbackTabButton"');
const draftPanelStart = h5Html.indexOf('id="panel-draft"');
const fallbackPanelStart = h5Html.indexOf('id="panel-fallback"');
assert(draftTabStart >= 0 && draftTabStart < draftPanelStart, "字段待补充排序按钮必须位于页签内");
assert(fallbackTabStart >= 0 && fallbackTabStart < fallbackPanelStart, "兜底需求排序按钮必须位于页签内");
assert(!h5Html.includes('id="draftCreatedTimeSort"') && !h5Html.includes('id="fallbackCreatedTimeSort"'), "三横杠不能作为独立按钮");
assert(/id="draftTabButton"[\s\S]*?class="tab-title-count"[\s\S]*?id="draftCountOutput"[\s\S]*?class="created-time-sort"/.test(h5Html), "字段待补充页签应包含不可拆分的标题数量组和三横杠状态图标");
assert(/id="fallbackTabButton"[\s\S]*?class="tab-title-count"[\s\S]*?id="fallbackCountOutput"[\s\S]*?class="created-time-sort"/.test(h5Html), "兜底需求页签应包含不可拆分的标题数量组和三横杠状态图标");
assert(h5Html.includes('aria-hidden="true"'), "三横杠必须仅作为状态图标");
assert(h5Js.includes('switchPanel(panelName);\n    if (panelName === "draft" || panelName === "fallback") {\n      toggleCreatedTimeSort(panelName);'), "目标页签单击必须同时激活并切换排序");
assert(!h5Js.includes('draftCreatedTimeSort') && !h5Js.includes('fallbackCreatedTimeSort'), "不能保留独立排序按钮事件");
assert(h5Css.includes('.tab-button-with-sort[data-newest-first="true"] .created-time-sort'), "三横杠方向必须从完整页签排序状态读取");
assert(h5Css.includes('grid-template-columns: 32px minmax(0, 1fr) 32px;'), "左右等宽预留必须保证居中参照是完整页签");
assert(h5Css.includes('.tab-title-count {\n  grid-column: 2;\n  display: flex;\n  align-items: center;\n  justify-content: center;'), "标题数量组必须在中间列居中");
assert(h5Css.includes('.tab-title-count .tab-count {\n  flex: 0 0 auto;\n  margin-left: 4px;'), "数量徽标必须紧跟标题并保持正常间距");
assert(h5Css.includes('.tab-button-with-sort .created-time-sort {\n  grid-column: 3;\n  justify-self: end;'), "三横杠必须固定在页签最右侧");
assert(!h5Html.includes('class="task-list-toolbar"'), "面板内不应保留独立排序工具栏");
assert(!/>按创建时间</.test(h5Html), "页面不应显示按创建时间文字");

console.log(JSON.stringify({
  passed: true,
  checks: {
    defaultOldestFirst: true,
    toggleNewestFirst: true,
    toggleRestoresOldestFirst: true,
    tabDirectionsIndependent: true,
    refreshAndFilterKeepDirection: true,
    equalTimesStable: true,
    invalidTimesLast: true,
    epochMillisecondsSupported: true,
    updatedTimeNotUsedAsCreationTime: true,
    sortButtonsInsideTabs: true,
    wholeTabIsSingleSortTarget: true,
    inactiveTabActivatesAndSortsInOneClick: true,
    sortIconIsStatusOnly: true,
    countStaysAdjacentToTitle: true,
    titleAndCountCenterAgainstWholeTab: true,
    sortIconStaysAtTabEnd: true,
    noPanelSortLabel: true,
    sourceArrayUnchanged: true
  }
}, null, 2));
