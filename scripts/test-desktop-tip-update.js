"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { createAdminServer } = require("../src/admin/adminServer");
const { createDesktopTipModule } = require("../src/modules/desktopTip/desktopTipModule");

function tempRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0 ^ -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function createZip(entries, outputPath) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [nameText, content] of entries) {
    const name = Buffer.from(nameText.replace(/\\/g, "/"), "utf8");
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    const hash = crc32(data);
    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(hash), u32(data.length), u32(data.length), u16(name.length), u16(0), name
    ]);
    local.push(localHeader, data);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(hash), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name
    ]));
    offset += localHeader.length + data.length;
  }
  const centralOffset = offset;
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBuffer.length), u32(centralOffset), u16(0)
  ]);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.concat([...local, centralBuffer, end]));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function compareVersion(left, right) {
  const a = String(left).replace(/^[vV]/, "").split(".").map((item) => (/^\d+$/.test(item) ? Number(item) : 0));
  const b = String(right).replace(/^[vV]/, "").split(".").map((item) => (/^\d+$/.test(item) ? Number(item) : 0));
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function createModuleWithRelease(root, releaseDir, manifestPath) {
  return createDesktopTipModule({
    logger: { info() {}, warn() {}, error() {} },
    disableMaintenanceScheduler: true,
    moduleConfig: {
      enabled: true,
      version: "0.3.0",
      storePath: path.join(root, "events.json"),
      clientRegistry: { storePath: path.join(root, "clients.json"), persistIntervalSeconds: 60 },
      clientUpdate: {
        enabled: true,
        manifestPath,
        packageDir: releaseDir,
        packageUrl: "/api/desktop-tip/client-update/package"
      },
      productionMaintenance: {
        enabled: true,
        storePath: path.join(root, "maintenance.json"),
        sendPermissionMode: "all_signed_in",
        deliveryChannels: ["desktop_tip"]
      }
    }
  });
}

async function requestRaw(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { response, buffer };
}

async function runServerEndpointTests() {
  const root = tempRoot("ea-desktop-tip-update-api-");
  const releaseDir = path.join(root, "releases");
  const manifestPath = path.join(releaseDir, "latest.json");
  const packagePath = path.join(releaseDir, "EA桌面提醒_client_v0.3.0.zip");
  createZip([["desktop-tip-client.ps1", "$Script:Version = \"0.3.0\""]], packagePath);
  const manifest = {
    version: "0.3.0",
    publishedAt: "2026-08-20T00:00:00.000Z",
    packageUrl: "/api/desktop-tip/client-update/package",
    packageFile: path.basename(packagePath),
    sha256: sha256(packagePath),
    size: fs.statSync(packagePath).size,
    releaseNotes: ["测试发布"],
    minimumSupportedVersion: "0.3.0"
  };
  writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const desktopTip = createModuleWithRelease(root, releaseDir, manifestPath);
  const adminServer = createAdminServer({
    config: {
      app: { server: { host: "127.0.0.1", port: 0, https: { enabled: false } }, runtime: {}, security: {} },
      modules: { modules: {}, monitors: {}, notification: {} },
      routes: {}
    },
    router: { handleMessage: async () => ({ ok: true }) },
    modules: { desktopTip },
    robotServer: {},
    robotDiagnostics: {},
    monitorManager: { getStatus: () => ({}) },
    notificationCenter: { getStatus: () => ({}) },
    logger: { info() {}, warn() {}, error() {} }
  });
  const server = adminServer.start();
  if (!server.listening) {
    await new Promise((resolve) => server.once("listening", resolve));
  }
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const manifestResult = await requestRaw(baseUrl, "/api/desktop-tip/client-update/manifest");
    assert.equal(manifestResult.response.status, 200);
    assert.equal(manifestResult.response.headers.get("cache-control"), "no-store");
    const manifestBody = JSON.parse(manifestResult.buffer.toString("utf8"));
    assert.equal(manifestBody.manifest.version, "0.3.0");
    assert.equal(manifestBody.manifest.packageUrl, "/api/desktop-tip/client-update/package");

    const packageResult = await requestRaw(baseUrl, "/api/desktop-tip/client-update/package");
    assert.equal(packageResult.response.status, 200);
    assert.match(packageResult.response.headers.get("content-type"), /application\/zip/);
    assert.equal(Number(packageResult.response.headers.get("content-length")), manifest.size);
    assert.equal(packageResult.buffer.length, manifest.size);
  } finally {
    adminServer.stop();
    desktopTip.stop();
  }
}

function assertThrowsStatus(fn, statusCode, message) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, message || "expected throw");
  assert.equal(thrown.statusCode, statusCode);
}

function runManifestValidationTests() {
  const root = tempRoot("ea-desktop-tip-update-validate-");
  const releaseDir = path.join(root, "releases");
  const manifestPath = path.join(releaseDir, "latest.json");
  let module = createModuleWithRelease(root, releaseDir, manifestPath);
  assertThrowsStatus(() => module.getClientUpdateManifest(), 404, "missing manifest must return 404");
  module.stop();

  const zipPath = path.join(releaseDir, "ok.zip");
  createZip([["desktop-tip-client.ps1", "ok"]], zipPath);
  const baseManifest = {
    version: "0.3.1",
    publishedAt: "2026-08-20T00:00:00.000Z",
    packageUrl: "/api/desktop-tip/client-update/package",
    packageFile: "ok.zip",
    sha256: sha256(zipPath),
    size: fs.statSync(zipPath).size,
    releaseNotes: ["ok"]
  };
  writeFile(manifestPath, JSON.stringify({ ...baseManifest, packageFile: "../secret.zip" }));
  module = createModuleWithRelease(root, releaseDir, manifestPath);
  assertThrowsStatus(() => module.getClientUpdateManifest(), 503, "path traversal package file must return 503");
  module.stop();

  writeFile(manifestPath, JSON.stringify({ ...baseManifest, size: baseManifest.size + 1 }));
  module = createModuleWithRelease(root, releaseDir, manifestPath);
  assertThrowsStatus(() => module.getClientUpdateManifest(), 503, "size mismatch must return 503");
  module.stop();

  writeFile(manifestPath, JSON.stringify({ ...baseManifest, sha256: "0".repeat(64) }));
  module = createModuleWithRelease(root, releaseDir, manifestPath);
  assertThrowsStatus(() => module.getClientUpdateManifest(), 503, "hash mismatch must return 503");
  module.stop();
}

function runUpdaterTests() {
  const root = tempRoot("中文-EA桌面提醒-update-");
  const installDir = path.join(root, "安装目录");
  fs.mkdirSync(installDir, { recursive: true });
  writeFile(path.join(installDir, "desktop-tip-client.ps1"), "old-client");
  writeFile(path.join(installDir, "desktop-tip-updater.ps1"), fs.readFileSync(path.join(__dirname, "..", "tools", "desktop-tip", "desktop-tip-updater.ps1"), "utf8"));
  writeFile(path.join(installDir, "config", "desktop-tip-client.config.json"), "{\"keep\":true}");
  writeFile(path.join(installDir, "data", "client-id.txt"), "keep-client-id");
  writeFile(path.join(installDir, "logs", "desktop-tip-client.log"), "keep-log");
  const restartScript = path.join(installDir, "restart-marker.ps1");
  writeFile(restartScript, `Set-Content -Path '${path.join(installDir, "restart.txt").replace(/'/g, "''")}' -Value restarted -Encoding UTF8`);

  const okZip = path.join(root, "ok.zip");
  createZip([
    ["desktop-tip-client.ps1", "new-client"],
    ["desktop-tip-updater.ps1", fs.readFileSync(path.join(__dirname, "..", "tools", "desktop-tip", "desktop-tip-updater.ps1"))],
    ["README.md", "readme"]
  ], okZip);
  const ok = childProcess.spawnSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", path.join(installDir, "desktop-tip-updater.ps1"),
    "-PackagePath", okZip,
    "-InstallDir", installDir,
    "-MainScript", restartScript,
    "-ExpectedSha256", sha256(okZip),
    "-ExpectedSize", String(fs.statSync(okZip).size),
    "-ExpectedVersion", "0.3.1"
  ], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
  assert.equal(fs.readFileSync(path.join(installDir, "desktop-tip-client.ps1"), "utf8"), "new-client");
  assert.equal(fs.readFileSync(path.join(installDir, "config", "desktop-tip-client.config.json"), "utf8"), "{\"keep\":true}");
  assert.equal(fs.readFileSync(path.join(installDir, "data", "client-id.txt"), "utf8"), "keep-client-id");
  assert.equal(fs.readFileSync(path.join(installDir, "logs", "desktop-tip-client.log"), "utf8"), "keep-log");

  const slipZip = path.join(root, "slip.zip");
  createZip([["../evil.txt", "evil"]], slipZip);
  const slip = childProcess.spawnSync("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", path.join(installDir, "desktop-tip-updater.ps1"),
    "-PackagePath", slipZip,
    "-InstallDir", installDir,
    "-MainScript", restartScript,
    "-ExpectedSha256", sha256(slipZip),
    "-ExpectedSize", String(fs.statSync(slipZip).size),
    "-ExpectedVersion", "0.3.2"
  ], { encoding: "utf8" });
  assert.notEqual(slip.status, 0, "zip slip package must be rejected");
  assert.equal(fs.existsSync(path.join(root, "evil.txt")), false);

  const badFileZip = path.join(root, "bad-file.zip");
  createZip([["config/desktop-tip-client.config.json", "{}"]], badFileZip);
  const badFile = childProcess.spawnSync("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", path.join(installDir, "desktop-tip-updater.ps1"),
    "-PackagePath", badFileZip,
    "-InstallDir", installDir,
    "-MainScript", restartScript,
    "-ExpectedSha256", sha256(badFileZip),
    "-ExpectedSize", String(fs.statSync(badFileZip).size),
    "-ExpectedVersion", "0.3.3"
  ], { encoding: "utf8" });
  assert.notEqual(badFile.status, 0, "non-whitelist config overwrite must be rejected");

  const before = fs.readFileSync(path.join(installDir, "desktop-tip-client.ps1"), "utf8");
  const badHash = childProcess.spawnSync("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", path.join(installDir, "desktop-tip-updater.ps1"),
    "-PackagePath", okZip,
    "-InstallDir", installDir,
    "-MainScript", restartScript,
    "-ExpectedSha256", "0".repeat(64),
    "-ExpectedSize", String(fs.statSync(okZip).size),
    "-ExpectedVersion", "0.4.0"
  ], { encoding: "utf8" });
  assert.notEqual(badHash.status, 0, "hash mismatch must fail safely");
  assert.equal(fs.readFileSync(path.join(installDir, "desktop-tip-client.ps1"), "utf8"), before);
}

function runClientSourceTests() {
  const source = fs.readFileSync(path.join(__dirname, "..", "tools", "desktop-tip", "desktop-tip-client.ps1"), "utf8");
  assert.match(source, /function Compare-Version/, "client must include semver compare");
  assert.match(source, /Check-ClientUpdate/, "client must include update check");
  assert.match(source, /Start-ClientUpdate/, "client must include update handoff");
  assert.match(source, /if \(\$SelfTest\)/, "selftest branch must exist");
  assert.match(source, /if \(\$Once\)/, "once branch must exist");
  assert.ok(source.indexOf("Run-SelfTest") < source.indexOf("Start-TipWindow"), "SelfTest must exit before GUI update check");
  assert.ok(source.indexOf("Run-Once") < source.indexOf("Start-TipWindow"), "-Once must exit before GUI update check");
  assert.equal(compareVersion("0.3.10", "0.3.9"), 1);
  assert.equal(compareVersion("0.3.0", "0.3"), 0);
  assert.equal(compareVersion("0.2.9", "0.3.0"), -1);
}

async function main() {
  runClientSourceTests();
  runManifestValidationTests();
  runUpdaterTests();
  await runServerEndpointTests();
  console.log("Desktop tip update tests passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
