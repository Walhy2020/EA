"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const copyApi = require("../src/admin/static/demand-task-id-copy");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "admin", "static", "demand-h5.html"), "utf8");
const css = fs.readFileSync(path.join(root, "src", "admin", "static", "demand-h5.css"), "utf8");
const js = fs.readFileSync(path.join(root, "src", "admin", "static", "demand-h5.js"), "utf8");

assert.strictEqual(copyApi.taskIdForItem({ demandId: " 000123 ", taskId: "task-2" }), "000123");
assert.strictEqual(copyApi.taskIdForItem({ taskId: " task-2 ", recordId: "record-3" }), "task-2");
assert.strictEqual(copyApi.taskIdForItem({ recordId: " record-3 " }), "record-3");
assert.strictEqual(copyApi.taskIdForItem({ id: " fallback-id " }), "fallback-id");
assert.strictEqual(copyApi.taskIdForItem({}), "");

assert.match(html, /demand-task-id-copy\.js\?v=0\.3\.0[\s\S]*demand-h5\.js\?v=0\.3\.3/);
assert.match(html, /class="build-version">v0\.3\.3</);
assert.match(css, /\.task-id-copy-button\s*\{[\s\S]*position:\s*absolute;[\s\S]*top:\s*8px;[\s\S]*right:\s*8px;/);
assert.match(css, /\.task-id-copy-icon::before,[\s\S]*\.task-id-copy-icon::after/);
assert.match(js, /event\.stopPropagation\(\)/);
assert.strictEqual((js.match(/appendTaskIdCopyButton\(item, /g) || []).length, 3);
assert.strictEqual((js.match(/document\.createElement\("div"\)/g) || []).length >= 3, true);

(async () => {
  let copiedValue = "";
  const copied = await copyApi.copyTaskId(" 000123 ", async (value) => {
    copiedValue = value;
    return true;
  });
  assert.deepStrictEqual(copied, { ok: true, taskId: "000123", reason: "copied" });
  assert.strictEqual(copiedValue, "000123");

  const rejected = await copyApi.copyTaskId("000123", async () => false);
  assert.deepStrictEqual(rejected, { ok: false, taskId: "000123", reason: "copy_rejected" });

  const failed = await copyApi.copyTaskId("000123", async () => {
    throw new Error("clipboard denied");
  });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.reason, "copy_failed");
  assert.strictEqual(failed.message, "clipboard denied");

  console.log("Demand H5 task ID copy checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
