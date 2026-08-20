"use strict";

const assert = require("assert");
const {
  resolveDemandH5EntryPolicy,
  isDemandH5OAuthRequestOriginAllowed
} = require("../src/admin/demandH5EntryPolicy");
const { demandH5OAuthCallbackUrl } = require("../src/admin/demandH5OAuth");

const noDomainTestFallback = resolveDemandH5EntryPolicy({
  testMode: true,
  testFallbackUserName: "高文盛"
});
const trustedDomainOAuth = resolveDemandH5EntryPolicy({
  oauthRedirectOrigin: "https://ea.example.com",
  testMode: true,
  testFallbackUserName: "高文盛"
});
const allowedInternalHttp = resolveDemandH5EntryPolicy({
  oauthRedirectOrigin: "http://com.veryeazy.com:39200",
  internalHttpOAuth: { enabled: true, allowedOrigin: "http://com.veryeazy.com:39200" },
  testMode: true,
  testFallbackUserName: "高文盛"
});
const invalidIpFallsBack = resolveDemandH5EntryPolicy({
  oauthRedirectOrigin: "http://10.1.1.81:39200",
  internalHttpOAuth: { enabled: true, allowedOrigin: "http://com.veryeazy.com:39200" },
  testMode: true,
  testFallbackUserName: "高文盛"
});
const noIdentityBlocks = resolveDemandH5EntryPolicy({ testMode: false, testFallbackUserName: "高文盛" });

assert.deepStrictEqual(
  { mode: noDomainTestFallback.mode, name: noDomainTestFallback.testFallbackName, oauth: noDomainTestFallback.oauth.enabled },
  { mode: "test_fallback", name: "高文盛", oauth: false }
);
assert.deepStrictEqual(
  { mode: trustedDomainOAuth.mode, origin: trustedDomainOAuth.oauth.origin, fallback: trustedDomainOAuth.testFallbackName },
  { mode: "wecom_oauth", origin: "https://ea.example.com", fallback: "" }
);
assert.deepStrictEqual(
  { mode: allowedInternalHttp.mode, origin: allowedInternalHttp.oauth.origin, callback: demandH5OAuthCallbackUrl(allowedInternalHttp.oauth.origin) },
  { mode: "wecom_oauth", origin: "http://com.veryeazy.com:39200", callback: "http://com.veryeazy.com:39200/demand-h5-auth" }
);
assert.strictEqual(isDemandH5OAuthRequestOriginAllowed(allowedInternalHttp, { protocol: "http", host: "com.veryeazy.com:39200" }), true);
assert.strictEqual(isDemandH5OAuthRequestOriginAllowed(allowedInternalHttp, { protocol: "http", host: "10.1.1.81:39200" }), false);
assert.strictEqual(isDemandH5OAuthRequestOriginAllowed(allowedInternalHttp, { protocol: "http", host: "other.veryeazy.com:39200" }), false);
assert.strictEqual(isDemandH5OAuthRequestOriginAllowed(allowedInternalHttp, { protocol: "http", host: "com.veryeazy.com:80" }), false);
assert.strictEqual(isDemandH5OAuthRequestOriginAllowed(allowedInternalHttp, { protocol: "https", host: "com.veryeazy.com:39200" }), false);
assert.strictEqual(invalidIpFallsBack.mode, "test_fallback");
assert.strictEqual(invalidIpFallsBack.oauth.reason, "trusted_origin_invalid");
assert.strictEqual(noIdentityBlocks.mode, "identity_required");

console.log(JSON.stringify({
  passed: true,
  checks: {
    noDomainTestFallback: true,
    httpsOriginUsesOAuth: true,
    exactInternalHttpOriginUsesOAuth: true,
    ipOtherDomainWrongPortAndForgedHostRejected: true,
    ipOriginDoesNotTriggerOAuth: true,
    missingIdentityBlocksOutsideTest: true
  }
}, null, 2));
