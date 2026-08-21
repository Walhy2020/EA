"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const toolDir = path.join(root, "tools", "ea-launcher");
const outputDir = path.join(toolDir, "OutPackage");
const executablePath = path.join(outputDir, "EA.exe");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8").replace(/^\uFEFF/, "");
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
      }
      reject(new Error(`process did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  const source = read("tools/ea-launcher/EaLauncher.cs");
  const build = read("tools/ea-launcher/build.ps1");
  const config = JSON.parse(read("tools/ea-launcher/ea-launcher.config.json"));
  const startCmd = read("scripts/start.cmd");
  const installer = read("scripts/install-startup-task.ps1");
  const packageJson = JSON.parse(read("package.json"));

  assert.strictEqual(packageJson.version, "0.6.70");
  assert.strictEqual(config.version, "0.1.0");
  assert.strictEqual(config.autoStartWithWindows, true);
  assert.strictEqual(config.port, 39200);
  assert.match(build, /target:winexe/i, "launcher must compile as a Windows GUI executable");
  assert.match(source, /CreateNoWindow\s*=\s*true/, "Node.js must start without a console");
  assert.match(source, /ProcessWindowStyle\.Hidden/, "Node.js window style must be hidden");
  assert.match(source, /EAEaLauncher_/, "launcher must have a per-project single-instance mutex");
  assert.match(source, /SpecialFolder\.Startup/, "launcher must manage the current-user Startup folder");
  assert.match(source, /CreateShortcut/, "launcher must create a Windows startup shortcut");
  assert.match(source, /startup-preference\.txt/, "launcher must persist the user's startup preference");
  assert.match(source, /ReadAutoStartPreference/, "launcher must preserve an explicit startup opt-out");
  assert.match(source, /GetExtendedTcpTable/, "launcher must identify the exact port listener before stopping EA");
  assert.match(source, /eazygame-integrated-assistant/, "status validation must identify the EA service");
  assert.match(startCmd, /EA\.exe/);
  assert.doesNotMatch(startCmd, /node\s+src[\\/]main\.js/i);
  assert.match(installer, /EA\.exe/);
  assert.doesNotMatch(installer, /ea-supervisor\.ps1/i);
  assert.match(installer, /WScript\.Shell/);
  assert.ok(fs.existsSync(executablePath), "built EA launcher EXE is missing");
  assert.ok(fs.existsSync(path.join(outputDir, "ea-launcher.config.json")));
  assert.ok(fs.existsSync(path.join(outputDir, "README.md")));
  assert.deepStrictEqual(
    fs.readdirSync(outputDir).sort(),
    ["EA.exe", "README.md", "ea-launcher.config.json"].sort(),
    "launcher output must not contain stale executables"
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ea-launcher-test-"));
  try {
    fs.mkdirSync(path.join(tempRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "src", "main.js"), "process.exit(0);\n", "utf8");
    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({
      name: "eazygame-integrated-assistant",
      version: "test"
    }), "utf8");

    const selfTest = spawnSync(executablePath, ["--self-test", "--project-dir", tempRoot], {
      timeout: 15000,
      windowsHide: true
    });
    assert.strictEqual(selfTest.error, undefined, selfTest.error && selfTest.error.message);
    assert.strictEqual(selfTest.status, 0, `self-test exit code: ${selfTest.status}`);

    const first = spawn(executablePath, ["--test-hold-seconds", "4", "--project-dir", tempRoot], {
      windowsHide: true,
      stdio: "ignore"
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const duplicateStartedAt = Date.now();
    const duplicate = spawnSync(executablePath, ["--test-hold-seconds", "1", "--project-dir", tempRoot], {
      timeout: 3000,
      windowsHide: true
    });
    const duplicateElapsedMs = Date.now() - duplicateStartedAt;
    assert.strictEqual(duplicate.error, undefined, duplicate.error && duplicate.error.message);
    assert.strictEqual(duplicate.status, 0);
    assert.ok(duplicateElapsedMs < 2500, `duplicate launcher did not exit quickly: ${duplicateElapsedMs} ms`);
    assert.strictEqual(await waitForExit(first, 7000), 0);

    const launcherLog = fs.readFileSync(path.join(tempRoot, "logs", "ea-launcher.log"), "utf8");
    assert.match(launcherLog, /self_test_passed/);
    assert.match(launcherLog, /duplicate_launcher/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("EA launcher tests passed");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
