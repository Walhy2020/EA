"use strict";

const fs = require("fs");
const path = require("path");
const { projectRoot, resolveProjectPath } = require("../../utils/paths");
const { maskSecrets } = require("../../utils/secretMask");

const DEFAULT_STORAGE_FILE = "data/feedback/demand-monitor-feedback.jsonl";
const DEFAULT_EXPORT_FILE = "data/feedback/demand-monitor-feedback.md";

const CATEGORY_RULES = [
  {
    category: "监控规则",
    pattern: /(规则|异常|逾期|延期|截止|剩余|无更新|卡住|阻塞|风险)/
  },
  {
    category: "提醒通知",
    pattern: /(通知|提醒|推送|负责人|主动|私聊|群|@)/
  },
  {
    category: "文档数据",
    pattern: /(共享文档|智能表格|表格|字段|读取|数据|权限|文档)/
  },
  {
    category: "机器人交互",
    pattern: /(机器人|追问|回复|问答|对话|入口)/
  },
  {
    category: "报表汇总",
    pattern: /(汇总|统计|导出|报表|列表|看板)/
  }
];

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function nowStamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function feedbackId() {
  return `fb-${nowStamp()}-${Math.random().toString(16).slice(2, 8)}`;
}

function sanitizeFeedbackText(value) {
  const masked = maskSecrets(String(value || ""));
  return masked
    .replace(/((?:api[_ -]?key|secret|token|webhook|password|密码|密钥)\s*[:=：]\s*)[^\s,，;；]+/gi, "$1***")
    .trim();
}

function extractPrefixedContent(text) {
  const rawText = String(text || "").trim();
  const patterns = [
    /^(?:需求监控|需求跟进|开发进度监控|开发进度|EA系统|EA)\s*(?:反馈|建议|问题|意见|需求)\s*[:：]\s*([\s\S]+)$/i,
    /^(?:反馈|建议|问题|意见)\s*(?:需求监控|需求跟进|开发进度监控|开发进度)\s*[:：]\s*([\s\S]+)$/i
  ];

  for (const pattern of patterns) {
    const matched = rawText.match(pattern);
    if (matched && matched[1]) {
      return matched[1].trim();
    }
  }
  return rawText;
}

function splitFeedbackItems(text) {
  const cleaned = sanitizeFeedbackText(text);
  if (!cleaned) {
    return [];
  }

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bulletLines = lines
    .map((line) => line.replace(/^(?:[-*]|[0-9]+[.、]|[一二三四五六七八九十]+[、.])\s*/, "").trim())
    .filter(Boolean);

  if (bulletLines.length > 1 && bulletLines.length === lines.length) {
    return bulletLines;
  }

  const paragraphs = cleaned
    .split(/\r?\n\s*\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  return paragraphs.length > 1 ? paragraphs : [cleaned];
}

function detectCategory(content) {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(content)) {
      return rule.category;
    }
  }
  return "其他";
}

function compactSender(sender = {}) {
  return {
    source: sender.source || "",
    chatType: sender.chatType || "",
    chatId: sender.chatId || "",
    userId: sender.userId || "",
    name: sender.name || ""
  };
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs.readFileSync(filePath, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function writeJsonlLine(filePath, value) {
  ensureDirForFile(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function summarize(entries) {
  const byCategory = {};
  const byStatus = {};
  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
  }

  return {
    total: entries.length,
    byCategory,
    byStatus,
    latestAt: entries.length > 0 ? entries[0].createdAt : ""
  };
}

function renderMarkdown(entries, summary) {
  const lines = [
    "# 需求监控反馈汇总",
    "",
    `更新时间：${new Date().toISOString()}`,
    "",
    "## 汇总",
    "",
    `- 总数：${summary.total}`,
    `- 分类：${Object.entries(summary.byCategory).map(([name, count]) => `${name} ${count}`).join("，") || "无"}`,
    "",
    "## 明细",
    ""
  ];

  if (entries.length === 0) {
    lines.push("暂无反馈。");
    return `${lines.join("\n")}\n`;
  }

  for (const entry of entries) {
    const senderName = entry.sender.name || entry.sender.userId || entry.sender.chatId || entry.sender.source || "未知";
    lines.push(`### ${entry.id}`);
    lines.push("");
    lines.push(`- 时间：${entry.createdAt}`);
    lines.push(`- 分类：${entry.category}`);
    lines.push(`- 状态：${entry.status}`);
    lines.push(`- 来源：${senderName}`);
    lines.push("");
    lines.push(entry.content);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function createDemandMonitorFeedbackModule(options = {}) {
  const logger = options.logger;
  const storageFile = resolveProjectPath(options.storageFile || DEFAULT_STORAGE_FILE);
  const exportFile = resolveProjectPath(options.exportFile || DEFAULT_EXPORT_FILE);

  function list(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit || 50), 500));
    const entries = readJsonl(storageFile).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    return {
      ok: true,
      module: "feedback",
      storageFile,
      exportFile,
      summary: summarize(entries),
      entries: entries.slice(0, limit)
    };
  }

  function collect(input = {}) {
    const content = sanitizeFeedbackText(extractPrefixedContent(input.content || input.text || ""));
    if (!content) {
      return {
        ok: false,
        module: "feedback",
        text: "请把需求监控的具体问题或建议写在消息里。"
      };
    }

    const entry = {
      id: feedbackId(),
      createdAt: new Date().toISOString(),
      source: input.source || (input.sender && input.sender.source) || "unknown",
      sender: compactSender(input.sender || {}),
      category: input.category || detectCategory(content),
      status: "new",
      content
    };
    writeJsonlLine(storageFile, entry);
    if (logger) {
      logger.info("Demand monitor feedback collected", {
        id: entry.id,
        category: entry.category,
        contentLength: entry.content.length,
        source: entry.source
      });
    }

    return {
      ok: true,
      module: "feedback",
      action: "collect_feedback",
      text: `已记录 1 条需求监控反馈，编号 ${entry.id}。`,
      data: { entry }
    };
  }

  function importText(input = {}) {
    const items = splitFeedbackItems(input.text || input.content || "");
    if (items.length === 0) {
      return {
        ok: false,
        module: "feedback",
        text: "没有识别到可保存的反馈内容。"
      };
    }

    const entries = items.map((content) => {
      const entry = {
        id: feedbackId(),
        createdAt: new Date().toISOString(),
        source: input.source || (input.sender && input.sender.source) || "admin-console",
        sender: compactSender(input.sender || {}),
        category: input.category || detectCategory(content),
        status: "new",
        content
      };
      writeJsonlLine(storageFile, entry);
      return entry;
    });

    if (logger) {
      logger.info("Demand monitor feedback imported", {
        count: entries.length,
        source: input.source || "admin-console"
      });
    }

    return {
      ok: true,
      module: "feedback",
      action: "import_feedback",
      text: `已保存 ${entries.length} 条需求监控反馈。`,
      data: { entries }
    };
  }

  function exportMarkdown() {
    const result = list({ limit: 500 });
    const markdown = renderMarkdown(result.entries, result.summary);
    ensureDirForFile(exportFile);
    fs.writeFileSync(exportFile, markdown, "utf8");
    return {
      ok: true,
      module: "feedback",
      action: "export_markdown",
      exportFile,
      summary: result.summary,
      markdown
    };
  }

  async function handle(context = {}) {
    const task = context.route && context.route.task ? context.route.task : {};
    const action = String((task && task.action) || context.intent || "").toLowerCase();
    if (action.includes("summary") || action.includes("list")) {
      const result = list({ limit: 20 });
      return {
        ok: true,
        module: "feedback",
        action: "feedback_summary",
        text: `当前已收集 ${result.summary.total} 条需求监控反馈。分类：${Object.entries(result.summary.byCategory).map(([name, count]) => `${name} ${count} 条`).join("，") || "暂无"}。`,
        data: result
      };
    }
    if (action.includes("export")) {
      const result = exportMarkdown();
      return {
        ok: true,
        module: "feedback",
        action: "export_feedback",
        text: `已导出需求监控反馈汇总：${path.relative(projectRoot, result.exportFile)}`,
        data: result
      };
    }

    return collect({
      text: context.text,
      content: task.params && task.params.content,
      sender: context.sender,
      source: context.sender && context.sender.source
    });
  }

  async function getStatus() {
    const result = list({ limit: 1 });
    return {
      enabled: true,
      ready: true,
      storageFile: path.relative(projectRoot, storageFile),
      exportFile: path.relative(projectRoot, exportFile),
      total: result.summary.total,
      byCategory: result.summary.byCategory
    };
  }

  return {
    name: "feedback",
    handle,
    collect,
    importText,
    list,
    exportMarkdown,
    getStatus
  };
}

module.exports = {
  createDemandMonitorFeedbackModule,
  extractPrefixedContent,
  splitFeedbackItems
};
