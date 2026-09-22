"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const crypto = require("crypto");
const https = require("https");
const { Readable } = require("stream");
const XLSX = require("xlsx");
const { readExcelContent } = require("../src/modules/docCreator/excelContent");
const { createDocCreatorModule } = require("../src/modules/docCreator/docCreatorModule");
const { rangeRequests } = require("../src/modules/docCreator/ordinarySheetImport");
const { createExcelBotImport } = require("../src/modules/docCreator/excelBotImport");
const { filenameFromHeader, publicAddress, downloadExcelFile } = require("../src/modules/docCreator/excelFileDownload");

const logger = { info() {}, warn() {}, error() {} };
function fixture(options = {}) {
  const book = XLSX.utils.book_new();
  const sheet = {
    "!ref": "A1:E7",
    B2: { t: "s", v: "  原内容\n第二行  " },
    D2: { t: "n", v: 0.125, z: "0.00%" },
    A4: { t: "n", v: 45292, z: "yyyy-mm-dd" },
    C4: { t: "n", v: 0 },
    E4: { t: "b", v: false },
    B6: { t: "n", f: "1+2", v: 3 },
    D6: { t: "s", v: "00123" },
    E7: { t: "s", v: "=不是公式" }
  };
  if (options.missingResult) sheet.B6 = { t: "n", f: "1+2" };
  if (options.merged) sheet["!merges"] = [XLSX.utils.decode_range("B2:C2")];
  if (options.range) sheet["!ref"] = options.range;
  XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["后页", "链接文字"], [], ["结束"]]), "第二张表");
  if (options.hidden) book.Workbook = { Sheets: [{ Hidden: 1 }, { Hidden: 0 }] };
  return XLSX.write(book, { type: "buffer", bookType: options.xls ? "biff8" : "xlsx" });
}

function mockApi(options = {}) {
  let serial = 0;
  let creates = 0;
  const calls = [];
  const registry = [];
  let sheets = [];
  const services = {
    token: async () => "test-token",
    append: (entry) => registry.push(entry),
    post: async (endpoint, token, payload) => {
      assert.equal(token, "test-token");
      calls.push({ endpoint, payload });
      assert.ok(!endpoint.startsWith("smartsheet/"), "ordinary import must not use smart-sheet APIs");
      if (endpoint === "create_doc") {
        creates += 1;
        assert.equal(payload.doc_type, 4);
        assert.deepEqual(payload.admin_users, ["admin", "alice"]);
        sheets = [{ sheet_id: "default", title: "Sheet1", rows: [] }];
        return { errcode: 0, docid: "document", url: "https://doc.weixin.qq.com/sheet/test" };
      }
      if (endpoint === "doc_share") return { errcode: 0, share_url: "https://doc.weixin.qq.com/sheet/test" };
      if (endpoint === "spreadsheet/get_sheet_properties") return { errcode: 0, properties: sheets.map(({ sheet_id, title }) => ({ sheet_id, title })) };
      if (endpoint === "spreadsheet/batch_update") {
        assert.ok(payload.requests.length <= 5);
        const responses = [];
        for (const request of payload.requests) {
          if (request.add_sheet_request) {
            const requestSheet = request.add_sheet_request;
            assert.ok(!sheets.some((sheet) => sheet.title === requestSheet.title), "duplicate title");
            const sheet = { sheet_id: `s${++serial}`, title: requestSheet.title, rows: [] };
            sheets.push(sheet);
            responses.push({ add_sheet_response: { properties: { sheet_id: sheet.sheet_id, title: sheet.title } } });
          } else if (request.delete_sheet_request) {
            sheets = sheets.filter((sheet) => sheet.sheet_id !== request.delete_sheet_request.sheet_id);
            assert.ok(sheets.length, "must not remove last sheet");
            responses.push({ delete_sheet_response: {} });
          } else {
            if (options.failWrite) return { errcode: 999, errmsg: "private remote message" };
            const { sheet_id, grid_data } = request.update_range_request;
            assert.equal(grid_data.start_column, 0);
            assert.ok(grid_data.rows.length <= 1000);
            assert.ok(grid_data.rows.length * grid_data.rows[0].values.length <= 10000);
            const sheet = sheets.find((item) => item.sheet_id === sheet_id);
            grid_data.rows.forEach((row, index) => { sheet.rows[grid_data.start_row + index] = row; });
            responses.push({ update_range_response: {} });
          }
        }
        return options.documentedShape ? { errcode: 0, data: { responses } } : { errcode: 0, responses };
      }
      if (endpoint === "spreadsheet/get_sheet_range_data") {
        const range = XLSX.utils.decode_range(payload.range);
        const sheet = sheets.find((item) => item.sheet_id === payload.sheet_id);
        const rows = structuredClone(sheet.rows.slice(range.s.r, range.e.r + 1));
        if (options.corruptRead) rows[0].values[0].cell_value.text = "wrong";
        const result = { start_row: range.s.r, start_column: 0, rows };
        return options.documentedShape ? { errcode: 0, data: { result } } : { errcode: 0, grid_data: result };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    }
  };
  return { services, calls, registry, creates: () => creates, sheets: () => sheets };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-ordinary-import-test-"));
  const previousEnv = { corp: process.env.EA_IMPORT_TEST_CORP, secret: process.env.EA_IMPORT_TEST_SECRET };
  process.env.EA_IMPORT_TEST_CORP = "test-corp";
  process.env.EA_IMPORT_TEST_SECRET = "test-secret";
  try {
    const buffer = fixture({ merged: true });
    const content = await readExcelContent(buffer, "测试.xlsx");
    assert.deepEqual(content.sheets.map((sheet) => sheet.title), ["Sheet1", "第二张表"]);
    const grid = content.sheets[0].values;
    assert.deepEqual(grid[0], ["", "", "", "", ""]);
    assert.equal(grid[1][1], "  原内容\n第二行  ");
    assert.equal(grid[1][2], "");
    assert.equal(grid[1][3], "12.50%");
    assert.equal(grid[3][0], "2024-01-01");
    assert.equal(grid[3][2], "0");
    assert.equal(grid[3][4], "FALSE");
    assert.equal(grid[5][1], "3");
    assert.equal(grid[5][3], "00123");
    assert.equal(grid[6][4], "=不是公式");
    assert.equal(content.formulaCount, 1);
    assert.equal(content.mergedCount, 1);
    assert.deepEqual((await readExcelContent(fixture({ xls: true }), "测试.xls")).sheets[0].values, grid);
    await assert.rejects(readExcelContent(fixture({ missingResult: true }), "formula.xlsx"), /公式没有已保存结果/);
    await assert.rejects(readExcelContent(fixture({ hidden: true }), "hidden.xlsx"), /隐藏状态/);
    await assert.rejects(readExcelContent(fixture({ range: "A1:GT51" }), "large.xlsx"), /超出范围限制/);
    await assert.rejects(readExcelContent(Buffer.from("not an excel"), "fake.xlsx"), /不是有效/);
    await assert.rejects(readExcelContent(buffer, "bad.xlsm"), /目前支持/);
    await assert.rejects(readExcelContent(Buffer.alloc(10 * 1024 * 1024 + 1), "large.xlsx"), /10MB/);
    assert.equal(filenameFromHeader("attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.xlsx"), "测试.xlsx");
    assert.equal(filenameFromHeader('attachment; filename="a.xlsx"'), "a.xlsx");
    for (const address of ["127.0.0.1", "10.1.1.1", "172.16.0.1", "169.254.1.1", "192.168.1.1", "::1"]) assert.equal(publicAddress(address), false);
    assert.equal(publicAddress("8.8.8.8"), true);
    const get = https.get;
    try {
      const key = crypto.randomBytes(32);
      const pad = 32 - buffer.length % 32;
      const cipher = crypto.createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
      cipher.setAutoPadding(false);
      const encrypted = Buffer.concat([cipher.update(Buffer.concat([buffer, Buffer.alloc(pad, pad)])), cipher.final()]);
      https.get = (url, options, callback) => {
        const request = new EventEmitter();
        request.destroy = (error) => request.emit("error", error);
        process.nextTick(() => {
          const response = Readable.from([encrypted]);
          response.headers = { "content-disposition": "attachment; filename=test.xlsx" };
          response.statusCode = 200;
          callback(response);
        });
        return request;
      };
      const downloaded = await downloadExcelFile({ url: "https://files.example.com/a", aeskey: key.toString("base64") });
      assert.ok(downloaded.buffer.equals(buffer));
      await assert.rejects(downloadExcelFile({ url: "https://127.0.0.1/a" }), /无法读取附件/);
      await assert.rejects(downloadExcelFile({ url: "http://files.example.com/a" }), /无法读取附件/);
      await assert.rejects(downloadExcelFile({ url: "https://files.example.com/a", aeskey: "bad" }), /无法读取附件/);
    } finally { https.get = get; }
    const requests = rangeRequests({ columns: 2, values: Array.from({ length: 1500 }, () => ["a", "b"]) }, "s");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].update_range_request.grid_data.start_row, 1000);

    function moduleFor(mock, name) {
      return createDocCreatorModule({ moduleConfig: { auth: { corpIdEnv: "EA_IMPORT_TEST_CORP", secretEnv: "EA_IMPORT_TEST_SECRET" },
        createDoc: { adminUsers: ["admin"], docTypes: { spreadsheet: 10 } } }, logger,
        importDirectory: path.join(root, name), services: mock.services });
    }
    const input = { sender: { userId: "alice", chatType: "single" }, botId: "bot", messageId: "file1",
      download: async () => ({ buffer, filename: "测试.xlsx" }) };
    const mock = mockApi();
    const module = moduleFor(mock, "success");
    const result = await module.importExcel(input);
    assert.equal(result.ok, false);
    assert.equal(result.status, "unsupported");
    assert.match(result.text, /暂不支持/);
    assert.equal((await module.getStatus()).ordinarySpreadsheetImport.enabled, false);
    assert.equal((await moduleFor(mock, "restart").getStatus()).ordinarySpreadsheetImport.enabled, false);
    assert.equal((await module.importExcel({ ...input, sender: {} })).ok, false);
    await module.importExcel({ ...input, download: async () => assert.fail("disabled import must not download") });
    assert.equal(mock.calls.length, 0, "disabled import must not call WeDoc");
    assert.equal(mock.registry.length, 0);
    assert.equal(fs.existsSync(path.join(root, "success")), false, "disabled import must not create a job");
    const created = await module.createSpreadsheet({ sender: input.sender, docName: "空普通表格" });
    assert.equal(created.ok, true, created.text);
    assert.equal(created.data.docType, 4);
    assert.match(created.text, /https:\/\/doc.weixin.qq.com/);
    assert.equal(mock.registry[0].docType, 4);
    assert.equal(mock.calls.find((call) => call.endpoint === "create_doc").payload.doc_name, "空普通表格");
    const routedCreate = await module.handle({ sender: input.sender,
      route: { task: { action: "create_spreadsheet", params: { docName: "项目周报" } } } });
    assert.equal(routedCreate.ok, true, routedCreate.text);
    assert.equal(routedCreate.data.docType, 4);
    assert.equal(mock.creates(), 2);

    let clock = 1000;
    let imported = 0;
    const controller = createExcelBotImport({ now: () => clock, docCreator: { async importExcel(received) {
      imported += 1;
      assert.equal(received.sender.userId, "alice");
      assert.equal((await received.download()).filename, "test.xlsx");
      return { ok: true };
    } }, download: async () => ({ buffer, filename: "test.xlsx" }) });
    let id = 0;
    function event(text, isFile = false, user = "alice", chat = "") {
      return { text, isFile, sender: { userId: user, chatType: chat ? "group" : "single", chatId: chat },
        frame: { body: { aibotid: "bot", msgid: `m${++id}`, from: { userid: user }, chattype: chat ? "group" : "single", chatid: chat,
          file: isFile ? { url: "https://example.com/test", aeskey: "private" } : undefined } } };
    }
    assert.equal(controller.capture(event("你好")), null);
    assert.match(controller.capture(event("转成普通表格")).text, /暂不支持/);
    assert.equal(controller.capture(event("创建普通表格，名称叫：项目周报")), null);
    assert.ok(!controller.capture(event("", true, "bob")).run, "other users cannot consume intent");
    assert.ok(!controller.capture(event("", true, "alice", "group")).run, "other chats cannot consume intent");
    const incoming = event("", true);
    const action = controller.capture(incoming);
    assert.equal(action.run, undefined);
    assert.match(action.text, /暂不支持/);
    assert.equal(controller.capture(incoming).duplicate, true);
    assert.equal(imported, 0);
    controller.capture(event("", true));
    assert.equal(controller.capture(event("把这个Excel转成普通表格")).run, undefined, "file then command remains disabled");
    controller.capture(event("转成普通表格"));
    clock += 300001;
    assert.ok(!controller.capture(event("", true)).run, "expired intent cannot import");
    assert.match(controller.capture(event("取消表格转换")).text, /暂不支持/);
    const spoofed = event("转成普通表格");
    spoofed.sender.userId = "bob";
    assert.match(controller.capture(spoofed).text, /无法确认/);
    const sdk = require("@wecom/aibot-node-sdk");
    const OriginalClient = sdk.WSClient;
    let client;
    const replies = [];
    let imports = 0;
    let routed = 0;
    try {
      sdk.WSClient = class extends EventEmitter {
        constructor() { super(); client = this; }
        connect() {}
        disconnect() {}
        async replyStream(frame, streamId, text, finish) { replies.push({ text, finish }); return {}; }
      };
      const { createWecomBotServer } = require("../src/robot/wecomBotServer");
      const server = createWecomBotServer({ config: { enabled: true, botId: "test-bot", secret: "test-only" }, logger,
        router: { async handleMessage() { routed += 1; return { text: "normal reply" }; } },
        docCreator: { async importExcel(received) { imports += 1; assert.equal(received.sender.userId, "alice"); return { ok: true, text: "import done" }; } } });
      server.start();
      const command = event("转成普通表格").frame;
      command.body.text = { content: "转成普通表格" };
      await client.listeners("message.text")[0](command);
      const attachment = event("", true).frame;
      await client.listeners("message.file")[0](attachment);
      await client.listeners("message.file")[0](attachment);
      assert.equal(imports, 0);
      assert.equal(routed, 0);
      assert.match(replies.at(-1).text, /暂不支持/);
      assert.ok(!replies.some((reply) => /正在读取|5分钟/.test(reply.text)));
      const normal = event("你好").frame;
      normal.body.text = { content: "你好" };
      await client.listeners("message.text")[0](normal);
      assert.equal(routed, 1, "ordinary conversations still reach router");
      server.stop();
    } finally { sdk.WSClient = OriginalClient; }
    console.log("Ordinary spreadsheet OK: create type/name/access/link, disabled import, no download/API/job, identity and bot flow");
  } finally {
    if (previousEnv.corp === undefined) delete process.env.EA_IMPORT_TEST_CORP; else process.env.EA_IMPORT_TEST_CORP = previousEnv.corp;
    if (previousEnv.secret === undefined) delete process.env.EA_IMPORT_TEST_SECRET; else process.env.EA_IMPORT_TEST_SECRET = previousEnv.secret;
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("ea-ordinary-import-test-")) fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
