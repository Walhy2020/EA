# EazyGame Integrated Assistant

统一智能机器人入口，第一阶段部署在公司 Win10 常开电脑上。

## 当前定位

```text
企业微信智能机器人消息
-> 本地规则 / DeepSeek 意图识别
-> Router
-> 各业务模块
-> DeepSeek 或本地模板整理回复
-> 回复提问人
```

后台监控程序独立运行，发现变化后统一交给通知中心推送给个人或群。

## 第一阶段部署建议

先部署在公司 Win10 常开电脑：

```text
E:\Study\AI2006\ljj_code\eazygame-integrated-assistant
```

EA 已内置小游戏榜单模块源码：

```text
src\modules\rank\embedded-wx-mini-rank-monitor
```

旧的独立榜单系统可以继续保留和运行；EA 使用自己的内置源码、`config\rank.config.json` 和 `data\rank`，不再要求部署机同时更新旧目录。

## 启动

```powershell
cd E:\Study\AI2006\ljj_code\eazygame-integrated-assistant
node src\main.js
```

默认管理台：

```text
http://127.0.0.1:39200
```

需求进度管理正式 PC 入口：

```text
https://com.veryeazy.com:39200/demand-login.html
```

普通浏览器会跳转到企业微信 CorpApp 扫码登录。登录成功后按扫码成员身份展示待办、字段待补充、组员待办和兜底需求；企业微信工作台入口继续使用原有 OAuth，并与 PC 版共用服务端签名会话。网页登录身份不接受网址或请求体中的姓名参数。

如需让内网其它电脑访问，把 `.env` 里的 `EAZYGAME_HOST` 改成 `0.0.0.0`，并在 Win10 防火墙里只放行公司内网。

## 配置

复制示例文件后再填写真实值：

```powershell
copy .env.example .env
copy config\app.config.example.json config\app.config.json
copy config\modules.config.example.json config\modules.config.json
copy config\routes.config.example.json config\routes.config.json
```

不要把任何 Secret / API Key / Webhook 写入文档、聊天记录或日志。真实值只放本机 `.env` 或真实配置文件。

## 企业微信智能机器人

当前按“使用 SDK 启动长连接”接入，不需要公网 HTTPS 回调。

开启新统一入口时，在 `.env` 填写：

```text
WECOM_SMART_BOT_ID=
WECOM_SMART_BOT_SECRET=
```

然后把 `config\app.config.json` 里的 `robot.enabled` 改成 `true`。

注意：统一入口启用后，旧榜单模块里的智能机器人长连接应关闭，只保留榜单扫描能力，避免两个进程同时使用同一套 Bot ID / Secret。

## 检查

```powershell
npm run check
npm run check:config
```

`npm run check:config` 会输出脱敏后的配置摘要。
