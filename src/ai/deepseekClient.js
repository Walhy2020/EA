"use strict";

const https = require("https");

function postJson(urlText, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const payload = JSON.stringify(body);
    const req = https.request({
      method: "POST",
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${error.message}`));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function createDeepSeekClient(aiConfig) {
  const apiKey = process.env[aiConfig.apiKeyEnv || "DEEPSEEK_API_KEY"];

  function chatCompletionsEndpoint() {
    const baseUrl = String(aiConfig.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(baseUrl)) {
      return baseUrl;
    }
    if (/\/v1$/i.test(baseUrl)) {
      return `${baseUrl}/chat/completions`;
    }
    return `${baseUrl}/v1/chat/completions`;
  }

  async function chat(messages) {
    if (!apiKey) {
      throw new Error("大模型 API Key 未配置");
    }

    const response = await postJson(chatCompletionsEndpoint(), {
      model: aiConfig.model || "deepseek-v4-flash",
      messages,
      temperature: 0.1
    }, {
      Authorization: `Bearer ${apiKey}`
    });

    return response && response.choices && response.choices[0] && response.choices[0].message
      ? response.choices[0].message.content
      : "";
  }

  return { chat };
}

module.exports = {
  createDeepSeekClient
};
