"use strict";

const assert = require("assert");
const { copyThenOpen } = require("../src/admin/static/demand-locator-navigation");

function childWindow(order) {
  return {
    opener: { unsafe: true },
    location: { replace: (url) => order.push(`open:${url}`) },
    close: () => order.push("close")
  };
}

const newWindowOrder = [];
const newWindow = childWindow(newWindowOrder);
const newWindowResult = copyThenOpen({
  demandId: "003670",
  url: "https://example.test/table",
  copySynchronously: (id) => { newWindowOrder.push(`copy:${id}`); return true; },
  openWindow: () => newWindow
});
assert.strictEqual(newWindowResult.copyStatus, "sync_copied");
assert.deepStrictEqual(newWindowResult.navigation, { strategy: "new_window", reason: "opened" });
assert.deepStrictEqual(newWindowOrder, ["copy:003670", "open:https://example.test/table"]);
assert.strictEqual(newWindow.opener, null);

const blockedOrder = [];
const blockedResult = copyThenOpen({
  demandId: "003669",
  url: "https://example.test/table",
  copySynchronously: (id) => { blockedOrder.push(`copy:${id}`); return true; },
  openWindow: () => null,
  navigateCurrent: (url) => blockedOrder.push(`current:${url}`)
});
assert.strictEqual(blockedResult.copyStatus, "sync_copied");
assert.deepStrictEqual(blockedResult.navigation, { strategy: "current_page", reason: "popup_blocked" });
assert.deepStrictEqual(blockedOrder, ["copy:003669", "current:https://example.test/table"]);

const noIdOrder = [];
const noIdResult = copyThenOpen({
  url: "https://example.test/table",
  copySynchronously: () => { noIdOrder.push("copy"); return true; },
  openWindow: () => childWindow(noIdOrder)
});
assert.strictEqual(noIdResult.copyStatus, "no_id");
assert.deepStrictEqual(noIdOrder, ["open:https://example.test/table"]);

const failedCopyOrder = [];
const failedCopyResult = copyThenOpen({
  demandId: "003668",
  url: "https://example.test/table",
  copySynchronously: () => { failedCopyOrder.push("copy"); throw new Error("copy_denied"); },
  copyAsynchronously: async () => { failedCopyOrder.push("async_copy"); throw new Error("async_denied"); },
  openWindow: () => childWindow(failedCopyOrder)
});
assert.strictEqual(failedCopyResult.copyStatus, "async_attempted");
assert.deepStrictEqual(failedCopyOrder, ["copy", "open:https://example.test/table"]);
failedCopyResult.asyncCopyPromise.then((result) => {
  assert.deepStrictEqual(result, { status: "copy_failed", reason: "async_denied" });
  assert.deepStrictEqual(failedCopyOrder, ["copy", "open:https://example.test/table", "async_copy"]);
  console.log(JSON.stringify({
    passed: true,
    checks: {
      syncCopyBeforeNewWindow: true,
      syncCopyBeforePopupFallback: true,
      noIdSkipsCopy: true,
      syncCopyFailureStillNavigatesBeforeAsyncRetry: true
    }
  }, null, 2));
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
