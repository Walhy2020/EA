"use strict";

const assert = require("assert");
const {
  COOKIE_NAME,
  clearDemandH5SessionCookie,
  createDemandH5Session,
  demandH5SessionCookie,
  parseCookieHeader,
  readDemandH5Session,
  verifyDemandH5Session
} = require("../src/admin/demandH5Session");

const secret = "test-only-demand-session-secret";
const now = 1_786_600_000_000;
const session = createDemandH5Session({ userId: "LiJingJing", name: "李晶晶" }, secret, {
  now,
  ttlMs: 7 * 24 * 60 * 60 * 1000
});
const cookie = demandH5SessionCookie(session.token, { secure: true, maxAgeSeconds: 604800 });
const request = { headers: { cookie: `${cookie.split(";")[0]}; other=value` } };
const verified = readDemandH5Session(request, secret, { now: now + 1000 });
const tokenParts = session.token.split(".");
const tamperedToken = `${tokenParts[0]}.${tokenParts[1].slice(0, -1)}${tokenParts[1].endsWith("A") ? "B" : "A"}`;

assert.strictEqual(verified.ok, true);
assert.strictEqual(verified.identity.userId, "LiJingJing");
assert.strictEqual(verified.identity.name, "李晶晶");
assert.strictEqual(verifyDemandH5Session(tamperedToken, secret, { now: now + 1000 }).ok, false);
assert.strictEqual(verifyDemandH5Session(session.token, secret, { now: now + 7 * 24 * 60 * 60 * 1000 }).reason, "expired");
assert.strictEqual(parseCookieHeader(`${COOKIE_NAME}=abc%2Edef; x=1`)[COOKIE_NAME], "abc.def");
assert.match(cookie, /HttpOnly/);
assert.match(cookie, /Secure/);
assert.match(cookie, /SameSite=Lax/);
assert.match(clearDemandH5SessionCookie({ secure: true }), /Max-Age=0/);
assert.throws(() => createDemandH5Session({ userId: "", name: "李晶晶" }, secret));

console.log(JSON.stringify({
  passed: true,
  checks: {
    signedSessionAccepted: true,
    tamperedSessionRejected: true,
    expiredSessionRejected: true,
    cookieParsedAndHardened: true,
    invalidIdentityRejected: true
  }
}, null, 2));
