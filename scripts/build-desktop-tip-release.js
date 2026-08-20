"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const packageInfo = require("../package.json");

const root = path.resolve(__dirname, "..");
const toolDir = path.join(root, "tools", "desktop-tip");
const outDir = path.join(toolDir, "OutPackage");
const releaseDir = path.join(toolDir, "releases");
const version = process.argv.find((item) => item.startsWith("--version="))?.slice("--version=".length)
  || process.env.DESKTOP_TIP_CLIENT_VERSION
  || "0.3.3";

const updateFiles = [
  { source: path.join(toolDir, "desktop-tip-client.ps1"), entry: "desktop-tip-client.ps1" },
  { source: path.join(toolDir, "desktop-tip-updater.ps1"), entry: "desktop-tip-updater.ps1" },
  { source: path.join(toolDir, "启动EA右下角提醒.bat"), entry: "启动EA右下角提醒.bat" },
  { source: path.join(toolDir, "README.md"), entry: "README.md" },
  { source: path.join(outDir, "README.txt"), entry: "README.txt" }
];

const installFiles = [
  ...updateFiles,
  { source: path.join(outDir, "config", "desktop-tip-client.config.json"), entry: "config/desktop-tip-client.config.json" },
  { source: path.join(outDir, "config", "desktop-tip-client.config.example.json"), entry: "config/desktop-tip-client.config.example.json" }
];

function crc32Buffer(buffer) {
  let crc = 0 ^ -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
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

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function writeUInt32LE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function writeUInt16LE(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function createZip(files, outputPath) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = dosDateTime();
  for (const file of files) {
    if (!fs.existsSync(file.source)) {
      throw new Error(`Missing desktop-tip release file: ${path.relative(root, file.source)}`);
    }
    const entry = file.entry.replace(/\\/g, "/");
    if (entry.startsWith("/") || entry.includes("..") || entry.includes(":")) {
      throw new Error(`Unsafe zip entry: ${entry}`);
    }
    const name = Buffer.from(entry, "utf8");
    const data = fs.readFileSync(file.source);
    const crc = crc32Buffer(data);
    const localHeader = Buffer.concat([
      writeUInt32LE(0x04034b50),
      writeUInt16LE(20),
      writeUInt16LE(0x0800),
      writeUInt16LE(0),
      writeUInt16LE(now.dosTime),
      writeUInt16LE(now.dosDate),
      writeUInt32LE(crc),
      writeUInt32LE(data.length),
      writeUInt32LE(data.length),
      writeUInt16LE(name.length),
      writeUInt16LE(0),
      name
    ]);
    localParts.push(localHeader, data);
    centralParts.push(Buffer.concat([
      writeUInt32LE(0x02014b50),
      writeUInt16LE(20),
      writeUInt16LE(20),
      writeUInt16LE(0x0800),
      writeUInt16LE(0),
      writeUInt16LE(now.dosTime),
      writeUInt16LE(now.dosDate),
      writeUInt32LE(crc),
      writeUInt32LE(data.length),
      writeUInt32LE(data.length),
      writeUInt16LE(name.length),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt32LE(0),
      writeUInt32LE(offset),
      name
    ]));
    offset += localHeader.length + data.length;
  }
  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    writeUInt32LE(0x06054b50),
    writeUInt16LE(0),
    writeUInt16LE(0),
    writeUInt16LE(files.length),
    writeUInt16LE(files.length),
    writeUInt32LE(central.length),
    writeUInt32LE(centralOffset),
    writeUInt16LE(0)
  ]);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.concat([...localParts, central, end]));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertInstallPackageClean(files) {
  const forbidden = /(^|\/)(data|logs)(\/|$)|client-id|secret|token/i;
  for (const file of files) {
    if (forbidden.test(file.entry)) {
      throw new Error(`Forbidden file in desktop-tip package: ${file.entry}`);
    }
  }
}

function main() {
  fs.mkdirSync(releaseDir, { recursive: true });
  assertInstallPackageClean(updateFiles);
  assertInstallPackageClean(installFiles);

  const updateZipName = `EA桌面提醒_client_v${version}.zip`;
  const updateZipPath = path.join(releaseDir, updateZipName);
  createZip(updateFiles, updateZipPath);
  const size = fs.statSync(updateZipPath).size;
  const hash = sha256(updateZipPath);
  const manifest = {
    version,
    appVersion: packageInfo.version,
    publishedAt: new Date().toISOString(),
    packageUrl: "/api/desktop-tip/client-update/package",
    packageFile: updateZipName,
    sha256: hash,
    size,
    minimumSupportedVersion: "0.3.0",
    releaseNotes: [
      "通用消息正文滚动条改为原生按需显示，短内容不显示，超出时显示",
      "正文继续与标题相同字号，保留自动换行和长正文滚动",
      "通用消息继续只保留“收到”，点击后提交已收到并关闭，不打开 URL",
      "保留原有 config、data、logs 和 clientId"
    ]
  };
  fs.writeFileSync(path.join(releaseDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const installZipName = `EA桌面提醒_v${version}_首次安装.zip`;
  const installZipPath = path.join(outDir, installZipName);
  createZip(installFiles, installZipPath);

  console.log(JSON.stringify({
    ok: true,
    version,
    updatePackage: path.relative(root, updateZipPath),
    updatePackageSize: size,
    updatePackageSha256: hash,
    manifest: path.relative(root, path.join(releaseDir, "latest.json")),
    installPackage: path.relative(root, installZipPath),
    installPackageSize: fs.statSync(installZipPath).size
  }, null, 2));
}

main();
