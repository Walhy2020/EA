"use strict";

const assert = require("assert/strict");
const { createAnswerComposer } = require("../src/ai/answerComposer");
const { createConversationOrchestrator } = require("../src/conversation/conversationOrchestrator");
const { createConversationStore } = require("../src/conversation/conversationStore");

async function main() {
  const capturedTasks = [];
  let aiCallCount = 0;
  const orchestrator = createConversationOrchestrator({
    aiConfig: { enabled: true },
    aiClient: {
      async chat() {
        aiCallCount += 1;
        return JSON.stringify({ status: "chat", reply: "这是创建方式说明。" });
      }
    },
    modules: {
      docCreator: {
        async handle(context) {
          capturedTasks.push(context.route.task);
          return {
            ok: true,
            text: `captured:${context.route.task.action}`
          };
        }
      }
    },
    answerComposer: createAnswerComposer(),
    store: createConversationStore(),
    logger: { info() {}, warn() {}, error() {} }
  });

  const cases = [
    ["创建一个表格，名称叫：AI进度", "create_smartsheet", "smartsheet"],
    ["创建共享表格，名称叫：周报", "create_smartsheet", "smartsheet"],
    ["创建普通表格，名称叫：临时清单", "create_spreadsheet", "spreadsheet"],
    ["创建一个文档，名称叫：项目方案", "create_smart_document", "smartdoc"],
    ["创建共享文档，名称叫：会议记录", "create_smart_document", "smartdoc"],
    ["创建普通文档，名称叫：离线说明", "create_document", "document"]
  ];

  for (const [text, expectedAction, expectedKind] of cases) {
    const result = await orchestrator.handle({
      text,
      sender: { source: "test", userId: `user-${capturedTasks.length}` }
    });
    assert.equal(result.ok, true, text);
    const task = capturedTasks[capturedTasks.length - 1];
    assert.equal(task.action, expectedAction, text);
    assert.equal(task.params.kind, expectedKind, text);
  }

  const createdCount = capturedTasks.length;
  const questionResult = await orchestrator.handle({
    text: "怎么创建表格？",
    sender: { source: "test", userId: "question-user" }
  });
  assert.equal(questionResult.ok, true);
  assert.equal(capturedTasks.length, createdCount, "询问创建方式不能触发真实创建");
  assert.equal(aiCallCount, 1, "创建方式问题应交给对话说明一次");

  console.log("Doc creator routing OK");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
