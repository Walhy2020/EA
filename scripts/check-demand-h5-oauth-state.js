"use strict";

const assert = require("assert");
const { signDemandH5State, verifyDemandH5State } = require("../src/admin/demandH5AuthState");

const secret = "test-only-state-secret";
const now = 1_786_600_000_000;
const state = signDemandH5State("/demand-h5.html?panel=todo", secret, { now, audience: "wecom_pc" });
const tampered = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
const normalize = (value) => String(value || "").startsWith("/demand-h5.html") ? String(value) : "/demand-h5.html";

assert.strictEqual(verifyDemandH5State(state, secret, { now: now + 1, audience: "wecom_pc", normalizeReturnPath: normalize }), "/demand-h5.html?panel=todo");
assert.strictEqual(verifyDemandH5State(state, secret, { now: now + 1, audience: "wecom_h5", normalizeReturnPath: normalize }), "");
assert.strictEqual(verifyDemandH5State(tampered, secret, { now: now + 1, audience: "wecom_pc", normalizeReturnPath: normalize }), "");
assert.strictEqual(verifyDemandH5State(state, secret, { now: now + 5 * 60 * 1000, audience: "wecom_pc", normalizeReturnPath: normalize }), "");

console.log(JSON.stringify({ passed: true, checks: { stateAccepted: true, audienceMismatchRejected: true, stateTamperingRejected: true, expiredStateRejected: true } }, null, 2));
