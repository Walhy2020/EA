"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const roots = ["src", "scripts"].map((item) => path.join(projectRoot, item));

function collectJsFiles(dir, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(fullPath, result);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      result.push(fullPath);
    }
  }
  return result;
}

const files = roots.flatMap((root) => collectJsFiles(root));
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: projectRoot,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    failed = true;
    console.error(result.stderr || result.stdout);
  }
}

if (failed) {
  process.exit(1);
}

console.log(`Syntax OK: ${files.length} files`);
