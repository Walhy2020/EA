"use strict";

const CONVERT = /^(?:请|帮我)?(?:(?:把|将)?(?:这个|这份|刚才的)?(?:excel|文件|表格))?(?:转成|转为|转换成|转换为|转|导入为|导入到)(?:企业微信)?普通表格[。！!]?$/i;
const EXCEL_IMPORT_UNSUPPORTED = "暂不支持将 Excel 转成企业微信普通表格。需要新建空表格，请发送：创建普通表格，名称叫：项目周报。";

function createExcelBotImport({ docCreator, now = Date.now }) {
  const seen = new Map();
  const ttl = 5 * 60 * 1000;
  function capture({ frame, sender, text, isFile = false }) {
    if (!docCreator) return null;
    const content = String(text || "").trim().replace(/^@\S+\s+/, "").replace(/\s/g, "");
    if (!isFile && !CONVERT.test(content) && content !== "取消表格转换") return null;
    const body = frame?.body;
    if (!body?.aibotid || !body?.msgid || !body.from?.userid || body.from.userid !== sender?.userId
      || !["single", "group"].includes(body.chattype) || (body.chattype === "group" && !body.chatid)) {
      return { text: "无法确认文件发送者，请在1号机器人会话中重新发送。" };
    }
    for (const [key, expires] of seen) if (expires <= now()) seen.delete(key);
    const key = JSON.stringify([body.aibotid, body.from.userid, body.chattype, body.chatid || "", body.msgid]);
    if (seen.has(key)) return { duplicate: true };
    if (seen.size >= 2000) return { text: "当前文件请求较多，请稍后重试。" };
    seen.set(key, now() + ttl);
    return { text: EXCEL_IMPORT_UNSUPPORTED };
  }
  return { capture };
}

module.exports = { createExcelBotImport, EXCEL_IMPORT_UNSUPPORTED };
