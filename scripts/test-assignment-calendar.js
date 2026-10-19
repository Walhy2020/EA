"use strict";

const assert = require("node:assert/strict");
const { __test: { calendarDateLabel } } = require("../src/modules/devProgress/wecomSmartsheetClient");
assert.equal(calendarDateLabel("1762963200000"), "2025-11-12", "legacy callers retain UTC interpretation");
assert.equal(calendarDateLabel("1762963200000", 480), "2025-11-13", "assignment dates use Shanghai date");
assert.equal(calendarDateLabel("1762963200", 480), "2025-11-13", "seconds supported");
assert.equal(calendarDateLabel("2026-10-19", 480), "2026-10-19", "explicit dates unchanged");
assert.equal(calendarDateLabel("", 480), "");
console.log("Assignment calendar passed: opt-in Shanghai date, numeric seconds/milliseconds, legacy default unchanged.");
