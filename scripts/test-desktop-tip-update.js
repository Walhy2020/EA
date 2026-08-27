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

function readStoredZipEntries(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    assert.equal(method, 0, "release ZIP entries must use stored mode for deterministic local inspection");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    entries.set(name, buffer.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
}

function readPeSubsystem(executablePath) {
  const buffer = fs.readFileSync(executablePath);
  assert.equal(buffer.subarray(0, 2).toString("ascii"), "MZ", "launcher must be a Windows PE executable");
  const peOffset = buffer.readUInt32LE(0x3c);
  assert.equal(buffer.subarray(peOffset, peOffset + 4).toString("binary"), "PE\u0000\u0000");
  const optionalHeader = peOffset + 24;
  const magic = buffer.readUInt16LE(optionalHeader);
  const subsystemOffset = magic === 0x20b ? optionalHeader + 88 : optionalHeader + 68;
  return buffer.readUInt16LE(subsystemOffset);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function copyClientScript(targetPath) {
  writeFile(targetPath, fs.readFileSync(path.join(__dirname, "..", "tools", "desktop-tip", "desktop-tip-client.ps1"), "utf8"));
}

function stopChild(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
  }
}

async function waitForFile(filePath, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return true;
    }
    await delay(100);
  }
  return false;
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
    "-ExpectedVersion", "0.4.2"
  ], { encoding: "utf8" });
  assert.notEqual(badHash.status, 0, "hash mismatch must fail safely");
  assert.equal(fs.readFileSync(path.join(installDir, "desktop-tip-client.ps1"), "utf8"), before);
}

async function runClientSingleInstanceAndCleanupTests() {
  const root = tempRoot("ea-desktop-tip-single-instance-");
  const installDir = path.join(root, "install-a");
  const otherDir = path.join(root, "install-b");
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  const clientPath = path.join(installDir, "desktop-tip-client.ps1");
  const otherClientPath = path.join(otherDir, "desktop-tip-client.ps1");
  copyClientScript(clientPath);
  copyClientScript(otherClientPath);

  const holder = childProcess.spawn("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", clientPath,
    "-SingleInstanceProbe",
    "-HoldSingleInstanceSeconds", "20"
  ], { windowsHide: true, stdio: "ignore" });
  try {
    await delay(1200);
    const duplicate = childProcess.spawnSync("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", clientPath,
      "-SingleInstanceProbe"
    ], { encoding: "utf8" });
    assert.notEqual(duplicate.status, 0, "same install dir second instance must be rejected");
    assert.match(duplicate.stdout, /single-instance-duplicate/, "duplicate instance must report duplicate");

    const differentInstall = childProcess.spawnSync("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", otherClientPath,
      "-SingleInstanceProbe"
    ], { encoding: "utf8" });
    assert.equal(differentInstall.status, 0, differentInstall.stderr || differentInstall.stdout);
    assert.match(differentInstall.stdout, /single-instance-acquired/, "different install dir must run independently");
  } finally {
    stopChild(holder);
  }

  const snapshotPath = path.join(root, "process-snapshot.json");
  writeFile(snapshotPath, JSON.stringify({
    processes: [
      {
        ProcessId: 0,
        Name: "powershell.exe",
        CommandLine: `powershell -File "${clientPath}"`
      },
      {
        ProcessId: 0,
        Name: "powershell.exe",
        CommandLine: `powershell -File "${clientPath}"`
      },
      {
        ProcessId: 0,
        Name: "powershell.exe",
        CommandLine: `powershell -File "${otherClientPath}"`
      },
      {
        ProcessId: 0,
        Name: "notepad.exe",
        CommandLine: `notepad "${clientPath}"`
      }
    ]
  }, null, 2));
  const cleanup = childProcess.spawnSync("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", clientPath,
    "-SelfCleanOldInstancesTest",
    "-ProcessSnapshotPath", snapshotPath
  ], { encoding: "utf8" });
  assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
  assert.match(cleanup.stdout, /stopped=0/, "test snapshot must not kill synthetic or current process ids");
  const logText = fs.readFileSync(path.join(installDir, "logs", "desktop-tip-client.log"), "utf8");
  assert.match(logText, /Failed to stop duplicate old desktop tip client process/, "same-path synthetic process must be selected by exact path and fail safely");
  assert.doesNotMatch(logText, /notepad/, "cleanup must not target non-PowerShell processes");
}

async function runLauncherBatTests() {
  if (process.platform !== "win32") {
    return;
  }
  const root = tempRoot("ea-desktop-tip-launcher-");
  const launcherPath = path.join(root, "start.bat");
  const markerPath = path.join(root, "client-started.txt");
  const pidPath = path.join(root, "client-pid.txt");
  fs.copyFileSync(path.join(__dirname, "..", "tools", "desktop-tip", "启动EA右下角提醒.bat"), launcherPath);
  writeFile(path.join(root, "desktop-tip-client.ps1"), [
    `Set-Content -Path '${pidPath.replace(/'/g, "''")}' -Value $PID -Encoding UTF8`,
    `Set-Content -Path '${markerPath.replace(/'/g, "''")}' -Value started -Encoding UTF8`,
    "Start-Sleep -Seconds 10"
  ].join("\n"));
  const startedAt = Date.now();
  const result = childProcess.spawnSync("cmd.exe", ["/c", launcherPath], {
    cwd: root,
    windowsHide: true,
    encoding: "utf8"
  });
  const elapsedMs = Date.now() - startedAt;
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(elapsedMs < 2000, `launcher BAT must exit quickly, elapsedMs=${elapsedMs}`);
    assert.equal(await waitForFile(markerPath), true, "hidden PowerShell client must continue running after BAT exits");
  } finally {
    if (fs.existsSync(pidPath)) {
      const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0) {
        childProcess.spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], {
          windowsHide: true,
          stdio: "ignore"
        });
      }
    }
  }
}

async function runLauncherExeTests() {
  if (process.platform !== "win32") {
    return;
  }
  const launcherName = "EA桌面提醒.exe";
  const sourceLauncher = path.join(__dirname, "..", "tools", "desktop-tip", launcherName);
  const packageLauncher = path.join(__dirname, "..", "tools", "desktop-tip", "OutPackage", launcherName);
  assert.ok(fs.existsSync(sourceLauncher), "source desktop tip EXE is missing");
  assert.ok(fs.existsSync(packageLauncher), "OutPackage desktop tip EXE is missing");
  assert.equal(readPeSubsystem(sourceLauncher), 2, "desktop tip EXE must use the Windows GUI subsystem");
  assert.equal(sha256(sourceLauncher), sha256(packageLauncher), "source and OutPackage EXE must match");

  const root = tempRoot("ea-desktop-tip-exe-");
  const launcherPath = path.join(root, launcherName);
  const markerPath = path.join(root, "client-started.txt");
  fs.copyFileSync(sourceLauncher, launcherPath);
  writeFile(path.join(root, "desktop-tip-client.ps1"), `Set-Content -LiteralPath '${markerPath.replace(/'/g, "''")}' -Value started -Encoding UTF8`);
  const selfTest = childProcess.spawnSync(launcherPath, ["--self-test"], {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
    timeout: 10000
  });
  assert.equal(selfTest.status, 0, selfTest.error ? selfTest.error.message : "desktop tip EXE self-test failed");

  const startedAt = Date.now();
  const launch = childProcess.spawnSync(launcherPath, ["--skip-autostart"], {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
    timeout: 10000
  });
  assert.equal(launch.status, 0, launch.error ? launch.error.message : "desktop tip EXE launch failed");
  assert.ok(Date.now() - startedAt < 3000, "desktop tip EXE must return quickly after hidden client start");
  assert.equal(await waitForFile(markerPath), true, "desktop tip EXE must start the PowerShell client");
}

function runReleaseArtifactTests() {
  const root = path.join(__dirname, "..", "tools", "desktop-tip");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "releases", "latest.json"), "utf8"));
  assert.equal(manifest.version, "0.5.1");
  assert.equal(manifest.appVersion, "0.6.78");
  const updatePath = path.join(root, "releases", manifest.packageFile);
  assert.equal(fs.statSync(updatePath).size, manifest.size);
  assert.equal(sha256(updatePath), manifest.sha256);
  const updateEntries = readStoredZipEntries(updatePath);
  assert.ok(updateEntries.has("desktop-tip-client.ps1"));
  assert.equal(updateEntries.has("EA桌面提醒.exe"), false, "v0.5.1 update ZIP must stay compatible with the v0.4.2 updater whitelist");
  const releaseClient = updateEntries.get("desktop-tip-client.ps1").toString("utf8");
  assert.doesNotMatch(releaseClient, /__EA_DESKTOP_TIP_LAUNCHER_(BASE64|SHA256)__/, "release client must embed the verified EXE payload");
  const base64Match = releaseClient.match(/\$Script:LauncherPayloadBase64 = "([A-Za-z0-9+/=]+)"/);
  const shaMatch = releaseClient.match(/\$Script:LauncherPayloadSha256 = "([a-f0-9]{64})"/);
  assert.ok(base64Match && shaMatch, "release client launcher payload metadata is missing");
  const launcherBuffer = Buffer.from(base64Match[1], "base64");
  assert.equal(crypto.createHash("sha256").update(launcherBuffer).digest("hex"), shaMatch[1]);
  assert.equal(crypto.createHash("sha256").update(launcherBuffer).digest("hex"), sha256(path.join(root, "EA桌面提醒.exe")));

  const installPath = path.join(root, "OutPackage", "EA桌面提醒_v0.5.1_首次安装.zip");
  const installEntries = readStoredZipEntries(installPath);
  assert.ok(installEntries.has("EA桌面提醒.exe"), "first-install ZIP must contain the EXE entrypoint");
  assert.ok(installEntries.has("config/desktop-tip-client.config.json"));
  assert.equal(installEntries.has("data/client-id.txt"), false);
}

function runLauncherPayloadMigrationTest() {
  if (process.platform !== "win32") {
    return;
  }
  const root = tempRoot("ea-desktop-tip-launcher-migration-");
  const clientPath = path.join(root, "desktop-tip-client.ps1");
  fs.copyFileSync(path.join(__dirname, "..", "tools", "desktop-tip", "OutPackage", "desktop-tip-client.ps1"), clientPath);
  const result = childProcess.spawnSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", clientPath,
    "-LauncherMigrationTest"
  ], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 15000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /launcher-migration-ok/);
  const launcherPath = path.join(root, "EA桌面提醒.exe");
  assert.ok(fs.existsSync(launcherPath), "online migration must materialize the EXE");
  assert.equal(readPeSubsystem(launcherPath), 2);
  assert.equal(sha256(launcherPath), sha256(path.join(__dirname, "..", "tools", "desktop-tip", "EA桌面提醒.exe")));
}

function runClientSourceTests() {
  const source = fs.readFileSync(path.join(__dirname, "..", "tools", "desktop-tip", "desktop-tip-client.ps1"), "utf8");
  const launcher = fs.readFileSync(path.join(__dirname, "..", "tools", "desktop-tip", "启动EA右下角提醒.bat"), "utf8");
  const packageLauncher = fs.readFileSync(path.join(__dirname, "..", "tools", "desktop-tip", "OutPackage", "启动EA右下角提醒.bat"), "utf8");
  assert.match(source, /function Compare-Version/, "client must include semver compare");
  assert.match(source, /Check-ClientUpdate/, "client must include update check");
  assert.match(source, /Start-ClientUpdate/, "client must include update handoff");
  assert.match(source, /Initialize-SingleInstance/, "client must enforce same-install single instance");
  assert.match(source, /Local\\EADesktopTip_/, "client single instance lock must be local per user session");
  assert.match(source, /Stop-OtherDesktopTipClientInstances/, "client must clean old same-path instances started by old updater");
  assert.match(source, /Test-CommandLineTargetsMainScript/, "client cleanup must match exact script path");
  assert.match(source, /System\.Management\.ManagementObjectSearcher/, "client must fallback to System.Management Win32_Process command line reader");
  assert.doesNotMatch(source, /WMIC\.exe|wmic/i, "client must not use unreliable wmic fallback");
  assert.match(source, /\$Script:UpdatePromptInProgress/, "client must lock update prompt reentry");
  assert.match(source, /\$Script:LastUpdatePostponedVersion/, "client must remember postponed version");
  assert.match(source, /Client update auto prompt skipped after postpone/, "client must skip automatic prompt until next cycle after later");
  assert.match(source, /Ensure-DesktopTipLauncher/, "client must materialize the verified EXE during online migration");
  assert.match(source, /Set-DesktopTipAutoStart/, "client must expose a Windows startup toggle");
  assert.match(source, /autostart-preference\.txt/, "client must persist an explicit startup preference");
  assert.match(source, /function New-DesktopTipApplicationIcon/, "client must build the blue EA application icon");
  assert.match(source, /New-Object System\.Windows\.Forms\.NotifyIcon/, "client must register a Windows notification-area icon");
  assert.match(source, /\$trayIcon\.ContextMenuStrip = \$exitMenu/, "tray icon must reuse the desktop tip context menu");
  assert.match(source, /\$trayIcon\.Visible = \$true/, "tray icon must be visible while M04 is running");
  assert.match(source, /\$trayIcon\.Visible = \$false/, "tray icon must be hidden during client shutdown");
  assert.match(source, /Desktop tip tray icon registered/, "client must log tray icon registration");
  assert.match(source, /Desktop tip tray icon released/, "client must log tray icon cleanup");
  assert.match(source, /#1677ff/, "tray icon must use the existing EA blue background");
  assert.match(source, /DrawString\("EA"/, "tray icon must render the EA label");
  assert.match(source, /if \(\$SingleInstanceProbe\)/, "single instance probe must allow automated tests without GUI");
  assert.match(source, /if \(\$SelfCleanOldInstancesTest\)/, "old-instance cleanup test hook must not trigger real UI");
  assert.match(source, /if \(\$LauncherMigrationTest\)/, "launcher migration must be independently testable without GUI or startup changes");
  assert.match(source, /if \(\$SelfTest\)/, "selftest branch must exist");
  assert.match(source, /if \(\$Once\)/, "once branch must exist");
  assert.ok(source.indexOf("Run-SelfTest") < source.indexOf("Start-TipWindow"), "SelfTest must exit before GUI update check");
  assert.ok(source.indexOf("Run-Once") < source.indexOf("Start-TipWindow"), "-Once must exit before GUI update check");
  assert.equal(compareVersion("0.3.10", "0.3.9"), 1);
  assert.equal(compareVersion("0.3.0", "0.3"), 0);
  assert.equal(compareVersion("0.2.9", "0.3.0"), -1);
  const updater = fs.readFileSync(path.join(__dirname, "..", "tools", "desktop-tip", "desktop-tip-updater.ps1"), "utf8");
  assert.match(updater, /Validate-ZipEntries/, "updater must validate zip whitelist");
  assert.match(updater, /Restore-Backup/, "updater must restore backup on failure");
  assert.match(updater, /Stop-OtherDesktopTipClientInstances/, "updater must stop same-path old client instances for future updates");
  assert.match(updater, /Test-CommandLineTargetsMainScript/, "updater must match exact client script path");
  assert.match(updater, /function Start-DesktopTipClientHidden/, "updater must restart the client through a hidden launcher helper");
  assert.match(updater, /GetExtension\(\$launcherExePath\).*\.exe/, "updater must prefer the installed EXE after migration");
  assert.match(updater, /"-WindowStyle", "Hidden"/, "updater restart arguments must hide PowerShell");
  assert.doesNotMatch(updater, /Start-Process -FilePath \$restartTarget/, "updater must not restart through a visible BAT/cmd window");
  assert.match(updater, /System\.Management\.ManagementObjectSearcher/, "updater must fallback to System.Management Win32_Process command line reader");
  assert.doesNotMatch(updater, /WMIC\.exe|wmic/i, "updater must not use unreliable wmic fallback");
  assert.match(updater, /\$_.ProcessId -ne \$PID/, "updater cleanup must not stop itself");
  for (const content of [launcher, packageLauncher]) {
    assert.match(content, /69,65,26700,38754,25552,37266/, "legacy BAT must locate the desktop tip EXE without raw Chinese command text");
    assert.match(content, /Start-Process -FilePath 'powershell\.exe'.*'-WindowStyle','Hidden'.*desktop-tip-client\.ps1/im, "launcher BAT must start the client hidden through a short helper process");
    assert.doesNotMatch(content, /^powershell\s+-NoProfile\s+-ExecutionPolicy\s+Bypass\s+-File/im, "launcher BAT must not block on foreground PowerShell");
  }
  const launcherSource = fs.readFileSync(path.join(__dirname, "..", "tools", "desktop-tip", "DesktopTipLauncher.cs"), "utf8");
  assert.match(launcherSource, /CreateNoWindow\s*=\s*true/, "desktop tip EXE must hide the PowerShell console");
  assert.match(launcherSource, /SpecialFolder\.Startup/, "desktop tip EXE must enable current-user startup by default");
  assert.match(launcherSource, /autostart-preference\.txt/, "desktop tip EXE must honor the saved startup preference");
  assert.doesNotMatch(launcherSource, /src[\\/]main\.js|39200|Restart EA/, "M04 EXE must not manage the EA server");
  const launcherBuildScript = fs.readFileSync(path.join(__dirname, "..", "tools", "desktop-tip", "build-desktop-tip-launcher.ps1"), "utf8");
  assert.match(launcherBuildScript, /Copy-Item -LiteralPath \$asciiOutputPath -Destination \$outputPath -Force/, "launcher build must overwrite an existing EXE on Windows PowerShell 5");
  assert.match(launcherBuildScript, /Remove-Item -LiteralPath \$asciiOutputPath -Force/, "launcher build must remove its temporary EXE");
  assert.doesNotMatch(launcherBuildScript, /Move-Item -LiteralPath \$asciiOutputPath -Destination \$outputPath -Force/, "launcher build must not rely on Move-Item -Force overwrite semantics");
}

async function main() {
  runClientSourceTests();
  runReleaseArtifactTests();
  runLauncherPayloadMigrationTest();
  runManifestValidationTests();
  runUpdaterTests();
  await runClientSingleInstanceAndCleanupTests();
  await runLauncherExeTests();
  await runLauncherBatTests();
  await runServerEndpointTests();
  console.log("Desktop tip update tests passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
