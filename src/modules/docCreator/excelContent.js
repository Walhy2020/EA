"use strict";

const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const LIMITS = Object.freeze({ bytes: 10 * 1024 * 1024, expandedBytes: 32 * 1024 * 1024,
  sheets: 20, columns: 200, cellsPerSheet: 10000, totalCells: 50000, textBytes: 2 * 1024 * 1024 });

function validateZip(buffer) {
  const yauzl = require("yauzl");
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(new Error("Excel 文件损坏或不是有效的 xlsx 文件。"));
      let declared = 0;
      let expanded = 0;
      let entries = 0;
      const fail = () => { zip.close(); reject(new Error("Excel 压缩内容异常、加密或超出读取限制。")); };
      zip.on("error", fail);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        declared += entry.uncompressedSize;
        if (++entries > 2000 || declared > LIMITS.expandedBytes || (entry.generalPurposeBitFlag & 1)) return fail();
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail();
          stream.on("error", fail);
          stream.on("data", (chunk) => {
            expanded += chunk.length;
            if (expanded > LIMITS.expandedBytes) { stream.destroy(); fail(); }
          });
          stream.on("end", () => zip.readEntry());
        });
      });
      zip.readEntry();
    });
  });
}

async function parseContent(buffer, filename) {
  if (!/\.(xlsx|xls)$/i.test(filename)) throw new Error("目前支持 .xlsx 和 .xls，请将文件另存为这两种格式后发送。");
  if (!buffer.length || buffer.length > LIMITS.bytes) throw new Error("Excel 文件不能为空，且不能超过 10MB。");
  const isZip = buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const isOle = buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (!isZip && !isOle) throw new Error("文件内容不是有效的 Excel 工作簿，请勿只修改扩展名。");
  if (isZip) await validateZip(buffer);
  const XLSX = require("xlsx");
  let book;
  try {
    book = XLSX.read(buffer, { type: "buffer", cellText: true, cellNF: true, cellFormula: true,
      cellDates: false, bookVBA: false, WTF: true });
  } catch (_) {
    throw new Error("无法读取 Excel，请检查文件是否损坏、加密或含不支持的内容。");
  }
  if (!book.SheetNames.length || book.SheetNames.length > LIMITS.sheets) throw new Error("每次支持 1 至 20 个工作表。");
  let totalCells = 0;
  let textBytes = 0;
  let formulaCount = 0;
  let mergedCount = 0;
  const sheets = book.SheetNames.map((title, index) => {
    if (book.Workbook?.Sheets?.[index]?.Hidden) throw new Error(`工作表「${title}」处于隐藏状态，请先确认内容并取消隐藏后再导入。`);
    const source = book.Sheets[title];
    if (!source) throw new Error(`无法读取工作表「${title}」。`);
    let rows = 1;
    let columns = 1;
    // Include the used range and merged area, preserving leading and internal blanks.
    const ranges = source["!ref"] ? [XLSX.utils.decode_range(source["!ref"])] : [];
    ranges.push(...(source["!merges"] || []));
    for (const range of ranges) {
      rows = Math.max(rows, range.e.r + 1);
      columns = Math.max(columns, range.e.c + 1);
    }
    totalCells += rows * columns;
    if (columns > LIMITS.columns || rows * columns > LIMITS.cellsPerSheet || totalCells > LIMITS.totalCells) {
      throw new Error(`工作表「${title}」超出范围限制：每表最多 200 列、10000 个格子，整份文件最多 50000 个格子（包含空格子）。`);
    }
    mergedCount += (source["!merges"] || []).length;
    const values = Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => {
      const address = XLSX.utils.encode_cell({ r, c });
      const cell = source[address];
      if (!cell) return "";
      if (cell.f) {
        formulaCount += 1;
        if (cell.v === undefined || cell.v === null) throw new Error(`「${title}」${address} 的公式没有已保存结果，请用 Excel 重新计算并保存后再发送。`);
      }
      const value = cell.w !== undefined ? String(cell.w) : XLSX.utils.format_cell(cell);
      if (value.length > 10000) throw new Error(`「${title}」${address} 内容超过 10000 字，未创建在线表格。`);
      textBytes += Buffer.byteLength(value);
      if (textBytes > LIMITS.textBytes) throw new Error("Excel 文字内容超过 2MB，请拆分文件后再导入。");
      return value;
    }));
    return { title, rows, columns, values };
  });
  return { sheets, totalCells, formulaCount, mergedCount, textBytes };
}

function readExcelContent(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || buffer.length > LIMITS.bytes) return Promise.reject(new Error("Excel 文件无效或超过 10MB。"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { buffer, filename },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Excel 解析超时，请缩小文件后再试。")), 20000);
    worker.once("message", (message) => finish(message.error ? new Error(message.error) : null, message.content));
    worker.once("error", () => finish(new Error("Excel 解析失败或超出内存限制，请缩小文件后再试。")));
    worker.once("exit", () => { if (!settled) finish(new Error("Excel 解析意外结束，未创建在线表格。")); });
  });
}

if (!isMainThread) {
  parseContent(Buffer.from(workerData.buffer), workerData.filename)
    .then((content) => parentPort.postMessage({ content }))
    .catch((error) => parentPort.postMessage({ error: error.message }));
}

module.exports = { readExcelContent, LIMITS };
