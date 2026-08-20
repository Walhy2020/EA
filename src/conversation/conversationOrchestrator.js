"use strict";

const VERSION_PROJECT_ALIASES = {
  "一骑": "一骑当千",
  "一骑当千": "一骑当千",
  "女王": "女王之刃",
  "QB": "女王之刃",
  "qb": "女王之刃",
  "女王之刃": "女王之刃",
  "高校": "恶魔高校",
  "恶魔高校": "恶魔高校",
  "噬血": "嗜血",
  "噬血狂袭": "嗜血",
  "嗜血": "嗜血",
  "魔王": "魔王",
  "STB": "嗜血",
  "stb": "嗜血"
};

const CAPABILITY_REPLY = "我可以帮你查小游戏榜单和历史排名、查看开发进度（个人任务、版本计划）、打开需求协作入口、创建盯梢任务、创建新的文档、智能文档、表格或智能表格、查询历史反馈。你想做什么？";

function stripJsonFence(text) {
  return String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseJsonObject(text) {
  const cleaned = stripJsonFence(text);
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("大模型没有返回可解析的 JSON");
  }
}

function conciseTitle(text) {
  const cleaned = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 24 ? `${cleaned.slice(0, 24)}...` : cleaned;
}

function sessionIdFromMessage(message) {
  const sender = message.sender || {};
  return [
    sender.source || "unknown",
    sender.chatId || sender.userId || sender.name || "default"
  ].join(":");
}

function normalizeProjectMatchText(value) {
  return String(value || "").trim().replace(/\s+/g, "").toLowerCase();
}

function versionProjectAliasEntries() {
  return Object.entries(VERSION_PROJECT_ALIASES)
    .map(([alias, projectName]) => ({
      alias,
      projectName
    }))
    .sort((left, right) => right.alias.length - left.alias.length);
}

function resolveVersionProjectAlias(value) {
  const normalizedValue = normalizeProjectMatchText(value);
  if (!normalizedValue) {
    return null;
  }
  return versionProjectAliasEntries().find((entry) => {
    return normalizeProjectMatchText(entry.alias) === normalizedValue
      || normalizeProjectMatchText(entry.projectName) === normalizedValue;
  }) || null;
}

function extractVersionProjectParams(text, params = {}) {
  const existingProject = String(params.projectName || params.project || "").trim();
  if (existingProject) {
    const aliasEntry = resolveVersionProjectAlias(existingProject);
    return {
      projectName: aliasEntry ? aliasEntry.projectName : existingProject,
      projectAlias: existingProject
    };
  }

  const normalizedText = normalizeProjectMatchText(text);
  if (!normalizedText) {
    return null;
  }

  for (const entry of versionProjectAliasEntries()) {
    if (normalizedText.includes(normalizeProjectMatchText(entry.alias))) {
      return {
        projectName: entry.projectName,
        projectAlias: entry.alias
      };
    }
  }
  return null;
}

function looksLikeVersionSummaryQuery(text) {
  const rawText = String(text || "").trim();
  if (!/版本/.test(rawText) || /(系统版本|应用版本|机器人版本|EA版本|版本号)/i.test(rawText)) {
    return false;
  }
  if (looksLikeVersionPlanQuery(rawText)) {
    return true;
  }
  if (extractVersionProjectParams(rawText)) {
    return true;
  }
  const timeWords = "今天|今日|昨天|本周|这周|这个星期|上周|本月|这个月|当月|上月|本季度|这季度|这个季度|上季度|今年|本年|去年";
  const datePattern = "\\d{4}\\s*(?:年|[-/.])\\s*\\d{1,2}|\\d{1,2}月";
  return new RegExp(`(?:几个|多少|当前|现在|本次|有哪些|什么|啥|哪几个|导出|查看|看看|看一下|情况|概况|统计|${timeWords}|${datePattern}).{0,16}版本|版本.{0,16}(?:任务|需求|明细|导出|列表|几个|多少|什么|啥|情况|概况|统计|计划|${timeWords}|${datePattern})`).test(rawText);
}

function looksLikeVersionPlanQuery(text) {
  const rawText = String(text || "").trim();
  return /版本.{0,8}计划|计划.{0,8}版本/.test(rawText);
}

function hasVersionTimePhrase(text) {
  return /(?:今天|今日|昨天|本周|这周|这个星期|上周|本月|这个月|当月|上月|本季度|这季度|这个季度|上季度|今年|本年|去年|\d{4}\s*(?:年|[-/.])\s*\d{1,2}\s*月?|\d{1,2}月)/.test(String(text || ""));
}

function versionQueryTaskText(text) {
  return hasVersionTimePhrase(text) ? String(text || "").trim() : `本周 ${String(text || "").trim()}`;
}

function versionPlanTaskText(text) {
  return versionQueryTaskText(text);
}

function looksLikeDemandDetailQuery(text) {
  const rawText = String(text || "").trim();
  if (!rawText || /版本/.test(rawText)) {
    return false;
  }
  if (!/(需求|任务|进度)/.test(rawText)) {
    return false;
  }
  const asksForDetailFields = /(需求名称|需求内容|状态|需求进度|明细|列表|更新时间)/.test(rawText);
  const hasUpdateTimeScope = /(更新时间|更新).{0,12}(今天|今日|昨天|本周|这周|这个星期|上周|本月|这个月|当月|上月|\d{4}\s*(?:年|[-/.])\s*\d{1,2}|\d{1,2}月)/.test(rawText)
    || /(今天|今日|昨天|本周|这周|这个星期|上周|本月|这个月|当月|上月|\d{4}\s*(?:年|[-/.])\s*\d{1,2}|\d{1,2}月).{0,12}(更新时间|更新)/.test(rawText)
    || (/(更新时间|更新)/.test(rawText) && hasVersionTimePhrase(rawText));
  return asksForDetailFields && hasUpdateTimeScope;
}

function demandDetailTaskText(text) {
  return hasVersionTimePhrase(text) ? String(text || "").trim() : `今天 ${String(text || "").trim()}`;
}

function looksLikeVersionExcelSend(text) {
  return /(?:发送|发给|发我|给我发|推送|传给|转发|导出)/.test(String(text || "").trim());
}

function normalizeSendTargetName(value) {
  const text = String(value || "")
    .trim()
    .replace(/[，,。！？!?.；;：:]$/g, "");
  if (!text || /^(?:我|自己|本人)$/.test(text)) {
    return "";
  }
  return text;
}

function isSelfSendTarget(value) {
  return /^(?:我|自己|本人)$/.test(String(value || "").trim());
}

function splitSendTargets(value) {
  const text = String(value || "")
    .trim()
    .replace(/[，,。！？!?.；;：:]$/g, "");
  if (!text) {
    return [];
  }

  return text
    .split(/(?:以及|还有|并且|和|及|与|跟|、|,|，|\/|\\|\||;|；|\s+)+/)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function normalizeSendTargets(value) {
  const result = {
    sendToSelf: false,
    targetNames: []
  };

  for (const item of splitSendTargets(value)) {
    if (isSelfSendTarget(item)) {
      result.sendToSelf = true;
      continue;
    }

    const targetName = normalizeSendTargetName(item);
    if (targetName && !result.targetNames.includes(targetName)) {
      result.targetNames.push(targetName);
    }
  }

  return result;
}

function versionExcelSendParams(text) {
  const rawText = String(text || "").trim();
  const targetPatterns = [
    /(?:发送|发|推送|传|转发|导出)(?:Excel|excel|表格|文件|明细)?(?:给|到)\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_.@-]{0,31})/,
    /(?:给|到)\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_.@-]{0,31})\s*(?:发送|发|推送|传|转发|导出)/,
    /(?:发送|发给|传给|推送给|导出给)\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_.@-]{0,31})/
  ];

  let targetSegment = "";
  for (const pattern of targetPatterns) {
    const matched = rawText.match(pattern);
    if (matched && matched[1]) {
      targetSegment = matched[1];
      break;
    }
  }

  const normalized = normalizeSendTargets(targetSegment);
  const explicitSelf = /(?:发我|给我发|发送给我|发给我|传给我|推送给我)/.test(rawText);
  const sendToSelf = explicitSelf || normalized.sendToSelf;
  const sendToConversation = !sendToSelf && normalized.targetNames.length === 0;
  return {
    sendExcel: true,
    sendTargetName: normalized.targetNames[0] || "",
    sendTargetNames: normalized.targetNames,
    sendToSelf,
    sendToConversation
  };
}

function defaultVersionExcelParams() {
  return {
    sendExcel: true,
    sendTargetName: "",
    sendTargetNames: [],
    sendToSelf: false,
    sendToConversation: true
  };
}

function withVersionProjectParams(params, text) {
  const projectParams = extractVersionProjectParams(text, params);
  if (!projectParams) {
    return params;
  }
  return {
    ...params,
    projectName: projectParams.projectName,
    projectAlias: projectParams.projectAlias
  };
}

function versionQuerySendParams(text) {
  const params = looksLikeVersionExcelSend(text)
    ? versionExcelSendParams(text)
    : defaultVersionExcelParams();
  return withVersionProjectParams(params, text);
}

function demandDetailQueryParams(text) {
  const params = looksLikeVersionExcelSend(text)
    ? versionExcelSendParams(text)
    : defaultVersionExcelParams();
  return withVersionProjectParams({
    ...params,
    sendExcel: true
  }, text);
}

function looksLikeIssueCollection(text) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    return false;
  }
  if (looksLikeDocCreate(rawText) || looksLikeVersionSummaryQuery(rawText) || looksLikeDemandDetailQuery(rawText) || /(top20|榜单|排行|排名|历史|关注列表|几条任务|多少任务|哪些人有任务|谁有任务|几个版本|多少版本|当前.*版本|版本.*任务|导出.*版本|我有(?:多少|几条|几项|几个)?(?:任务|需求|进度)|我的(?:任务|需求|进度)|我.*(?:任务|需求|进度).*吗|(?:任务|需求|进度).*我.*吗)/i.test(rawText)) {
    return false;
  }
  const issueWords = /(反馈|建议|问题|BUG|Bug|bug|报错|异常|错误|失败|闪退|卡死|白屏|打不开|无法|希望|需要|最好|优化|漏|提醒|不智能|理解错|数据不对|不完整)/;
  const eaContext = /(EA系统|EA|机器人|助手|管理台|后台服务|本地网页管理台|开发进度监控|需求监控|任务跟进|任务提醒|版本查询|版本计划|Excel|excel|文档创建|智能文档创建|智能表格创建|创建文档|创建表格|诊断|反馈卡片)/;
  const explicitPrefix = /^(?:EA系统|EA|机器人|助手|管理台|后台服务|本地网页管理台|开发进度监控|需求监控|任务跟进|任务提醒|版本查询|版本计划|文档创建|智能文档创建|智能表格创建|创建文档|创建表格)\s*(?:反馈|建议|问题|意见|需求|Bug|BUG|bug)[:：]?/;
  return issueWords.test(rawText) && (eaContext.test(rawText) || explicitPrefix.test(rawText));
}

function looksLikeWatchdogCreate(text) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    return false;
  }
  if (looksLikeWatchdogReschedule(rawText)) {
    return false;
  }
  if (looksLikeWatchdogHelp(rawText)) {
    return false;
  }
  if (/(?:取消|停止|删除|关闭|完成).{0,8}(?:盯梢|定时提醒)/.test(rawText)) {
    return false;
  }
  return /(?:盯梢|盯一下|盯一盯|盯下|帮我盯|创建.{0,8}盯梢|新建.{0,8}盯梢)/.test(rawText)
    || /(?:定时|每隔|每天|每日|天天|每\s*\d|每\s*[一二三四五六七八九十半]|(?:每\s*)?(?:周|星期|礼拜)\s*[一二三四五六日天1-7]).{0,16}(?:问|找|提醒|催|收集|盯梢).{0,16}(?:进度|完成情况|情况|任务|事项|处理)?/.test(rawText)
    || /(?:工作日|工作天|周一\s*(?:到|至|-|~)\s*周?五|星期一\s*(?:到|至|-|~)\s*(?:星期)?五|礼拜一\s*(?:到|至|-|~)\s*(?:礼拜)?五).{0,16}(?:问|找|提醒|催|收集|盯梢).{0,16}(?:进度|完成情况|情况|任务|事项|处理)?/.test(rawText)
    || /(?:今天|今日|明天|后天|\d{1,2}\s*月\s*\d{1,2}\s*(?:日|号)?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}).{0,20}(?:提醒|盯梢|催)/.test(rawText)
    || /(?:提醒|盯梢|催).{0,20}(?:今天|今日|明天|后天|\d{1,2}\s*月\s*\d{1,2}\s*(?:日|号)?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/.test(rawText);
}

function looksLikeWatchdogReschedule(text) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    return false;
  }
  return /(?:下次|下一次|下回|下轮).{0,12}(?:盯梢|提醒|时间|迭代)/.test(rawText)
    || /(?:补|填|填写|设置|修改|更新|调整|改到|改成|改为).{0,12}(?:下次|下一次|下回|下轮).{0,12}(?:盯梢|提醒|时间|迭代)?/.test(rawText)
    || /(?:盯梢|提醒).{0,8}(?:改到|改成|改为|调整到|设置为|更新为).{0,20}(?:今天|今日|明天|后天|\d{1,2}\s*月|\d{4}[-/.])/.test(rawText);
}

function looksLikeWatchdogCancel(text) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    return false;
  }
  return /(?:取消|停止|删除|关闭|停掉|终止|不再|别再).{0,16}(?:盯梢|定时提醒)/.test(rawText)
    || /(?:盯梢|定时提醒).{0,16}(?:取消|停止|删除|关闭|停掉|终止|不再|别再)/.test(rawText);
}

function looksLikeWatchdogList(text) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    return false;
  }
  return /(?:盯梢|定时提醒).{0,16}(?:列表|清单|状态|运行|运作|进行中|正在|多少|几条|几项|有哪些|哪些)/.test(rawText)
    || /(?:当前|现在|目前)?.{0,8}(?:有多少|多少|几条|几项|有哪些|哪些).{0,12}(?:盯梢|定时提醒)/.test(rawText);
}

function looksLikeWatchdogHelp(text) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    return false;
  }
  return /(?:怎么|如何|怎样).{0,10}(?:盯梢|定时提醒|提醒同事)/.test(rawText)
    || /(?:盯梢|定时提醒).{0,10}(?:怎么用|如何用|怎样用|用法|说明|格式|填写|模式)/.test(rawText);
}

function looksLikeWatchdogForm(text) {
  return /(?:被盯梢人|盯梢人|盯梢任务|盯梢间隔|盯梢时间|提醒时间|一次性时间|时间节点|附件)\s*(?:是|为|:|：)/.test(String(text || ""));
}

function looksLikeCapabilityQuestion(text) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    return false;
  }
  return /(?:你|机器人|EA|系统|助手)?.{0,8}(?:能做什么|可以做什么|会做什么|有什么功能|支持什么|怎么用|使用说明|能力介绍)/.test(rawText);
}

function looksLikeDemandCollaborationEntry(text) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    return false;
  }

  return /^(?:打开|进入|访问|查看|发我|发一下|给我|我要|来个)?\s*(?:需求协作|需求待办|需求H5|需求h5|需求页面|需求入口)(?:入口|页面|链接|地址|H5|h5)?\s*(?:给我|发我|一下|看看|吗|？|\?)?$/.test(rawText)
    || /(?:需求协作|需求待办).{0,8}(?:入口|链接|地址|页面|打开|访问|进入)/.test(rawText)
    || /(?:打开|进入|访问|发我|给我).{0,8}(?:需求协作|需求待办)/.test(rawText);
}

function isConfirmText(text) {
  return /^(是|对|确认|确定|同意|可以|可以的|执行|保存|记录|提交|好|好的|没问题|ok|OK|yes|y)$/i.test(String(text || "").trim());
}

function isCancelText(text) {
  return /^(不|否|取消|算了|不要|先不用|no|n)$/i.test(String(text || "").trim());
}

function stripFollowupPrefix(text) {
  return String(text || "")
    .trim()
    .replace(/^(?:那|那么|然后|还有|再|也|继续|顺便|麻烦|帮我|帮忙)\s*/, "")
    .replace(/[？?。！!，,\s]+$/g, "")
    .trim();
}

function looksLikeVersionTimeFollowup(text) {
  const cleaned = stripFollowupPrefix(text);
  if (!cleaned) {
    return false;
  }
  return /^(?:今天|今日|昨天|本周|这周|这个星期|上周|上个星期|本月|这个月|当月|上月|上个月|本季度|这季度|这个季度|上季度|上个季度|今年|本年|去年|\d{4}\s*(?:年|[-/.])\s*\d{1,2}\s*月?|\d{1,2}月)(?:呢|的呢|有几个|几个|多少)?$/.test(cleaned);
}

function followupPersonName(text) {
  const cleaned = stripFollowupPrefix(text)
    .replace(/(?:呢|的呢|有几条|有多少|多少|几条|任务|需求|进度)$/g, "")
    .trim();
  if (/^[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·._-]{1,15}$/.test(cleaned)) {
    return cleaned;
  }
  return "";
}

function normalizeIssueType(value, text = "") {
  const rawValue = String(value || "").trim();
  if (/^(bug|Bug|BUG|缺陷|报错|异常|错误|故障)$/i.test(rawValue)) {
    return "Bug";
  }
  if (/^(需求|建议|优化|反馈|问题|功能)$/i.test(rawValue)) {
    return "需求";
  }

  const rawText = String(text || "");
  if (/(bug|BUG|Bug|报错|异常|错误|失败|闪退|卡死|白屏|打不开|无法|不能|崩溃)/.test(rawText)) {
    return "Bug";
  }
  return "需求";
}

function issueScreenshot(params = {}) {
  return String(params.screenshot || params.image || params.attachment || "").trim();
}

function isMissingScreenshot(value) {
  const text = String(value || "").trim();
  return !text || /^(暂无|无|没有|没|无截图|没有截图)$/i.test(text);
}

function isNoScreenshotReply(text) {
  return /^(没有|没|无|暂无|没有截图|没截图|无截图|先没有|暂时没有)$/i.test(String(text || "").trim());
}

function normalizeBugCollectionTask(task, fallbackText = "") {
  const params = task.params || {};
  const issueType = normalizeIssueType(params.issueType || params.type || params.category, [
    params.title,
    params.description,
    params.content,
    fallbackText
  ].filter(Boolean).join(" "));
  return {
    ...task,
    module: "bugCollection",
    action: "collect_issue",
    requireConfirmation: true,
    params: {
      ...params,
      issueType
    }
  };
}

function pendingScreenshotAsked(session) {
  return Boolean(
    session
    && session.pending
    && session.pending.module === "bugCollection"
    && session.pending.params
    && session.pending.params.screenshotAsked
  );
}

function needsBugScreenshotFollowup(task, session) {
  const params = task.params || {};
  return normalizeIssueType(params.issueType, `${params.title || ""} ${params.description || ""}`) === "Bug"
    && isMissingScreenshot(issueScreenshot(params))
    && !params.screenshotAsked
    && !pendingScreenshotAsked(session);
}

function taskNeedsConfirmation(task) {
  const action = String(task.action || "").toLowerCase();
  if (task.module === "rank" && (action === "watch_add" || action === "watch_remove")) {
    return false;
  }
  return Boolean(task.requireConfirmation)
    || (task.module === "bugCollection" && action === "collect_issue")
    || action.includes("add")
    || action.includes("remove")
    || action.includes("delete")
    || action.includes("update");
}

function rankTaskText(task, originalText) {
  if (task.normalizedText) {
    return String(task.normalizedText);
  }

  const params = task.params || {};
  const action = String(task.action || "query").toLowerCase();
  if (action === "top20" || action === "top" || action === "rank_top") {
    return "top20";
  }
  if (action === "history") {
    const gameName = params.gameName || params.game || "";
    const days = params.days ? ` 最近${params.days}天` : "";
    return gameName ? `历史 ${gameName}${days}` : originalText;
  }
  if (action === "watch_list") {
    return "关注列表";
  }
  if (action === "watch_add") {
    return `关注 ${params.gameName || params.game || ""}`.trim();
  }
  if (action === "watch_remove") {
    return `取消关注 ${params.gameName || params.game || ""}`.trim();
  }
  if (action === "help") {
    return "帮助";
  }

  return originalText;
}

function looksLikeDocCreate(text) {
  const value = String(text || "").trim();
  if (!value) {
    return false;
  }
  if (looksLikeDocCreateQuestion(value)) {
    return false;
  }
  const docTypeWords = "(?:智能表格|智能文档|普通表格|在线表格|共享表格|普通文档|在线文档|共享文档|表格|文档|表)";
  return new RegExp(`(?:创建|新建|建立|生成|建).{0,20}${docTypeWords}`).test(value)
    || new RegExp(`${docTypeWords}.{0,20}(?:创建|新建|建立|生成|建)`).test(value);
}

function looksLikeDocCreateQuestion(text) {
  const value = String(text || "").trim();
  if (/(?:如何|怎么|怎样).{0,8}(?:创建|新建|建立|生成|建)/.test(value)) {
    return true;
  }
  if (/(?:区别|有什么区别|什么区别|在你看来|解释|说明)/.test(value)
    && /(文档|表格|智能文档|智能表格)/.test(value)) {
    return true;
  }
  if (/(?:能创建什么|可以创建什么|支持创建什么|能建立什么|可以建立什么|支持建立什么)/.test(value)) {
    return true;
  }
  return /^(?:能不能|可以|能否|是否|会不会).{0,8}(?:创建|新建|建立|生成|建).*(?:吗|么|\?)$/i.test(value)
    && !/(帮我|请|麻烦|给我)/.test(value);
}

function docCreateKind(text) {
  const value = String(text || "").trim();
  if (/智能表格/.test(value)) {
    return "smartsheet";
  }
  if (/智能文档/.test(value)) {
    return "smartdoc";
  }
  if (/(?:普通表格|在线表格|共享表格|表格|表)/.test(value)) {
    return "spreadsheet";
  }
  return "document";
}

function docCreateAction(kind) {
  const actions = {
    document: "create_document",
    smartdoc: "create_smart_document",
    spreadsheet: "create_spreadsheet",
    smartsheet: "create_smartsheet"
  };
  return actions[kind] || "create_document";
}

function isGenericDocCreateName(value) {
  return /^(?:一?个|一?张|新的?|智能|普通|在线|共享|企业微信)$/.test(String(value || "").trim());
}

function extractDocCreateName(text) {
  const value = String(text || "").trim();
  const patterns = [
    /(?:叫|名叫|名称叫|名字叫|命名为)\s*[:：]?\s*([^\n，,。！？!?.；;：:]{2,80})/,
    /(?:创建|新建|建立|生成|建)(?:一个|一张|个|张)?(?:新的?)?(?:智能|普通|在线|共享)?(?:文档|表格|表)\s*[:：]\s*([^\n]{2,80})/,
    /(?:创建|新建|建立|生成|建)(?:一个|一张|个|张)?\s*([^\n，,。！？!?.；;：:]{2,80})(?:智能文档|智能表格|普通文档|普通表格|在线文档|在线表格|共享文档|共享表格|文档|表格|表)/
  ];
  for (const [index, pattern] of patterns.entries()) {
    const matched = value.match(pattern);
    if (matched && matched[1]) {
      const candidate = matched[1].trim().replace(/^["“”'‘’]+|["“”'‘’]+$/g, "");
      if (index > 0 && isGenericDocCreateName(candidate)) {
        continue;
      }
      return candidate;
    }
  }
  return "";
}

function detectLocalTask(text, modules) {
  const rawText = String(text || "").trim();
  if (modules.demandCollaboration && looksLikeDemandCollaborationEntry(rawText)) {
    return {
      module: "demandCollaboration",
      action: "open_entry",
      params: {},
      requireConfirmation: false,
      normalizedText: rawText
    };
  }

  if (modules.watchdog && looksLikeWatchdogCancel(rawText)) {
    return {
      module: "watchdog",
      action: "cancel_watchdog",
      params: {},
      requireConfirmation: false,
      normalizedText: rawText
    };
  }

  if (modules.watchdog && looksLikeWatchdogList(rawText)) {
    return {
      module: "watchdog",
      action: "list_watchdog",
      params: {
        scope: /(?:我的|我发起|我创建|自己)/.test(rawText) ? "mine" : "all"
      },
      requireConfirmation: false,
      normalizedText: rawText
    };
  }

  if (modules.watchdog && looksLikeWatchdogHelp(rawText)) {
    return {
      module: "watchdog",
      action: "help_watchdog",
      params: {},
      requireConfirmation: false,
      normalizedText: rawText
    };
  }

  if (modules.watchdog && looksLikeWatchdogReschedule(rawText)) {
    return {
      module: "watchdog",
      action: "reschedule_watchdog",
      params: {},
      requireConfirmation: false,
      normalizedText: rawText
    };
  }

  if (modules.watchdog && (looksLikeWatchdogCreate(rawText) || looksLikeWatchdogForm(rawText))) {
    return {
      module: "watchdog",
      action: "create_watchdog",
      params: {},
      requireConfirmation: false,
      normalizedText: rawText
    };
  }

  if (modules.docCreator && looksLikeDocCreate(rawText)) {
    const kind = docCreateKind(rawText);
    return {
      module: "docCreator",
      action: docCreateAction(kind),
      params: {
        docName: extractDocCreateName(rawText),
        kind
      },
      requireConfirmation: false,
      normalizedText: rawText
    };
  }

  if (modules.feedback) {
    if (!modules.bugCollection) {
      const feedbackPatterns = [
        /^(?:需求监控|需求跟进|开发进度监控|开发进度|EA系统|EA)\s*(?:反馈|建议|问题|意见|需求)\s*[:：]\s*([\s\S]+)$/i,
        /^(?:反馈|建议|问题|意见)\s*(?:需求监控|需求跟进|开发进度监控|开发进度)\s*[:：]\s*([\s\S]+)$/i
      ];
      for (const pattern of feedbackPatterns) {
        const matched = rawText.match(pattern);
        if (matched && matched[1] && matched[1].trim()) {
          return {
            module: "feedback",
            action: "collect_feedback",
            params: {
              content: matched[1].trim()
            },
            requireConfirmation: false,
            normalizedText: rawText
          };
        }
      }
    }

    if (/(需求监控|需求跟进|开发进度监控|开发进度).*(反馈|建议|问题|意见).*(导出)|(?:导出).*(需求监控|需求跟进|开发进度监控|开发进度).*(反馈|建议|问题|意见)/.test(rawText)) {
      return {
        module: "feedback",
        action: "export_feedback",
        params: {},
        requireConfirmation: false,
        normalizedText: rawText
      };
    }

    if (/(需求监控|需求跟进|开发进度监控|开发进度).*(反馈|建议|问题|意见).*(汇总|统计|列表|查看|看看|看一下)|(?:汇总|统计|列表|查看|看看|看一下).*(需求监控|需求跟进|开发进度监控|开发进度).*(反馈|建议|问题|意见)/.test(rawText)) {
      return {
        module: "feedback",
        action: "feedback_summary",
        params: {},
        requireConfirmation: false,
        normalizedText: rawText
      };
    }
  }

  if (!modules.devProgress || !/(任务|需求|进度|版本)/.test(rawText)) {
    return null;
  }

  const cleaned = rawText.replace(/^(?:查一下|查询|看一下|看看|统计|我问)\s*/, "");
  if (looksLikeDemandDetailQuery(cleaned)) {
    return {
      module: "devProgress",
      action: "demand_detail",
      params: demandDetailQueryParams(cleaned),
      requireConfirmation: false,
      normalizedText: demandDetailTaskText(rawText)
    };
  }

  if (looksLikeVersionPlanQuery(cleaned)) {
    return {
      module: "devProgress",
      action: "version_summary",
      params: versionQuerySendParams(cleaned),
      requireConfirmation: false,
      normalizedText: versionPlanTaskText(rawText)
    };
  }

  if (looksLikeVersionSummaryQuery(cleaned)) {
    return {
      module: "devProgress",
      action: "version_summary",
      params: versionQuerySendParams(cleaned),
      requireConfirmation: false,
      normalizedText: versionQueryTaskText(rawText)
    };
  }

  if (/(?:^|[，,。！？\s])(?:我|我的|自己|本人).*(?:任务|需求|进度)|(?:任务|需求|进度).*(?:我|我的|自己|本人)/.test(cleaned)) {
    return {
      module: "devProgress",
      action: "person_task_count",
      params: {
        personName: "__self__"
      },
      requireConfirmation: false,
      normalizedText: rawText
    };
  }

  if (/(哪些人|谁|人员|负责人).*(任务|需求|进度)|(任务|需求|进度).*(哪些人|谁|人员|负责人)/.test(cleaned)) {
    return {
      module: "devProgress",
      action: "people_task_summary",
      params: {},
      requireConfirmation: false,
      normalizedText: rawText
    };
  }

  const patterns = [
    /^([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·._-]{1,15})\s*(?:现在|当前)?(?:有|负责|手上|名下)(?:多少|几条|几项|几个)?(?:个|条|项)?(?:任务|需求|进度)/,
    /^([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·._-]{1,15})\s*(?:多少|几条|几项|几个)(?:个|条|项)?(?:任务|需求|进度)/,
    /^([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·._-]{1,15})的(?:任务|需求|进度)/
  ];

  for (const pattern of patterns) {
    const matched = cleaned.match(pattern);
    if (matched && matched[1]) {
      return {
        module: "devProgress",
        action: "person_task_count",
        params: {
          personName: matched[1].trim()
        },
        requireConfirmation: false,
        normalizedText: rawText
      };
    }
  }

  return null;
}

function describeTask(task) {
  const params = task.params || {};
  if (task.module === "bugCollection") {
    const lines = [
      "请确认是否记录到需求和 Bug 收集表：",
      `类型：${normalizeIssueType(params.issueType || params.type || params.category, `${params.title || ""} ${params.description || ""}`)}`,
      `标题：${params.title || params.summary || "未填写"}`,
      `描述：${params.description || params.content || "未填写"}`,
      `截图：${params.screenshot || params.image || params.attachment || "暂无"}`,
      `提交人：${params.submitter || "自动识别"}`
    ];
    return lines.join("\n");
  }

  const parts = [
    `模块：${task.module || "未知"}`,
    `动作：${task.action || "query"}`
  ];
  if (params.gameName || params.game) {
    parts.push(`游戏：${params.gameName || params.game}`);
  }
  if (params.days) {
    parts.push(`天数：${params.days}`);
  }
  return parts.join("，");
}

function buildPlannerPrompt(input) {
  const historyText = input.session && input.session.pending
    ? JSON.stringify(input.session.pending)
    : "无";
  const confirmationText = input.session && input.session.pendingConfirmation
    ? JSON.stringify(input.session.pendingConfirmation)
    : "无";
  const recentContextText = input.session && input.session.recentContext
    ? JSON.stringify(input.session.recentContext)
    : "无";

  return [
    "你是企业内部智能机器人入口的对话协调器。",
    "你的职责：先理解同事的问题；如果信息不足，追问；如果信息足够，输出结构化任务。",
    "你不能直接执行任何模块，也不能编造查询结果。",
    "只返回 JSON，不要返回 Markdown。",
    "",
    "可用模块：",
    "- rank：小游戏榜单。动作：top20、history、watch_list、watch_add、watch_remove、help。",
    "- demandCollaboration：需求协作 H5 入口。动作：open_entry。用于同事要打开需求协作、需求待办、需求 H5、需求入口时返回可点击链接。",
    "- devProgress：开发进度智能表格。动作：person_task_count、people_task_summary、version_summary、demand_detail。用于回答某个人有几条任务、我有任务吗、哪些人有任务、当前/本月/某个月有几个版本、某项目什么版本、版本计划并导出版本任务 Excel，也可按更新时间查询需求名称、需求内容、状态并导出 Excel。",
    "- watchdog：盯梢系统。动作：create_watchdog、reschedule_watchdog、cancel_watchdog、list_watchdog、help_watchdog。用于定时找某个同事收集某条任务或内容的进度，直到对方反馈已完成；也支持盯梢备注、一次性定点提醒、补充下一次盯梢时间、发起人取消自己创建的进行中盯梢、查询当前运行中的盯梢数量和列表、回答盯梢用法。",
    "- bugCollection：EA 系统自身的需求和 Bug 收集智能表格。动作：collect_issue。仅用于收集同事对 EA 系统、机器人、管理台、开发进度监控、版本查询、需求监控等能力的问题、Bug、需求、建议，并写入共享智能表格；不要用于记录游戏业务需求或需求总表里的项目需求。",
    "- docCreator：创建新的企业微信文档、智能文档、表格或智能表格。动作：create_document、create_smart_document、create_spreadsheet、create_smartsheet。普通“文档/在线文档/共享文档”用 create_document；明确说“智能文档”用 create_smart_document；普通“表格/在线表格/共享表格”用 create_spreadsheet；明确说“智能表格”才用 create_smartsheet；创建后把地址返回给同事。",
    "- feedback：旧本地需求监控反馈文件。动作：feedback_summary、export_feedback。只用于查询或导出历史本地反馈；新的 EA 系统问题、Bug、需求、建议都用 bugCollection。",
    "- demand：旧需求进度占位模块。当前模块未接入，除非用户明确问旧需求进度，否则不要选择。",
    "- activity：活动情报。当前模块未接入，除非用户明确问活动，否则不要选择。",
    "- history：跨模块历史。当前模块未接入。",
    "",
    "返回格式之一：",
    "{\"status\":\"need_clarification\",\"question\":\"你想查哪个游戏？\",\"pending\":{\"module\":\"rank\",\"action\":\"history\",\"params\":{}}}",
    "{\"status\":\"ready\",\"task\":{\"module\":\"rank\",\"action\":\"history\",\"params\":{\"gameName\":\"三国：冰河时代\",\"days\":7},\"requireConfirmation\":false,\"normalizedText\":\"历史 三国：冰河时代 最近7天\"}}",
    "{\"status\":\"ready\",\"task\":{\"module\":\"watchdog\",\"action\":\"create_watchdog\",\"params\":{},\"requireConfirmation\":false,\"normalizedText\":\"盯梢李猛，任务是首充礼包联调，1小时一次\"}}",
    "{\"status\":\"ready\",\"task\":{\"module\":\"watchdog\",\"action\":\"create_watchdog\",\"params\":{},\"requireConfirmation\":false,\"normalizedText\":\"盯梢李猛，任务是首充礼包联调，1小时一次，备注优先确认阻塞点\"}}",
    "{\"status\":\"ready\",\"task\":{\"module\":\"watchdog\",\"action\":\"create_watchdog\",\"params\":{},\"requireConfirmation\":false,\"normalizedText\":\"每天 10:00 盯梢李猛处理首充礼包\"}}",
    "{\"status\":\"ready\",\"task\":{\"module\":\"watchdog\",\"action\":\"create_watchdog\",\"params\":{},\"requireConfirmation\":false,\"normalizedText\":\"工作日每天 11点 盯梢李猛处理首充礼包\"}}",
    "{\"status\":\"ready\",\"task\":{\"module\":\"watchdog\",\"action\":\"create_watchdog\",\"params\":{},\"requireConfirmation\":false,\"normalizedText\":\"每周一 16:00 盯梢李猛处理周报\"}}",
    "{\"status\":\"ready\",\"task\":{\"module\":\"watchdog\",\"action\":\"create_watchdog\",\"params\":{},\"requireConfirmation\":false,\"normalizedText\":\"5月26日 10:00 提醒李猛处理首充礼包\"}}",
    "{\"status\":\"ready\",\"task\":{\"module\":\"watchdog\",\"action\":\"reschedule_watchdog\",\"params\":{},\"requireConfirmation\":false,\"normalizedText\":\"下次盯梢时间 6月24日 16:00\"}}",
    "{\"status\":\"ready\",\"task\":{\"module\":\"watchdog\",\"action\":\"cancel_watchdog\",\"params\":{},\"requireConfirmation\":false,\"normalizedText\":\"取消盯梢李猛首充礼包\"}}",
    "{\"status\":\"ready\",\"task\":{\"module\":\"watchdog\",\"action\":\"list_watchdog\",\"params\":{\"scope\":\"all\"},\"requireConfirmation\":false,\"normalizedText\":\"当前有多少盯梢正在运作\"}}",
    "{\"status\":\"ready\",\"task\":{\"module\":\"watchdog\",\"action\":\"help_watchdog\",\"params\":{},\"requireConfirmation\":false,\"normalizedText\":\"怎么盯梢\"}}",
    "{\"status\":\"ready\",\"task\":{\"module\":\"bugCollection\",\"action\":\"collect_issue\",\"params\":{\"issueType\":\"需求\",\"title\":\"开发进度提醒需要更明确\",\"description\":\"同事希望临近截止但未更新时提醒负责人。\",\"screenshot\":\"暂无\"},\"requireConfirmation\":true}}",
    `{"status":"chat","reply":"${CAPABILITY_REPLY}"}`,
    "",
    "规则：",
    "- top20、榜单、当前排名：信息足够，module=rank，action=top20。",
    "- 问“需求协作/需求待办/打开需求协作/需求 H5/需求入口”：信息足够，module=demandCollaboration，action=open_entry，不要追问。",
    "- 问某个游戏最近怎样、走势、历史：如果游戏名明确，module=rank，action=history；天数不明确时默认 7 天，不要追问。",
    "- 问“某人有几条任务/多少任务/某人的任务”：信息足够，module=devProgress，action=person_task_count，params.personName=人名。",
    "- 问“我有任务吗/我的任务/我手上有什么需求”：信息足够，module=devProgress，action=person_task_count，params.personName=__self__。",
    "- 问“哪些人有任务/谁有任务/负责人任务汇总”：信息足够，module=devProgress，action=people_task_summary。",
    "- 开发进度项目别名：一骑=一骑当千；女王=女王之刃；QB=女王之刃；高校=恶魔高校；噬血=噬血狂袭；魔王=魔王。开发进度查询中出现这些别名时，params.projectName 填正式项目名。",
    "- 问“更新时间是今天的高校项目的需求名称和需求内容及状态/今天更新了哪些需求/某项目今天更新需求明细”：信息足够，module=devProgress，action=demand_detail；按需求总表“更新时间”过滤；没有指定时间时默认今天；params.sendExcel=true，params.sendToConversation=true，直接把 Excel 发到当前对话，不要二次询问。",
    "- 问“当前有几个版本/版本情况/版本计划/本月有几个版本/上月版本/2026年6月版本/导出版本任务/版本明细/这个月一骑什么版本/QB 本月什么版本”：信息足够，module=devProgress，action=version_summary；版本按需求总表“更新时间”的日期归并；没有指定时间时默认本周；params.sendExcel=true，params.sendToConversation=true，直接把 Excel 发到当前对话，不要二次询问。",
    "- 版本查询里如果明确说“发送给我/发送给某某/发送给某某和我”，params.sendExcel=true，并按用户指定目标填写 sendToSelf、sendTargetNames。",
    "- 如果上一轮业务上下文是版本查询，用户说“上月呢/本周呢/发送给我/也发给某某”，要继承上一轮是 devProgress.version_summary，并直接发送 Excel。",
    "- 如果上一轮业务上下文是个人任务查询，用户说“某某呢”，通常是在继续问另一个人的任务，module=devProgress，action=person_task_count。",
    "- 同事问“盯梢列表 / 当前有多少盯梢正在运作 / 运行中的盯梢 / 我的盯梢”，module=watchdog，action=list_watchdog；说“我的/我发起的”时 params.scope=mine，否则 params.scope=all。",
    "- 同事问“怎么盯梢 / 盯梢怎么用 / 盯梢模式 / 盯梢怎么填写”，module=watchdog，action=help_watchdog。",
    "- 同事要求“取消盯梢 / 停止盯梢 / 关闭定时提醒 / 删除盯梢任务”，module=watchdog，action=cancel_watchdog，requireConfirmation=false，normalizedText 保留原文；只取消发起人自己的进行中盯梢。",
    "- 同事要求“盯梢某人 / 盯下某人 / 1小时盯梢一次 / 每天 10:00 盯梢某人 / 工作日 11:00 盯梢某人 / 每周一 16:00 盯梢某人 / 定时找某人收集进度”，或按“被盯梢人、盯梢任务、盯梢间隔、备注、附件”格式补充盯梢信息：module=watchdog，action=create_watchdog，requireConfirmation=false，normalizedText 保留原文；不写入 bugCollection。",
    "- 同事在创建盯梢时说“备注/说明/补充说明”时，保留在 normalizedText 里交给 watchdog 解析；发起人收到盯梢反馈后回复“备注：新的备注内容”属于 watchdog 的反馈后备注修改，不要写入 bugCollection。",
    "- 同事要求“5月26日提醒某人 / 明天 10:00 提醒某人处理某事 / 提醒时间：5月26日 10:00”时，也走 module=watchdog，action=create_watchdog，表示一次性盯梢。",
    "- 同事说“下次盯梢时间 6月24日 16:00 / 下次提醒改到明天下午4点 / 更新下一次迭代时间”时，module=watchdog，action=reschedule_watchdog；这是给已有一次性盯梢补下次时间，不是创建新盯梢，不要把“时间”识别成被盯梢人。",
    "- 循环盯梢默认 3 小时一次；如果同事明确说 30 分钟、1 小时、每天一次、每天 10:00、工作日 11:00、每周一 16:00 等，以同事说的时间为准。一次性盯梢以同事说的日期时间为准。",
    "- 同事自然反馈 EA 系统、机器人、管理台、开发进度监控、版本查询、需求监控等能力的问题、Bug、需求或建议，且不是在查询榜单/开发进度时，优先 module=bugCollection，action=collect_issue。",
    "- 如果同事只是描述游戏业务需求、项目需求、需求总表里的需求，不要选择 bugCollection；这类内容要么走 devProgress 查询，要么 status=need_clarification。",
    "- 同事要求“创建一个文档/新建共享文档/帮我建一篇方案文档”等，信息足够，module=docCreator，action=create_document；如果能识别文档名称，params.docName=文档名称；不需要确认。",
    "- 同事明确说“智能文档”时，module=docCreator，action=create_smart_document；不要把普通“文档”当成智能文档。",
    "- 同事要求“创建一个表格/新建普通表格/创建在线表格/帮我建一张项目周报表”等，信息足够，module=docCreator，action=create_spreadsheet；如果能识别表格名称，params.docName=表格名称；不需要确认。",
    "- 只有同事明确说“智能表格”时，module=docCreator，action=create_smartsheet；不要把普通“表格”当成智能表格。",
    "- 同事只是问“如何创建/有什么区别/能创建什么”时不要创建文档，status=chat 或 need_clarification。",
    "- bugCollection 的表格字段是：任务ID、类型、标题、描述、截图、提交人、创建时间、更新时间；任务ID 由系统自动生成，大模型不要填写。",
    "- 对 bugCollection：issueType 只能填“Bug”或“需求”；报错、异常、闪退、白屏、打不开、失败、不能正常使用归为 Bug；建议、优化、希望新增或流程诉求归为需求。",
    "- 对 bugCollection：如果同事说得足够清楚，你要整理出 issueType、简短标题和完整描述；submitter 可不填，由系统识别。",
    "- 对 bugCollection：Bug 最好保留截图或链接；如果 Bug 没有截图且之前没问过截图，先追问截图或链接；对方说没有时 screenshot 填“暂无”。",
    "- 对 bugCollection：需求或建议没有截图时不要追问，screenshot 填“暂无”。",
    "- 对 bugCollection：如果完全看不出要记录什么，status=need_clarification。",
    "- 对 bugCollection：只要准备写入表格，必须 requireConfirmation=true，让同事确认后再写入。",
    "- 如果上一轮待补充信息是 bugCollection，同事最新消息是补充内容，你要合并上一轮信息后继续判断，信息足够就 ready。",
    "- 问需求监控反馈汇总：module=feedback，action=feedback_summary。",
    "- 要导出需求监控反馈：module=feedback，action=export_feedback。",
    "- 添加关注、取消关注榜单游戏时不要二次确认；如果游戏名明确，module=rank，action=watch_add/watch_remove，requireConfirmation=false，并直接执行。",
    "- 问法太模糊且无法判断模块或关键参数时，status=need_clarification。",
    "- 对未接入模块，可以 status=chat 简短说明当前还未接入。",
    "",
    `上一轮待确认任务：${confirmationText}`,
    `上一轮待补充信息：${historyText}`,
    `上一轮业务上下文：${recentContextText}`,
    `同事最新消息：${input.text}`
  ].join("\n");
}

function buildIssuePrompt(input) {
  const pendingText = input.session && input.session.pending
    ? JSON.stringify(input.session.pending)
    : "无";
  return [
    "你负责把同事对 EA 系统自身的 Bug 或需求反馈整理成“需求和 Bug 收集”智能表格记录。",
    "表格字段是：任务ID、类型、标题、描述、截图、提交人、创建时间、更新时间；任务ID 由系统自动生成，你不要填写。",
    "你只返回严格 JSON，不要返回 Markdown。",
    "",
    "规则：",
    "- 只处理 EA 系统、机器人、管理台、开发进度监控、版本查询、需求监控等能力自身的问题或需求。",
    "- 不要把游戏业务需求、项目需求总表中的需求当作这里的需求记录。",
    "- 如果同事描述中已经能看出 EA 系统自身的问题或需求，就整理为 ready。",
    "- issueType 只能填“Bug”或“需求”。",
    "- 报错、异常、闪退、白屏、打不开、失败、不能正常使用等归为 Bug。",
    "- 建议、优化、希望新增、流程诉求、提醒规则等归为需求。",
    "- title 要短，像表格标题，最多 24 个中文字符。",
    "- description 要保留同事反馈的核心背景、问题和期望结果。",
    "- Bug 最好保留截图或链接；如果 Bug 没有截图且 pending.screenshotAsked 不是 true，返回 need_clarification，询问“这个 Bug 有截图或链接吗？有的话发我；没有也可以回复‘没有’。”，pending.params 保留已整理的 issueType、title、description，并设置 screenshotAsked=true。",
    "- 如果 pending.screenshotAsked=true 且同事回复没有截图，ready，并把 screenshot 填“暂无”。",
    "- 如果 pending.screenshotAsked=true 且同事补充截图或链接，ready，并把 screenshot 填为截图说明或链接。",
    "- 需求或建议没有截图时不要追问，screenshot 填“暂无”。",
    "- 只有完全不知道要记录什么时才 need_clarification。",
    "- 如果上一轮 pending 有内容，要和同事最新消息合并。",
    "- 准备写表时必须 requireConfirmation=true。",
    "",
    "返回格式之一：",
    "{\"status\":\"ready\",\"task\":{\"module\":\"bugCollection\",\"action\":\"collect_issue\",\"params\":{\"issueType\":\"需求\",\"title\":\"临近截止任务需要提醒\",\"description\":\"任务快到期但负责人没更新时，希望机器人主动提醒，避免遗漏。\",\"screenshot\":\"暂无\"},\"requireConfirmation\":true}}",
    "{\"status\":\"need_clarification\",\"question\":\"这个 Bug 有截图或链接吗？有的话发我；没有也可以回复“没有”。\",\"pending\":{\"module\":\"bugCollection\",\"action\":\"collect_issue\",\"params\":{\"issueType\":\"Bug\",\"title\":\"页面打开失败\",\"description\":\"页面无法打开，需要记录排查。\",\"screenshotAsked\":true}}}",
    "{\"status\":\"need_clarification\",\"question\":\"你希望记录的问题具体是什么？\",\"pending\":{\"module\":\"bugCollection\",\"action\":\"collect_issue\",\"params\":{}}}",
    "",
    `上一轮待补充信息：${pendingText}`,
    `同事最新消息：${input.text}`
  ].join("\n");
}

function createConversationOrchestrator(options) {
  const aiConfig = options.aiConfig || {};
  const aiClient = options.aiClient;
  const modules = options.modules;
  const answerComposer = options.answerComposer;
  const store = options.store;
  const logger = options.logger;

  function isEnabled() {
    return Boolean(aiConfig.enabled && aiClient);
  }

  function baseState(sessionId) {
    const current = store.get(sessionId) || {};
    return current.recentContext ? { recentContext: current.recentContext } : {};
  }

  function setState(sessionId, patch = {}) {
    store.set(sessionId, {
      ...baseState(sessionId),
      ...patch
    });
  }

  function patchState(sessionId, patch = {}) {
    const current = store.get(sessionId) || {};
    store.set(sessionId, {
      ...current,
      ...patch
    });
  }

  function clearInteractiveState(sessionId) {
    const base = baseState(sessionId);
    if (Object.keys(base).length > 0) {
      store.set(sessionId, base);
      return;
    }
    store.clear(sessionId);
  }

  function recentContextFromTask(task, result) {
    if (!task || !result || !result.ok) {
      return null;
    }

    const params = task.params || {};
    if (task.module === "devProgress" && task.action === "version_summary") {
      const summary = result.data && result.data.summary ? result.data.summary : {};
      const projectFilter = summary.projectFilter || {};
      return {
        module: "devProgress",
        action: "version_summary",
        params: {
          timeRange: summary.timeRange || params.timeRange || null,
          projectName: projectFilter.projectName || params.projectName || "",
          projectAlias: projectFilter.matchedAlias || params.projectAlias || ""
        },
        canSendExcel: Boolean(result.data && result.data.canSendExcel),
        versionCount: summary.versionCount,
        taskCount: summary.scannedCount
      };
    }

    if (task.module === "devProgress" && task.action === "person_task_count") {
      return {
        module: "devProgress",
        action: "person_task_count",
        params: {
          personName: params.personName || (result.data && result.data.summary ? result.data.summary.personName : "")
        }
      };
    }

    if (task.module === "devProgress" && task.action === "people_task_summary") {
      return {
        module: "devProgress",
        action: "people_task_summary",
        params: {}
      };
    }

    if (task.module === "rank") {
      return {
        module: "rank",
        action: task.action || "query",
        params: {
          gameName: params.gameName || params.game || "",
          days: params.days || ""
        }
      };
    }

    return null;
  }

  function detectContextualTask(text, modules, session) {
    const recent = session && session.recentContext ? session.recentContext : null;
    if (!recent || !modules.devProgress) {
      return null;
    }

    if (recent.module === "devProgress" && recent.action === "version_summary") {
      if (looksLikeVersionExcelSend(text)) {
        return {
          module: "devProgress",
          action: "version_summary",
          params: {
            ...(recent.params || {}),
            ...versionExcelSendParams(text)
          },
          requireConfirmation: false,
          normalizedText: text
        };
      }

      if (looksLikeVersionTimeFollowup(text)) {
        const recentParams = recent.params || {};
        return {
          module: "devProgress",
          action: "version_summary",
          params: {
            ...defaultVersionExcelParams(),
            projectName: recentParams.projectName || "",
            projectAlias: recentParams.projectAlias || ""
          },
          requireConfirmation: false,
          normalizedText: text
        };
      }
    }

    if (recent.module === "devProgress" && /^(?:person_task_count|people_task_summary)$/.test(recent.action || "")) {
      const personName = followupPersonName(text);
      if (personName) {
        return {
          module: "devProgress",
          action: "person_task_count",
          params: {
            personName
          },
          requireConfirmation: false,
          normalizedText: text
        };
      }
    }

    return null;
  }

  async function askModel(message, session) {
    const content = await aiClient.chat([
      {
        role: "system",
        content: "你只返回严格 JSON。不要输出密钥、不要输出日志、不要执行任务。"
      },
      {
        role: "user",
        content: buildPlannerPrompt({
          text: message.text,
          session
        })
      }
    ]);
    return parseJsonObject(content);
  }

  async function askIssueModel(message, session) {
    const content = await aiClient.chat([
      {
        role: "system",
        content: "你只返回严格 JSON。不要输出密钥、不要输出日志、不要执行任务。"
      },
      {
        role: "user",
        content: buildIssuePrompt({
          text: message.text,
          session
        })
      }
    ]);
    return parseJsonObject(content);
  }

  async function handleIssueCollection(message, sessionId, session) {
    let decision;
    if (pendingScreenshotAsked(session) && isNoScreenshotReply(message.text)) {
      decision = {
        status: "ready",
        task: {
          module: "bugCollection",
          action: "collect_issue",
          params: {
            ...session.pending.params,
            screenshot: "暂无"
          },
          requireConfirmation: true
        }
      };
    } else {
      try {
        decision = await askIssueModel(message, session);
      } catch (error) {
        logger.warn("LLM issue extraction failed", { message: error.message });
        decision = {
          status: "ready",
          task: {
            module: "bugCollection",
            action: "collect_issue",
            params: {
              issueType: normalizeIssueType("", message.text),
              title: conciseTitle(message.text),
              description: message.text,
              screenshot: "暂无"
            },
            requireConfirmation: true
          }
        };
      }
    }

    if (!decision.task && decision.pending && decision.pending.params) {
      decision = {
        ...decision,
        pending: {
          ...decision.pending,
          params: {
            ...decision.pending.params,
            issueType: normalizeIssueType(
              decision.pending.params.issueType || decision.pending.params.type || decision.pending.params.category,
              `${decision.pending.params.title || ""} ${decision.pending.params.description || ""} ${message.text || ""}`
            )
          }
        }
      };
    }

    logger.info("LLM issue collection decision", {
      status: decision.status,
      action: decision.task && decision.task.action
    });

    if (decision.status === "need_clarification") {
      setState(sessionId, {
        pending: {
          module: "bugCollection",
          action: "collect_issue",
          params: (decision.pending && decision.pending.params) || {}
        },
        lastQuestion: decision.question || ""
      });
      return {
        ok: true,
        route: { source: "llm", status: "need_clarification", module: "bugCollection" },
        text: decision.question || "你希望记录的问题具体是什么？"
      };
    }

    if (decision.status === "ready" && decision.task) {
      decision.task = normalizeBugCollectionTask(decision.task, message.text);
      if (needsBugScreenshotFollowup(decision.task, session)) {
        setState(sessionId, {
          pending: {
            module: "bugCollection",
            action: "collect_issue",
            params: {
              ...decision.task.params,
              screenshotAsked: true
            }
          },
          lastQuestion: "这个 Bug 有截图或链接吗？有的话发我；没有也可以回复“没有”。"
        });
        return {
          ok: true,
          route: { source: "llm", status: "need_clarification", module: "bugCollection" },
          text: "这个 Bug 有截图或链接吗？有的话发我；没有也可以回复“没有”。"
        };
      }
      setState(sessionId, {
        pendingConfirmation: {
          task: decision.task
        }
      });
      return {
        ok: true,
        route: { source: "llm", status: "need_confirmation", module: "bugCollection" },
        text: `${describeTask(decision.task)}\n回复“确认”执行，回复“取消”放弃。`
      };
    }

    return {
      ok: true,
      route: { source: "llm", status: "need_clarification", module: "bugCollection" },
      text: "你希望记录的问题具体是什么？"
    };
  }

  function isVersionSummaryTask(task) {
    return task && task.module === "devProgress" && String(task.action || "").toLowerCase() === "version_summary";
  }

  function isDemandDetailTask(task) {
    return task && task.module === "devProgress" && String(task.action || "").toLowerCase() === "demand_detail";
  }

  function hasExplicitVersionTarget(params = {}) {
    const targetNames = Array.isArray(params.sendTargetNames) ? params.sendTargetNames : [];
    return params.sendToSelf === true
      || params.sendToConversation === true
      || targetNames.length > 0
      || Boolean(params.sendTargetName || params.targetName);
  }

  function normalizeVersionSummaryTask(task, message) {
    if (!isVersionSummaryTask(task)) {
      return task;
    }

    const params = {
      ...(task.params || {})
    };
    if (params.sendExcel !== true) {
      params.sendExcel = true;
    }
    if (!hasExplicitVersionTarget(params)) {
      params.sendTargetName = "";
      params.sendTargetNames = [];
      params.sendToSelf = false;
      params.sendToConversation = true;
    }
    const projectParams = extractVersionProjectParams(task.normalizedText || (message && message.text) || "", params);
    if (projectParams && !params.projectName) {
      params.projectName = projectParams.projectName;
      params.projectAlias = projectParams.projectAlias;
    }

    return {
      ...task,
      params,
      requireConfirmation: false,
      normalizedText: versionQueryTaskText(task.normalizedText || (message && message.text) || "版本")
    };
  }

  function normalizeDemandDetailTask(task, message) {
    if (!isDemandDetailTask(task)) {
      return task;
    }

    const params = {
      ...(task.params || {}),
      sendExcel: true
    };
    if (!hasExplicitVersionTarget(params)) {
      params.sendTargetName = "";
      params.sendTargetNames = [];
      params.sendToSelf = false;
      params.sendToConversation = true;
    }
    const projectParams = extractVersionProjectParams(task.normalizedText || (message && message.text) || "", params);
    if (projectParams && !params.projectName) {
      params.projectName = projectParams.projectName;
      params.projectAlias = projectParams.projectAlias;
    }

    return {
      ...task,
      params,
      requireConfirmation: false,
      normalizedText: demandDetailTaskText(task.normalizedText || (message && message.text) || "需求明细")
    };
  }

  function shouldKeepVersionExportPending(task, result) {
    const params = task && task.params ? task.params : {};
    return isVersionSummaryTask(task)
      && params.sendExcel !== true
      && result
      && result.ok
      && result.data
      && result.data.canSendExcel
      && (!Array.isArray(result.files) || result.files.length === 0);
  }

  async function executeTask(task, message, execution = {}) {
    const executableTask = normalizeDemandDetailTask(normalizeVersionSummaryTask(task, message), message);
    const moduleName = executableTask.module || "rank";
    const selectedModule = modules[moduleName];
    if (!selectedModule) {
      return {
        ok: false,
        route: { source: "llm", module: moduleName, intent: `${moduleName}.${executableTask.action || "query"}` },
        text: `暂时没有可用模块处理：${moduleName}`
      };
    }

    const moduleText = moduleName === "rank"
      ? rankTaskText(executableTask, message.text)
      : (executableTask.normalizedText || message.text);
    const intent = {
      source: "llm",
      module: moduleName,
      intent: `${moduleName}.${executableTask.action || "query"}`,
      task: executableTask
    };
    const moduleResult = await selectedModule.handle({
      text: moduleText,
      intent: intent.intent,
      route: intent,
      sender: message.sender || {},
      raw: message.raw || {}
    });

    const composed = await answerComposer.compose({
      text: moduleText,
      intent,
      moduleResult
    });

    if (execution.sessionId && composed && composed.confirmationTask) {
      setState(execution.sessionId, {
        pendingConfirmation: {
          task: composed.confirmationTask
        }
      });
      return composed;
    }

    if (execution.sessionId && composed && composed.pending) {
      setState(execution.sessionId, {
        pending: composed.pending
      });
      return composed;
    }

    const recentContext = recentContextFromTask(executableTask, composed);
    if (execution.sessionId && (recentContext || shouldKeepVersionExportPending(executableTask, composed))) {
      const summary = composed.data && composed.data.summary ? composed.data.summary : {};
      const patch = {};
      if (recentContext) {
        patch.recentContext = recentContext;
      }
      if (shouldKeepVersionExportPending(executableTask, composed)) {
        patch.pendingVersionExport = {
          task: {
            ...executableTask,
            params: {
              ...(executableTask.params || {}),
              timeRange: summary.timeRange || null
            },
            normalizedText: executableTask.normalizedText || message.text
          }
        };
      }
      patchState(execution.sessionId, patch);
    }

    return composed;
  }

  async function handle(message) {
    const text = String(message.text || "").trim();
    const sessionId = sessionIdFromMessage(message);
    const session = store.get(sessionId) || {};

    if (modules.watchdog && looksLikeWatchdogHelp(text)) {
      clearInteractiveState(sessionId);
      return executeTask({
        module: "watchdog",
        action: "help_watchdog",
        params: {},
        requireConfirmation: false,
        normalizedText: text
      }, message, { sessionId });
    }

    if (session.pendingConfirmation) {
      if (isConfirmText(text)) {
        const task = session.pendingConfirmation.task;
        clearInteractiveState(sessionId);
        return executeTask(task, message, { sessionId });
      }
      if (isCancelText(text)) {
        clearInteractiveState(sessionId);
        return {
          ok: true,
          text: "已取消。"
        };
      }
    }

    if (session.pendingVersionExport) {
      if (isCancelText(text)) {
        clearInteractiveState(sessionId);
        return {
          ok: true,
          text: "已取消发送 Excel。"
        };
      }

      if (isConfirmText(text) || looksLikeVersionExcelSend(text)) {
        const task = session.pendingVersionExport.task || {};
        const sendParams = looksLikeVersionExcelSend(text)
          ? versionExcelSendParams(text)
          : { sendExcel: true, sendTargetName: "", sendTargetNames: [], sendToSelf: false, sendToConversation: true };
        clearInteractiveState(sessionId);
        return executeTask({
          ...task,
          params: {
            ...(task.params || {}),
            ...sendParams
          }
        }, message, { sessionId });
      }
    }

    if (session.pending && session.pending.module === "watchdog") {
      if (isCancelText(text)) {
        clearInteractiveState(sessionId);
        return {
          ok: true,
          text: "已取消这次操作。"
        };
      }
      const pendingTask = {
        module: "watchdog",
        action: session.pending.action || "cancel_watchdog",
        params: {
          ...(session.pending.params || {}),
          selectionText: text
        },
        requireConfirmation: false,
        normalizedText: text
      };
      clearInteractiveState(sessionId);
      return executeTask(pendingTask, message, { sessionId });
    }

    if (looksLikeCapabilityQuestion(text)) {
      clearInteractiveState(sessionId);
      return {
        ok: true,
        route: { source: "local", status: "chat", action: "capability_help" },
        text: CAPABILITY_REPLY
      };
    }

    if (modules.bugCollection && ((session.pending && session.pending.module === "bugCollection") || looksLikeIssueCollection(text))) {
      return handleIssueCollection(message, sessionId, session);
    }

    const localTask = detectLocalTask(text, modules);
    if (localTask) {
      clearInteractiveState(sessionId);
      return executeTask(localTask, message, { sessionId });
    }

    const contextualTask = detectContextualTask(text, modules, session);
    if (contextualTask) {
      clearInteractiveState(sessionId);
      return executeTask(contextualTask, message, { sessionId });
    }

    const decision = await askModel(message, session);
    logger.info("LLM conversation decision", {
      status: decision.status,
      module: decision.task && decision.task.module,
      action: decision.task && decision.task.action
    });
    const disabledBugCollectionDecision = !modules.bugCollection && (
      (decision.task && decision.task.module === "bugCollection")
      || (decision.pending && decision.pending.module === "bugCollection")
    );
    if (disabledBugCollectionDecision) {
      clearInteractiveState(sessionId);
      return {
        ok: true,
        route: { source: "local", status: "chat", action: "bug_collection_disabled" },
        text: "EA 的需求和 Bug 收集功能目前已暂停，请直接描述你要执行的业务操作。"
      };
    }

    if (decision.status === "need_clarification") {
      setState(sessionId, {
        pending: decision.pending || {},
        lastQuestion: decision.question || ""
      });
      return {
        ok: true,
        route: { source: "llm", status: "need_clarification" },
        text: decision.question || "我需要再确认一下你的需求。"
      };
    }

    if (decision.status === "chat") {
      clearInteractiveState(sessionId);
      return {
        ok: true,
        route: { source: "llm", status: "chat" },
        text: decision.reply || CAPABILITY_REPLY
      };
    }

    if (decision.status === "ready" && decision.task) {
      clearInteractiveState(sessionId);
      if (taskNeedsConfirmation(decision.task)) {
        setState(sessionId, {
          pendingConfirmation: {
            task: decision.task
          }
        });
        return {
          ok: true,
          route: { source: "llm", status: "need_confirmation" },
          text: `${describeTask(decision.task)}\n回复“确认”执行，回复“取消”放弃。`
        };
      }
      return executeTask(decision.task, message, { sessionId });
    }

    clearInteractiveState(sessionId);
    return {
      ok: false,
      route: { source: "llm", status: "invalid" },
      text: "我没有理解清楚你的需求，可以换个说法吗？"
    };
  }

  return {
    isEnabled,
    handle
  };
}

module.exports = {
  createConversationOrchestrator
};
