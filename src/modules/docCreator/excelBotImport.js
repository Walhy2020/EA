"use strict";

const { downloadExcelFile } = require("./excelFileDownload");

const CONVERT = /^(?:请|帮我)?(?:(?:把|将)?(?:这个|这份|刚才的)?(?:excel|文件|表格))?(?:转成|转为|转换成|转换为|转|导入为|导入到)(?:企业微信)?普通表格[。！!]?$/i;
const GUIDE = "请在5分钟内发送 Excel 文件（.xlsx 或 .xls，最大10MB）。按原工作表和格子位置导入文字，公式保留已保存结果，不保留原排版、图片和图表。";

function createExcelBotImport({ docCreator, download = downloadExcelFile, now = Date.now }) {
  const pending = new Map();
  const seen = new Map();
  const ttl = 5 * 60 * 1000;
  function prune() {
    for (const [key, entry] of pending) if (entry.expires <= now()) pending.delete(key);
    for (const [key, expires] of seen) if (expires <= now()) seen.delete(key);
  }
  function identity(frame, sender) {
    const body = frame?.body;
    if (!body?.aibotid || !body?.msgid || !body.from?.userid || body.from.userid !== sender?.userId
      || !["single", "group"].includes(body.chattype) || (body.chattype === "group" && !body.chatid)) return "";
    return JSON.stringify([body.aibotid, body.from.userid, body.chattype, body.chatid || ""]);
  }
  function execute(fileFrame, sender) {
    return () => docCreator.importExcel({
      sender, botId: fileFrame.body.aibotid, messageId: fileFrame.body.msgid,
      download: () => download(fileFrame.body.file)
    });
  }
  function capture({ frame, sender, text, isFile = false }) {
    if (!docCreator?.importExcel) return null;
    const content = String(text || "").trim().replace(/^@\S+\s+/, "").replace(/\s/g, "");
    const wantsConvert = CONVERT.test(content);
    const wantsCancel = content === "取消表格转换";
    if (!isFile && !wantsConvert && !wantsCancel) return null;
    prune();
    const key = identity(frame, sender);
    if (!key) return { text: "无法确认文件发送者，请在1号机器人会话中重新发送。" };
    const messageKey = `${key}:${frame.body.msgid}`;
    if (seen.has(messageKey)) return { duplicate: true };
    if (seen.size >= 2000) return { text: "当前文件请求较多，请稍后重试。" };
    seen.set(messageKey, now() + ttl);
    if (wantsCancel) { pending.delete(key); return { text: "已取消等待转换的文件。" }; }
    const previous = pending.get(key);
    if (isFile) {
      if (!frame.body.file?.url) return { text: "文件下载信息缺失，请重新发送 Excel。" };
      if (previous?.waiting) { pending.delete(key); return { run: execute(frame, sender) }; }
      if (pending.size >= 500) return { text: "等待处理的文件较多，请稍后重试。" };
      pending.set(key, { frame, expires: now() + ttl });
      return { text: "收到文件。如需按原位置导入 Excel 内容，请在5分钟内回复“转成普通表格”。公式只保留已保存结果，不保留原排版、图片和图表。" };
    }
    if (previous?.frame) { pending.delete(key); return { run: execute(previous.frame, sender) }; }
    if (pending.size >= 500) return { text: "等待处理的文件较多，请稍后重试。" };
    pending.set(key, { waiting: true, expires: now() + ttl });
    return { text: GUIDE };
  }
  return { capture };
}

module.exports = { createExcelBotImport };
