"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readExcelContent } = require("./excelContent");

function rangeRequests(sheet, sheetId) {
  const requests = [];
  let start = 0;
  let rows = [];
  let size = 0;
  const flush = () => {
    if (!rows.length) return;
    requests.push({ update_range_request: { sheet_id: sheetId,
      grid_data: { start_row: start, start_column: 0, rows } } });
    start += rows.length;
    rows = [];
    size = 0;
  };
  for (const values of sheet.values) {
    const row = { values: values.map((text) => ({ cell_value: { text } })) };
    const bytes = Buffer.byteLength(JSON.stringify(row));
    if (rows.length && (rows.length >= 1000 || (rows.length + 1) * sheet.columns > 10000 || size + bytes > 256 * 1024)) flush();
    rows.push(row);
    size += bytes;
  }
  flush();
  return requests;
}

function createOrdinarySheetImporter({ directory, createSpreadsheet, api, logger, readExcel = readExcelContent }) {
  const active = new Set();
  let running = 0;
  async function importExcel(input) {
    const sender = input.sender || {};
    if (!sender.userId || !input.messageId || !input.botId || typeof input.download !== "function") {
      return { ok: false, text: "请通过1号机器人发送 Excel 文件后转换。" };
    }
    const actorKey = crypto.createHash("sha256").update(JSON.stringify([input.botId, sender.userId, sender.chatType, sender.chatId])).digest("hex");
    const id = crypto.createHash("sha256").update(`${actorKey}:${input.messageId}`).digest("hex");
    const file = path.join(directory, `${id}.json`);
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(file)) {
      try {
        const old = JSON.parse(fs.readFileSync(file, "utf8"));
        if (old.result) return { ...old.result, duplicate: true };
        return { ok: false, duplicate: true, text: `这份文件的转换正在处理，或曾中断，未重复创建。${old.url ? `\n已创建地址：${old.url}` : ""}\n如需重新转换，请重新发送文件。` };
      } catch (_) {
        return { ok: false, text: "这份文件的转换记录异常，已停止重复创建，请联系管理员。" };
      }
    }
    if (running >= 2 || active.has(actorKey)) return { ok: false, text: "当前已有 Excel 正在转换，请稍后重新发送文件。" };
    const state = { id, startedAt: new Date().toISOString(), status: "started" };
    try { fs.writeFileSync(file, JSON.stringify(state), { flag: "wx" }); }
    catch (_) { return { ok: false, text: "无法登记转换任务，未创建在线表格，请稍后再试。" }; }
    const save = () => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(state)); fs.renameSync(`${file}.tmp`, file); };
    active.add(actorKey);
    running += 1;
    let phase = "download";
    let completedSheets = 0;
    let created;
    try {
      logger.info("WeDoc Excel import started", { jobId: id.slice(0, 12) });
      const downloaded = await input.download();
      phase = "parse";
      const workbook = await readExcel(downloaded.buffer, downloaded.filename);
      logger.info("WeDoc Excel import validated", { jobId: id.slice(0, 12), sheetCount: workbook.sheets.length,
        totalCells: workbook.totalCells, textBytes: workbook.textBytes, formulaCount: workbook.formulaCount });
      phase = "create";
      created = await createSpreadsheet({ sender, docName: path.basename(downloaded.filename).replace(/\.(xlsx|xls)$/i, "") }, (doc) => {
        state.docid = doc.docid;
        state.url = doc.url || "";
        state.status = "created";
        save();
      });
      if (!created.ok) {
        state.result = created;
        save();
        return created;
      }
      state.url = created.data.shareUrl || created.data.docUrl || state.url;
      const docid = state.docid;
      const call = await api();
      const checked = async (endpoint, payload) => {
        const result = await call(endpoint, { docid, ...payload });
        if (result.errcode !== 0) {
          const error = new Error("ordinary_sheet_api_failed");
          error.apiCode = result.errcode;
          throw error;
        }
        return result;
      };
      phase = "list_sheets";
      const original = await checked("spreadsheet/get_sheet_properties", {});
      if (!Array.isArray(original.properties)) throw new Error("invalid_sheet_properties");
      // A temporary sheet avoids name collisions with defaults such as Sheet1.
      const temporary = await checked("spreadsheet/batch_update", { requests: [{ add_sheet_request: {
        title: `EA_import_${id.slice(0, 12)}`, row_count: 1, column_count: 1
      } }] });
      const temporaryId = (temporary.responses || temporary.data?.responses)?.[0]?.add_sheet_response?.properties?.sheet_id;
      if (!temporaryId) throw new Error("temporary_sheet_id_missing");
      for (const sheet of original.properties) {
        await checked("spreadsheet/batch_update", { requests: [{ delete_sheet_request: { sheet_id: sheet.sheet_id } }] });
      }
      for (const sheet of workbook.sheets) {
        phase = "add_sheet";
        const added = await checked("spreadsheet/batch_update", { requests: [{ add_sheet_request: {
          title: sheet.title, row_count: sheet.rows, column_count: sheet.columns
        } }] });
        const properties = (added.responses || added.data?.responses)?.[0]?.add_sheet_response?.properties;
        if (!properties?.sheet_id || properties.title !== sheet.title) throw new Error("sheet_name_or_id_mismatch");
        phase = "write_cells";
        for (const request of rangeRequests(sheet, properties.sheet_id)) {
          await checked("spreadsheet/batch_update", { requests: [request] });
        }
        phase = "verify_cells";
        const chunks = rangeRequests(sheet, properties.sheet_id);
        for (const chunk of chunks) {
          const grid = chunk.update_range_request.grid_data;
          const column = require("xlsx").utils.encode_col(sheet.columns - 1);
          const fetched = await checked("spreadsheet/get_sheet_range_data", {
            sheet_id: properties.sheet_id,
            range: `A${grid.start_row + 1}:${column}${grid.start_row + grid.rows.length}`
          });
          const actual = fetched.grid_data || fetched.result || fetched.data?.result;
          if (!actual) throw new Error("verification_response_missing");
          for (let r = 0; r < grid.rows.length; r += 1) {
            for (let c = 0; c < sheet.columns; c += 1) {
              const value = actual.rows?.[r]?.values?.[c]?.cell_value;
              const text = value?.text ?? value?.link?.text ?? "";
              if (text !== sheet.values[grid.start_row + r][c]) throw new Error("verification_content_mismatch");
            }
          }
        }
        completedSheets += 1;
        state.completedSheets = completedSheets;
        save();
        logger.info("WeDoc Excel sheet verified", { jobId: id.slice(0, 12), sheetIndex: completedSheets, rows: sheet.rows, columns: sheet.columns });
      }
      phase = "remove_default_sheets";
      await checked("spreadsheet/batch_update", { requests: [{ delete_sheet_request: { sheet_id: temporaryId } }] });
      phase = "verify_order";
      const finalSheets = await checked("spreadsheet/get_sheet_properties", {});
      if (JSON.stringify(finalSheets.properties?.map((sheet) => sheet.title)) !== JSON.stringify(workbook.sheets.map((sheet) => sheet.title))) throw new Error("verification_sheet_order_mismatch");
      state.status = "complete";
      state.result = { ok: true, status: "imported", text: `普通表格已转换完成，共 ${completedSheets} 个工作表，内容已逐格核对。\n地址：${state.url}\n按原位置保留文字内容；公式为已保存结果，不保留原排版、图片和图表。`,
        data: { docid, url: state.url, sheetCount: completedSheets, totalCells: workbook.totalCells } };
      save();
      logger.info("WeDoc Excel import completed", { jobId: id.slice(0, 12), sheetCount: completedSheets });
      return state.result;
    } catch (error) {
      const stages = { create: "创建表格", list_sheets: "准备工作表", add_sheet: "新增工作表", write_cells: "写入内容",
        verify_cells: "核对内容", remove_default_sheets: "整理工作表", verify_order: "核对工作表顺序" };
      const beforeCreate = ["download", "parse"].includes(phase);
      const detail = beforeCreate ? error.message : `处理阶段：${stages[phase] || phase}${error.apiCode !== undefined ? `，企业微信错误码：${error.apiCode}` : ""}`;
      state.status = "failed";
      state.result = { ok: false, status: state.docid ? "partial_import" : "import_failed",
        text: `转换未完成：${detail}${state.docid ? `\n已核对 ${completedSheets} 个工作表；下面是未完成的表格，请勿作为完整结果使用。\n地址：${state.url || "链接未返回，请联系管理员"}` : beforeCreate ? "\n未创建在线表格。" : "\n未确认创建成功；如请求曾超时，请先检查文档列表，避免重复创建。"}` };
      try { save(); } catch (_) { logger.error("WeDoc Excel import journal save failed", { jobId: id.slice(0, 12) }); }
      logger.warn("WeDoc Excel import failed", { jobId: id.slice(0, 12), phase, completedSheets, hasDocId: Boolean(state.docid), apiCode: error.apiCode,
        reason: error.code || (phase === "parse" ? "excel_validation_failed" : "import_step_failed") });
      return state.result;
    } finally {
      running -= 1;
      active.delete(actorKey);
    }
  }
  return { importExcel };
}

module.exports = { createOrdinarySheetImporter, rangeRequests };
